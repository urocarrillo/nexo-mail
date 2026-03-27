import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { createPatientCoupon } from '@/lib/woocommerce-coupons';

// ─── Calendly webhook types ────────────────────────────────────────

interface CalendlyEvent {
  uri: string;
  name: string;
  start_time: string;
  end_time: string;
}

interface CalendlyInvitee {
  uri: string;
  name: string;
  email: string;
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
const SCHEDULED_EMAILS_KEY = 'calendly:scheduled';

// ─── Brevo transactional send ───────────────────────────────────────

import * as Brevo from '@getbrevo/brevo';

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
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { email, name, couponCode, templateId } = params;

  try {
    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.templateId = templateId;
    sendEmail.to = [{ email, name }];
    sendEmail.params = {
      NOMBRE: name.split(' ')[0], // first name only
      COUPON_CODE: couponCode,
    };

    const result = await transacApi.sendTransacEmail(sendEmail);
    console.log(`Post-consultation email sent to ${email} (coupon: ${couponCode})`);
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

// ─── Scheduled email entry ──────────────────────────────────────────

interface ScheduledConsultationEmail {
  id: string;
  email: string;
  name: string;
  couponCode: string;
  templateId: number;
  eventName: string;
  eventEndTime: string;
  sendAt: string; // ISO date — event end + 1 hour
  status: 'pending' | 'sent' | 'failed' | 'canceled';
  createdAt: string;
  sentAt?: string;
  error?: string;
}

// ─── Validation ─────────────────────────────────────────────────────

function validateCalendlySignature(
  request: NextRequest,
  body: string
): boolean {
  const secret = process.env.CALENDLY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('CALENDLY_WEBHOOK_SECRET not set — skipping signature validation');
    return true;
  }

  const signature = request.headers.get('calendly-webhook-signature');
  if (!signature) return false;

  // Calendly v2 signature format: t=timestamp,v1=signature
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

function isAllowedEvent(payload: CalendlyWebhookPayload): boolean {
  // Check event type name
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
  // Parse body (need raw text for signature validation)
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

  // Validate Calendly signature
  if (!validateCalendlySignature(request, rawBody)) {
    console.error('Invalid Calendly webhook signature');
    return NextResponse.json(
      { success: false, error: 'Invalid signature' },
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
    // 1. Create WooCommerce coupon
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

    // 2. Calculate send time: event end + 1 hour
    const endTime = new Date(eventEndTime);
    const sendAt = new Date(endTime.getTime() + POST_CONSULTATION_DELAY_MS);

    // 3. Schedule email in KV (will be sent by /api/cron/send-emails-calendly)
    const templateId = BREVO_TEMPLATE_ID;
    const scheduledEmail: ScheduledConsultationEmail = {
      id: `cal_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      email,
      name: name || 'Paciente',
      couponCode: couponResult.code,
      templateId,
      eventName: body.payload.scheduled_event?.name || 'Atención Prioritaria',
      eventEndTime,
      sendAt: sendAt.toISOString(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await kv.hset(SCHEDULED_EMAILS_KEY, {
      [scheduledEmail.id]: JSON.stringify(scheduledEmail),
    });

    console.log(
      `Scheduled post-consultation email: ${email} | coupon: ${couponResult.code} | send at: ${sendAt.toISOString()}`
    );

    return NextResponse.json({
      success: true,
      message: 'Coupon created and email scheduled',
      couponCode: couponResult.code,
      sendAt: sendAt.toISOString(),
      scheduledEmailId: scheduledEmail.id,
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

// ─── Process scheduled consultation emails (called by cron) ─────────

export async function processScheduledConsultationEmails(): Promise<{
  processed: number;
  sent: number;
  failed: number;
  remaining: number;
}> {
  const now = new Date();
  const allEntries = await kv.hgetall<Record<string, string>>(SCHEDULED_EMAILS_KEY);

  if (!allEntries) {
    return { processed: 0, sent: 0, failed: 0, remaining: 0 };
  }

  let processed = 0;
  let sent = 0;
  let failed = 0;
  let remaining = 0;

  for (const [id, json] of Object.entries(allEntries)) {
    const entry: ScheduledConsultationEmail =
      typeof json === 'string' ? JSON.parse(json) : json;

    if (entry.status !== 'pending') continue;

    const sendAt = new Date(entry.sendAt);
    if (sendAt > now) {
      remaining++;
      continue;
    }

    // Time to send
    processed++;
    const result = await sendPostConsultationEmail({
      email: entry.email,
      name: entry.name,
      couponCode: entry.couponCode,
      templateId: entry.templateId,
    });

    if (result.success) {
      sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      console.log(`Post-consultation email sent: ${entry.email} (${entry.couponCode})`);
    } else {
      failed++;
      entry.status = 'failed';
      entry.error = result.error;
      console.error(`Post-consultation email failed: ${entry.email}: ${result.error}`);
    }

    await kv.hset(SCHEDULED_EMAILS_KEY, { [id]: JSON.stringify(entry) });
  }

  return { processed, sent, failed, remaining };
}
