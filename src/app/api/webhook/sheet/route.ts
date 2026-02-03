import { NextRequest, NextResponse } from 'next/server';
import { addContactToBrevo } from '@/lib/brevo';
import { saveLead, updateLeadStatus, getLeadByEmail } from '@/lib/storage';
import { WebhookPayload, WebhookResponse, LeadTag } from '@/lib/types';

const VALID_TAGS: LeadTag[] = ['general', 'programa-de', 'eyaculacion-precoz', 'youtube'];

function validateApiKey(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key');
  return apiKey === process.env.API_SECRET_KEY;
}

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePayload(data: unknown): { valid: boolean; error?: string; payload?: WebhookPayload } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid payload' };
  }

  const payload = data as Record<string, unknown>;

  if (!payload.email || typeof payload.email !== 'string') {
    return { valid: false, error: 'Email is required' };
  }

  if (!validateEmail(payload.email)) {
    return { valid: false, error: 'Invalid email format' };
  }

  const tag = (payload.tag as string) || 'general';
  if (!VALID_TAGS.includes(tag as LeadTag)) {
    return { valid: false, error: `Invalid tag. Must be one of: ${VALID_TAGS.join(', ')}` };
  }

  return {
    valid: true,
    payload: {
      email: payload.email.toLowerCase().trim(),
      name: typeof payload.name === 'string' ? payload.name.trim() : undefined,
      phone: typeof payload.phone === 'string' ? payload.phone.trim() : undefined,
      source: typeof payload.source === 'string' ? payload.source.trim() : 'instagram',
      tag: tag as LeadTag,
    },
  };
}

export async function GET(): Promise<NextResponse<WebhookResponse>> {
  return NextResponse.json({
    success: true,
    message: 'Sheet webhook endpoint is active. Use POST to submit leads.',
  });
}

export async function POST(request: NextRequest): Promise<NextResponse<WebhookResponse>> {
  // Validate API key
  if (!validateApiKey(request)) {
    return NextResponse.json(
      { success: false, message: 'Unauthorized', error: 'Invalid or missing API key' },
      { status: 401 }
    );
  }

  // Parse and validate payload
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON', error: 'Could not parse request body' },
      { status: 400 }
    );
  }

  const validation = validatePayload(body);
  if (!validation.valid || !validation.payload) {
    return NextResponse.json(
      { success: false, message: 'Validation failed', error: validation.error },
      { status: 400 }
    );
  }

  const { email, name, phone, source, tag } = validation.payload;

  try {
    // Check if lead already exists
    let lead = await getLeadByEmail(email);

    if (!lead) {
      // Save new lead to storage
      lead = await saveLead({
        email,
        name,
        phone,
        source: source || 'instagram',
        tag: tag || 'general',
      });
    }

    // Add to Brevo
    const brevoResult = await addContactToBrevo({
      email,
      name,
      phone,
      source,
      tag,
    });

    if (brevoResult.success) {
      // Update lead status to subscribed
      await updateLeadStatus(lead.id, 'subscribed', {
        brevoContactId: brevoResult.contactId,
      });

      return NextResponse.json({
        success: true,
        message: 'Lead processed successfully',
        leadId: lead.id,
      });
    } else {
      // Update lead status to error
      await updateLeadStatus(lead.id, 'error');

      return NextResponse.json(
        {
          success: false,
          message: 'Failed to add contact to Brevo',
          error: brevoResult.error,
          leadId: lead.id,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
