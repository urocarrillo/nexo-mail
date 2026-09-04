/**
 * Mail post-test del programa DE (antes vivía en el POST de
 * /api/webhook/typeform). Lo consumen el webhook y el cron postest-vigilante.
 *
 * Comportamiento por tier:
 *  - C   → mail Tier C (Calendly) vía sendPlainSecuencia + marca en columna Secuencia.
 *  - A/B → filtro cliente (fail-open), skip si cliente-programa, marca CRM si
 *          cliente-otro, contacto Brevo lista 24, mail M0 (A) o mail B,
 *          enrolamiento en la secuencia solo tier A lead puro.
 */
import { kv } from '@vercel/kv';
import { getClienteInfo, clienteCellText, type ClientesMap, type EstadoCliente } from '@/lib/clientes';
import { markClienteInCRM, markSecuenciaForEmails } from '@/lib/crm-sheet';
import { enrollSecuencia, getEnrolledSecuenciaEmails, sendPlainSecuencia } from '@/lib/email-drip';
import {
  buildSecuenciaMail,
  buildMailTierC,
  computeSequenceDates,
  fechaArgDDMM,
} from '@/lib/secuencia-post-typeform';

const POSTEST_LIST_ID = 24; // "PROGRAMA Control Mental" en Brevo
const SENDER = { name: 'Mauro Carrillo', email: 'mauro@urologia.ar' };
const LANDING = 'https://urologia.ar/recuperatuereccion';
const BREVO_TIMEOUT_MS = 8000;
const AUX_TIMEOUT_MS = 8000; // Woo (mapa de clientes), KV drip:queue: etapas fail-open

/**
 * Huella "ya se mandó el post-test a este email". La setea todo caller
 * (webhook y vigilante) tras un envío exitoso, así ninguno repite lo que el
 * otro ya hizo. El vigilante además la usa como guardia previa (inflight).
 */
export const SENT_KEY_PREFIX = 'postest-sent:';
export const SENT_TTL_S = 60 * 60 * 24 * 60; // 60 días

export type Tier = 'A' | 'B' | 'C';

/** Marca pendiente en el Sheet CRM que el caller escribe por fila (deferMarks). */
export interface PendingMark {
  col: 'secuencia' | 'cliente' | 'estado';
  text: string;
}

export interface DispatchOptions {
  /** Mapa de clientes ya cargado (evita Woo por candidato). */
  clientes?: ClientesMap;
  /** Emails ya enrolados en la secuencia (evita hgetall por candidato). */
  alreadyEnrolled?: Set<string>;
  /**
   * true → no releer el Sheet para marcar Secuencia/Cliente/Estado: se
   * devuelven en `pendingMarks` y el caller (que conoce la fila) las escribe.
   */
  deferMarks?: boolean;
}

export interface TypeformPayload {
  email: string;
  name?: string;
  pantalla: string;
  variante?: string;
  score?: number;
  tier: Tier;
  /** ISO-2 (o 'XX') del test propio; Typeform no lo manda. */
  pais?: string;
}

