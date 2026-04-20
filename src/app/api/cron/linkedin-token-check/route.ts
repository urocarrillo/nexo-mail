import { NextRequest, NextResponse } from 'next/server';
import * as Brevo from '@getbrevo/brevo';
import { getAccountHealth } from '@/lib/linkedin';

// Daily cron — checks LinkedIn token expiry
// Only sends email if token expires in ≤7 days
// Runs daily at 13:00 UTC (10:00 AM Argentina)

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const REMINDER_EMAIL = process.env.APPROVAL_EMAIL || '';

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

function buildTokenEmail(daysLeft: number): string {
  const isExpired = daysLeft <= 0;
  const bgColor = daysLeft <= 1 ? '#e74c3c' : '#E67E22';
  const title = isExpired
    ? 'LinkedIn DESCONECTADO'
    : `LinkedIn expira en ${daysLeft} dia${daysLeft === 1 ? '' : 's'}`;
  const subtitle = isExpired
    ? 'Los posts de LinkedIn NO se van a publicar hasta que reconectes.'
    : 'Reconecta ahora para que tus posts se sigan publicando sin interrupcion.';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4; padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:600px; width:100%;">
<tr><td style="background:${bgColor}; padding:40px 30px; text-align:center;">
  <p style="margin:0 0 12px; font-size:40px;">&#9888;</p>
  <h1 style="margin:0 0 12px; font-size:24px; color:#ffffff; font-weight:700;">${title}</h1>
  <p style="margin:0 0 24px; font-size:16px; color:#ffffff; opacity:0.9;">${subtitle}</p>
  <a href="https://zernio.com" style="display:inline-block; background:#ffffff; color:${bgColor}; text-decoration:none; padding:16px 40px; border-radius:30px; font-size:18px; font-weight:700;">Reconectar ahora</a>
</td></tr>
<tr><td style="padding:30px; text-align:center;">
  <h2 style="margin:0 0 16px; font-size:18px; color:#152735;">Instrucciones (30 segundos)</h2>
  <ol style="text-align:left; padding-left:24px; margin:0 0 20px;">
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">Hace click en el boton de arriba</li>
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">En Zernio, anda a <strong>Connections</strong></li>
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">En LinkedIn, click en <strong>Reconnect</strong></li>
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">Ingresa tu usuario y contrasena de LinkedIn</li>
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">Listo — queda renovado por 60 dias mas</li>
  </ol>
</td></tr>
<tr><td style="padding:16px 30px; border-top:1px solid #e0e0e0; text-align:center;">
  <p style="margin:0; font-size:12px; color:#999;">Nexo-mail — LinkedIn token alert</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const healthResult = await getAccountHealth();

    if (!healthResult.success || !healthResult.data?.expiresAt) {
      return NextResponse.json({
        success: true,
        action: 'skip',
        reason: 'Could not check token expiry',
        timestamp: new Date().toISOString(),
      });
    }

    const expiresAt = new Date(healthResult.data.expiresAt);
    const now = new Date();
    const daysLeft = Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    // Only send email if 7 days or less
    if (daysLeft > 7) {
      return NextResponse.json({
        success: true,
        action: 'skip',
        reason: `Token OK — ${daysLeft} days left`,
        daysLeft,
        timestamp: new Date().toISOString(),
      });
    }

    // Send alert email
    const html = buildTokenEmail(daysLeft);
    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.sender = { email: 'info@urologia.ar', name: 'LinkedIn ALERTA' };
    sendEmail.to = [{ email: REMINDER_EMAIL }];
    sendEmail.subject = daysLeft <= 0
      ? '🔴 LinkedIn DESCONECTADO — reconectar AHORA'
      : daysLeft <= 1
        ? '🔴 LinkedIn expira MAÑANA — reconectar AHORA'
        : daysLeft <= 3
          ? `🟠 LinkedIn expira en ${daysLeft} días`
          : `🟡 LinkedIn expira en ${daysLeft} días`;
    sendEmail.htmlContent = html;

    await transacApi.sendTransacEmail(sendEmail);

    console.log(`LinkedIn token alert sent: ${daysLeft} days left`);

    return NextResponse.json({
      success: true,
      action: 'alert_sent',
      daysLeft,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn token check error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
