import { NextRequest, NextResponse } from 'next/server';
import * as Brevo from '@getbrevo/brevo';
import { publishPost } from '@/lib/linkedin';

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || '';
const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const APPROVAL_EMAIL = 'REDACTED_EMAIL@example.com';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

async function getPostContent(postId: string): Promise<string | null> {
  try {
    const res = await fetch(`${ZERNIO_BASE_URL}/posts/${postId}`, {
      headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.post?.content || data.content || null;
  } catch {
    return null;
  }
}

async function deletePost(postId: string): Promise<void> {
  await fetch(`${ZERNIO_BASE_URL}/posts/${postId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` },
  });
}

// GET: Show edit form with current post content
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const postId = searchParams.get('postId');
  const token = searchParams.get('token');

  if (!token || token !== process.env.API_SECRET_KEY) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (!postId) {
    return new NextResponse('Missing postId', { status: 400 });
  }

  const content = await getPostContent(postId);
  if (!content) {
    return new NextResponse('Post not found', { status: 404 });
  }

  const escapedContent = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return new NextResponse(
    `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Editar post LinkedIn</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:#f4f4f4; font-family:Arial,sans-serif; }
  .container { max-width:600px; margin:0 auto; background:#fff; border-radius:12px; padding:30px; box-shadow:0 2px 12px rgba(0,0,0,0.1); }
  h1 { margin:0 0 8px; font-size:22px; color:#152735; }
  p.sub { margin:0 0 20px; font-size:14px; color:#666; }
  textarea { width:100%; min-height:300px; padding:16px; border:2px solid #e0e0e0; border-radius:8px; font-family:Arial,sans-serif; font-size:15px; line-height:1.6; color:#313131; resize:vertical; }
  textarea:focus { outline:none; border-color:#0077B5; }
  .counter { text-align:right; font-size:13px; color:#999; margin:4px 0 20px; }
  .counter.warn { color:#E67E22; }
  .counter.over { color:#e74c3c; }
  button { display:block; width:100%; background:#0077B5; color:#fff; border:none; padding:14px; border-radius:30px; font-size:16px; font-weight:700; cursor:pointer; }
  button:hover { background:#005f8f; }
  button:disabled { background:#ccc; cursor:not-allowed; }
  .info { margin-top:16px; font-size:13px; color:#999; text-align:center; }
</style>
</head>
<body>
<div class="container">
  <h1>Editar post LinkedIn</h1>
  <p class="sub">Modifica el texto y envialo. Se creara un nuevo draft para tu aprobacion.</p>

  <form method="POST" action="${BASE_URL}/api/linkedin/edit">
    <input type="hidden" name="postId" value="${postId}">
    <input type="hidden" name="token" value="${token}">
    <textarea id="content" name="content">${escapedContent}</textarea>
    <div class="counter" id="counter">0 / 3000</div>
    <button type="submit" id="submitBtn">Enviar version editada</button>
  </form>

  <p class="info">Al enviar se crea un nuevo draft y recibis un email para aprobar la version final.</p>
</div>

<script>
const ta = document.getElementById('content');
const counter = document.getElementById('counter');
const btn = document.getElementById('submitBtn');

function update() {
  const len = ta.value.length;
  counter.textContent = len + ' / 3000';
  counter.className = 'counter' + (len > 2500 ? (len > 3000 ? ' over' : ' warn') : '');
  btn.disabled = len === 0 || len > 3000;
}

ta.addEventListener('input', update);
update();
</script>
</body>
</html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}

// POST: Receive edited content, create new draft, send approval email
export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData();
  const postId = formData.get('postId') as string;
  const token = formData.get('token') as string;
  const content = (formData.get('content') as string)?.trim();

  if (!token || token !== process.env.API_SECRET_KEY) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (!postId || !content) {
    return new NextResponse('Missing data', { status: 400 });
  }

  if (content.length > 3000) {
    return new NextResponse('Post too long (max 3000 chars)', { status: 400 });
  }

  try {
    // 1. Delete old draft
    await deletePost(postId);

    // 2. Create new draft with edited content
    const draftResult = await publishPost(content, false);
    if (!draftResult.success || !draftResult.data) {
      return new NextResponse('Failed to create draft', { status: 502 });
    }

    const newPostId = draftResult.data.id;

    // 3. Build and send approval email (reuse the template from regenerate)
    const approveUrl = `${BASE_URL}/api/linkedin/approve?postId=${newPostId}&token=${process.env.API_SECRET_KEY}`;
    const cercanoUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${newPostId}&token=${process.env.API_SECRET_KEY}&tone=cercano`;
    const profesionalUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${newPostId}&token=${process.env.API_SECRET_KEY}&tone=profesional`;
    const datosUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${newPostId}&token=${process.env.API_SECRET_KEY}&tone=datos`;
    const rejectUrl = `${BASE_URL}/api/linkedin/reject?postId=${newPostId}&token=${process.env.API_SECRET_KEY}`;
    const editUrl = `${BASE_URL}/api/linkedin/edit?postId=${newPostId}&token=${process.env.API_SECRET_KEY}`;
    const previewContent = content.replace(/\n/g, '<br>');

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
<tr><td style="background:#0077B5;padding:24px 30px;text-align:center;">
  <p style="margin:0;font-size:11px;letter-spacing:2px;color:#fff;opacity:0.8;text-transform:uppercase;">LinkedIn Post</p>
  <h1 style="margin:8px 0 0;font-size:20px;color:#fff;font-weight:700;">Tu version editada <span style="background:#E67E22;padding:2px 10px;border-radius:12px;font-size:12px;">editado</span></h1>
</td></tr>
<tr><td style="padding:30px;">
  <div style="background:#f8f9fa;border-radius:8px;padding:20px;margin-bottom:20px;border-left:4px solid #E67E22;">
    <p style="margin:0;font-size:15px;color:#313131;line-height:1.6;">${previewContent}</p>
  </div>
  <p style="margin:0 0 20px;font-size:14px;color:#666;">Al aprobar se programa para el proximo martes, miercoles o jueves a las 9:00 AM.</p>
  <div style="text-align:center;margin-bottom:16px;">
    <a href="${approveUrl}" style="display:inline-block;background:#0077B5;color:#fff;text-decoration:none;padding:14px 36px;border-radius:30px;font-size:16px;font-weight:700;">Aprobar y programar</a>
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  <tr>
    <td width="33%" style="padding:4px;text-align:center;"><a href="${cercanoUrl}" style="display:block;background:#48c9b0;color:#fff;text-decoration:none;padding:10px 8px;border-radius:6px;font-size:13px;font-weight:600;">Mas cercano</a></td>
    <td width="33%" style="padding:4px;text-align:center;"><a href="${profesionalUrl}" style="display:block;background:#152735;color:#fff;text-decoration:none;padding:10px 8px;border-radius:6px;font-size:13px;font-weight:600;">Mas profesional</a></td>
    <td width="33%" style="padding:4px;text-align:center;"><a href="${datosUrl}" style="display:block;background:#5ac8fa;color:#fff;text-decoration:none;padding:10px 8px;border-radius:6px;font-size:13px;font-weight:600;">Revisar datos</a></td>
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="50%" style="padding:4px;text-align:center;"><a href="${editUrl}" style="display:block;background:#E67E22;color:#fff;text-decoration:none;padding:10px 8px;border-radius:6px;font-size:13px;font-weight:600;">Editar yo</a></td>
    <td width="50%" style="padding:4px;text-align:center;"><a href="${rejectUrl}" style="display:block;background:#e0e0e0;color:#666;text-decoration:none;padding:10px 8px;border-radius:6px;font-size:13px;font-weight:600;">Rechazar</a></td>
  </tr></table>
</td></tr>
<tr><td style="padding:12px 30px;border-top:1px solid #e0e0e0;text-align:center;">
  <p style="margin:0;font-size:12px;color:#999;">Nexo-mail — LinkedIn automation</p>
</td></tr>
</table></td></tr></table></body></html>`;

    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.sender = { email: 'info@urologia.ar', name: 'LinkedIn Post' };
    sendEmail.to = [{ email: APPROVAL_EMAIL }];
    sendEmail.subject = `LinkedIn [editado]: "${content.slice(0, 50)}..."`;
    sendEmail.htmlContent = html;

    await transacApi.sendTransacEmail(sendEmail);

    return new NextResponse(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Enviado</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;">
<div style="background:#fff;border-radius:12px;padding:40px;max-width:500px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.1);">
  <div style="width:64px;height:64px;background:#E67E22;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;">
    <span style="color:#fff;font-size:28px;">&#9998;</span>
  </div>
  <h1 style="margin:0 0 12px;font-size:24px;color:#152735;">Version enviada</h1>
  <p style="margin:0;font-size:16px;color:#666;">Revisá tu email para aprobar la version editada.</p>
</div></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn edit error:', msg);
    return new NextResponse(`Error: ${msg}`, { status: 500 });
  }
}