export interface DispatchResult {
  success: boolean;
  tier: Tier;
  pantalla: string;
  skipped?: boolean;
  reason?: string;
  messageId?: string;
  error?: string;
  stage?: 'contact' | 'send';
  // Tier C: success=true aunque el envío falle (comportamiento histórico);
  // `sent` dice si el mail salió de verdad.
  sent?: boolean;
  sendError?: string;
  marked?: boolean;
  enrolled?: boolean;
  /** Marcas de Sheet que el caller debe escribir (solo con opts.deferMarks). */
  pendingMarks?: PendingMark[];
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Un fallo de envío es AMBIGUO cuando no hubo respuesta HTTP definitiva de
 * Brevo: timeout/abort/corte de red. Brevo pudo haber aceptado el POST igual,
 * así que reintentar puede duplicar el mail. Un 4xx/5xx sí es definitivo.
 */
export function esErrorAmbiguo(error: string | undefined | null): boolean {
  const e = (error || '').toLowerCase();
  if (!e) return false;
  if (/brevo (send|contact) \d{3}/.test(e)) return false; // respuesta HTTP definitiva
  return /timeout|timed out|abort|fetch failed|econnreset|socket|network|other side closed/.test(e);
}

/** Promise.race con timer limpio. Rechaza con TimeoutError. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`TimeoutError: ${label} > ${ms} ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Huella KV post-envío (best-effort, nunca lanza). */
async function marcarEnviadoKV(email: string): Promise<void> {
  try {
    await kv.set(`${SENT_KEY_PREFIX}${email}`, new Date().toISOString(), { ex: SENT_TTL_S });
  } catch (err) {
    console.error('postest kv sent-mark error (non-blocking):', err);
  }
}

export function parsePayload(
  data: unknown
): { ok: true; payload: TypeformPayload } | { ok: false; error: string } {
  if (!data || typeof data !== 'object') return { ok: false, error: 'Invalid payload' };
  const d = data as Record<string, unknown>;

  if (typeof d.email !== 'string' || !validateEmail(d.email)) {
    return { ok: false, error: 'Invalid or missing email' };
  }
  if (typeof d.pantalla !== 'string' || !d.pantalla.trim()) {
    return { ok: false, error: 'Missing pantalla' };
  }
  if (d.tier !== 'A' && d.tier !== 'B' && d.tier !== 'C') {
    return { ok: false, error: 'tier must be A | B | C' };
  }

  return {
    ok: true,
    payload: {
      email: d.email.toLowerCase().trim(),
      name: typeof d.name === 'string' ? d.name.trim() : undefined,
      pantalla: d.pantalla.trim(),
      variante: typeof d.variante === 'string' ? d.variante.trim() : undefined,
      score: typeof d.score === 'number' ? d.score : undefined,
      tier: d.tier,
    },
  };
}

function firstName(name?: string): string {
  if (!name) return '';
  return name.trim().split(/\s+/)[0] || '';
}

function buildMailB(name: string): { subject: string; text: string } {
  const greeting = name ? `Hola ${name},` : 'Hola,';
  return {
    subject: 'Espero poder ayudarte',
    text:
      `${greeting}\n\n` +
      `Te cuento que ya recibí el resultado del test.\n\n` +
      `Por lo que contás, el programa puede ayudarte con tu situación.\n\n` +
      `Te dejo el link para que lo veas tranquilo y decidas:\n\n` +
      `${LANDING}\n\n` +
      `Si te interesa saber más respecto al programa, respondé este correo y lo vemos.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

async function brevoCreateOrUpdateContact(p: TypeformPayload): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };

  // Atributos reales de la cuenta Brevo: NOMBRE (FIRSTNAME no existe y Brevo
  // lo descarta en silencio), TIER, PANTALLA, VARIANTE, SCORE y PAIS.
  const body = {
    email: p.email,
    attributes: {
      NOMBRE: firstName(p.name),
      TIER: p.tier,
      PANTALLA: p.pantalla,
      VARIANTE: p.variante || '',
      SCORE: typeof p.score === 'number' ? p.score : 0,
      ...(p.pais ? { PAIS: p.pais } : {}),
    },
    listIds: [POSTEST_LIST_ID],
    updateEnabled: true,
  };

  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
    });

    if (res.status === 201 || res.status === 204) return { ok: true };

    const raw = await res.text();
    // Brevo responde 400 "Contact already exist" cuando updateEnabled lo resuelve como éxito
    if (res.status === 400 && raw.toLowerCase().includes('already')) return { ok: true };
    return { ok: false, error: `Brevo contact ${res.status}: ${raw}` };
  } catch (err) {
    return { ok: false, error: `Brevo contact error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function brevoSendTransactional(
  toEmail: string,
  toName: string,
  subject: string,
  text: string
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };

  const body = {
    sender: SENDER,
    to: [{ email: toEmail, name: toName || undefined }],
    replyTo: { email: SENDER.email },
    subject,
    textContent: text,
  };

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
    });

