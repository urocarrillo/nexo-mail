import { NextRequest, NextResponse } from 'next/server';
import {
  COMBO_SENDER_ENTREGA,
  computeComboDates,
  mailEntrega,
} from '@/lib/secuencia-combo';
import { enrollCombo, plainToHtml } from '@/lib/email-drip';
import { logLeadCombo } from '@/lib/sheets-combo';

// Funnel "Experto en Intimidad" (combo programa DE 3740 + curso EP 3208,
// producto WooCommerce 5243) — captura desde urologia.ar/intimidad-sin-ansiedad
// (CORS) o server-to-server desde ManyChat (header x-api-key). Alta en Brevo,
// mail de entrega inmediato desde mauro@, registro en el Sheet CRM del combo
// y enrolamiento en la secuencia ei1..ei5 (espejo de /api/form/durar-mas).
const COMBO_LIST_ID = 37; // "COMBO Experto en Intimidad" en Brevo

const SOURCES = ['web', 'instagram', 'tiktok'] as const;
type Source = (typeof SOURCES)[number];

const ALLOWED_ORIGINS = [
  'https://urologia.ar',
  'https://www.urologia.ar',
  'https://link.urologia.ar',
];

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function firstName(name?: string): string {
  if (!name) return '';
  return name.trim().split(/\s+/)[0] || '';
}

/** Server-to-server (ManyChat): x-api-key válida saltea el chequeo de origin. */
function hasValidApiKey(request: NextRequest): boolean {
  const key = request.headers.get('x-api-key');
  return Boolean(process.env.API_SECRET_KEY) && key === process.env.API_SECRET_KEY;
}

// Rate limiting: simple in-memory store (resets on deploy)
const submissions = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minuto
const RATE_LIMIT_MAX = 3;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (submissions.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW);
  submissions.set(ip, recent);
  return recent.length >= RATE_LIMIT_MAX;
}

function recordSubmission(ip: string) {
  const history = submissions.get(ip) || [];
  history.push(Date.now());
  submissions.set(ip, history);
}

// El copy del mail de entrega vive en @/lib/secuencia-combo (COPY_ENTREGA).

async function brevoCreateOrUpdateContact(
  email: string,
  name: string | undefined,
  leadSource: string
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      email,
      attributes: { NOMBRE: firstName(name), LEAD_SOURCE: leadSource },
      listIds: [COMBO_LIST_ID],
      updateEnabled: true,
    }),
  });

  if (res.status === 201 || res.status === 204) return { ok: true };
  const raw = await res.text();
  if (res.status === 400 && raw.toLowerCase().includes('already')) return { ok: true };
  return { ok: false, error: `Brevo contact ${res.status}: ${raw}` };
}

async function brevoSendEntrega(email: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };
  const mail = mailEntrega(name);

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      sender: COMBO_SENDER_ENTREGA,
      to: [{ email, name: name || undefined }],
      replyTo: { email: COMBO_SENDER_ENTREGA.email },
      subject: mail.subject,
      textContent: mail.text,
      htmlContent: plainToHtml(mail.text, ''), // link clickeable, aspecto texto plano
    }),
  });

  if (res.status === 201) return { ok: true };
  const raw = await res.text();
  return { ok: false, error: `Brevo send ${res.status}: ${raw}` };
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ success: true, message: 'Experto en Intimidad funnel form endpoint active.' });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429, headers });
  }

  // Origen: navegador desde los dominios permitidos, o server-to-server
  // (ManyChat) con x-api-key. El rate limit por IP aplica en ambos casos.
  if (!hasValidApiKey(request) && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
    return NextResponse.json({ success: false, error: 'Origin not allowed' }, { status: 403, headers });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400, headers });
  }

  // Honeypot: si _hp tiene valor, es un bot. Aceptamos en silencio.
  if (body._hp && typeof body._hp === 'string' && body._hp.trim() !== '') {
    return NextResponse.json({ success: true }, { headers });
  }

  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  if (!email || !validateEmail(email)) {
    return NextResponse.json({ success: false, error: 'Email inválido' }, { status: 400, headers });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;

  const rawSource = typeof body.source === 'string' ? body.source.trim().toLowerCase() : '';
  const source: Source = (SOURCES as readonly string[]).includes(rawSource)
    ? (rawSource as Source)
    : 'web';
  const leadSource = `experto-intimidad-${source}`;

  recordSubmission(ip);

  const contact = await brevoCreateOrUpdateContact(email, name, leadSource);
  if (!contact.ok) {
    console.error('Experto-intimidad contact error:', contact.error);
    return NextResponse.json({ success: false, error: 'Error al procesar' }, { status: 502, headers });
  }

  // Post-alta en paralelo, non-blocking (espejo de /api/form/durar-mas):
  // (a) mail de entrega, (b) registro en el Sheet CRM, (c) enrolar ei1..ei5.
  const nombre = firstName(name);
  const [entrega, sheetLog, enroll] = await Promise.allSettled([
    brevoSendEntrega(email, nombre),
    logLeadCombo({ nombre: name || '', email, fuente: leadSource }),
    enrollCombo({ email, name: nombre || undefined, dates: computeComboDates(new Date()) }),
  ]);

  if (entrega.status === 'fulfilled') {
    if (!entrega.value.ok) console.error('Experto-intimidad entrega mail error:', entrega.value.error);
  } else {
    console.error('Experto-intimidad entrega mail error:', entrega.reason);
  }
  if (sheetLog.status === 'rejected') {
    console.error('Experto-intimidad sheet log error:', sheetLog.reason);
  }
  if (enroll.status === 'fulfilled') {
    if (enroll.value.skipped) console.log(`Experto-intimidad enroll skip (${enroll.value.skipped}): ${email}`);
  } else {
    console.error('Experto-intimidad enroll error:', enroll.reason);
  }

  return NextResponse.json({ success: true }, { headers });
}
