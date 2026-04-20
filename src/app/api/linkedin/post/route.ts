import { NextRequest, NextResponse } from 'next/server';
import * as Brevo from '@getbrevo/brevo';
import { publishPost, publishPostWithImage } from '@/lib/linkedin';

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const APPROVAL_EMAIL = 'REDACTED_EMAIL@example.com';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  BREVO_API_KEY
);

function validateApiKey(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key');
  return apiKey === process.env.API_SECRET_KEY;
}

interface PostRequestBody {
  content: string;
  publishNow?: boolean;
  scheduledFor?: string;
  imageUrl?: string;
  firstComment?: string;
  skipApproval?: boolean;
}

function validatePayload(data: unknown): { valid: boolean; error?: string; payload?: PostRequestBody } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid payload' };
  }

  const body = data as Record<string, unknown>;

  if (!body.content || typeof body.content !== 'string') {
    return { valid: false, error: 'content is required and must be a string' };
  }

  if (body.content.trim().length === 0) {
    return { valid: false, error: 'content cannot be empty' };
  }

  return {
    valid: true,
    payload: {
      content: body.content.trim(),
      publishNow: !!body.publishNow,
      scheduledFor: body.scheduledFor as string | undefined,
      imageUrl: body.imageUrl as string | undefined,
      firstComment: body.firstComment as string | undefined,
      skipApproval: !!body.skipApproval,
    },
  };
}

function buildApprovalEmail(content: string, postId: string, firstComment?: string): string {
  const approveUrl = `${BASE_URL}/api/linkedin/approve?postId=${postId}&token=${process.env.API_SECRET_KEY}`;
  const cercanoUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${postId}&token=${process.env.API_SECRET_KEY}&tone=cercano`;
  const profesionalUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${postId}&token=${process.env.API_SECRET_KEY}&tone=profesional`;
  const datosUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${postId}&token=${process.env.API_SECRET_KEY}&tone=datos`;
  const reformularUrl = `${BASE_URL}/api/linkedin/regenerate?postId=${postId}&token=${process.env.API_SECRET_KEY}&tone=reformular`;
  const customEditUrl = `${BASE_URL}/api/linkedin/custom-edit?postId=${postId}&token=${process.env.API_SECRET_KEY}`;
  const rejectUrl = `${BASE_URL}/api/linkedin/reject?postId=${postId}&token=${process.env.API_SECRET_KEY}`;
  const editUrl = `${BASE_URL}/api/linkedin/edit?postId=${postId}&token=${process.env.API_SECRET_KEY}`;
  const previewContent = content.replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4; padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:600px; width:100%;">

<tr><td style="background:#0077B5; padding:24px 30px; text-align:center;">
  <p style="margin:0; font-size:11px; letter-spacing:2px; color:#ffffff; opacity:0.8; text-transform:uppercase;">LinkedIn Post</p>
  <h1 style="margin:8px 0 0; font-size:20px; color:#ffffff; font-weight:700;">Nuevo post para aprobar</h1>
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

  <div style="text-align:center; margin-bottom:16px;">
    <a href="${approveUrl}" style="display:inline-block; background:#0077B5; color:#ffffff; text-decoration:none; padding:14px 36px; border-radius:30px; font-size:16px; font-weight:700;">Aprobar y programar</a>
  </div>

  <div style="text-align:center; margin-bottom:16px;">
    <a href="${customEditUrl}" style="display:inline-block; background:#6c5ce7; color:#ffffff; text-decoration:none; padding:12px 28px; border-radius:30px; font-size:14px; font-weight:700;">Modificación puntual</a>
  </div>

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!validateApiKey(request)) {
    return NextResponse.json(
      { success: false, error: 'Invalid or missing API key' },
      { status: 401 }
    );
  }

  if (!process.env.ZERNIO_API_KEY) {
    return NextResponse.json(
      { success: false, error: 'ZERNIO_API_KEY not configured' },
      { status: 500 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Could not parse request body' },
      { status: 400 }
    );
  }

  const validation = validatePayload(body);
  if (!validation.valid || !validation.payload) {
    return NextResponse.json(
      { success: false, error: validation.error },
      { status: 400 }
    );
  }

  const { content, publishNow, scheduledFor, imageUrl, firstComment, skipApproval } = validation.payload;

  try {
    // If skipApproval or explicit publishNow/scheduledFor, publish/schedule directly
    if (skipApproval || publishNow || scheduledFor) {
      let result;
      const shouldPublishNow = publishNow && !scheduledFor;

      if (imageUrl) {
        result = await publishPostWithImage(content, imageUrl, shouldPublishNow, firstComment);
      } else {
        result = await publishPost(content, shouldPublishNow, scheduledFor, firstComment);
      }

      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 502 });
      }

      const action = shouldPublishNow ? 'published' : 'scheduled';
      console.log(`LinkedIn post ${action} (skip approval): ${content.slice(0, 80)}...`);

      return NextResponse.json({
        success: true,
        action,
        post: result.data,
        timestamp: new Date().toISOString(),
      });
    }

    // DEFAULT: Save as draft + send approval email
    const draftResult = await publishPost(content, false, undefined, firstComment);

    if (!draftResult.success || !draftResult.data) {
      return NextResponse.json({ success: false, error: draftResult.error || 'Failed to create draft' }, { status: 502 });
    }

    const postId = draftResult.data.id;

    // Send approval email
    const html = buildApprovalEmail(content, postId, firstComment);
    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.sender = { email: 'info@urologia.ar', name: 'LinkedIn Post' };
    sendEmail.to = [{ email: APPROVAL_EMAIL }];
    sendEmail.subject = `LinkedIn: "${content.slice(0, 60)}..."`;
    sendEmail.htmlContent = html;

    await transacApi.sendTransacEmail(sendEmail);

    console.log(`LinkedIn draft created + approval email sent: ${postId}`);

    return NextResponse.json({
      success: true,
      action: 'draft_pending_approval',
      postId,
      approvalEmailSent: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn post route error:', msg);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
