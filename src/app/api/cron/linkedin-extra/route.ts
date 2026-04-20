import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { kv } from '@vercel/kv';
import { LINKEDIN_SYSTEM_PROMPT } from '@/lib/linkedin-prompts';

export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';
const TOPIC_INDEX_KEY = 'linkedin_extra:last_topic_index';
const LAST_RUN_KEY = 'linkedin_extra:last_run_ts';
const MIN_HOURS_BETWEEN_RUNS = 120; // 5 days — prevents duplicate posts from retries or accidental hits

const TOPICS: Array<{ id: number; title: string; category: string; pattern: string }> = [
  // Behind the scenes — usar patrón A (historia) o B (lista)
  { id: 1, title: 'Cómo automaticé mi embudo de ventas sin equipo de marketing', category: 'behind_scenes', pattern: 'historia' },
  { id: 2, title: 'De 0 a 330K en YouTube con contenido orgánico: qué funcionó', category: 'behind_scenes', pattern: 'lista' },
  { id: 3, title: 'Mi stack de herramientas para crear, vender y escalar solo', category: 'behind_scenes', pattern: 'lista' },
  { id: 4, title: 'Cómo uso IA para producir contenido basado en evidencia', category: 'behind_scenes', pattern: 'historia' },
  { id: 5, title: 'Lo que aprendí vendiendo un programa online de 295 USD', category: 'behind_scenes', pattern: 'lista' },
  { id: 6, title: 'Cómo manejo mi tiempo entre la clínica y la creación de contenido', category: 'behind_scenes', pattern: 'historia' },
  { id: 7, title: 'Mi proceso de edición: de guión a video publicado en 1 semana', category: 'behind_scenes', pattern: 'lista' },
  { id: 8, title: 'Cómo paso de un paper científico a un video que entiende cualquiera', category: 'behind_scenes', pattern: 'historia' },
  { id: 9, title: 'Mi sistema de emails automatizados: qué aprendí después de 8000 contactos', category: 'behind_scenes', pattern: 'lista' },
  { id: 10, title: 'Cómo mido lo que funciona (y lo que no) en mi contenido', category: 'behind_scenes', pattern: 'lista' },
  // Soluciones para empresas — usar patrón C (opinión)
  { id: 11, title: 'Tu empresa de salud tiene Instagram pero no convierte: probablemente es esto', category: 'soluciones_empresas', pattern: 'opinion' },
  { id: 12, title: '3 errores que veo en canales de salud de empresas (y cómo los solucionaría)', category: 'soluciones_empresas', pattern: 'lista' },
  { id: 13, title: 'Por qué el contenido de una farmacéutica no conecta (y el de un urólogo en YouTube sí)', category: 'soluciones_empresas', pattern: 'opinion' },
  { id: 14, title: 'Lo que le diría al equipo de marketing de una empresa de salud si me sentara 1 hora con ellos', category: 'soluciones_empresas', pattern: 'lista' },
  { id: 15, title: 'Contenido orgánico vs pauta: cuándo invertir en cada uno', category: 'soluciones_empresas', pattern: 'opinion' },
  { id: 16, title: 'Cuánto cuesta NO tener contenido orgánico: lo que las empresas de salud pierden', category: 'soluciones_empresas', pattern: 'opinion' },
  { id: 17, title: 'El contenido de salud que funciona no parece marketing, parece educación', category: 'soluciones_empresas', pattern: 'opinion' },
  { id: 18, title: 'Por qué los médicos generan más confianza que los influencers en salud', category: 'soluciones_empresas', pattern: 'opinion' },
];

const PATTERN_DESCRIPTIONS: Record<string, string> = {
  historia: 'confesión/anécdota personal breve → tensión o problema → giro/descubrimiento → lección transferible → CTA pregunta',
  lista: 'afirmación fuerte con un número → 3-5 puntos cortos con etiqueta corta (no numeración visible tipo "1." "2." "3.") → cierre que reenmarca → CTA pregunta',
  opinion: 'hot take contrarian en la primera línea → sabiduría convencional que desafía → tu argumento con 1-2 datos → reencuadre → CTA pregunta polarizante',
  prueba: 'resultado/número concreto → backstory corto → qué hiciste específicamente → repetición del resultado con contexto → conclusión (principio detrás) → CTA pregunta',
};

