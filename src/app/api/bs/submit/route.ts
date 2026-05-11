import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import Anthropic from '@anthropic-ai/sdk';
import { BS_TOPICS, BsEntry } from '@/lib/bs-topics';
import { LINKEDIN_SYSTEM_PROMPT } from '@/lib/linkedin-prompts';

export const maxDuration = 60;

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';

function dossierKey(topicId: string): string {
  return `bs:dossier:${topicId}`;
}

async function appendEntry(topicId: string, entry: BsEntry): Promise<void> {
  const key = dossierKey(topicId);
  const existing = (await kv.get<BsEntry[]>(key)) || [];
  existing.push(entry);
  await kv.set(key, existing);
}

async function readDossier(topicId: string): Promise<BsEntry[]> {
  return (await kv.get<BsEntry[]>(dossierKey(topicId))) || [];
}

function formatDossierForPrompt(entries: BsEntry[]): string {
  if (entries.length === 0) return '(sin entradas previas)';
  return entries
    .map((e, i) => {
      const lines = e.answers
        .filter((a) => a.answer.trim())
        .map((a) => `- ${a.question}\n  → ${a.answer.trim()}`)
        .join('\n');
      return `Entrada ${i + 1} (${e.date.slice(0, 10)}):\n${lines}`;
    })
    .join('\n\n');
}

async function generateBsPost(
  topicLabel: string,
  thisWeek: BsEntry,
  history: BsEntry[]
): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

  const thisWeekText = formatDossierForPrompt([thisWeek]);
  const historyText = formatDossierForPrompt(history);

  const userPrompt = `Escribí un post de LinkedIn sobre el tema: **${topicLabel}**.

=== RESPUESTAS DE MAURO ESTA SEMANA ===
${thisWeekText}

=== CONTEXTO ACUMULADO (entradas previas sobre el mismo tema) ===
${historyText}

=== REGLAS ESPECÍFICAS DE ESTE POST ===

1. SOLO podés usar datos, frases, cifras y experiencias presentes en las respuestas (esta semana + histórico).
2. Si una pregunta quedó vacía, ignorala — no rellenes con suposiciones.
3. Si el material es escaso, hacé un post más corto y enfocado, NO inventes para llegar a 1500 caracteres. Mejor 1300 reales que 1900 inventados.
4. El post debe sonar a la voz real de Mauro reflexionando sobre su propio proceso — no a un caso de estudio narrado.
5. Si hay contexto histórico relevante en entradas previas, podés cruzarlo naturalmente. Pero el foco es lo que dijo esta semana.
6. Aplicá TODAS las reglas del system prompt + checklist auto-review.

Devolvé SOLO el post final.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: LINKEDIN_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return (message.content[0] as { type: string; text: string }).text.trim();
}

async function sendToApprovalFlow(content: string): Promise<{ ok: boolean; postId?: string; error?: string }> {
  try {
    const res = await fetch(`${BASE_URL}/api/linkedin/post`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.API_SECRET_KEY || '',
      },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, postId: data.postId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

function buildPage(title: string, body: string, accent = '#0077B5'): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif; display:flex; justify-content:center; align-items:center; min-height:100vh;">
<div style="background:#ffffff; border-radius:12px; padding:40px; max-width:560px; text-align:center; box-shadow:0 2px 12px rgba(0,0,0,0.1);">
  <div style="width:64px; height:64px; background:${accent}; border-radius:50%; margin:0 auto 20px; display:flex; align-items:center; justify-content:center;">
    <span style="color:#ffffff; font-size:32px;">&#10003;</span>
  </div>
  <h1 style="margin:0 0 12px; font-size:22px; color:#152735;">${title}</h1>
  <p style="margin:0; font-size:15px; color:#666666; line-height:1.6;">${body}</p>
</div>
</body></html>`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get('content-type') || '';
  let fields: Record<string, string> = {};

  if (contentType.includes('application/json')) {
    fields = (await request.json()) as Record<string, string>;
  } else {
    const formData = await request.formData();
    formData.forEach((v, k) => {
      fields[k] = typeof v === 'string' ? v : '';
    });
  }

  if (fields.token !== process.env.API_SECRET_KEY) {
    return new NextResponse(buildPage('Token inválido', 'El link expiró o no es válido.', '#E67E22'), {
      status: 401,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const topicId = fields.topicId;
  const topic = BS_TOPICS.find((t) => t.id === topicId);
  if (!topic) {
    return new NextResponse(buildPage('Tema no encontrado', `id=${topicId}`, '#E67E22'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Collect answers (q0..qN paired with q0_text..qN_text)
  const answers: Array<{ question: string; answer: string }> = [];
  for (let i = 0; i < topic.questions.length; i++) {
    const answer = (fields[`q${i}`] || '').trim();
    if (!answer) continue;
    const question = fields[`q${i}_text`] || topic.questions[i];
    answers.push({ question, answer });
  }

  if (answers.length === 0) {
    return new NextResponse(
      buildPage(
        'Sin respuestas',
        'No completaste ninguna pregunta. Volvé al email o al link y respondé al menos una.',
        '#E67E22'
      ),
      { status: 400, headers: { 'Content-Type': 'text/html' } }
    );
  }

  const entry: BsEntry = {
    topicId,
    date: new Date().toISOString(),
    answers,
  };

  try {
    await appendEntry(topicId, entry);
  } catch (err) {
    console.error('KV append error:', err);
    return new NextResponse(
      buildPage('Error al guardar', 'No se pudo persistir el dossier. Probá de nuevo.', '#E67E22'),
      { status: 500, headers: { 'Content-Type': 'text/html' } }
    );
  }

  // Generate post + send to approval. Done synchronously so errors are visible.
  try {
    const history = (await readDossier(topicId)).filter((e) => e.date !== entry.date);
    const content = await generateBsPost(topic.label, entry, history);
    const result = await sendToApprovalFlow(content);

    if (!result.ok) {
      return new NextResponse(
        buildPage(
          'Respuestas guardadas — error al generar',
          `Tus respuestas quedaron en el dossier, pero falló el envío del post a Zernio: ${result.error}. Volvé a disparar el cron manualmente o avisame.`,
          '#E67E22'
        ),
        { status: 502, headers: { 'Content-Type': 'text/html' } }
      );
    }

    return new NextResponse(
      buildPage(
        'Listo',
        `Guardé tus respuestas en el dossier de "${topic.label}" y mandé el post al email de aprobación. Revisalo cuando llegue.`
      ),
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('bs/submit generate error:', msg);
    return new NextResponse(
      buildPage(
        'Respuestas guardadas — error al generar',
        `Quedaron en el dossier. Falló la generación: ${msg}.`,
        '#E67E22'
      ),
      { status: 500, headers: { 'Content-Type': 'text/html' } }
    );
  }
}