    if (res.status === 201) {
      const data = (await res.json()) as { messageId?: string };
      return { ok: true, messageId: data.messageId };
    }
    const raw = await res.text();
    return { ok: false, error: `Brevo send ${res.status}: ${raw}` };
  } catch (err) {
    return { ok: false, error: `Brevo send error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Dispara el mail post-test según tier. Mismo flujo que el webhook histórico. */
export async function dispatchPostTest(
  payload: TypeformPayload,
  opts: DispatchOptions = {}
): Promise<DispatchResult> {
  const pendingMarks: PendingMark[] = [];

  if (payload.tier === 'C') {
    // Tier C (red flags médicos): el caso merece consulta individual. Enviamos el
    // mail que redirige a Calendly (mismo mecanismo plain que la secuencia, con
    // pie de baja) y marcamos "Mail C enviado dd/mm" en la columna Secuencia.
    // sendPlainSecuencia no lleva AbortSignal: lo acotamos acá (el timeout se
    // reporta como sendError ambiguo, ver esErrorAmbiguo).
    const mail = buildMailTierC(firstName(payload.name));
    let sendResult: { success: boolean; messageId?: string; error?: string };
    try {
      sendResult = await withTimeout(
        sendPlainSecuencia(payload.email, payload.name || '', mail.subject, mail.text),
        BREVO_TIMEOUT_MS,
        'Brevo send (tier C)'
      );
    } catch (err) {
      sendResult = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    let marked = false;
    if (sendResult.success) {
      await marcarEnviadoKV(payload.email);
      const text = `Mail C enviado ${fechaArgDDMM(new Date())}`;
      if (opts.deferMarks) {
        pendingMarks.push({ col: 'secuencia', text });
      } else {
        try {
          const r = await markSecuenciaForEmails([{ email: payload.email, text }]);
          marked = r.marked > 0;
        } catch (crmErr) {
          console.error('Tier C sheet mark error (non-blocking):', crmErr);
        }
      }
    }

    return {
      success: true,
      tier: 'C',
      pantalla: payload.pantalla,
      sent: sendResult.success,
      messageId: sendResult.messageId,
      marked,
      ...(sendResult.success ? {} : { sendError: sendResult.error }),
      ...(opts.deferMarks ? { pendingMarks } : {}),
    };
  }

  // Filtro "¿ya es cliente?" (PRD-filtro-cliente / T8). Fuente: WooCommerce.
  // Fail-open: si la consulta falla o tarda, seguimos el flujo normal (no bloquear leads).
  let estado: EstadoCliente = 'lead';
  try {
    const info = opts.clientes
      ? await getClienteInfo(payload.email, opts.clientes)
      : await withTimeout(getClienteInfo(payload.email), AUX_TIMEOUT_MS, 'getClienteInfo');
    estado = info?.estado || 'lead';

    if (estado === 'cliente-programa') {
      // Ya es alumno del programa → NO mail de venta.
      console.log(`Post-test: ${payload.email} es cliente-programa, skip mail de venta`);
      return {
        success: true,
        skipped: true,
        reason: 'cliente-programa',
        tier: payload.tier,
        pantalla: payload.pantalla,
      };
    }

    if (estado === 'cliente-otro' && info) {
      // Compró otro producto → mail de venta normal + marcar el Sheet CRM
      // (Cliente + Estado seguimiento = "COMPRÓ", igual que markClienteInCRM).
      if (opts.deferMarks) {
        pendingMarks.push({ col: 'cliente', text: clienteCellText(info) });
        pendingMarks.push({ col: 'estado', text: 'COMPRÓ' });
      } else {
        try {
          await markClienteInCRM(payload.email, clienteCellText(info));
        } catch (crmErr) {
          console.error('Post-test CRM marking (cliente-otro) error (non-blocking):', crmErr);
        }
      }
    }
  } catch (err) {
    console.error('Post-test estadoCliente check failed (fail-open a flujo normal):', err);
  }

  const name = firstName(payload.name);
  // Tier A → M0 de la secuencia post-Typeform ("Buenas noticias"). Tier B → mail B.
  const mail = payload.tier === 'A' ? buildSecuenciaMail(0, name) : buildMailB(name);

  const contactResult = await brevoCreateOrUpdateContact(payload);
  if (!contactResult.ok) {
    return {
      success: false,
      tier: payload.tier,
      pantalla: payload.pantalla,
      stage: 'contact',
      error: contactResult.error,
    };
  }

  const sendResult = await brevoSendTransactional(payload.email, payload.name || '', mail.subject, mail.text);
  if (!sendResult.ok) {
    return {
      success: false,
      tier: payload.tier,
      pantalla: payload.pantalla,
      stage: 'send',
      error: sendResult.error,
      ...(opts.deferMarks ? { pendingMarks } : {}),
    };
  }
  await marcarEnviadoKV(payload.email);

  // Enrolamiento en la secuencia (M1..M8): SOLO tier A que sea lead puro.
  // Los cliente-otro reciben el M0 pero no se enrolan: el re-chequeo
  // esCliente() los cancelaría en el primer envío.
  let enrolled = false;
  if (payload.tier === 'A' && estado === 'lead') {
    try {
      const already =
        opts.alreadyEnrolled ??
        (await withTimeout(getEnrolledSecuenciaEmails(), AUX_TIMEOUT_MS, 'getEnrolledSecuenciaEmails'));
      const dates = computeSequenceDates(new Date());
      const r = await enrollSecuencia({
        email: payload.email,
        name,
        variant: 'A', // lead nuevo → siempre M1A
        dates,
        alreadyEnrolled: already,
      });
      enrolled = r.scheduled > 0;
    } catch (err) {
      console.error('Post-test enroll secuencia error (non-blocking):', err);
    }
  }

  return {
    success: true,
    tier: payload.tier,
    pantalla: payload.pantalla,
    messageId: sendResult.messageId,
    enrolled,
    ...(opts.deferMarks ? { pendingMarks } : {}),
  };
}
