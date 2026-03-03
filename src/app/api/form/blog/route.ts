import { NextRequest, NextResponse } from 'next/server';
import { addContactToBrevo } from '@/lib/brevo';
import { saveLead, updateLeadStatus, getLeadByEmail } from '@/lib/storage';
import { startDripSequence } from '@/lib/email-drip';
import { LeadTag } from '@/lib/types';

const BLOG_VALID_TAGS: LeadTag[] = [
  'lead-magnet-5h',
  'lead-magnet-ep',
  'lead-magnet-preservativo',
  'waitlist-programa',
  'general',
];

const ALLOWED_ORIGINS = [
  'https://urologia.ar',
  'https://www.urologia.ar',
];

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Rate limiting: simple in-memory store (resets on deploy)
const submissions = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 3; // max 3 submissions per IP per minute

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const history = submissions.get(ip) || [];
  const recent = history.filter((t) => now - t < RATE_LIMIT_WINDOW);
  submissions.set(ip, recent);
  return recent.length >= RATE_LIMIT_MAX;
}

function recordSubmission(ip: string) {
  const history = submissions.get(ip) || [];
  history.push(Date.now());
  submissions.set(ip, history);
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);

  // Rate limiting
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { success: false, error: 'Too many requests' },
      { status: 429, headers }
    );
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON' },
      { status: 400, headers }
    );
  }

  // Honeypot check — if _hp field has a value, it's a bot
  if (body._hp && typeof body._hp === 'string' && body._hp.trim() !== '') {
    // Silently accept to not tip off bots
    return NextResponse.json({ success: true }, { headers });
  }

  // Validate email
  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  if (!email || !validateEmail(email)) {
    return NextResponse.json(
      { success: false, error: 'Email inválido' },
      { status: 400, headers }
    );
  }

  // Validate tag
  const tag = (typeof body.tag === 'string' ? body.tag : 'general') as LeadTag;
  if (!BLOG_VALID_TAGS.includes(tag)) {
    return NextResponse.json(
      { success: false, error: 'Tag inválido' },
      { status: 400, headers }
    );
  }

  const name = typeof body.name === 'string' ? body.name.trim() : undefined;

  recordSubmission(ip);

  try {
    // Check/create lead
    let lead = await getLeadByEmail(email);
    if (!lead) {
      lead = await saveLead({
        email,
        name,
        source: 'blog',
        tag,
      });
    }

    // Add to Brevo
    const brevoResult = await addContactToBrevo({
      email,
      name,
      source: 'blog',
      tag,
    });

    if (brevoResult.success) {
      await updateLeadStatus(lead.id, 'subscribed', {
        brevoContactId: brevoResult.contactId,
      });

      // Start drip email sequence (EP, Preservativo, or Waitlist)
      // For lead-magnet-5h: handled by existing Brevo automation #27
      // For general: no drip sequence
      let drip = { started: false, emailsSent: 0, emailsScheduled: 0 };
      try {
        drip = await startDripSequence(email, tag, name);
      } catch (err) {
        console.error('Drip start error:', err);
      }

      return NextResponse.json({ success: true, drip }, { headers });
    } else {
      await updateLeadStatus(lead.id, 'error');
      return NextResponse.json(
        { success: false, error: 'Error al procesar' },
        { status: 500, headers }
      );
    }
  } catch (error) {
    console.error('Blog form error:', error);
    return NextResponse.json(
      { success: false, error: 'Error interno' },
      { status: 500, headers }
    );
  }
}
