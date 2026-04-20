import { NextRequest, NextResponse } from 'next/server';
import * as Brevo from '@getbrevo/brevo';

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const UMAMI_URL = process.env.UMAMI_API_URL || 'https://umami-urologia.vercel.app';
const UMAMI_USERNAME = process.env.UMAMI_USERNAME || '';
const UMAMI_PASSWORD = process.env.UMAMI_PASSWORD || '';
const UMAMI_WEBSITE_ID = process.env.UMAMI_WEBSITE_ID || '';
const REPORT_EMAIL = process.env.APPROVAL_EMAIL || '';

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  BREVO_API_KEY
);

// --- Umami API helpers ---

async function getUmamiToken(): Promise<string> {
  const res = await fetch(`${UMAMI_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: UMAMI_USERNAME, password: UMAMI_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Umami login failed: ${res.status}`);
  const data = await res.json();
  return data.token;
}

async function getStats(token: string, startAt: number, endAt: number) {
  const res = await fetch(
    `${UMAMI_URL}/api/websites/${UMAMI_WEBSITE_ID}/stats?startAt=${startAt}&endAt=${endAt}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Umami stats failed: ${res.status}`);
  return res.json();
}

async function getMetrics(token: string, startAt: number, endAt: number, type: string, limit = 10) {
  const res = await fetch(
    `${UMAMI_URL}/api/websites/${UMAMI_WEBSITE_ID}/metrics?startAt=${startAt}&endAt=${endAt}&type=${type}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Umami metrics (${type}) failed: ${res.status}`);
  return res.json();
}

// --- Date helpers ---

function getWeekRange(weeksAgo: number): { start: number; end: number } {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const endDate = new Date(now);
  endDate.setDate(now.getDate() - dayOfWeek - 7 * weeksAgo);
  endDate.setHours(23, 59, 59, 999);

  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - 6);
  startDate.setHours(0, 0, 0, 0);

  return { start: startDate.getTime(), end: endDate.getTime() };
}

