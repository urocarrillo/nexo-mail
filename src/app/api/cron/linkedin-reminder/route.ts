import { NextRequest, NextResponse } from 'next/server';
import * as Brevo from '@getbrevo/brevo';
import { getAccountHealth, listPosts } from '@/lib/linkedin';

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const REMINDER_EMAIL = 'REDACTED_EMAIL@example.com';

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

function buildReminderHtml(
  date: string,
  connectionStatus: string,
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

  const connectionColor = connectionStatus === 'connected' ? '#48c9b0' : '#E67E22';
  const connectionLabel = connectionStatus === 'connected' ? 'Conectado' : connectionStatus;

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

  <!-- Checklist -->
  <h2 style="margin:0 0 12px; font-size:18px; color:#152735; border-bottom:2px solid #5ac8fa; padding-bottom:8px;">Checklist semanal</h2>
  <ul style="padding-left:20px; margin:0 0 24px; list-style:none;">
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">&#9744; Publicar post de video de YouTube de la semana</li>
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">&#9744; Publicar 1 post de know-how o caso clinico</li>
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">&#9744; Revisar metricas de posts anteriores</li>
    <li style="margin-bottom:8px; font-size:15px; color:#313131;">&#9744; Interactuar con comentarios y conexiones</li>
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Verify cron secret (Vercel sets this header for cron jobs)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check required env vars
  if (!process.env.ZERNIO_API_KEY) {
    return NextResponse.json(
      { success: false, error: 'ZERNIO_API_KEY not configured' },
      { status: 500 }
    );
  }

  try {
    // 1. Check connection health and get posts in parallel
    const [healthResult, postsResult] = await Promise.all([
      getAccountHealth(),
      listPosts(),
    ]);

    const connectionStatus = healthResult.success
      ? (healthResult.data?.status || 'unknown')
      : 'error';

    // 2. Count posts this week/month
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

    // 3. Build and send reminder email via Brevo transactional API
    const dateStr = formatDate(now);
    const html = buildReminderHtml(
      dateStr,
      connectionStatus,
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
      `LinkedIn reminder sent: ${postsThisWeek} posts this week, connection: ${connectionStatus}`
    );

    return NextResponse.json({
      success: true,
      connectionStatus,
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
