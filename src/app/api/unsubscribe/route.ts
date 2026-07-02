import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';

export const maxDuration = 10;

/**
 * Baja de la secuencia post-Typeform (y de todo email marketing).
 * GET  → click humano desde el link del header List-Unsubscribe.
 * POST → one-click unsubscribe de Gmail/Outlook (RFC 8058).
 * Firma HMAC (mismo esquema que buildUnsubscribeUrl en email-drip).
 * Efecto: blacklist en Brevo → la secuencia se corta sola en el próximo run.
 */
function validSignature(email: string, token: string): boolean {
  const secret = process.env.API_SECRET_KEY;
  if (!secret || !email || !token) return false;
  const expected = createHmac('sha256', secret)
    .update(email.toLowerCase().trim())
    .digest('hex')
    .slice(0, 32);
  return expected === token;
}

async function blacklistInBrevo(email: string): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return false;
  const res = await fetch(
    `https://api.brevo.com/v3/contacts/${encodeURIComponent(email.toLowerCase().trim())}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ emailBlacklisted: true }),
    }
  );
  // 204 = ok; 404 = no es contacto de Brevo (nada que blacklistear, damos ok igual)
  return res.status === 204 || res.status === 404;
}

const PAGE = (msg: string) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>urologia.ar</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#f4f4f4;margin:0;padding:40px 16px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;text-align:center;color:#313131">
<p style="font-size:17px;line-height:1.6;margin:0 0 12px">${msg}</p>
<p style="font-size:14px;color:#999;margin:16px 0 0">Mauro Carrillo — Urólogo · urologia.ar</p>
</div></body></html>`;

async function handle(request: NextRequest): Promise<NextResponse> {
  const email = request.nextUrl.searchParams.get('e') || '';
  const token = request.nextUrl.searchParams.get('t') || '';

  if (!validSignature(email, token)) {
    return new NextResponse(PAGE('El enlace no es válido o ya venció.'), {
      status: 400,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const ok = await blacklistInBrevo(email);
  console.log(`Unsubscribe: ${email} → ${ok ? 'blacklisted' : 'ERROR'}`);

  return new NextResponse(
    PAGE(ok ? 'Listo. No te escribo más.' : 'Hubo un problema — escribime a mauro@urologia.ar y te doy de baja yo.'),
    { status: ok ? 200 : 500, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// One-click (RFC 8058): Gmail/Outlook hacen POST a la misma URL.
export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