function formatNumber(n: number): string {
  return n.toLocaleString('es-AR');
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('es-AR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

function changeIndicator(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? '<span style="color:#48c9b0;">&#9650; nuevo</span>' : '';
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct > 0) return `<span style="color:#48c9b0;">&#9650; ${pct}%</span>`;
  if (pct < 0) return `<span style="color:#E67E22;">&#9660; ${Math.abs(pct)}%</span>`;
  return '<span style="color:#999999;">= igual</span>';
}

// --- Email builder ---

function buildReportHtml(
  dateRange: string,
  stats: { pageviews: number; visitors: number; visits: number; bounces: number; totaltime: number },
  prevStats: { pageviews: number; visitors: number; visits: number; bounces: number; totaltime: number },
  topPages: Array<{ x: string; y: number }>,
  topReferrers: Array<{ x: string; y: number }>,
): string {
  const bounceRate = stats.visits > 0 ? Math.round((stats.bounces / stats.visits) * 100) : 0;
  const avgTime = stats.visits > 0 ? Math.round(stats.totaltime / stats.visits) : 0;
  const avgMinutes = Math.floor(avgTime / 60);
  const avgSeconds = avgTime % 60;

  const pagesHtml = topPages.length > 0
    ? topPages
        .map((p, i) => {
          const path = p.x || '(home)';
          const label = path.length > 45 ? path.slice(0, 45) + '...' : path;
          const bg = i % 2 === 0 ? '#f8f9fa' : '#ffffff';
          return `<tr style="background:${bg};">
            <td style="padding:8px 12px; font-size:14px; color:#313131; border-bottom:1px solid #eee;">${label}</td>
            <td style="padding:8px 12px; font-size:14px; color:#152735; font-weight:600; text-align:right; border-bottom:1px solid #eee;">${formatNumber(p.y)}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="2" style="padding:12px; color:#999;">Sin datos esta semana</td></tr>';

  const referrersHtml = topReferrers.length > 0
    ? topReferrers
        .filter((r) => r.x) // exclude direct/none
        .slice(0, 7)
        .map((r) => {
          const source = r.x.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const label = source.length > 40 ? source.slice(0, 40) + '...' : source;
          return `<li style="margin-bottom:6px; font-size:14px; color:#313131;">${label} — <strong>${formatNumber(r.y)}</strong></li>`;
        })
        .join('')
    : '<li style="color:#999;">Sin referrers esta semana</li>';

  const directVisits = topReferrers.find((r) => !r.x);
  const directCount = directVisits ? directVisits.y : 0;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4; padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:600px; width:100%;">

<!-- Header -->
<tr><td style="background:#152735; padding:24px 30px; text-align:center;">
  <p style="margin:0; font-size:11px; letter-spacing:2px; color:#5ac8fa; text-transform:uppercase;">Analytics semanal</p>
  <h1 style="margin:8px 0 0; font-size:22px; color:#ffffff; font-weight:700; line-height:1.3;">urologia.ar &mdash; ${dateRange}</h1>
</td></tr>

<!-- Accent line -->
<tr><td style="height:3px; background:linear-gradient(90deg,#5ac8fa,#48c9b0);"></td></tr>

<!-- Stats cards -->
<tr><td style="padding:24px 30px 0;">
  <table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td width="33%" style="text-align:center; padding:12px 8px; background:#f8f9fa; border-radius:8px 0 0 8px;">
      <p style="margin:0; font-size:28px; font-weight:700; color:#152735;">${formatNumber(stats.visitors)}</p>
      <p style="margin:4px 0 2px; font-size:12px; color:#666666;">Visitantes</p>
      <p style="margin:0; font-size:12px;">${changeIndicator(stats.visitors, prevStats.visitors)}</p>
    </td>
    <td width="34%" style="text-align:center; padding:12px 8px; background:#f8f9fa;">
      <p style="margin:0; font-size:28px; font-weight:700; color:#152735;">${formatNumber(stats.pageviews)}</p>
      <p style="margin:4px 0 2px; font-size:12px; color:#666666;">Pageviews</p>
      <p style="margin:0; font-size:12px;">${changeIndicator(stats.pageviews, prevStats.pageviews)}</p>
    </td>
    <td width="33%" style="text-align:center; padding:12px 8px; background:#f8f9fa; border-radius:0 8px 8px 0;">
      <p style="margin:0; font-size:28px; font-weight:700; color:#152735;">${avgMinutes}:${String(avgSeconds).padStart(2, '0')}</p>
      <p style="margin:4px 0 2px; font-size:12px; color:#666666;">Tiempo prom.</p>
      <p style="margin:0; font-size:12px;">${bounceRate}% rebote</p>
    </td>
  </tr>
  </table>
</td></tr>

<!-- Top pages -->
<tr><td style="padding:24px 30px 0;">
  <h2 style="margin:0 0 12px; font-size:18px; color:#152735; border-bottom:2px solid #5ac8fa; padding-bottom:8px;">Paginas mas visitadas</h2>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px; overflow:hidden;">
    <tr style="background:#152735;">
      <td style="padding:8px 12px; font-size:13px; color:#ffffff; font-weight:600;">Pagina</td>
      <td style="padding:8px 12px; font-size:13px; color:#ffffff; font-weight:600; text-align:right;">Visitas</td>
    </tr>
    ${pagesHtml}
  </table>
</td></tr>

<!-- Referrers -->
<tr><td style="padding:24px 30px 0;">
  <h2 style="margin:0 0 12px; font-size:18px; color:#152735; border-bottom:2px solid #5ac8fa; padding-bottom:8px;">De donde vienen</h2>
  ${directCount > 0 ? `<p style="margin:0 0 8px; font-size:14px; color:#666;">Trafico directo: <strong style="color:#152735;">${formatNumber(directCount)}</strong> visitas</p>` : ''}
  <ul style="padding-left:20px; margin:0 0 16px;">
    ${referrersHtml}
  </ul>
</td></tr>

<!-- CTA -->
<tr><td style="padding:20px 30px 24px; text-align:center;">
  <a href="https://umami-urologia.vercel.app" style="display:inline-block; background:#E67E22; color:#ffffff; padding:12px 32px; border-radius:30px; text-decoration:none; font-size:15px; font-weight:600;">Ver dashboard completo</a>
</td></tr>

<!-- Footer -->
<tr><td style="padding:16px 30px; border-top:1px solid #e0e0e0; text-align:center;">
  <p style="margin:0; font-size:13px; color:#999999;">
    Nexo-mail &mdash; Reporte automatico de analytics
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// --- Main handler ---

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!UMAMI_USERNAME || !UMAMI_PASSWORD || !UMAMI_WEBSITE_ID) {
    return NextResponse.json(
      { success: false, error: 'Umami env vars not configured' },
      { status: 500 }
    );
  }

  try {
    // 1. Auth with Umami
    const token = await getUmamiToken();

    // 2. Get this week and last week ranges
    const thisWeek = getWeekRange(0);
    const lastWeek = getWeekRange(1);

    // 3. Fetch all data in parallel
    const [stats, prevStats, topPages, topReferrers] = await Promise.all([
      getStats(token, thisWeek.start, thisWeek.end),
      getStats(token, lastWeek.start, lastWeek.end),
      getMetrics(token, thisWeek.start, thisWeek.end, 'path', 10),
      getMetrics(token, thisWeek.start, thisWeek.end, 'referrer', 15),
    ]);

    // 4. Build date range label
    const startLabel = formatDate(new Date(thisWeek.start));
    const endLabel = formatDate(new Date(thisWeek.end));
    const dateRange = `${startLabel} — ${endLabel}`;

    // 5. Build and send email
    const html = buildReportHtml(dateRange, stats, prevStats, topPages, topReferrers);

    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.sender = { email: 'info@urologia.ar', name: 'Analytics urologia.ar' };
    sendEmail.to = [{ email: REPORT_EMAIL }];
    sendEmail.subject = `Analytics semanal — ${formatNumber(stats.visitors)} visitantes, ${formatNumber(stats.pageviews)} pageviews`;
    sendEmail.htmlContent = html;

    const emailResult = await transacApi.sendTransacEmail(sendEmail);

    console.log(`Weekly analytics sent: ${stats.visitors} visitors, ${stats.pageviews} pageviews`);

    return NextResponse.json({
      success: true,
      stats: {
        visitors: stats.visitors,
        pageviews: stats.pageviews,
        visits: stats.visits,
        bounceRate: stats.visits > 0 ? Math.round((stats.bounces / stats.visits) * 100) : 0,
      },
      topPages: topPages.slice(0, 5).map((p: { x: string; y: number }) => `${p.x}: ${p.y}`),
      emailSent: true,
      messageId: emailResult.body?.messageId,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Weekly analytics cron error:', msg);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
