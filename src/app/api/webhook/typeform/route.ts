import { NextRequest, NextResponse } from 'next/server';

const POSTEST_LIST_ID = 24; // "PROGRAMA Control Mental" en Brevo
const SENDER = { name: 'Mauro Carrillo', email: 'mauro@urologia.ar' };
const LANDING = 'https://urologia.ar/recuperatuereccion';

type Tier = 'A' | 'B' | 'C';

interface TypeformPayload {
  email: string;
  name?: string;
  pantalla: string;
  variante?: string;
  score?: number;
  tier: Tier;
}

function validateApiKey(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key');
  return Boolean(apiKey) && apiKey === process.env.API_SECRET_KEY;
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parsePayload(data: unknown): { ok: true; payload: TypeformPayload } | { ok: false; error: string } {
  if (!data || typeof data !== 'object') return { ok: false, error: 'Invalid payload' };
  const d = data as Record<string, unknown>;

  if (typeof d.email !== 'string' || !validateEmail(d.email)) {
    return { ok: false, error: 'Invalid or missing email' };
  }
  if (typeof d.pantalla !== 'string' || !d.pantalla.trim()) {
    return { ok: false, error: 'Missing pantalla' };
  }
  if (d.tier !== 'A' && d.tier !== 'B' && d.tier !== 'C') {
    return { ok: false, error: 'tier must be A | B | C' };
  }

  return {
    ok: true,
    payload: {
      email: d.email.toLowerCase().trim(),
      name: typeof d.name === 'string' ? d.name.trim() : undefined,
      pantalla: d.pantalla.trim(),
      variante: typeof d.variante === 'string' ? d.variante.trim() : undefined,
      score: typeof d.score === 'number' ? d.score : undefined,
      tier: d.tier,
    },
  };
}

function firstName(name?: string): string {
  if (!name) return '';
  return name.trim().split(/\s+/)[0] || '';
}

function buildMailA(name: string): { subject: string; text: string } {
  const greeting = name ? `Hola ${name},` : 'Hola,';
  return {
    subject: 'Buenas noticias, el programa es para vos',
    text:
      `${greeting}\n\n` +
      `Vi tus respuestas del test. Por lo que contás, el programa es para vos.\n\n` +
      `Te dejo el link para que lo mires con calma:\n\n` +
      `${LANDING}\n\n` +
      `Tomate el tiempo que necesites. Si después de leer te queda alguna duda puntual, me respondés este mismo mail y lo conversamos.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

function buildMailB(name: string): { subject: string; text: string } {
  const greeting = name ? `Hola ${name},` : 'Hola,';
  return {
    subject: 'Espero poder ayudarte',
    text:
      `${greeting}\n\n` +
      `Te cuento que ya recibí el resultado del test.\n\n` +
      `Por lo que contás, el programa puede ayudarte con tu situación.\n\n` +
      `Te dejo el link para que lo veas tranquilo y decidas:\n\n` +
      `${LANDING}\n\n` +
      `Si te interesa saber más respecto al programa, respondé este correo y lo vemos.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

async function brevoCreateOrUpdateContact(p: TypeformPayload): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };

  const body = {
    email: p.email,
    attributes: {
      FIRSTNAME: firstName(p.name),
      TIER: p.tier,
      PANTALLA: p.pantalla,
      VARIANTE: p.variante || '',
      SCORE: typeof p.score === 'number' ? p.score : 0,
    },
    listIds: [POSTEST_LIST_ID],
    updateEnabled: true,
  };

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 201 || res.status === 204) return { ok: true };

  const raw = await res.text();
  // Brevo responds 400 "Contact already exist" when updateEnabled handles it as success — treat as ok
  if (res.status === 400 && raw.toLowerCase().includes('already')) return { ok: true };
  return { ok: false, error: `Brevo contact ${res.status}: ${raw}` };
}

async function brevoSendTransactional(
  toEmail: string,
  toName: string,
  subject: string,
  text: string
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };

  const body = {
    sender: SENDER,
    to: [{ email: toEmail, name: toName || undefined }],
    replyTo: { email: SENDER.email },
    subject,
    textContent: text,
  };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 201) {
    const data = (await res.json()) as { messageId?: string };
    return { ok: true, messageId: data.messageId };
  }
  const raw = await res.text();
  return { ok: false, error: `Brevo send ${res.status}: ${raw}` };
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    success: true,
    message: 'Typeform webhook endpoint active. POST with x-api-key header to dispatch post-test email.',
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!validateApiKey(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = parsePayload(raw);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }
  const payload = parsed.payload;

  if (payload.tier === 'C') {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'tier C does not receive post-test email',
      pantalla: payload.pantalla,
    });
  }

  const name = firstName(payload.name);
  const mail = payload.tier === 'A' ? buildMailA(name) : buildMailB(name);

  const contactResult = await brevoCreateOrUpdateContact(payload);
  if (!contactResult.ok) {
    return NextResponse.json(
      { success: false, stage: 'contact', error: contactResult.error },
      { status: 502 }
    );
  }

  const sendResult = await brevoSendTransactional(payload.email, payload.name || '', mail.subject, mail.text);
  if (!sendResult.ok) {
    return NextResponse.json(
      { success: false, stage: 'send', error: sendResult.error },
      { status: 502 }
    );
  }

  return NextResponse.json({
    success: true,
    tier: payload.tier,
    pantalla: payload.pantalla,
    messageId: sendResult.messageId,
  });
}
