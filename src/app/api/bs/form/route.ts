import { NextRequest, NextResponse } from 'next/server';
import { BS_TOPICS } from '@/lib/bs-topics';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';

function buildErrorPage(msg: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial; max-width:600px; margin:40px auto; padding:20px;">
<h1 style="color:#E67E22;">Error</h1><p>${msg}</p></body></html>`;
}

function buildFormPage(topicId: string, label: string, questions: string[], token: string): string {
  const submitUrl = `${BASE_URL}/api/bs/submit`;

  const fields = questions
    .map(
      (q, i) => `
    <div style="margin-bottom:20px;">
      <label style="display:block; font-size:14px; font-weight:600; color:#152735; margin-bottom:6px;">${i + 1}. ${q}</label>
      <textarea name="q${i}" rows="4" style="width:100%; padding:10px; border:1px solid #d0d0d0; border-radius:6px; font-family:Arial,sans-serif; font-size:14px; box-sizing:border-box; resize:vertical;" placeholder="Tu respuesta (podés dejar en blanco si no aplica)"></textarea>
      <input type="hidden" name="q${i}_text" value="${q.replace(/"/g, '&quot;')}">
    </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Behind the scenes: ${label}</title></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:640px; margin:20px auto; background:#ffffff; border-radius:8px; overflow:hidden;">
  <div style="background:#152735; padding:24px 30px; text-align:center;">
    <p style="margin:0; font-size:11px; letter-spacing:2px; color:#5ac8fa; text-transform:uppercase;">Behind the scenes — Mini entrevista</p>
    <h1 style="margin:8px 0 0; font-size:22px; color:#ffffff;">${label}</h1>
  </div>
  <div style="padding:24px 30px;">
    <p style="margin:0 0 14px; font-size:15px; color:#313131; line-height:1.6;">Respondé con frases cortas y datos reales. Lo que escribas se guarda en el dossier para alimentar posts futuros.</p>
    <p style="margin:0 0 20px; font-size:13px; color:#666;">Mejor 2 respuestas reales que 5 inventadas. Si una no aplica, dejala vacía.</p>
    <form action="${submitUrl}" method="POST" style="background:#f8f9fa; padding:20px; border-radius:8px;">
      <input type="hidden" name="topicId" value="${topicId}">
      <input type="hidden" name="token" value="${token}">
      ${fields}
      <div style="text-align:center; margin-top:24px;">
        <button type="submit" style="background:#0077B5; color:#ffffff; border:none; padding:14px 36px; border-radius:30px; font-size:16px; font-weight:700; cursor:pointer;">Generar post con esto</button>
      </div>
    </form>
  </div>
</div>
</body></html>`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const topicId = searchParams.get('topicId');
  const token = searchParams.get('token');

  if (!token || token !== process.env.API_SECRET_KEY) {
    return new NextResponse(buildErrorPage('Token inválido o expirado.'), {
      status: 401,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const topic = BS_TOPICS.find((t) => t.id === topicId);
  if (!topic) {
    return new NextResponse(buildErrorPage(`Tema no encontrado: ${topicId}`), {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  return new NextResponse(buildFormPage(topic.id, topic.label, topic.questions, token), {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}
