import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import * as Brevo from '@getbrevo/brevo';
import { publishPost } from '@/lib/linkedin';
import { LINKEDIN_SYSTEM_PROMPT } from '@/lib/linkedin-prompts';

export const maxDuration = 30;

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || '';
const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
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

function buildEditSystemPrompt(): string {
  return `${LINKEDIN_SYSTEM_PROMPT}

=== TAREA ESPECÍFICA: EDITOR DE POSTS ===

Vas a recibir un post original + una instrucción puntual del usuario. Tu trabajo es aplicar EXACTAMENTE lo que pide, manteniendo todo lo demás igual.

PRIORIDAD ABSOLUTA: las reglas críticas del system ganan sobre la instrucción del usuario. Si la instrucción te pide algo que rompe una regla (ej: "agregá una cita a Uloko 2023"), aplicá el espíritu de la instrucción pero respetando la regla (en el ejemplo: agregá el dato sin citar al autor).

Corré el checklist auto-review sobre el resultado final. Si algún check falla, corregí antes de devolver.`;
}

// GET: Show form with post preview + textarea for custom instruction
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

  const previewContent = content.replace(/\n/g, '<br>');

  return new NextResponse(
    `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Modificación puntual</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif; color:#313131; }
  .container { max-width:640px; margin:0 auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.1); }
  .header { background:#152735; padding:24px 30px; color:#fff; }
  .header p { margin:0; font-size:11px; letter-spacing:2px; color:#5ac8fa; text-transform:uppercase; }
  .header h1 { margin:8px 0 0; font-size:22px; font-weight:700; }
  .accent { height:3px; background:linear-gradient(90deg,#5ac8fa,#6c5ce7); }
  .body { padding:24px 30px; }
  h2 { margin:0 0 12px; font-size:15px; color:#666; text-transform:uppercase; letter-spacing:1px; font-weight:600; }
  .preview { background:#f8f9fa; border-left:4px solid #0077B5; border-radius:8px; padding:18px 20px; margin-bottom:24px; font-size:14px; line-height:1.6; color:#313131; max-height:260px; overflow-y:auto; }
  .examples { background:#eefaf6; border-left:4px solid #48c9b0; border-radius:8px; padding:14px 18px; margin-bottom:16px; font-size:13px; color:#555; line-height:1.6; }
  .examples strong { color:#313131; }
  textarea { width:100%; min-height:140px; padding:14px; border:2px solid #e0e0e0; border-radius:8px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:1.5; color:#313131; resize:vertical; }
  textarea:focus { outline:none; border-color:#6c5ce7; }
  .counter { text-align:right; font-size:13px; color:#999; margin:6px 0 20px; }
  button { display:block; width:100%; background:#6c5ce7; color:#fff; border:none; padding:14px; border-radius:30px; font-size:16px; font-weight:700; cursor:pointer; transition:background 0.15s; }
  button:hover { background:#5748d1; }
  button:disabled { background:#ccc; cursor:not-allowed; }
  .loading { display:none; text-align:center; padding:20px; color:#666; font-size:14px; }
  .info { margin-top:14px; font-size:13px; color:#999; text-align:center; line-height:1.5; }
  .warn { background:#fef6ee; border-left:4px solid #E67E22; border-radius:8px; padding:12px 16px; margin-bottom:20px; font-size:13px; color:#555; line-height:1.5; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <p>LinkedIn Post</p>
    <h1>Modificación puntual</h1>
  </div>
  <div class="accent"></div>
  <div class="body">

    <h2>Post actual</h2>
    <div class="preview">${previewContent}</div>

    <h2>Qué querés cambiar</h2>
    <div class="examples">
      <strong>Ejemplos:</strong><br>
      • "Sacá la mención a Zaviacic en 2000."<br>
      • "El hook no me convence, probá uno más directo."<br>
      • "Cambiá 'como urólogo' por algo menos autoritativo."<br>
      • "Reemplazá el párrafo de los 8000 axones por una frase general."<br>
      • "La pregunta final está floja, probá otra."
    </div>
    <div class="warn">
      El sistema aplica tu instrucción respetando las reglas de siempre (no citas de papers, no autoridad clínica inventada, no datos inventados, etc.).
    </div>

    <form id="editForm" method="POST" action="${BASE_URL}/api/linkedin/custom-edit">
      <input type="hidden" name="postId" value="${postId}">
      <input type="hidden" name="token" value="${token}">
      <input type="hidden" name="originalContent" value="${escapedContent}">
      <textarea id="instruction" name="instruction" placeholder="Escribí acá qué cambiar, con el detalle que quieras..." required></textarea>
      <div class="counter" id="counter">0 caracteres</div>
      <button type="submit" id="submitBtn" disabled>Aplicar cambio</button>
      <div class="loading" id="loading">Aplicando cambio... esto puede tardar 10 segundos.</div>
    </form>

    <p class="info">Se genera una nueva versión y te llega un email para aprobarla.<br>Si no te convence, podés pedir otra modificación desde ese email.</p>
  </div>
</div>

<script>
const ta = document.getElementById('instruction');
const counter = document.getElementById('counter');
const btn = document.getElementById('submitBtn');
const form = document.getElementById('editForm');
const loading = document.getElementById('loading');

function update() {
  const len = ta.value.trim().length;
  counter.textContent = len + ' caracteres';
  btn.disabled = len < 5;
}
ta.addEventListener('input', update);
update();

form.addEventListener('submit', function() {
  btn.style.display = 'none';
  loading.style.display = 'block';
});
</script>
</body>
</html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}

// POST: Apply custom instruction with Claude, create new draft, send approval email
export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData();
  const postId = formData.get('postId') as string;
  const token = formData.get('token') as string;
  const instruction = (formData.get('instruction') as string)?.trim();
  const originalContent = (formData.get('originalContent') as string)?.trim();

  if (!token || token !== process.env.API_SECRET_KEY) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (!postId || !instruction) {
    return new NextResponse('Missing data', { status: 400 });
  }

  if (instruction.length > 2000) {
    return new NextResponse('Instruction too long (max 2000 chars)', { status: 400 });
  }

  try {
    // 1. Get current content (prefer originalContent from form, fallback to Zernio)
    const content = originalContent || (await getPostContent(postId));
    if (!content) {
      return new NextResponse('Post not found', { status: 404 });
    }

    // 2. Apply custom instruction with Claude
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: buildEditSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: `Post original:\n\n${content}\n\n---\n\nInstrucción puntual del usuario:\n\n${instruction}\n\nAplicá el cambio pedido, manteniendo todo lo demás igual. Corré el checklist auto-review. Devolvé SOLO el post modificado.`,
        },
      ],
    });

    const newContent = (message.content[0] as { type: string; text: string }).text.trim();

    // 3. Delete old draft
    await deletePost(postId);

    // 4. Create new draft
    const draftResult = await publishPost(newContent, false);
    if (!draftResult.success || !draftResult.data) {
      return new NextResponse('Failed to create new draft', { status: 502 });
    }

    const newPostId = draftResult.data.id;

    // 5. Build approval email
    const approveUrl = `${BASE_URL}/api/linkedin/approve?postId=${newPostId}&token=${process.env.API_SECRET_KEY}`;
    const cercanoUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${newPostId}&token=${process.env.API_SECRET_KEY}&tone=cercano`;
    const profesionalUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${newPostId}&token=${process.env.API_SECRET_KEY}&tone=profesional`;
    const datosUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${newPostId}&token=${process.env.API_SECRET_KEY}&tone=datos`;
    const reformularUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${newPostId}&token=${process.env.API_SECRET_KEY}&tone=reformular`;
    const customEditUrl = `${BASE_URL}/api/linkedin/custom-edit?postId=${newPostId}&token=${process.env.API_SECRET_KEY}`;
    const rejectUrl = `${BASE_URL}/api/linkedin/reject?postId=${newPostId}&token=${process.env.API_SECRET_KEY}`;
    const editUrl = `${BASE_URL}/api/linkedin/edit?postId=${newPostId}&token=${process.env.API_SECRET_KEY}`;
    const previewContent = newContent.replace(/\n/g, '<br>');
    const instructionPreview = instruction.length > 180 ? instruction.slice(0, 180) + '...' : instruction;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
<tr><td style="background:#0077B5;padding:24px 30px;text-align:center;">
  <p style="margin:0;font-size:11px;letter-spacing:2px;color:#fff;opacity:0.8;text-transform:uppercase;">LinkedIn Post</p>
  <h1 style="margin:8px 0 0;font-size:20px;color:#fff;font-weight:700;">Post modificado <span style="background:#6c5ce7;padding:2px 10px;border-radius:12px;font-size:12px;margin-left:8px;">mod. puntual</span></h1>
</td></tr>
<tr><td style="padding:30px;">
  <div style="background:#eef0ff;border-radius:8px;padding:12px 16px;margin-bottom:16px;border-left:4px solid #6c5ce7;">
    <p style="margin:0 0 4px;font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px;">Tu instrucción:</p>
    <p style="margin:0;font-size:14px;color:#313131;font-style:italic;">${instructionPreview}</p>
  </div>
  <div style="background:#f8f9fa;border-radius:8px;padding:20px;margin-bottom:20px;border-left:4px solid #0077B5;">
    <p style="margin:0;font-size:15px;color:#313131;line-height:1.6;">${previewContent}</p>
  </div>
  <p style="margin:0 0 20px;font-size:14px;color:#666;">Al aprobar se programa para el proximo martes, miercoles o jueves a las 9:00 AM.</p>
  <div style="text-align:center;margin-bottom:16px;">
    <a href="${approveUrl}" style="display:inline-block;background:#0077B5;color:#fff;text-decoration:none;padding:14px 36px;border-radius:30px;font-size:16px;font-weight:700;">Aprobar y programar</a>
  </div>
  <div style="text-align:center;margin-bottom:16px;">
    <a href="${customEditUrl}" style="display:inline-block;background:#6c5ce7;color:#fff;text-decoration:none;padding:12px 28px;border-radius:30px;font-size:14px;font-weight:700;">Otra modificación puntual</a>
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  <tr>
    <td width="25%" style="padding:4px;text-align:center;"><a href="${cercanoUrl}" style="display:block;background:#48c9b0;color:#fff;text-decoration:none;padding:10px 4px;border-radius:6px;font-size:12px;font-weight:600;">Mas cercano</a></td>
    <td width="25%" style="padding:4px;text-align:center;"><a href="${profesionalUrl}" style="display:block;background:#152735;color:#fff;text-decoration:none;padding:10px 4px;border-radius:6px;font-size:12px;font-weight:600;">Mas profesional</a></td>
    <td width="25%" style="padding:4px;text-align:center;"><a href="${datosUrl}" style="display:block;background:#5ac8fa;color:#fff;text-decoration:none;padding:10px 4px;border-radius:6px;font-size:12px;font-weight:600;">Revisar datos</a></td>
    <td width="25%" style="padding:4px;text-align:center;"><a href="${reformularUrl}" style="display:block;background:#9b59b6;color:#fff;text-decoration:none;padding:10px 4px;border-radius:6px;font-size:12px;font-weight:600;">Reformular</a></td>
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
    sendEmail.subject = `LinkedIn [mod. puntual]: "${newContent.slice(0, 50)}..."`;
    sendEmail.htmlContent = html;

    await transacApi.sendTransacEmail(sendEmail);

    return new NextResponse(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Modificado</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;">
<div style="background:#fff;border-radius:12px;padding:40px;max-width:500px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.1);">
  <div style="width:64px;height:64px;background:#6c5ce7;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;">
    <span style="color:#fff;font-size:28px;">&#10003;</span>
  </div>
  <h1 style="margin:0 0 12px;font-size:24px;color:#152735;">Modificación aplicada</h1>
  <p style="margin:0;font-size:16px;color:#666;">Revisá tu email para aprobar la nueva versión.</p>
</div></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn custom-edit error:', msg);
    return new NextResponse(`Error: ${msg}`, { status: 500 });
  }
}
