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
const APPROVAL_EMAIL = process.env.APPROVAL_EMAIL || '';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

const TONE_PROMPTS: Record<string, string> = {
  cercano: `TAREA: reescribir el post completamente con un giro de tono más CERCANO.

OBJETIVO: que suene como Mauro tomando un café con un colega, contando algo que lo sorprendió de un paper o de un tema. Sigue siendo profesional, pero con más emoción genuina y menos formal.

CAMBIOS OBLIGATORIOS:
- Hook completamente nuevo (diferente al original, ≤ 140 chars).
- Reestructurá la narrativa. No puede quedar parecido al original.
- Primera persona con emoción genuina: "me quedé pensando en", "no me lo esperaba", "me sorprendió encontrar".
- Si el original tiene formato lista, pasalo a narrativa fluida.
- Si el original es muy técnico, priorizá la reflexión humana detrás del dato.
- Mantené los datos duros del original, pero integrados en la historia (sin citar autores ni años).

Todo lo demás: aplicar las reglas del system y el checklist auto-review.`,

  profesional: `TAREA: reescribir el post completamente con ángulo B2B / industria salud.

OBJETIVO: que suene como un experto compartiendo un insight de negocio, con autoridad pero sin arrogancia. Enfocado en qué significa esto para empresas de salud, marketing en salud, dirección médica.

CAMBIOS OBLIGATORIOS:
- Hook completamente nuevo orientado a negocio o industria (≤ 140 chars).
- Reestructurá: el ángulo es empresarial, no clínico.
- Si el original habla de un tema médico, girá hacia "¿qué significa esto para una farmacéutica / prepaga / healthtech?".
- Incluí al menos una reflexión sobre la industria de la salud o el mercado.
- Los datos del original se mantienen pero recontextualizados para audiencia B2B (marketing, dirección, ventas).
- Evitá formato "lista numerada de hallazgos". Si usás lista, que sea con etiquetas cortas, no numeración.

Todo lo demás: aplicar las reglas del system y el checklist auto-review.`,

  datos: `TAREA: revisar el post para endurecer credibilidad de datos y tono, sin cambiar estructura.

OBJETIVO: que cualquier dato del post sea verificable o esté suavizado. Que Mauro no suene a marketer desesperado, incompetente o necesitado.

CAMBIOS OBLIGATORIOS:
- Cualquier número específico que no sea verificable (suscriptores exactos, porcentajes, años de experiencia, cantidad de pacientes) → reemplazar por lenguaje vago ("miles", "con el tiempo", "hace años").
- Cualquier cita nominal a paper ("Uloko 2023", "Smith et al.") → eliminar, dejando solo el dato.
- Cualquier frase de autoridad clínica sin respaldo ("en consulta", "años atendiendo") → reemplazar por fenómeno general.
- Tono → ajustar si hace parecer a Mauro incompetente o necesitado. Narrativa positiva de crecimiento.
- Mantené la estructura general del original (hook + cuerpo + CTA).

Todo lo demás: aplicar las reglas del system y el checklist auto-review.`,

  reformular: `TAREA: descartar el post y escribir uno completamente nuevo sobre el mismo tema, con enfoque/ángulo DIFERENTE.

OBJETIVO: explorar una perspectiva que el original no tocó. Si el original era informativo, probá contrarian. Si era B2B, probá personal. Si era técnico, probá reflexivo.

REGLAS:
- Hook nuevo (≤ 140 chars), narrativa nueva, ángulo distinto.
- Podés usar los mismos datos que el original, pero desde otro marco.
- Elegí el patrón (historia/lista/opinion/prueba) que mejor encaje con el nuevo ángulo.

Todo lo demás: aplicar las reglas del system y el checklist auto-review.`,
};

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

