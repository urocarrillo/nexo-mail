import { NextRequest, NextResponse } from 'next/server';
import { plainToHtml } from '@/lib/email-drip';

const TIKTOK_LIST_ID = 33; // "TIKTOK Leads PROGRAMA" en Brevo
const SENDER = { name: 'Mauro Carrillo', email: 'mauro@urologia.ar' };
const FORM_URL = 'https://urologia.ar/recupera-form';

interface TikTokFormPayload {
  email: string;
  name?: string;
  manychat_id?: string;
}

function validateApiKey(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key');
  return Boolean(apiKey) && apiKey === process.env.API_SECRET_KEY;
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parsePayload(data: unknown): { ok: true; payload: TikTokFormPayload } | { ok: false; error: string } {
  if (!data || typeof data !== 'object') return { ok: false, error: 'Invalid payload' };
  const d = data as Record<string, unknown>;

  if (typeof d.email !== 'string' || !validateEmail(d.email)) {
    return { ok: false, error: 'Invalid or missing email' };
  }

  return {
    ok: true,
    payload: {
      email: d.email.toLowerCase().trim(),
      name: typeof d.name === 'string' ? d.name.trim() : undefined,
      manychat_id: typeof d.manychat_id === 'string' ? d.manychat_id.trim() : undefined,
    },
  };
}

function firstName(name?: string): string {
  if (!name) return '';
  return name.trim().split(/\s+/)[0] || '';
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

async function brevoCreateOrUpdateContact(p: TikTokFormPayload): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };

  const body = {
    email: p.email,
    // Atributos reales de la cuenta Brevo: NOMBRE y LEAD_SOURCE
    // (FIRSTNAME/SOURCE/MANYCHAT_ID no existen y Brevo los descarta en silencio).
    attributes: {
      NOMBRE: firstName(p.name),
      LEAD_SOURCE: 'programa-tiktok-dm',
    },
    listIds: [TIKTOK_LIST_ID],
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
    htmlContent: plainToHtml(text, ''), // link clickeable, aspecto texto plano
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
    message: 'TikTok form webhook endpoint active. POST with x-api-key header to dispatch invite email.',
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

  const name = firstName(payload.name);
  const mail = buildMail(name);

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
    email: payload.email,
    messageId: sendResult.messageId,
  });
}
