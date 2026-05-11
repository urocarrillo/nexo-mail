import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import * as Brevo from '@getbrevo/brevo';
import { BS_TOPICS } from '@/lib/bs-topics';

export const maxDuration = 30;

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const APPROVAL_EMAIL = process.env.APPROVAL_EMAIL || '';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';
const TOPIC_INDEX_KEY = 'bs:weekly_topic_index';

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

async function selectNextTopic() {
  let lastIndex = -1;
  try {
    const stored = await kv.get<number>(TOPIC_INDEX_KEY);
    if (typeof stored === 'number') lastIndex = stored;
  } catch (err) {
    console.error('KV read error (falling back to 0):', err);
  }
  const newIndex = (lastIndex + 1) % BS_TOPICS.length;
  return { topic: BS_TOPICS[newIndex], newIndex };
}

function buildEmail(topicId: string, label: string, questions: string[]): string {
  const submitUrl = `${BASE_URL}/api/bs/submit`;
  const token = process.env.API_SECRET_KEY || '';

  const questionFields = questions
    .map(
      (q, i) => `
    <div style="margin-bottom:18px;">
      <label style="display:block; font-size:14px; font-weight:600; color:#152735; margin-bottom:6px;">${i + 1}. ${q}</label>
      <textarea name="q${i}" rows="3" style="width:100%; padding:10px; border:1px solid #d0d0d0; border-radius:6px; font-family:Arial,sans-serif; font-size:14px; box-sizing:border-box;" placeholder="Tu respuesta (podés dejar en blanco si no aplica)"></textarea>
      <input type="hidden" name="q${i}_text" value="${q.replace(/"/g, '&quot;')}">
    </div>`
    )
    .join('');

  // Email-friendly form: action posts to submit endpoint which renders a thank-you page.
  const formHtml = `
<form action="${submitUrl}" method="POST" style="background:#f8f9fa; padding:20px; border-radius:8px; margin-top:10px;">
  <input type="hidden" name="topicId" value="${topicId}">
  <input type="hidden" name="token" value="${token}">
  ${questionFields}
  <div style="text-align:center; margin-top:24px;">
    <button type="submit" style="background:#0077B5; color:#ffffff; border:none; padding:14px 36px; border-radius:30px; font-size:16px; font-weight:700; cursor:pointer;">Generar post con esto</button>
  </div>
</form>`;

  // Fallback link: many email clients block form submission. Open in browser.
  const browserUrl = `${BASE_URL}/api/bs/form?topicId=${encodeURIComponent(topicId)}&token=${encodeURIComponent(token)}`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4; padding:20px 0;">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:640px; width:100%;">

<tr><td style="background:#152735; padding:24px 30px; text-align:center;">
  <p style="margin:0; font-size:11px; letter-spacing:2px; color:#5ac8fa; opacity:0.9; text-transform:uppercase;">Behind the scenes — Mini entrevista</p>
  <h1 style="margin:8px 0 0; font-size:22px; color:#ffffff; font-weight:700;">${label}</h1>
</td></tr>

<tr><td style="padding:24px 30px 8px;">
  <p style="margin:0 0 14px; font-size:15px; color:#313131; line-height:1.6;">Respondé con frases cortas y datos reales. Lo que escribas se guarda en el dossier para alimentar posts futuros (cada vez con más contexto tuyo, menos invención del modelo).</p>
  <p style="margin:0 0 14px; font-size:13px; color:#666; line-height:1.5;">Si una pregunta no aplica esta semana, dejala vacía. Mejor 2 respuestas reales que 5 inventadas.</p>
  <p style="margin:0 0 14px; font-size:13px; color:#999; line-height:1.5;">Si tu cliente de email no envía el form, abrilo en el navegador:<br><a href="${browserUrl}" style="color:#0077B5;">${browserUrl}</a></p>
</td></tr>

<tr><td style="padding:0 30px 30px;">
  ${formHtml}
</td></tr>

<tr><td style="padding:12px 30px; border-top:1px solid #e0e0e0; text-align:center;">
  <p style="margin:0; font-size:12px; color:#999;">Nexo-mail — Behind the scenes interview</p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const apiSecret = process.env.API_SECRET_KEY;
  const { searchParams } = new URL(request.url);
  const manualToken = searchParams.get('token');

  const bearerOk = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const tokenOk = apiSecret && manualToken === apiSecret;
  if (!bearerOk && !tokenOk) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!BREVO_API_KEY || !APPROVAL_EMAIL) {
    return NextResponse.json(
      { success: false, error: 'BREVO_API_KEY or APPROVAL_EMAIL not configured' },
      { status: 500 }
    );
  }

  try {
    const { topic, newIndex } = await selectNextTopic();
    const html = buildEmail(topic.id, topic.label, topic.questions);

    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.subject = `Behind the scenes: ${topic.label}`;
    sendEmail.htmlContent = html;
    sendEmail.sender = { email: 'info@urologia.ar', name: 'Behind the scenes' };
    sendEmail.to = [{ email: APPROVAL_EMAIL }];

    await transacApi.sendTransacEmail(sendEmail);

    try {
      await kv.set(TOPIC_INDEX_KEY, newIndex);
    } catch (err) {
      console.error('KV write error (index not saved):', err);
    }

    console.log(`bs-weekly-interview sent: ${topic.id} (#${newIndex})`);
    return NextResponse.json({
      success: true,
      topic: topic.id,
      index: newIndex,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('bs-weekly-interview error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