function buildApprovalEmail(content: string, postId: string, iteration: number, firstComment?: string): string {
  const approveUrl = `${BASE_URL}/api/linkedin/approve?postId=${postId}&token=${process.env.API_SECRET_KEY}`;
  const cercanoUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${postId}&token=${process.env.API_SECRET_KEY}&tone=cercano`;
  const profesionalUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${postId}&token=${process.env.API_SECRET_KEY}&tone=profesional`;
  const datosUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${postId}&token=${process.env.API_SECRET_KEY}&tone=datos`;
  const reformularUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${postId}&token=${process.env.API_SECRET_KEY}&tone=reformular`;
  const customEditUrl = `${BASE_URL}/api/linkedin/custom-edit?postId=${postId}&token=${process.env.API_SECRET_KEY}`;
  const rejectUrl = `${BASE_URL}/api/linkedin/reject?postId=${postId}&token=${process.env.API_SECRET_KEY}`;
  const editUrl = `${BASE_URL}/api/linkedin/edit?postId=${postId}&token=${process.env.API_SECRET_KEY}`;
  const previewContent = content.replace(/\n/g, '<br>');

  const iterationBadge = iteration > 1 ? `<span style="background:#5ac8fa; color:#fff; padding:2px 10px; border-radius:12px; font-size:12px; margin-left:8px;">v${iteration}</span>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4; padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:600px; width:100%;">

<tr><td style="background:#0077B5; padding:24px 30px; text-align:center;">
  <p style="margin:0; font-size:11px; letter-spacing:2px; color:#ffffff; opacity:0.8; text-transform:uppercase;">LinkedIn Post</p>
  <h1 style="margin:8px 0 0; font-size:20px; color:#ffffff; font-weight:700;">Post para aprobar ${iterationBadge}</h1>
</td></tr>

<tr><td style="padding:30px;">

  <div style="background:#f8f9fa; border-radius:8px; padding:20px; margin-bottom:20px; border-left:4px solid #0077B5;">
    <p style="margin:0; font-size:15px; color:#313131; line-height:1.6;">${previewContent}</p>
  </div>

  ${firstComment ? `<div style="background:#fff8f0; border-radius:8px; padding:12px 16px; margin-bottom:20px; border-left:4px solid #E67E22;">
    <p style="margin:0 0 4px; font-size:11px; color:#666; text-transform:uppercase; letter-spacing:1px;">Primer comentario:</p>
    <p style="margin:0; font-size:14px; color:#313131;">${firstComment}</p>
  </div>` : ''}

  <p style="margin:0 0 20px; font-size:14px; color:#666;">Al aprobar se programa para el proximo martes, miercoles o jueves a las 9:00 AM.</p>

  <!-- APPROVE -->
  <div style="text-align:center; margin-bottom:16px;">
    <a href="${approveUrl}" style="display:inline-block; background:#0077B5; color:#ffffff; text-decoration:none; padding:14px 36px; border-radius:30px; font-size:16px; font-weight:700;">Aprobar y programar</a>
  </div>

  <!-- CUSTOM EDIT -->
  <div style="text-align:center; margin-bottom:16px;">
    <a href="${customEditUrl}" style="display:inline-block; background:#6c5ce7; color:#ffffff; text-decoration:none; padding:12px 28px; border-radius:30px; font-size:14px; font-weight:700;">Modificación puntual</a>
  </div>

  <!-- TONE BUTTONS -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  <tr>
    <td width="25%" style="padding:4px; text-align:center;">
      <a href="${cercanoUrl}" style="display:block; background:#48c9b0; color:#fff; text-decoration:none; padding:10px 4px; border-radius:6px; font-size:12px; font-weight:600;">Mas cercano</a>
    </td>
    <td width="25%" style="padding:4px; text-align:center;">
      <a href="${profesionalUrl}" style="display:block; background:#152735; color:#fff; text-decoration:none; padding:10px 4px; border-radius:6px; font-size:12px; font-weight:600;">Mas profesional</a>
    </td>
    <td width="25%" style="padding:4px; text-align:center;">
      <a href="${datosUrl}" style="display:block; background:#5ac8fa; color:#fff; text-decoration:none; padding:10px 4px; border-radius:6px; font-size:12px; font-weight:600;">Revisar datos</a>
    </td>
    <td width="25%" style="padding:4px; text-align:center;">
      <a href="${reformularUrl}" style="display:block; background:#9b59b6; color:#fff; text-decoration:none; padding:10px 4px; border-radius:6px; font-size:12px; font-weight:600;">Reformular</a>
    </td>
  </tr>
  </table>

  <!-- EDIT + REJECT -->
  <table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td width="50%" style="padding:4px; text-align:center;">
      <a href="${editUrl}" style="display:block; background:#E67E22; color:#fff; text-decoration:none; padding:10px 8px; border-radius:6px; font-size:13px; font-weight:600;">Editar yo</a>
    </td>
    <td width="50%" style="padding:4px; text-align:center;">
      <a href="${rejectUrl}" style="display:block; background:#e0e0e0; color:#666; text-decoration:none; padding:10px 8px; border-radius:6px; font-size:13px; font-weight:600;">Rechazar</a>
    </td>
  </tr>
  </table>

</td></tr>

<tr><td style="padding:12px 30px; border-top:1px solid #e0e0e0; text-align:center;">
  <p style="margin:0; font-size:12px; color:#999;">Nexo-mail — LinkedIn automation</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const postId = searchParams.get('postId');
  const token = searchParams.get('token');
  const tone = searchParams.get('tone') || 'cercano';

  if (!token || token !== process.env.API_SECRET_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!postId) {
    return NextResponse.json({ error: 'Missing postId' }, { status: 400 });
  }

  const tonePrompt = TONE_PROMPTS[tone];
  if (!tonePrompt) {
    return NextResponse.json({ error: 'Invalid tone' }, { status: 400 });
  }

  try {
    // 1. Get current post content
    const content = await getPostContent(postId);
    if (!content) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    // 2. Regenerate with Claude
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: LINKEDIN_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${tonePrompt}\n\nPost original:\n\n${content}\n\nCorré el checklist auto-review mentalmente y devolvé SOLO el post nuevo.` }],
    });

    const newContent = (message.content[0] as { type: string; text: string }).text.trim();

    // 3. Delete old draft
    await deletePost(postId);

    // 4. Create new draft
    const draftResult = await publishPost(newContent, false);
    if (!draftResult.success || !draftResult.data) {
      return NextResponse.json({ error: 'Failed to create new draft' }, { status: 502 });
    }

    const newPostId = draftResult.data.id;

    // 5. Parse iteration number from old content (simple heuristic)
    const iteration = 2; // TODO: could track this more precisely

    // 6. Send new approval email
    const html = buildApprovalEmail(newContent, newPostId, iteration);
    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.sender = { email: 'info@urologia.ar', name: 'LinkedIn Post' };
    sendEmail.to = [{ email: APPROVAL_EMAIL }];
    sendEmail.subject = `LinkedIn [${tone}]: "${newContent.slice(0, 50)}..."`;
    sendEmail.htmlContent = html;

    await transacApi.sendTransacEmail(sendEmail);

    // Return a nice HTML page
    return new NextResponse(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Regenerando...</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;">
<div style="background:#fff;border-radius:12px;padding:40px;max-width:500px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.1);">
  <div style="width:64px;height:64px;background:#0077B5;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;">
    <span style="color:#fff;font-size:28px;">&#8635;</span>
  </div>
  <h1 style="margin:0 0 12px;font-size:24px;color:#152735;">Post regenerado</h1>
  <p style="margin:0 0 8px;font-size:16px;color:#666;">Tono: <strong>${tone}</strong></p>
  <p style="margin:0;font-size:14px;color:#999;">Revisá tu email para ver la nueva version.</p>
</div></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn regenerate error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
