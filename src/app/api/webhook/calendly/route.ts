import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import * as Brevo from '@getbrevo/brevo';
import { createPatientCoupon } from '@/lib/woocommerce-coupons';

// ─── Calendly webhook types ────────────────────────────────────────

interface CalendlyEvent {
  uri: string;
  name: string;
  start_time: string;
  end_time: string;
}

interface CalendlyWebhookPayload {
  event: string; // "invitee.created" | "invitee.canceled"
  payload: {
    event: string; // event URI
    name: string;
    email: string;
    scheduled_event?: CalendlyEvent;
    event_type?: {
      name: string;
    };
  };
}

// ─── Config ─────────────────────────────────────────────────────────

const ALLOWED_EVENT_NAMES = ['Atención Prioritaria'];
const POST_CONSULTATION_DELAY_MS = 60 * 60 * 1000; // 1 hour after event ends
const BREVO_TEMPLATE_ID = parseInt(process.env.CALENDLY_EMAIL_TEMPLATE_ID || '0');

// ─── Brevo transactional send ───────────────────────────────────────

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY || ''
);

async function sendPostConsultationEmail(params: {
  email: string;
  name: string;
  couponCode: string;
  templateId: number;
  scheduledAt?: string; // ISO datetime — Brevo sends at this time
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { email, name, couponCode, templateId, scheduledAt } = params;

  try {
    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.templateId = templateId;
    sendEmail.to = [{ email, name }];
    sendEmail.params = {
      NOMBRE: name.split(' ')[0],
      COUPON_CODE: couponCode,
    };
    if (scheduledAt) {
      sendEmail.scheduledAt = scheduledAt as unknown as Date;
    }

    const result = await transacApi.sendTransacEmail(sendEmail);
    const action = scheduledAt ? `scheduled for ${scheduledAt}` : 'sent immediately';
    console.log(`Post-consultation email ${action} to ${email} (coupon: ${couponCode})`);
    return { success: true, messageId: result.body?.messageId };
  } catch (error: unknown) {
    const apiError = error as { response?: { body?: { message?: string } }; message?: string };
    console.error('Brevo send error:', apiError.response?.body || apiError.message);
    return {
      success: false,
      error: apiError.response?.body?.message || apiError.message || 'Unknown error',
    };
  }
}

// ─── Validation ─────────────────────────────────────────────────────

function validateRequest(request: NextRequest, body: string): boolean {
  // Layer 1: URL token (required) — Calendly stores the full URL including ?token=xxx
  const token = request.nextUrl.searchParams.get('token');
  const expectedToken = process.env.CALENDLY_WEBHOOK_TOKEN;

  if (!expectedToken) {
    console.error('CALENDLY_WEBHOOK_TOKEN not set — rejecting all requests');
    return false;
  }

  if (token !== expectedToken) {
    console.error('Invalid webhook token');
    return false;
  }

  // Layer 2: Calendly signature (optional, if signing key is configured)
  const secret = process.env.CALENDLY_WEBHOOK_SECRET;
  if (secret) {
    const signature = request.headers.get('calendly-webhook-signature');
    if (!signature) return false;

    const parts = signature.split(',');
    const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
    const v1 = parts.find(p => p.startsWith('v1='))?.slice(3);

    if (!timestamp || !v1) return false;

    const data = `${timestamp}.${body}`;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(data, 'utf8')
      .digest('hex');

    return v1 === expected;
  }

  return true; // token valid, no signing key configured
}

function isAllowedEvent(payload: CalendlyWebhookPayload): boolean {
  const eventName = payload.payload.event_type?.name
    || payload.payload.scheduled_event?.name
    || '';
  return ALLOWED_EVENT_NAMES.some(
    allowed => eventName.toLowerCase().includes(allowed.toLowerCase())
  );
}

// ─── Route handlers ─────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    success: true,
    message: 'Calendly webhook endpoint is active. Use POST to receive events.',
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let rawBody: string;
  let body: CalendlyWebhookPayload;

  try {
    rawBody = await request.text();
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON' },
      { status: 400 }
    );
  }

  // Validate request (URL token + optional Calendly signature)
  if (!validateRequest(request, rawBody)) {
    console.error('Unauthorized Calendly webhook request');
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Only process invitee.created events
  if (body.event !== 'invitee.created') {
    return NextResponse.json({
      success: true,
      message: `Ignored event: ${body.event}`,
      skipped: true,
    });
  }

  // Only process "Atención Prioritaria" events
  if (!isAllowedEvent(body)) {
    const eventName = body.payload.event_type?.name
      || body.payload.scheduled_event?.name
      || 'unknown';
    console.log(`Skipping non-eligible event type: ${eventName}`);
    return NextResponse.json({
      success: true,
      message: `Skipped event type: ${eventName}`,
      skipped: true,
    });
  }

  const { email, name } = body.payload;
  const eventEndTime = body.payload.scheduled_event?.end_time;

  if (!email || !eventEndTime) {
    return NextResponse.json(
      { success: false, error: 'Missing email or event end time' },
      { status: 400 }
    );
  }

  try {
    // 1. Create WooCommerce coupon (30%, 24hr, single use)
    const couponResult = await createPatientCoupon({
      patientName: name || 'Paciente',
      patientEmail: email,
    });

    if (!couponResult.success || !couponResult.code) {
      console.error('Failed to create coupon:', couponResult.error);
      return NextResponse.json(
        { success: false, error: `Coupon creation failed: ${couponResult.error}` },
        { status: 500 }
      );
    }

    // 2. Schedule email via Brevo's scheduledAt — 1 hour after consultation ends
    //    Brevo handles the delay server-side, no cron needed.
    const endTime = new Date(eventEndTime);
    const sendAt = new Date(endTime.getTime() + POST_CONSULTATION_DELAY_MS);

    const emailResult = await sendPostConsultationEmail({
      email,
      name: name || 'Paciente',
      couponCode: couponResult.code,
      templateId: BREVO_TEMPLATE_ID,
      scheduledAt: sendAt.toISOString(),
    });

    if (!emailResult.success) {
      // Coupon was created but email failed — log but don't fail the webhook
      console.error(`Email scheduling failed for ${email}: ${emailResult.error}. Coupon ${couponResult.code} was created.`);
    }

    console.log(
      `Post-consultation flow complete: ${email} | coupon: ${couponResult.code} | email scheduled: ${sendAt.toISOString()}`
    );

    return NextResponse.json({
      success: true,
      message: 'Coupon created and email scheduled via Brevo',
      couponCode: couponResult.code,
      sendAt: sendAt.toISOString(),
      emailScheduled: emailResult.success,
    });
  } catch (error) {
    console.error('Calendly webhook error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
