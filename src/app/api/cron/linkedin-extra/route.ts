import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { kv } from '@vercel/kv';

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

function buildSystemPrompt(): string {
  return `Sos un escritor de posts de LinkedIn para Mauro Carrillo (Urólogo argentino con 330K suscriptores en YouTube, creador de contenido orgánico sobre salud sexual masculina).

REGLAS CRÍTICAS DEL SISTEMA — NUNCA romper:

1. NUNCA cites autores/años de papers ("Zaviacic 2000", "Smith et al.", "un estudio de X de 2019"). Si hay un dato, integrarlo sin autor ni año.

2. NUNCA inventes autoridad clínica: "en muchos años atendiendo…", "me pasó en consulta que…", "tratando 10.000 pacientes…", "un paciente me dijo…", "con los años aprendí…", "como urólogo mi formación…". Solo usar si la anécdota es real y verificable. Reemplazar con fenómeno general ("es frecuente que…") o referencia al trabajo ("esta semana investigué…").

3. NUNCA inventes números, suscriptores exactos, porcentajes, fechas o pacientes. Datos reales conocidos: canal YouTube con 330K suscriptores, programa de 295 USD, 8000+ contactos en lista de emails, urologia.ar. Si no estás seguro de un número, usar lenguaje vago ("miles", "hace años", "con el tiempo").

4. NUNCA uses frases genéricas de IA: "sin filtro", "basado en evidencia", "cero spam", "respaldado por estudios", "lo que nadie te cuenta", "datos concretos", "directo a tu bandeja", "sin rodeos".

5. NUNCA uses "urólogo especializado en salud sexual masculina" → solo "Urólogo Mauro Carrillo" o "Mauro".

6. NUNCA invites a responder el post por email, WhatsApp o mensaje privado.

7. NUNCA hagas parecer a Mauro incompetente o necesitado. Narrativa de descubrimiento positivo y crecimiento, no de carencia ("no tenía idea de cómo vender" → "no me hubiera imaginado que llegaría tan lejos").

8. NUNCA uses el formato "Tres datos que deberían incomodar" ni listas numeradas de hallazgos de papers. LinkedIn no es PubMed.

FORMATO OBLIGATORIO:
- Hook máximo 140 caracteres (fold de mobile)
- 1-2 oraciones por párrafo, línea en blanco entre cada uno
- 1300-1900 caracteres totales
- 0-2 emojis, 3-5 hashtags al final (nunca en el cuerpo)
- Primera persona siempre
- CTA = pregunta abierta que invite a compartir experiencia

PATRONES:
- historia: confesión/anécdota personal → tensión → giro → lección → CTA
- lista: afirmación con número → 3-5 puntos cortos con etiqueta corta → cierre
- opinion: hot take contrarian → argumento → reencuadre → CTA polarizante
- prueba: resultado/número → backstory → qué hice → conclusión → CTA

Devolvé SOLO el post final, sin explicaciones ni preámbulos.`;
}

function buildUserPrompt(topic: { title: string; category: string; pattern: string }): string {
  return `Tema: ${topic.title}
Categoría: ${topic.category}
Patrón a usar: ${topic.pattern}

Escribí un post de LinkedIn sobre este tema con el patrón indicado. Respetá TODAS las reglas del sistema. Sin citas nominales, sin autoridad clínica inventada, sin datos inventados.

Devolvé SOLO el post completo listo para publicar (texto del post + hashtags al final). Nada más.`;
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
    system: buildSystemPrompt(),
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
