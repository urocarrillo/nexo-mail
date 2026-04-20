import { NextRequest, NextResponse } from 'next/server';
import * as Brevo from '@getbrevo/brevo';
import { getAccountHealth, listPosts } from '@/lib/linkedin';

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const REMINDER_EMAIL = process.env.APPROVAL_EMAIL || '';

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  BREVO_API_KEY
);

function formatDate(date: Date): string {
  return date.toLocaleDateString('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

function getTokenExpiryWarning(expiresAt: string | undefined): string {
  if (!expiresAt) return '';

  const now = new Date();
  const expiry = new Date(expiresAt);
  const daysLeft = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (daysLeft <= 0) {
    return `<div style="background:#e74c3c; border-radius:8px; padding:20px; margin-bottom:20px; text-align:center;">
      <p style="margin:0 0 8px; font-size:20px; font-weight:700; color:#ffffff;">TOKEN EXPIRADO</p>
      <p style="margin:0 0 16px; font-size:15px; color:#ffffff;">Tu conexion LinkedIn se desconecto. Los posts NO se van a publicar hasta que reconectes.</p>
      <a href="https://zernio.com" style="display:inline-block; background:#ffffff; color:#e74c3c; text-decoration:none; padding:12px 30px; border-radius:30px; font-size:15px; font-weight:700;">Reconectar ahora (30 seg)</a>
      <p style="margin:12px 0 0; font-size:13px; color:#ffffff; opacity:0.8;">Zernio &gt; Connections &gt; LinkedIn &gt; Reconnect &gt; Login</p>
    </div>`;
  }

  if (daysLeft <= 1) {
    return `<div style="background:#e74c3c; border-radius:8px; padding:20px; margin-bottom:20px; text-align:center;">
      <p style="margin:0 0 8px; font-size:20px; font-weight:700; color:#ffffff;">EXPIRA MANANA</p>
      <p style="margin:0 0 16px; font-size:15px; color:#ffffff;">Tu conexion LinkedIn expira manana. Reconecta AHORA o los posts dejaran de publicarse.</p>
      <a href="https://zernio.com" style="display:inline-block; background:#ffffff; color:#e74c3c; text-decoration:none; padding:12px 30px; border-radius:30px; font-size:15px; font-weight:700;">Reconectar ahora (30 seg)</a>
      <p style="margin:12px 0 0; font-size:13px; color:#ffffff; opacity:0.8;">Zernio &gt; Connections &gt; LinkedIn &gt; Reconnect &gt; Login</p>
    </div>`;
  }

  if (daysLeft <= 7) {
    return `<div style="background:#E67E22; border-radius:8px; padding:20px; margin-bottom:20px; text-align:center;">
      <p style="margin:0 0 8px; font-size:18px; font-weight:700; color:#ffffff;">Token expira en ${daysLeft} dias</p>
      <p style="margin:0 0 16px; font-size:15px; color:#ffffff;">Renova la conexion LinkedIn antes de que expire. Son 30 segundos.</p>
      <a href="https://zernio.com" style="display:inline-block; background:#ffffff; color:#E67E22; text-decoration:none; padding:12px 30px; border-radius:30px; font-size:15px; font-weight:700;">Renovar conexion</a>
      <p style="margin:12px 0 0; font-size:13px; color:#ffffff; opacity:0.8;">Zernio &gt; Connections &gt; LinkedIn &gt; Reconnect &gt; Login</p>
    </div>`;
  }

  if (daysLeft <= 14) {
    return `<div style="background:#f8f9fa; border-radius:8px; padding:12px 20px; margin-bottom:20px; border-left:4px solid #E67E22;">
      <p style="margin:0; font-size:14px; color:#666;">Token LinkedIn expira en <strong style="color:#E67E22;">${daysLeft} dias</strong> — <a href="https://zernio.com" style="color:#0077B5;">renovar en Zernio</a> (30 seg)</p>
    </div>`;
  }

  return '';
}

function buildReminderHtml(
  date: string,
  connectionStatus: string,
  tokenWarning: string,
  postsThisWeek: number,
  postsThisMonth: number,
  recentPosts: Array<{ content: string; createdAt: string }>
): string {
  const postsList = recentPosts.length > 0
    ? recentPosts
        .slice(0, 5)
        .map(
          (p) =>
            `<li style="margin-bottom:8px; color:#313131; font-size:15px; line-height:1.5;">${p.content.slice(0, 120)}${p.content.length > 120 ? '...' : ''} <span style="color:#999999; font-size:13px;">(${new Date(p.createdAt).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })})</span></li>`
        )
        .join('')
    : '<li style="color:#999999; font-size:15px;">No hubo publicaciones esta semana.</li>';

  const connectionColor = connectionStatus === 'connected' ? '#48c9b0' : '#e74c3c';
  const connectionLabel = connectionStatus === 'connected' ? 'Conectado' : 'DESCONECTADO';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4; padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:600px; width:100%;">

<!-- Header -->
<tr><td style="background:#152735; padding:24px 30px; text-align:center;">
  <p style="margin:0; font-size:11px; letter-spacing:2px; color:#5ac8fa; text-transform:uppercase;">LinkedIn semanal</p>
  <h1 style="margin:8px 0 0; font-size:22px; color:#ffffff; font-weight:700; line-height:1.3;">Reporte ${date}</h1>
</td></tr>

<!-- Accent line -->
<tr><td style="height:3px; background:linear-gradient(90deg,#5ac8fa,#48c9b0);"></td></tr>

<!-- Body -->
<tr><td style="padding:30px;">

  <!-- TOKEN WARNING (if applicable) -->
  ${tokenWarning}

  <!-- Connection status -->
  <div style="background:#f8f9fa; border-radius:8px; padding:16px 20px; margin-bottom:20px;">
    <p style="margin:0; font-size:14px; color:#666666;">Estado de conexion:
      <strong style="color:${connectionColor};">${connectionLabel}</strong>
    </p>
  </div>

  <!-- Stats -->
  <div style="display:flex; gap:16px; margin-bottom:24px;">
    <div style="background:#f8f9fa; border-radius:8px; padding:16px 20px; flex:1; text-align:center;">
      <p style="margin:0; font-size:28px; font-weight:700; color:#152735;">${postsThisWeek}</p>
      <p style="margin:4px 0 0; font-size:13px; color:#666666;">Esta semana</p>
    </div>
    <div style="background:#f8f9fa; border-radius:8px; padding:16px 20px; flex:1; text-align:center;">
      <p style="margin:0; font-size:28px; font-weight:700; color:#152735;">${postsThisMonth}</p>
      <p style="margin:4px 0 0; font-size:13px; color:#666666;">Este mes</p>
    </div>
  </div>

  <!-- Recent posts -->
  <h2 style="margin:0 0 12px; font-size:18px; color:#152735; border-bottom:2px solid #5ac8fa; padding-bottom:8px;">Publicaciones recientes</h2>
  <ul style="padding-left:20px; margin:0 0 24px;">
    ${postsList}
  </ul>

  <!-- Automatico -->
  <h2 style="margin:0 0 12px; font-size:18px; color:#152735; border-bottom:2px solid #5ac8fa; padding-bottom:8px;">Automatico (revisar en tu email)</h2>
  <ul style="padding-left:20px; margin:0 0 20px; list-style:none;">
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">&#9744; <strong>Post del video</strong> — deberia estar en tu email para aprobar. Si no llego, pedile a Claude: <code>/linkedin-video</code></li>
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">&#9744; <strong>Post extra</strong> — pedile a Claude: <code>/linkedin-extra</code> y te llega otro email para aprobar</li>
  </ul>

  <!-- Manual (2 min) -->
  <h2 style="margin:0 0 12px; font-size:18px; color:#152735; border-bottom:2px solid #5ac8fa; padding-bottom:8px;">Manual — 2 minutos</h2>
  <ul style="padding-left:20px; margin:0 0 20px; list-style:none;">
    <li style="margin-bottom:12px; font-size:15px; color:#313131;">&#9744; <strong>Newsletter</strong> (1x/mes) — Abri LinkedIn &gt; Escribir articulo &gt; Newsletter &gt; Pega el texto del ultimo blog de <a href="https://urologia.ar/blog/" style="color:#0077B5;">urologia.ar/blog</a></li>
    <li style="margin-bottom:12px; font-size:15px; color:#313131;">&#9744; <strong>Carousel PDF</strong> (1x/mes) — Abri LinkedIn &gt; Crear post &gt; Documento &gt; Subi el PDF de <code>08-Raptor/carousels/</code></li>
    <li style="margin-bottom:12px; font-size:15px; color:#313131;">&#9744; <strong>Commenting</strong> (5 min) — Busca 2-3 posts de empresas de salud o healthtech y deja un comentario inteligente</li>
  </ul>

</td></tr>

<!-- Footer -->
<tr><td style="padding:20px 30px; border-top:1px solid #e0e0e0; text-align:center;">
  <p style="margin:0; font-size:13px; color:#999999;">
    Nexo-mail &mdash; Reporte automatico LinkedIn
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildUrgentTokenEmail(daysLeft: number): string {
  const isExpired = daysLeft <= 0;
  const bgColor = isExpired ? '#e74c3c' : '#E67E22';
  const title = isExpired ? 'LinkedIn DESCONECTADO' : `LinkedIn expira en ${daysLeft} dia${daysLeft === 1 ? '' : 's'}`;
  const subtitle = isExpired
    ? 'Los posts de LinkedIn NO se van a publicar hasta que reconectes.'
    : 'Reconecta ahora para que tus posts se sigan publicando.';

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
  <p style="margin:0; font-size:12px; color:#999;">Nexo-mail — LinkedIn automation</p>
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

  if (!process.env.ZERNIO_API_KEY) {
    return NextResponse.json(
      { success: false, error: 'ZERNIO_API_KEY not configured' },
      { status: 500 }
    );
  }

  try {
    const [healthResult, postsResult] = await Promise.all([
      getAccountHealth(),
      listPosts(),
    ]);

    const connectionStatus = healthResult.success
      ? (healthResult.data?.status || 'unknown')
      : 'error';

    const tokenExpiresAt = healthResult.data?.expiresAt;

    // Count posts this week/month
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let postsThisWeek = 0;
    let postsThisMonth = 0;
    const recentPosts: Array<{ content: string; createdAt: string }> = [];

    if (postsResult.success && postsResult.data) {
      for (const post of postsResult.data) {
        const postDate = new Date(post.createdAt);
        if (postDate >= startOfWeek) {
          postsThisWeek++;
          recentPosts.push({ content: post.content, createdAt: post.createdAt });
        }
        if (postDate >= startOfMonth) postsThisMonth++;
      }
    }

    // Check token expiry
    const tokenWarning = getTokenExpiryWarning(tokenExpiresAt);
    let daysUntilExpiry = -1;
    if (tokenExpiresAt) {
      daysUntilExpiry = Math.floor((new Date(tokenExpiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Send urgent standalone email if token expiring in 7 days, 3 days, or 1 day
    // (separate from the weekly reminder, so it's impossible to miss)
    let urgentEmailSent = false;
    if (daysUntilExpiry >= 0 && daysUntilExpiry <= 7) {
      const urgentHtml = buildUrgentTokenEmail(daysUntilExpiry);
      const urgentEmail = new Brevo.SendSmtpEmail();
      urgentEmail.sender = { email: 'info@urologia.ar', name: 'LinkedIn URGENTE' };
      urgentEmail.to = [{ email: REMINDER_EMAIL }];
      urgentEmail.subject = daysUntilExpiry <= 0
        ? '🔴 LinkedIn DESCONECTADO — reconectar ahora'
        : daysUntilExpiry <= 1
          ? '🔴 LinkedIn expira MAÑANA — reconectar ahora'
          : `🟠 LinkedIn expira en ${daysUntilExpiry} días — renovar conexión`;
      urgentEmail.htmlContent = urgentHtml;

      await transacApi.sendTransacEmail(urgentEmail);
      urgentEmailSent = true;
      console.log(`URGENT LinkedIn token email sent: ${daysUntilExpiry} days left`);
    }

    // Send weekly reminder
    const dateStr = formatDate(now);
    const html = buildReminderHtml(
      dateStr,
      connectionStatus,
      tokenWarning,
      postsThisWeek,
      postsThisMonth,
      recentPosts
    );

    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.sender = { email: 'info@urologia.ar', name: 'Nexo-mail' };
    sendEmail.to = [{ email: REMINDER_EMAIL }];
    sendEmail.subject = `LinkedIn esta semana — ${dateStr}`;
    sendEmail.htmlContent = html;

    const emailResult = await transacApi.sendTransacEmail(sendEmail);

    console.log(
      `LinkedIn reminder sent: ${postsThisWeek} posts this week, connection: ${connectionStatus}, token days left: ${daysUntilExpiry}`
    );

    return NextResponse.json({
      success: true,
      connectionStatus,
      tokenDaysLeft: daysUntilExpiry,
      urgentEmailSent,
      postsThisWeek,
      postsThisMonth,
      emailSent: true,
      messageId: emailResult.body?.messageId,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn reminder cron error:', msg);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
