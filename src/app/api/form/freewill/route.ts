import { NextRequest, NextResponse } from 'next/server';

// Landing "Toma el control" (urologia.ar/toma-el-control) — captura para futura app free-will.
const FREEWILL_LIST_ID = 34; // "app free-will" en Brevo
const SENDER = { name: 'Mauro Carrillo', email: 'mauro@urologia.ar' };

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
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function firstName(name?: string): string {
  if (!name) return '';
  return name.trim().split(/\s+/)[0] || '';
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
  const hola = name ? `Hola ${name}` : 'Hola';
  return {
    subject: 'Ya estás en la lista',
    text:
      `${hola},\n\n` +
      `Gracias por dejarme tu mail. Acabás de dar el primer paso.\n\n` +
      `Estoy preparando algo que te va a ayudar a tener más control sobre tu cabeza y sobre tu vida. ` +
      `Todavía no puedo contarte todo, pero quiero que seas de los primeros en enterarte cuando esté listo.\n\n` +
      `Por ahora te pido una sola cosa: estate atento a mis próximos mails.\n\n` +
      `Un favor para no perdernos: si este mensaje te llegó a Spam o a Promociones, movelo a tu bandeja principal y marcá mi dirección como segura. Así no te perdés nada de lo que viene.\n\n` +
      `Nos vemos pronto.\n\n` +
      `Mauro\n`,
  };
}

async function brevoCreateOrUpdateContact(email: string, name?: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      email,
      attributes: { NOMBRE: firstName(name), LEAD_SOURCE: 'freewill-landing' },
      listIds: [FREEWILL_LIST_ID],
      updateEnabled: true,
    }),
  });

  if (res.status === 201 || res.status === 204) return { ok: true };
  const raw = await res.text();
  if (res.status === 400 && raw.toLowerCase().includes('already')) return { ok: true };
  return { ok: false, error: `Brevo contact ${res.status}: ${raw}` };
}

async function brevoSendWelcome(email: string, name: string): Promise<{ ok: boolean; error?: string }> {
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
  return NextResponse.json({ success: true, message: 'Free-will landing form endpoint active.' });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429, headers });
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

  recordSubmission(ip);

  const contact = await brevoCreateOrUpdateContact(email, name);
  if (!contact.ok) {
    console.error('Free-will contact error:', contact.error);
    return NextResponse.json({ success: false, error: 'Error al procesar' }, { status: 502, headers });
  }

  // El mail de bienvenida no debe bloquear el éxito de la suscripción.
  const send = await brevoSendWelcome(email, firstName(name));
  if (!send.ok) console.error('Free-will welcome mail error:', send.error);

  return NextResponse.json({ success: true }, { headers });
}