function buildUserPrompt(topic: { title: string; category: string; pattern: string }): string {
  return `Escribí un post de LinkedIn sobre este tema:

TEMA: ${topic.title}
CATEGORÍA: ${topic.category === 'behind_scenes' ? 'Behind the scenes (mostrar procesos reales como prueba de expertise)' : 'Soluciones para empresas de salud (posts que venden consultoría sin vender)'}
PATRÓN: ${topic.pattern} — ${PATTERN_DESCRIPTIONS[topic.pattern] || topic.pattern}

${topic.category === 'soluciones_empresas' ? 'AUDIENCIA: equipos de marketing y dirección de empresas farmacéuticas, prepagas, clínicas privadas, healthtech. El objetivo es que alguien de esas empresas lea y piense "este tipo sabe de lo que habla, le escribo".' : 'AUDIENCIA: otros creadores de contenido profesional, emprendedores de salud, consultores. Queremos que piensen "quiero aprender de este proceso".'}

Aplicá TODAS las reglas del system prompt, corré el checklist auto-review mentalmente y devolvé SOLO el post final.`;
}

async function selectNextTopic(): Promise<{ topic: typeof TOPICS[0]; newIndex: number }> {
  let lastIndex = -1;
  try {
    const stored = await kv.get<number>(TOPIC_INDEX_KEY);
    if (typeof stored === 'number') lastIndex = stored;
  } catch (err) {
    console.error('KV read error (falling back to 0):', err);
  }

  const newIndex = (lastIndex + 1) % TOPICS.length;
  return { topic: TOPICS[newIndex], newIndex };
}

async function generatePost(topic: typeof TOPICS[0]): Promise<string> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: LINKEDIN_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(topic) }],
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const apiSecret = process.env.API_SECRET_KEY;
  const { searchParams } = new URL(request.url);
  const manualToken = searchParams.get('token');
  const force = searchParams.get('force') === '1';

  // Accept either Vercel cron Bearer (CRON_SECRET) or manual trigger with API_SECRET_KEY
  const bearerOk = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const tokenOk = apiSecret && manualToken === apiSecret;
  if (!bearerOk && !tokenOk) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ success: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
  }

  // Dedupe: skip if last run was within MIN_HOURS_BETWEEN_RUNS
  if (!force) {
    try {
      const lastRun = await kv.get<number>(LAST_RUN_KEY);
      if (typeof lastRun === 'number') {
        const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
        if (hoursSince < MIN_HOURS_BETWEEN_RUNS) {
          return NextResponse.json({
            success: false,
            skipped: true,
            reason: `Last run was ${hoursSince.toFixed(1)}h ago (min ${MIN_HOURS_BETWEEN_RUNS}h). Use ?force=1 to override.`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error('KV read error for dedupe (proceeding anyway):', err);
    }
  }

  try {
    const { topic, newIndex } = await selectNextTopic();
    console.log(`linkedin-extra cron: selected topic #${topic.id} (${topic.category}/${topic.pattern}) — "${topic.title}"`);

    const content = await generatePost(topic);
    console.log(`linkedin-extra cron: generated ${content.length} chars`);

    const result = await sendToApprovalFlow(content);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error, topic: topic.title },
        { status: 502 }
      );
    }

    try {
      await kv.set(TOPIC_INDEX_KEY, newIndex);
      await kv.set(LAST_RUN_KEY, Date.now());
    } catch (err) {
      console.error('KV write error (index/timestamp not saved):', err);
    }

    return NextResponse.json({
      success: true,
      topic: topic.title,
      category: topic.category,
      pattern: topic.pattern,
      index: newIndex,
      postId: result.postId,
      contentLength: content.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('linkedin-extra cron error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
