import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';

export const maxDuration = 10;

/**
 * Baja de la secuencia post-Typeform (y de todo email marketing).
 *
 * GET  → muestra una página de confirmación con un botón (form POST). NO
 *        ejecuta la baja: los escáneres de seguridad de los clientes de correo
 *        (Outlook SafeLinks, antivirus) hacen GET a todos los links del mail
 *        y estaban dando de baja leads sin acción humana.
 * POST → ejecuta la baja. Cubre el submit del form de confirmación y el
 *        one-click de Gmail/Outlook (RFC 8058, List-Unsubscribe-Post), que
 *        hace POST a la misma URL; los params e y t vienen en la query en
 *        ambos casos.
 *
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
  const target = email.toLowerCase().trim();
  const headers = { 'content-type': 'application/json', 'api-key': apiKey };
  const res = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(target)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ emailBlacklisted: true }),
  });
  if (res.status === 204) return true;
  if (res.status !== 404) return false;

  // 404 = nunca fue contacto de Brevo (lead del test/Typeform: entra por Sheet + KV,
  // no por lista). Antes se daba por ok y el drip seguía mandando, porque
  // isEmailBlacklisted devuelve false ante 404. Lo creamos ya blacklisteado, sin
  // listas, para que el motor lo corte antes del próximo envío.
  const created = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: target, emailBlacklisted: true, updateEnabled: true }),
  });
  // 201 = creado; 204 = existía (carrera con otro alta) y quedó actualizado
  return created.status === 201 || created.status === 204;
}

const escHtml = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAGE = (msg: string, extra = '') => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>urologia.ar</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#f4f4f4;margin:0;padding:40px 16px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;text-align:center;color:#313131">
<p style="font-size:17px;line-height:1.6;margin:0 0 12px">${msg}</p>
${extra}<p style="font-size:14px;color:#999;margin:16px 0 0">Mauro Carrillo — Urólogo · urologia.ar</p>
</div></body></html>`;

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

// GET: sólo confirmación (sin JavaScript, sin auto-submit). La baja real
// sale con el POST del form, que un escáner no dispara.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const email = request.nextUrl.searchParams.get('e') || '';
  const token = request.nextUrl.searchParams.get('t') || '';

  if (!validSignature(email, token)) {
    return new NextResponse(PAGE('El enlace no es válido o ya venció.'), {
      status: 400,
      headers: HTML_HEADERS,
    });
  }

  const action = `/api/unsubscribe?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
  const form = `<form method="post" action="${escHtml(action)}" style="margin:24px 0 12px">
<button type="submit" style="background:#E67E22;color:#ffffff;border:none;border-radius:30px;padding:14px 32px;font-size:16px;font-family:Arial,Helvetica,sans-serif;cursor:pointer">Sí, darme de baja</button>
</form>
`;
  return new NextResponse(PAGE('¿Querés dejar de recibir estos mails?', form), {
    status: 200,
    headers: HTML_HEADERS,
  });
}

// POST: ejecuta la baja (form de confirmación + one-click RFC 8058).
export async function POST(request: NextRequest): Promise<NextResponse> {
  const email = request.nextUrl.searchParams.get('e') || '';
  const token = request.nextUrl.searchParams.get('t') || '';

  if (!validSignature(email, token)) {
    return new NextResponse(PAGE('El enlace no es válido o ya venció.'), {
      status: 400,
      headers: HTML_HEADERS,
    });
  }

  const ok = await blacklistInBrevo(email);
  console.log(`Unsubscribe: ${email} → ${ok ? 'blacklisted' : 'ERROR'}`);

  return new NextResponse(
    PAGE(ok ? 'Listo. No te escribo más.' : 'Hubo un problema — escribime a mauro@urologia.ar y te doy de baja yo.'),
    { status: ok ? 200 : 500, headers: HTML_HEADERS }
  );
}
