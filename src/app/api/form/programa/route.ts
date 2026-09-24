import { NextRequest, NextResponse } from 'next/server';
import { logLeadProgramaWeb } from '@/lib/sheets-tiktok-programa';

// Funnel programa DE — captura pre-test desde landing web (urologia.ar/test-de-ereccion).
// Alta en Brevo #33, mail plain con el link al Typeform calificatorio
// (recupera-form) y fila en el sheet "TikTok PROGRAMA Form" con SUCCESS.
// El mail es el mismo aprobado en el PRD tiktok-manychat-recupera-form:
// URL limpia sin parámetros (entregabilidad); la atribución vive en Brevo
// (SOURCE) y en el sheet (col B = bio-<source>), cruce por email con el CRM.
const PROGRAMA_LIST_ID = 33; // "TIKTOK Leads PROGRAMA" en Brevo
const SENDER = { name: 'Mauro Carrillo', email: 'mauro@urologia.ar' };
const FORM_URL = 'https://urologia.ar/recupera-form';

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

/** Server-to-server: x-api-key válida saltea el chequeo de origin. */
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

function buildMail(name: string): { subject: string; text: string } {
  const greetingLine = name ? `Hola ${name}` : 'Hola';
  return {
    subject: '1 minuto para entender qué te pasa',
    text:
      `${greetingLine}\n\n` +
      `Tal cual te prometí, te dejo el test rápido. En menos de 1 minuto entendés qué te pasa y cómo te puedo ayudar.\n\n` +
      `Hacé click acá:\n` +
      `${FORM_URL}\n\n` +
      `Mauro\n\n` +
      `PD: si este mail no llegó a tu bandeja principal, movelo desde Promociones o SPAM así no se nos pierde el contacto.\n`,
  };
}

async function brevoCreateOrUpdateContact(
  email: string,
  name: string | undefined,
  source: Source
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      email,
      // Atributos reales de la cuenta Brevo: NOMBRE y LEAD_SOURCE
      // (FIRSTNAME/SOURCE no existen y Brevo los descarta en silencio).
      attributes: { NOMBRE: firstName(name), LEAD_SOURCE: `programa-${source}` },
      listIds: [PROGRAMA_LIST_ID],
      updateEnabled: true,
    }),
  });

  if (res.status === 201 || res.status === 204) return { ok: true };
  const raw = await res.text();
  if (res.status === 400 && raw.toLowerCase().includes('already')) return { ok: true };
  return { ok: false, error: `Brevo contact ${res.status}: ${raw}` };
}

async function brevoSendTest(email: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };
  const mail = buildMail(name);

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      sender: SENDER,
      to: [{ email, name: name || undefined }],
      replyTo: { email: SENDER.email },
      subject: mail.subject,
      textContent: mail.text,
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
  return NextResponse.json({ success: true, message: 'Programa DE pre-test form endpoint active.' });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429, headers });
  }

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

  recordSubmission(ip);

  const contact = await brevoCreateOrUpdateContact(email, name, source);
  if (!contact.ok) {
    console.error('Programa form contact error:', contact.error);
    return NextResponse.json({ success: false, error: 'Error al procesar' }, { status: 502, headers });
  }

  const nombre = firstName(name);
  const send = await brevoSendTest(email, nombre);
  if (!send.ok) {
    console.error('Programa form mail error:', send.error);
    return NextResponse.json({ success: false, error: 'Error al enviar' }, { status: 502, headers });
  }

  // Sheet: best-effort, después del envío (fila con SUCCESS para que el
  // Apps Script del sheet nunca la reprocese).
  const sheetLog = await logLeadProgramaWeb({ nombre: name || '', email, source });
  if (!sheetLog.ok) {
    console.error('Programa form sheet log failed (non-blocking)');
  }

  return NextResponse.json({ success: true }, { headers });
}
