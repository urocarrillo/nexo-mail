import { kv } from '@vercel/kv';
import { createHmac } from 'crypto';
import * as Brevo from '@getbrevo/brevo';
import { LeadTag } from './types';
import { esCliente, getClientes, type ClientesMap } from './clientes';
import { isEmailBlacklisted } from './brevo';
import {
  readCrmSheet,
  writeSecuenciaMarks,
  type CrmRow,
  type CrmSnapshot,
} from './crm-sheet';
import {
  buildSecuenciaMail,
  buildRecuperoMail,
  estadoPausaSecuencia,
  fechaArgDDMM,
  isSecuenciaExcluido,
  SECUENCIA_SENDER,
  SECUENCIA_TAG,
  type MailVariant,
  type SeqTrack,
} from './secuencia-post-typeform';
import {
  buildDurarMasMail,
  DURARMAS_OFFSETS_DIAS,
  DURARMAS_SEQ_VERSION,
  estadoCortaDurarMas,
  DURARMAS_SENDER_SECUENCIA,
  DURARMAS_TAG,
} from './secuencia-durar-mas';
import { markSecuenciaDurarMas, readEstadosDurarMas } from './sheets-durar-mas';
import {
  buildFirmeSeguroMail,
  FIRMESEGURO_SENDER_SECUENCIA,
  FIRMESEGURO_TAG,
} from './secuencia-firme-seguro';
import { markSecuenciaFirmeSeguro } from './sheets-firme-seguro';
import {
  buildComboMail,
  COMBO_SENDER_SECUENCIA,
  COMBO_TAG,
} from './secuencia-combo';
import { markSecuenciaCombo } from './sheets-combo';
import {
  buildRescateMail,
  diasArtEntre,
  esDomingoART,
  RESCATE_KIND,
  RESCATE_SENDER,
  RESCATE_STEPS,
  RESCATE_TAG,
  type RescateStep,
} from './secuencia-rescate-a';

// ─── Sequence definitions ───────────────────────────────────────────
// Each step: { templateId, delayDays } where delayDays is from subscription date
interface DripStep {
  templateId: number;
  delayDays: number;
  subject: string; // for logging/debugging
}

interface DripSequence {
  steps: DripStep[];
}

// Template IDs from Brevo (created via scripts/create-brevo-templates.py)
const SEQUENCES: Partial<Record<LeadTag, DripSequence>> = {
  'lead-magnet-ep': {
    steps: [
      { templateId: 88, delayDays: 0, subject: 'EP Email 1: Entrega PDF' },
      { templateId: 89, delayDays: 3, subject: 'EP Email 2: Valor + ciclo' },
      { templateId: 90, delayDays: 7, subject: 'EP Email 3: Oferta' },
    ],
  },
  'lead-magnet-preservativo': {
    steps: [
      { templateId: 91, delayDays: 0, subject: 'Preservativo Email 1: PDF' },
      { templateId: 92, delayDays: 3, subject: 'Preservativo Email 2: Insight' },
      { templateId: 93, delayDays: 7, subject: 'Preservativo Email 3: Curso' },
    ],
  },
  'waitlist-programa': {
    steps: [
      { templateId: 94, delayDays: 0, subject: 'Waitlist Email 1: Confirmación' },
    ],
  },
  'lead-magnet-5h': {
    steps: [
      { templateId: 157, delayDays: 0, subject: '5H Email 1: Entrega PDF' },
      { templateId: 153, delayDays: 2, subject: '5H Email 2: Historia personal' },
      { templateId: 154, delayDays: 4, subject: '5H Email 3: Ciclo ansiedad' },
      { templateId: 155, delayDays: 6, subject: '5H Email 4: El programa' },
      { templateId: 156, delayDays: 8, subject: '5H Email 5: Cierre + waitlist' },
    ],
  },
  // general: no drip sequence
};

// ─── Scheduled email entry ──────────────────────────────────────────
interface ScheduledEmail {
  id: string;
  email: string;
  name?: string;
  tag: string;
  stepIndex: number;
  templateId: number; // 0 para la secuencia post-Typeform (mail inline)
  subject: string;
  sendAt: string; // ISO date
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  createdAt: string;
  sentAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  error?: string;
  // ── Secuencias inline (mails plain sin template de Brevo) ──
  kind?: 'template' | 'secuencia' | 'recupero' | 'durar-mas' | 'firme-seguro' | 'combo' | 'rescate-a'; // undefined = 'template' (retrocompat)
  seqStep?: number; // secuencia: 1..8 (M1..M8) · durar-mas: 1..2 (ep1, ep2; legado 1..6 dm1..dm6) · firme-seguro: 1..5 (fs1..fs5) · combo: 1..5 (ei1..ei5) · rescate-a: 2..4 (R2..R4)
  seqVersion?: number; // durar-mas: 3 = secuencia v3 (30/09/2026, ep1/ep2). Sin versión = entry legado dm1..dm6 (se cancela sola)
  mailVariant?: MailVariant; // legado: variante del M1 viejo (A/B)
  seqTrack?: SeqTrack; // secuencia v6 (24/09/2026): 'A' (día 1, día 4) · 'B' (día 3). Sin track = entry legado M1..M8
  rescateVariante?: string; // rescate-a: valor de la columna Variante del CRM (PD de R3)
  rescateRowIndex?: number; // rescate-a: fila del CRM evaluada al enrolar (Estado + marca)
  attempts?: number; // rescate-a: intentos de envío (reintento de 'failed' hasta RESCATE_MAX_ATTEMPTS)
  // ── Recupero de carrito (R1/R2) ──
  orderId?: string;
  orderKey?: string; // link "pagar pedido" mientras el pedido siga pendiente
  productId?: number; // producto-curso del pedido (link add-to-cart si ya se canceló)
  curso?: string; // nombre del curso para el copy
}

const DRIP_QUEUE_KEY = 'drip:queue';
const DRIP_SENT_KEY = 'drip:sent';

// ─── Recupero de carrito (T9) ───────────────────────────────────────
export const RECUPERO_TAG = 'recupero-carrito';
// Dos mails: R1 a la hora y R2 a las 20 h. WooCommerce ("Mantener stock" = 1440)
// cancela el pedido pendiente a las 24 h, así el link "pagar pedido" sigue vivo en los dos.
const RECUPERO_DELAYS_MS: Record<1 | 2, number> = { 1: 60 * 60 * 1000, 2: 20 * 60 * 60 * 1000 };
const PEDIDO_PAGADO = new Set(['processing', 'completed']);
const PEDIDO_PAGABLE = new Set(['pending', 'on-hold', 'failed']);

/** Lectura mínima del pedido en WooCommerce (status + order_key). null si falla o sin credenciales. */
async function estadoPedidoLite(orderId: string): Promise<{ status: string; order_key?: string } | null> {
  const user = process.env.WP_USER || '';
  const pass = process.env.WP_APP_PASSWORD || '';
  if (!user || !pass) return null;
  try {
    const res = await fetch(`https://urologia.ar/wp-json/wc/v3/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const o = (await res.json()) as { status?: string; order_key?: string };
    return o.status ? { status: o.status, order_key: o.order_key } : null;
  } catch {
    return null;
  }
}

/** Link del mail: "pagar pedido" del mismo pedido si sigue pendiente; si no, carrito con el curso. */
function linkRecupero(entry: ScheduledEmail, pedido: { status: string; order_key?: string } | null): string {
  const paso = entry.seqStep === 2 ? 2 : 1;
  const key = pedido?.order_key || entry.orderKey;
  if (pedido && PEDIDO_PAGABLE.has(pedido.status) && entry.orderId && key) {
    return `https://urologia.ar/finalizar-compra/order-pay/${entry.orderId}/?pay_for_order=true&key=${encodeURIComponent(key)}&mseq=rec${paso}`;
  }
  return `https://urologia.ar/carrito/?add-to-cart=${entry.productId || 3740}&mseq=rec${paso}`;
}
// Dedupe por email: máximo 1 recupero cada 30 días.
const RECUPERO_DEDUPE_PREFIX = 'recupero-dedupe:';
const RECUPERO_DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 días

// Tope de envíos de secuencia por corrida de cron (protege el timeout de 60s de
// la función; el resto queda 'pending' y sale en la próxima corrida). Configurable.
const MAX_SECUENCIA_SENDS_PER_RUN =
  parseInt(process.env.SECUENCIA_MAX_PER_RUN || '', 10) || 150;

// Tope propio del rescate tier A por corrida (RESCATE_MAX_PER_RUN, default 300).
// Cap propio y procesado al final: un lote grande de rescate (cientos de R2 el
// mismo día) no deja sin cupo a las otras secuencias. Los envíos van en paralelo
// (RESCATE_CONCURRENCY grupos por email) y el deadline del motor corta antes del
// maxDuration, así que 300 entra cómodo en la corrida de 300 s del cron.
const MAX_RESCATE_SENDS_PER_RUN = parseInt(process.env.RESCATE_MAX_PER_RUN || '', 10) || 300;
const RESCATE_CONCURRENCY = parseInt(process.env.RESCATE_CONCURRENCY || '', 10) || 5;
// Reintentos de un envío 'failed' (Brevo 5xx/429, timeout): hasta 2 intentos en
// corridas distintas. Agotados → los pasos siguientes se cancelan (previo-fallido).
const RESCATE_MAX_ATTEMPTS = 2;
// Gap mínimo (días de calendario ART) entre un paso y el siguiente de la misma
// persona: aunque R2 y R3 estén vencidos (backlog del cap o cron perdido) nunca
// salen el mismo día ni en días consecutivos.
const RESCATE_MIN_GAP_DIAS = 2;
// Marcas del Sheet: flush cada N envíos (no sólo al final) para no perder el
// registro si la función muere a mitad de la corrida.
const RESCATE_SHEET_FLUSH_EVERY = 25;

// Lock de la corrida del cron send-emails (evita dos corridas solapadas leyendo
// la misma cola: cron de Vercel + curl manual, o un reintento).
const DRIP_LOCK_KEY = 'lock:send-emails';
const DRIP_LOCK_TTL_S = 330; // > maxDuration 300 del cron
// Deadline de trabajo del motor (maxDuration 300 s del cron send-emails): lo que
// no entra queda pending y sale en la próxima corrida, en vez de que Vercel mate
// la función a mitad de un envío (mail salido + entry sin marcar).
const DRIP_DEADLINE_MS = parseInt(process.env.DRIP_DEADLINE_MS || '', 10) || 250_000;

// ─── Brevo transactional email sender ───────────────────────────────
const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY || ''
);

async function sendTemplate(
  templateId: number,
  email: string,
  name?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.templateId = templateId;
    sendEmail.to = [{ email, name: name || undefined }];

    const result = await transacApi.sendTransacEmail(sendEmail);
    return { success: true, messageId: result.body?.messageId };
  } catch (error: unknown) {
    const apiError = error as { response?: { body?: { message?: string } }; message?: string };
    console.error('Brevo send error:', apiError.response?.body || apiError.message);
    return {
      success: false,
      error: apiError.response?.body?.message || apiError.message || 'Unknown error',
    };
  }
}

/**
 * Envía un mail plain-text de la secuencia post-Typeform (mail "casero" de
 * mauro@). Usa la REST API directa (mismo patrón que webhook/typeform): sender
 * y reply-to mauro@, sólo textContent → Brevo no reescribe los links, así el
 * click tracking queda OFF y los ?mseq=sqN llegan intactos.
 */
/** URL firmada de baja (HMAC con API_SECRET_KEY). '' si falta el secret. */
export function buildUnsubscribeUrl(email: string): string {
  const secret = process.env.API_SECRET_KEY;
  if (!secret) return '';
  const e = email.toLowerCase().trim();
  const t = createHmac('sha256', secret).update(e).digest('hex').slice(0, 32);
  const base = process.env.PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';
  return `${base}/api/unsubscribe?e=${encodeURIComponent(e)}&t=${t}`;
}

/**
 * Convierte el texto plano del mail a HTML mínimo indistinguible del plain
 * (Arial 15px, sin branding) + pie de baja chiquito y separado.
 */
export function plainToHtml(text: string, unsubUrl: string): string {
  const esc = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linkify = (t: string) =>
    t.replace(
      /(https?:\/\/[^\s]+)/g,
      '<a href="$1" style="color:#0b57d0">$1</a>'
    );
  const paras = text
    .trim()
    .split(/\n\n+/)
    .map(
      (par) =>
        `<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#313131">${linkify(esc(par)).replace(/\n/g, '<br>')}</p>`
    )
    .join('');
  const footer = unsubUrl
    ? `<p style="margin:44px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#a8a8a8">Si no quer\u00e9s recibir m\u00e1s estos mails, <a href="${unsubUrl}" style="color:#a8a8a8">date de baja ac\u00e1</a>.</p>`
    : '';
  return `<div style="max-width:600px">${paras}${footer}</div>`;
}

export async function sendPlainSecuencia(
  email: string,
  name: string | undefined,
  subject: string,
  text: string,
  sender: { name: string; email: string } = SECUENCIA_SENDER
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { success: false, error: 'BREVO_API_KEY missing' };

  // Header de baja invisible: el cuerpo queda humano, Gmail/Outlook muestran
  // su propio "darse de baja" y el click corta la secuencia (blacklist Brevo).
  const unsubUrl = buildUnsubscribeUrl(email);
  const body = {
    sender,
    to: [{ email, name: name || undefined }],
    replyTo: { email: sender.email },
    subject,
    textContent: unsubUrl
      ? `${text}\n\n--\nSi no quer\u00e9s recibir m\u00e1s estos mails, date de baja ac\u00e1: ${unsubUrl}`
      : text,
    htmlContent: plainToHtml(text, unsubUrl),
    headers: unsubUrl
      ? {
          'List-Unsubscribe': `<${unsubUrl}>, <mailto:${sender.email}?subject=baja>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : undefined,
  };

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 201) {
      const data = (await res.json()) as { messageId?: string };
      return { success: true, messageId: data.messageId };
    }
    return { success: false, error: `Brevo send ${res.status}: ${await res.text()}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Start a drip sequence for a new subscriber.
 * Sends Email 1 immediately, schedules the rest.
 */
export async function startDripSequence(
  email: string,
  tag: LeadTag,
  name?: string
): Promise<{ started: boolean; emailsSent: number; emailsScheduled: number }> {
  const sequence = SEQUENCES[tag];
  if (!sequence) {
    return { started: false, emailsSent: 0, emailsScheduled: 0 };
  }

  // Always send - no deduplication (user may re-request the guide)

  const now = new Date();
  let emailsSent = 0;
  let emailsScheduled = 0;

  // FIRST: schedule all future emails (so they're queued even if immediate send fails)
  for (let i = 0; i < sequence.steps.length; i++) {
    const step = sequence.steps[i];
    if (step.delayDays === 0) continue; // handle immediate separately below

    try {
      const sendAt = new Date(now.getTime() + step.delayDays * 24 * 60 * 60 * 1000);
      const scheduled: ScheduledEmail = {
        id: `drip_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        email,
        name,
        tag,
        stepIndex: i,
        templateId: step.templateId,
        subject: step.subject,
        sendAt: sendAt.toISOString(),
        status: 'pending',
        createdAt: now.toISOString(),
      };

      await kv.hset(DRIP_QUEUE_KEY, { [scheduled.id]: JSON.stringify(scheduled) });
      emailsScheduled++;
      console.log(`Drip scheduled: ${step.subject} → ${email} at ${sendAt.toISOString()}`);
    } catch (err) {
      console.error(`Drip schedule error for step ${i}:`, err);
    }
  }

  // THEN: send immediate emails (Email 1)
  for (const step of sequence.steps) {
    if (step.delayDays !== 0) continue;

    try {
      const result = await sendTemplate(step.templateId, email, name);
      if (result.success) {
        emailsSent++;
        console.log(`Drip sent: ${step.subject} → ${email}`);
      } else {
        console.error(`Drip send failed: ${step.subject} → ${email}: ${result.error}`);
      }
    } catch (err) {
      console.error(`Drip send error: ${step.subject} → ${email}:`, err);
    }
  }

  // Log drip start
  console.log(`Drip sequence completed for ${email} / ${tag}: ${emailsSent} sent, ${emailsScheduled} scheduled`);

  return { started: true, emailsSent, emailsScheduled };
}

// ─── Secuencia post-Typeform ────────────────────────────────────────

/** Set de emails con al menos un mail de secuencia pendiente (para dedupe). */
export async function getEnrolledSecuenciaEmails(): Promise<Set<string>> {
  const all = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);
  const set = new Set<string>();
  if (!all) return set;
  for (const json of Object.values(all)) {
    const e: ScheduledEmail = typeof json === 'string' ? JSON.parse(json) : json;
    if (e.kind === 'secuencia' && e.status === 'pending') {
      set.add((e.email || '').trim().toLowerCase());
    }
  }
  return set;
}

/**
 * Enrola un email en la secuencia post-test corta (v6, 24/09/2026).
 * `dates` = instantes de cada paso ya calculados por el caller
 * (computeSequenceDates(testAt, track)): A → [día 1, día 4] · B → [día 3].
 * El mail 0 NO se encola acá: es el mail inmediato del post-test.
 *
 * @param alreadyEnrolled set opcional para dedupe en bulk (evita re-encolar).
 */
export async function enrollSecuencia(params: {
  email: string;
  name?: string;
  track: SeqTrack;
  dates: Date[];
  alreadyEnrolled?: Set<string>;
}): Promise<{ scheduled: number; skipped?: 'already-enrolled' | 'bad-dates' }> {
  const email = (params.email || '').trim().toLowerCase();
  if (params.dates.length === 0) return { scheduled: 0, skipped: 'bad-dates' };
  if (params.alreadyEnrolled?.has(email)) return { scheduled: 0, skipped: 'already-enrolled' };

  const now = new Date().toISOString();
  const fields: Record<string, string> = {};

  for (let i = 0; i < params.dates.length; i++) {
    const seqStep = i + 1;
    const { subject } = buildSecuenciaMail(seqStep, params.name || '', params.track);
    const entry: ScheduledEmail = {
      id: `sq_${Date.now()}_${params.track}${seqStep}_${Math.random().toString(36).slice(2, 8)}`,
      email,
      name: params.name,
      tag: SECUENCIA_TAG,
      stepIndex: seqStep,
      templateId: 0,
      subject,
      sendAt: params.dates[i].toISOString(),
      status: 'pending',
      createdAt: now,
      kind: 'secuencia',
      seqStep,
      seqTrack: params.track,
    };
    fields[entry.id] = JSON.stringify(entry);
  }

  // Un solo hset con todos los pasos.
  await kv.hset(DRIP_QUEUE_KEY, fields);

  params.alreadyEnrolled?.add(email);
  console.log(`Secuencia enrolada: ${email} (track ${params.track}, ${params.dates.length} mails)`);
  return { scheduled: params.dates.length };
}

interface SecuenciaRunResult {
  processed: number;
  sent: number;
  failed: number;
  cancelled: number;
  deferred: number; // pospuestos (orden estricto o cap) → siguen pending
}

/**
 * Procesa los mails de secuencia vencidos. Re-chequea exclusiones ANTES de cada
 * envío (cliente / blacklist / Estado del CRM) con UNA sola lectura del Sheet y
 * del mapa de clientes por corrida. Respeta el orden estricto N-1→N y registra
 * cada envío en la columna Secuencia del Sheet.
 */
async function processSecuenciaDue(
  due: Array<{ id: string; entry: ScheduledEmail }>,
  allEntries: Array<{ id: string; entry: ScheduledEmail }>,
  now: Date
): Promise<SecuenciaRunResult> {
  const res: SecuenciaRunResult = { processed: 0, sent: 0, failed: 0, cancelled: 0, deferred: 0 };

  // Caches por corrida (una sola lectura cara de cada fuente).
  let clientesMap: ClientesMap | null = null;
  try {
    clientesMap = await getClientes();
  } catch (err) {
    console.warn('Secuencia: no se pudo cargar el mapa de clientes (fail-open):', err);
  }

  let snap: CrmSnapshot | null = null;
  const rowsByEmail = new Map<string, CrmRow[]>();
  try {
    snap = await readCrmSheet();
    for (const row of snap.rows) {
      if (!row.email) continue;
      const list = rowsByEmail.get(row.email);
      if (list) list.push(row);
      else rowsByEmail.set(row.email, [row]);
    }
  } catch (err) {
    console.warn('Secuencia: no se pudo leer el Sheet CRM (Estado/registro best-effort):', err);
  }

  const blCache = new Map<string, boolean>();
  const blacklisted = async (email: string): Promise<boolean> => {
    const cached = blCache.get(email);
    if (cached !== undefined) return cached;
    const v = await isEmailBlacklisted(email);
    blCache.set(email, v);
    return v;
  };

  // Índice email → (step → entry) para el guard de orden estricto.
  const stepsByEmail = new Map<string, Map<number, ScheduledEmail>>();
  for (const { entry } of allEntries) {
    if (entry.kind !== 'secuencia' || !entry.seqStep) continue;
    const em = (entry.email || '').trim().toLowerCase();
    let m = stepsByEmail.get(em);
    if (!m) { m = new Map(); stepsByEmail.set(em, m); }
    m.set(entry.seqStep, entry);
  }

  // Orden determinístico: por fecha de envío y luego por paso.
  const ordered = [...due].sort((a, b) => {
    const t = new Date(a.entry.sendAt).getTime() - new Date(b.entry.sendAt).getTime();
    return t !== 0 ? t : (a.entry.seqStep || 0) - (b.entry.seqStep || 0);
  });

  const sheetMarks: Array<{ rowIndex: number; text: string }> = [];

  const cancel = async (id: string, entry: ScheduledEmail, reason: string) => {
    entry.status = 'cancelled';
    entry.cancelledAt = now.toISOString();
    entry.cancelReason = reason;
    await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
    res.cancelled++;
    console.log(`Secuencia cancelada (${reason}): ${entry.subject} → ${entry.email}`);
  };

  for (const { id, entry } of ordered) {
    const email = (entry.email || '').trim().toLowerCase();
    const step = entry.seqStep || 0;

    // Cap de envíos por corrida: lo que no entra queda pending.
    if (res.sent >= MAX_SECUENCIA_SENDS_PER_RUN) {
      res.deferred++;
      continue;
    }

    // ── Re-chequeo de exclusiones (antes de CADA envío) ──
    if (clientesMap && (await esCliente(email, clientesMap))) {
      await cancel(id, entry, 'cliente');
      continue;
    }
    if (isSecuenciaExcluido(email)) {
      await cancel(id, entry, 'excluido-1a1');
      continue;
    }
    const rows = rowsByEmail.get(email) || [];
    if (rows.some((r) => estadoPausaSecuencia(r.estado))) {
      await cancel(id, entry, 'estado-crm');
      continue;
    }
    if (await blacklisted(email)) {
      await cancel(id, entry, 'blacklist');
      continue;
    }
    // ── Entries de la secuencia vieja (M2..M8, sin track): se cancelan. El M1
    //    viejo (step 1) sale con el texto nuevo "¿la pudiste ver?" (track A). ──
    if (!entry.seqTrack && step >= 2) {
      await cancel(id, entry, 'secuencia-legacy');
      continue;
    }

    // ── Orden estricto: no sale M_N si no salió M_(N-1) ──
    if (step >= 2) {
      const prev = stepsByEmail.get(email)?.get(step - 1);
      if (prev?.status === 'cancelled') {
        await cancel(id, entry, 'previo-cancelado');
        continue;
      }
      if (!prev || prev.status !== 'sent') {
        // el previo aún no se envió (o falló) → posponer este paso
        res.deferred++;
        continue;
      }
    }

    // ── Envío ──
    res.processed++;
    const mail = buildSecuenciaMail(step, entry.name || '', entry.seqTrack || 'A');
    const result = await sendPlainSecuencia(email, entry.name, mail.subject, mail.text);

    if (result.success) {
      res.sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      const marca = `sq${entry.seqTrack === 'B' ? 'b' : ''}${step}`;
      console.log(`Secuencia enviada: ${marca} → ${email}`);
      // Registro en el Sheet (marca sqN / sqbN enviado dd/mm) sobre la primera fila.
      const row = rows[0];
      if (row) sheetMarks.push({ rowIndex: row.rowIndex, text: `${marca} enviado ${fechaArgDDMM(now)}` });
    } else {
      res.failed++;
      entry.status = 'failed';
      entry.error = result.error;
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.error(`Secuencia falló: sq${step} → ${email}: ${result.error}`);
    }
  }

  // Registro en el Sheet en un solo batch.
  if (snap && sheetMarks.length > 0) {
    try {
      await writeSecuenciaMarks(snap, sheetMarks);
    } catch (err) {
      console.error('Secuencia: no se pudo registrar en el Sheet (non-blocking):', err);
    }
  }

  return res;
}

// ─── Secuencia "Durar más" (curso EP) ───────────────────────────────

/**
 * Set de emails que ya tienen entries durar-mas en la cola (CUALQUIER status,
 * no sólo pending): un lead que re-envía el formulario después de terminar la
 * secuencia no debe recibirla de nuevo.
 */
async function getEnrolledDurarMasEmails(): Promise<Set<string>> {
  const all = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);
  const set = new Set<string>();
  if (!all) return set;
  for (const json of Object.values(all)) {
    const e: ScheduledEmail = typeof json === 'string' ? JSON.parse(json) : json;
    if (e.kind === 'durar-mas') {
      set.add((e.email || '').trim().toLowerCase());
    }
  }
  return set;
}

/**
 * Enrola un email en la secuencia durar-mas v3 (ep1 día 1, ep2 día 4).
 * `dates` = instantes ya calculados por el caller (computeDurarMasDates).
 * El mail de entrega NO se encola acá: es el mail inmediato del endpoint
 * /api/form/durar-mas.
 */
export async function enrollDurarMas(params: {
  email: string;
  name?: string;
  dates: Date[]; // length DURARMAS_OFFSETS_DIAS.length (ep1, ep2)
}): Promise<{ scheduled: number; skipped?: 'already-enrolled' | 'bad-dates' }> {
  const email = (params.email || '').trim().toLowerCase();
  if (params.dates.length !== DURARMAS_OFFSETS_DIAS.length) return { scheduled: 0, skipped: 'bad-dates' };

  const enrolled = await getEnrolledDurarMasEmails();
  if (enrolled.has(email)) return { scheduled: 0, skipped: 'already-enrolled' };

  const now = new Date().toISOString();
  const fields: Record<string, string> = {};

  for (let i = 0; i < params.dates.length; i++) {
    const seqStep = i + 1; // ep1, ep2
    const { subject } = buildDurarMasMail(seqStep, params.name);
    const entry: ScheduledEmail = {
      id: `dm_${Date.now()}_${seqStep}_${Math.random().toString(36).slice(2, 8)}`,
      email,
      name: params.name,
      tag: DURARMAS_TAG,
      stepIndex: seqStep,
      templateId: 0,
      subject,
      sendAt: params.dates[i].toISOString(),
      status: 'pending',
      createdAt: now,
      kind: 'durar-mas',
      seqStep,
      seqVersion: DURARMAS_SEQ_VERSION,
    };
    fields[entry.id] = JSON.stringify(entry);
  }

  // Un solo hset con todos los pasos.
  await kv.hset(DRIP_QUEUE_KEY, fields);

  console.log(`Durar-mas enrolado: ${email} (${params.dates.length} mails)`);
  return { scheduled: params.dates.length };
}

interface DurarMasRunResult {
  processed: number;
  sent: number;
  failed: number;
  cancelled: number;
  deferred: number; // pospuestos (orden estricto o cap) → siguen pending
}

/**
 * Procesa los mails durar-mas vencidos — versión simplificada de
 * processSecuenciaDue (sin Sheet CRM ni exclusión 1-a-1). Re-chequea ANTES de
 * cada envío: cliente (getClientes incluye a los compradores del curso EP) y
 * blacklist Brevo → cancela. El dm6 además se cancela si el lead ya clickeó
 * algún mail de la serie (regla retirada en la v3; el ep2 se corta por Estado del CRM: ya evaluó
 * la landing, perseguirlo de nuevo con el mismo pitch no suma). Respeta el
 * orden estricto dm(N-1)→dm(N). Envía
 * desde info@ (DURARMAS_SENDER_SECUENCIA) y registra cada envío en el Sheet de
 * leads durar-mas (best-effort).
 *
 * @param budget envíos disponibles en esta corrida (cap compartido con la
 *   secuencia post-Typeform: MAX_SECUENCIA_SENDS_PER_RUN menos lo ya enviado).
 */
async function processDurarMasDue(
  due: Array<{ id: string; entry: ScheduledEmail }>,
  allEntries: Array<{ id: string; entry: ScheduledEmail }>,
  now: Date,
  budget: number
): Promise<DurarMasRunResult> {
  const res: DurarMasRunResult = { processed: 0, sent: 0, failed: 0, cancelled: 0, deferred: 0 };

  // Cache por corrida (una sola lectura cara del mapa de clientes).
  let clientesMap: ClientesMap | null = null;
  try {
    clientesMap = await getClientes();
  } catch (err) {
    console.warn('Durar-mas: no se pudo cargar el mapa de clientes (fail-open):', err);
  }

  // Estados del CRM (col F), una sola lectura por corrida y sólo si hace falta.
  let estados: Map<string, string> | null | undefined;

  const blCache = new Map<string, boolean>();
  const blacklisted = async (email: string): Promise<boolean> => {
    const cached = blCache.get(email);
    if (cached !== undefined) return cached;
    const v = await isEmailBlacklisted(email);
    blCache.set(email, v);
    return v;
  };

  // Índice email → (step → entry) para el guard de orden estricto.
  const stepsByEmail = new Map<string, Map<number, ScheduledEmail>>();
  for (const { entry } of allEntries) {
    if (entry.kind !== 'durar-mas' || !entry.seqStep) continue;
    const em = (entry.email || '').trim().toLowerCase();
    let m = stepsByEmail.get(em);
    if (!m) { m = new Map(); stepsByEmail.set(em, m); }
    m.set(entry.seqStep, entry);
  }

  // Orden determinístico: por fecha de envío y luego por paso.
  const ordered = [...due].sort((a, b) => {
    const t = new Date(a.entry.sendAt).getTime() - new Date(b.entry.sendAt).getTime();
    return t !== 0 ? t : (a.entry.seqStep || 0) - (b.entry.seqStep || 0);
  });

  const cancel = async (id: string, entry: ScheduledEmail, reason: string) => {
    entry.status = 'cancelled';
    entry.cancelledAt = now.toISOString();
    entry.cancelReason = reason;
    await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
    res.cancelled++;
    console.log(`Durar-mas cancelado (${reason}): ${entry.subject} → ${entry.email}`);
  };

  for (const { id, entry } of ordered) {
    const email = (entry.email || '').trim().toLowerCase();
    const step = entry.seqStep || 0;

    // Cap de envíos por corrida: lo que no entra queda pending.
    if (res.sent >= budget) {
      res.deferred++;
      continue;
    }

    // ── Legado v2 (dm1..dm6, sin seqVersion): la v3 del 30/09/2026 los reemplaza ──
    if (entry.seqVersion !== DURARMAS_SEQ_VERSION || step > DURARMAS_OFFSETS_DIAS.length) {
      await cancel(id, entry, 'secuencia-legacy');
      continue;
    }

    // ── Re-chequeo de exclusiones (antes de CADA envío) ──
    if (clientesMap && (await esCliente(email, clientesMap))) {
      await cancel(id, entry, 'cliente');
      continue;
    }
    if (await blacklisted(email)) {
      await cancel(id, entry, 'blacklist');
      continue;
    }

    // ── Orden: ep2 espera a que ep1 haya salido. Un ep1 'failed' NO bloquea
    // (en agosto de 2026 la regla estricta congeló 223 leads tras un corte de
    // créditos de Brevo); un ep1 cancelado sí corta el resto. ──
    if (step >= 2) {
      const prev = stepsByEmail.get(email)?.get(step - 1);
      if (prev?.status === 'cancelled') {
        await cancel(id, entry, 'previo-cancelado');
        continue;
      }
      if (!prev || prev.status === 'pending') {
        res.deferred++;
        continue;
      }
    }

    // ── ep2 sólo si nadie respondió / gestionó al lead (Estado del CRM).
    // Pedido de Mauro 30/09/2026: quien responde el mail 0 o el 1 no recibe el 2.
    // Un acuse trivial ("Recibido — gracias") no corta. Fail-open si el Sheet falla. ──
    if (step === DURARMAS_OFFSETS_DIAS.length) {
      if (estados === undefined) estados = await readEstadosDurarMas();
      if (estadoCortaDurarMas(estados?.get(email))) {
        await cancel(id, entry, 'estado-crm');
        continue;
      }
    }

    // ── Envío ──
    res.processed++;
    const mail = buildDurarMasMail(step, entry.name);
    const result = await sendPlainSecuencia(
      email,
      entry.name,
      mail.subject,
      mail.text,
      DURARMAS_SENDER_SECUENCIA
    );

    if (result.success) {
      res.sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.log(`Durar-mas enviado: ep${step} → ${email}`);
      // Registro en el Sheet de leads (markSecuenciaDurarMas nunca lanza).
      await markSecuenciaDurarMas(email, `ep${step} enviado ${fechaArgDDMM(now)}`);
    } else {
      res.failed++;
      entry.status = 'failed';
      entry.error = result.error;
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.error(`Durar-mas falló: ep${step} → ${email}: ${result.error}`);
    }
  }

  return res;
}

// ─── Secuencia "Firme y Seguro" (curso Erección con Preservativo) ───

/**
 * Set de emails que ya tienen entries firme-seguro en la cola (CUALQUIER
 * status, no sólo pending): un lead que re-envía el formulario después de
 * terminar la secuencia no debe recibirla de nuevo.
 */
async function getEnrolledFirmeSeguroEmails(): Promise<Set<string>> {
  const all = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);
  const set = new Set<string>();
  if (!all) return set;
  for (const json of Object.values(all)) {
    const e: ScheduledEmail = typeof json === 'string' ? JSON.parse(json) : json;
    if (e.kind === 'firme-seguro') {
      set.add((e.email || '').trim().toLowerCase());
    }
  }
  return set;
}

/**
 * Enrola un email en la secuencia firme-y-seguro (fs1..fs5).
 * `dates` = 5 instantes ya calculados por el caller (computeFirmeSeguroDates).
 * El mail de entrega NO se encola acá: es el mail inmediato del endpoint
 * /api/form/firme-y-seguro.
 */
export async function enrollFirmeSeguro(params: {
  email: string;
  name?: string;
  dates: Date[]; // length 5, fs1..fs5
}): Promise<{ scheduled: number; skipped?: 'already-enrolled' | 'bad-dates' }> {
  const email = (params.email || '').trim().toLowerCase();
  if (params.dates.length !== 5) return { scheduled: 0, skipped: 'bad-dates' };

  const enrolled = await getEnrolledFirmeSeguroEmails();
  if (enrolled.has(email)) return { scheduled: 0, skipped: 'already-enrolled' };

  const now = new Date().toISOString();
  const fields: Record<string, string> = {};

  for (let i = 0; i < 5; i++) {
    const seqStep = i + 1; // fs1..fs5
    const { subject } = buildFirmeSeguroMail(seqStep, params.name);
    const entry: ScheduledEmail = {
      id: `fs_${Date.now()}_${seqStep}_${Math.random().toString(36).slice(2, 8)}`,
      email,
      name: params.name,
      tag: FIRMESEGURO_TAG,
      stepIndex: seqStep,
      templateId: 0,
      subject,
      sendAt: params.dates[i].toISOString(),
      status: 'pending',
      createdAt: now,
      kind: 'firme-seguro',
      seqStep,
    };
    fields[entry.id] = JSON.stringify(entry);
  }

  // Un solo hset con los 5 pasos.
  await kv.hset(DRIP_QUEUE_KEY, fields);

  console.log(`Firme-seguro enrolado: ${email} (5 mails)`);
  return { scheduled: 5 };
}

/**
 * Procesa los mails firme-seguro vencidos — espejo de processDurarMasDue.
 * Re-chequea ANTES de cada envío: cliente (getClientes incluye a los
 * compradores del curso 1043) y blacklist Brevo → cancela. Respeta el orden
 * estricto fs(N-1)→fs(N). Envía desde info@ (FIRMESEGURO_SENDER_SECUENCIA) y
 * registra cada envío en el Sheet de leads firme-seguro (best-effort).
 *
 * @param budget envíos disponibles en esta corrida (cap compartido con las
 *   otras secuencias plain: MAX_SECUENCIA_SENDS_PER_RUN menos lo ya enviado).
 */
async function processFirmeSeguroDue(
  due: Array<{ id: string; entry: ScheduledEmail }>,
  allEntries: Array<{ id: string; entry: ScheduledEmail }>,
  now: Date,
  budget: number
): Promise<{ processed: number; sent: number; failed: number; cancelled: number; deferred: number }> {
  const res = { processed: 0, sent: 0, failed: 0, cancelled: 0, deferred: 0 };

  // Cache por corrida (una sola lectura cara del mapa de clientes).
  let clientesMap: ClientesMap | null = null;
  try {
    clientesMap = await getClientes();
  } catch (err) {
    console.warn('Firme-seguro: no se pudo cargar el mapa de clientes (fail-open):', err);
  }

  const blCache = new Map<string, boolean>();
  const blacklisted = async (email: string): Promise<boolean> => {
    const cached = blCache.get(email);
    if (cached !== undefined) return cached;
    const v = await isEmailBlacklisted(email);
    blCache.set(email, v);
    return v;
  };

  // Índice email → (step → entry) para el guard de orden estricto.
  const stepsByEmail = new Map<string, Map<number, ScheduledEmail>>();
  for (const { entry } of allEntries) {
    if (entry.kind !== 'firme-seguro' || !entry.seqStep) continue;
    const em = (entry.email || '').trim().toLowerCase();
    let m = stepsByEmail.get(em);
    if (!m) { m = new Map(); stepsByEmail.set(em, m); }
    m.set(entry.seqStep, entry);
  }

  // Orden determinístico: por fecha de envío y luego por paso.
  const ordered = [...due].sort((a, b) => {
    const t = new Date(a.entry.sendAt).getTime() - new Date(b.entry.sendAt).getTime();
    return t !== 0 ? t : (a.entry.seqStep || 0) - (b.entry.seqStep || 0);
  });

  const cancel = async (id: string, entry: ScheduledEmail, reason: string) => {
    entry.status = 'cancelled';
    entry.cancelledAt = now.toISOString();
    entry.cancelReason = reason;
    await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
    res.cancelled++;
    console.log(`Firme-seguro cancelado (${reason}): ${entry.subject} → ${entry.email}`);
  };

  for (const { id, entry } of ordered) {
    const email = (entry.email || '').trim().toLowerCase();
    const step = entry.seqStep || 0;

    // Cap de envíos por corrida: lo que no entra queda pending.
    if (res.sent >= budget) {
      res.deferred++;
      continue;
    }

    // ── Re-chequeo de exclusiones (antes de CADA envío) ──
    if (clientesMap && (await esCliente(email, clientesMap))) {
      await cancel(id, entry, 'cliente');
      continue;
    }
    if (await blacklisted(email)) {
      await cancel(id, entry, 'blacklist');
      continue;
    }

    // ── Orden estricto: no sale fs_N si no salió fs_(N-1) ──
    if (step >= 2) {
      const prev = stepsByEmail.get(email)?.get(step - 1);
      if (prev?.status === 'cancelled') {
        await cancel(id, entry, 'previo-cancelado');
        continue;
      }
      if (!prev || prev.status !== 'sent') {
        // el previo aún no se envió (o falló) → posponer este paso
        res.deferred++;
        continue;
      }
    }

    // ── Envío ──
    res.processed++;
    const mail = buildFirmeSeguroMail(step, entry.name);
    const result = await sendPlainSecuencia(
      email,
      entry.name,
      mail.subject,
      mail.text,
      FIRMESEGURO_SENDER_SECUENCIA
    );

    if (result.success) {
      res.sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.log(`Firme-seguro enviado: fs${step} → ${email}`);
      // Registro en el Sheet de leads (markSecuenciaFirmeSeguro nunca lanza).
      await markSecuenciaFirmeSeguro(email, `fs${step} enviado ${fechaArgDDMM(now)}`);
    } else {
      res.failed++;
      entry.status = 'failed';
      entry.error = result.error;
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.error(`Firme-seguro falló: fs${step} → ${email}: ${result.error}`);
    }
  }

  return res;
}

// ─── Secuencia "Combo Experto en Intimidad" (programa DE + curso EP) ─

/**
 * Set de emails que ya tienen entries combo en la cola (CUALQUIER status,
 * no sólo pending): un lead que re-envía el formulario después de terminar
 * la secuencia no debe recibirla de nuevo.
 */
async function getEnrolledComboEmails(): Promise<Set<string>> {
  const all = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);
  const set = new Set<string>();
  if (!all) return set;
  for (const json of Object.values(all)) {
    const e: ScheduledEmail = typeof json === 'string' ? JSON.parse(json) : json;
    if (e.kind === 'combo') {
      set.add((e.email || '').trim().toLowerCase());
    }
  }
  return set;
}

/**
 * Enrola un email en la secuencia del combo (ei1..ei5).
 * `dates` = 5 instantes ya calculados por el caller (computeComboDates).
 * El mail de entrega NO se encola acá: es el mail inmediato del endpoint
 * /api/form/experto-en-intimidad.
 */
export async function enrollCombo(params: {
  email: string;
  name?: string;
  dates: Date[]; // length 5, ei1..ei5
}): Promise<{ scheduled: number; skipped?: 'already-enrolled' | 'bad-dates' }> {
  const email = (params.email || '').trim().toLowerCase();
  if (params.dates.length !== 5) return { scheduled: 0, skipped: 'bad-dates' };

  const enrolled = await getEnrolledComboEmails();
  if (enrolled.has(email)) return { scheduled: 0, skipped: 'already-enrolled' };

  const now = new Date().toISOString();
  const fields: Record<string, string> = {};

  for (let i = 0; i < 5; i++) {
    const seqStep = i + 1; // ei1..ei5
    const { subject } = buildComboMail(seqStep, params.name);
    const entry: ScheduledEmail = {
      id: `ei_${Date.now()}_${seqStep}_${Math.random().toString(36).slice(2, 8)}`,
      email,
      name: params.name,
      tag: COMBO_TAG,
      stepIndex: seqStep,
      templateId: 0,
      subject,
      sendAt: params.dates[i].toISOString(),
      status: 'pending',
      createdAt: now,
      kind: 'combo',
      seqStep,
    };
    fields[entry.id] = JSON.stringify(entry);
  }

  // Un solo hset con los 5 pasos.
  await kv.hset(DRIP_QUEUE_KEY, fields);

  console.log(`Combo enrolado: ${email} (5 mails)`);
  return { scheduled: 5 };
}

/**
 * Procesa los mails combo vencidos — espejo de processFirmeSeguroDue.
 * Re-chequea ANTES de cada envío: cliente (getClientes incluye a los
 * compradores del combo 5243, el programa 3740 y el curso EP 3208) y
 * blacklist Brevo → cancela. Respeta el orden estricto ei(N-1)→ei(N).
 * Envía desde mauro@ (COMBO_SENDER_SECUENCIA) y registra cada envío en el
 * Sheet de leads del combo (best-effort).
 *
 * @param budget envíos disponibles en esta corrida (cap compartido con las
 *   otras secuencias plain: MAX_SECUENCIA_SENDS_PER_RUN menos lo ya enviado).
 */
async function processComboDue(
  due: Array<{ id: string; entry: ScheduledEmail }>,
  allEntries: Array<{ id: string; entry: ScheduledEmail }>,
  now: Date,
  budget: number
): Promise<{ processed: number; sent: number; failed: number; cancelled: number; deferred: number }> {
  const res = { processed: 0, sent: 0, failed: 0, cancelled: 0, deferred: 0 };

  // Cache por corrida (una sola lectura cara del mapa de clientes).
  let clientesMap: ClientesMap | null = null;
  try {
    clientesMap = await getClientes();
  } catch (err) {
    console.warn('Combo: no se pudo cargar el mapa de clientes (fail-open):', err);
  }

  const blCache = new Map<string, boolean>();
  const blacklisted = async (email: string): Promise<boolean> => {
    const cached = blCache.get(email);
    if (cached !== undefined) return cached;
    const v = await isEmailBlacklisted(email);
    blCache.set(email, v);
    return v;
  };

  // Índice email → (step → entry) para el guard de orden estricto.
  const stepsByEmail = new Map<string, Map<number, ScheduledEmail>>();
  for (const { entry } of allEntries) {
    if (entry.kind !== 'combo' || !entry.seqStep) continue;
    const em = (entry.email || '').trim().toLowerCase();
    let m = stepsByEmail.get(em);
    if (!m) { m = new Map(); stepsByEmail.set(em, m); }
    m.set(entry.seqStep, entry);
  }

  // Orden determinístico: por fecha de envío y luego por paso.
  const ordered = [...due].sort((a, b) => {
    const t = new Date(a.entry.sendAt).getTime() - new Date(b.entry.sendAt).getTime();
    return t !== 0 ? t : (a.entry.seqStep || 0) - (b.entry.seqStep || 0);
  });

  const cancel = async (id: string, entry: ScheduledEmail, reason: string) => {
    entry.status = 'cancelled';
    entry.cancelledAt = now.toISOString();
    entry.cancelReason = reason;
    await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
    res.cancelled++;
    console.log(`Combo cancelado (${reason}): ${entry.subject} → ${entry.email}`);
  };

  for (const { id, entry } of ordered) {
    const email = (entry.email || '').trim().toLowerCase();
    const step = entry.seqStep || 0;

    // Cap de envíos por corrida: lo que no entra queda pending.
    if (res.sent >= budget) {
      res.deferred++;
      continue;
    }

    // ── Re-chequeo de exclusiones (antes de CADA envío) ──
    if (clientesMap && (await esCliente(email, clientesMap))) {
      await cancel(id, entry, 'cliente');
      continue;
    }
    if (await blacklisted(email)) {
      await cancel(id, entry, 'blacklist');
      continue;
    }

    // ── Orden estricto: no sale ei_N si no salió ei_(N-1) ──
    if (step >= 2) {
      const prev = stepsByEmail.get(email)?.get(step - 1);
      if (prev?.status === 'cancelled') {
        await cancel(id, entry, 'previo-cancelado');
        continue;
      }
      if (!prev || prev.status !== 'sent') {
        // el previo aún no se envió (o falló) → posponer este paso
        res.deferred++;
        continue;
      }
    }

    // ── Envío ──
    res.processed++;
    const mail = buildComboMail(step, entry.name);
    const result = await sendPlainSecuencia(
      email,
      entry.name,
      mail.subject,
      mail.text,
      COMBO_SENDER_SECUENCIA
    );

    if (result.success) {
      res.sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.log(`Combo enviado: ei${step} → ${email}`);
      // Registro en el Sheet de leads (markSecuenciaCombo nunca lanza).
      await markSecuenciaCombo(email, `ei${step} enviado ${fechaArgDDMM(now)}`);
    } else {
      res.failed++;
      entry.status = 'failed';
      entry.error = result.error;
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.error(`Combo falló: ei${step} → ${email}: ${result.error}`);
    }
  }

  return res;
}

// ─── Secuencia de rescate tier A (R2..R4) ───────────────────────────

/**
 * Set de emails con entries rescate-a en la cola (CUALQUIER status, no sólo
 * pending): quien ya pasó por el rescate (enviado, cancelado o pendiente) no
 * se vuelve a enrolar aunque el endpoint se corra de nuevo.
 */
export async function getEnrolledRescateEmails(): Promise<Set<string>> {
  return (await getRescateEnrollmentSets()).rescate;
}

/**
 * Una sola lectura de la cola para el enrolamiento del rescate:
 *   rescate   = emails con entries rescate-a (cualquier status)
 *   secuencia = emails con secuencia post-Typeform pendiente (misma regla que
 *               getEnrolledSecuenciaEmails) → no se enrolan en dos secuencias.
 */
export async function getRescateEnrollmentSets(): Promise<{
  rescate: Set<string>;
  secuencia: Set<string>;
}> {
  const all = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);
  const rescate = new Set<string>();
  const secuencia = new Set<string>();
  if (!all) return { rescate, secuencia };
  for (const json of Object.values(all)) {
    const e: ScheduledEmail = typeof json === 'string' ? JSON.parse(json) : json;
    const em = (e.email || '').trim().toLowerCase();
    if (e.kind === RESCATE_KIND) rescate.add(em);
    else if (e.kind === 'secuencia' && e.status === 'pending') secuencia.add(em);
  }
  return { rescate, secuencia };
}

export interface RescateEnrollParams {
  email: string;
  name?: string;
  variante: string;
  dates: Date[]; // length 3, R2..R4
  rowIndex?: number; // fila del CRM evaluada (Estado + marca del Sheet)
}

/** Entries R2..R4 (pending) de un candidato, listas para el hset. */
function buildRescateEntries(p: RescateEnrollParams, nowIso: string): Record<string, string> {
  const email = (p.email || '').trim().toLowerCase();
  const fields: Record<string, string> = {};
  RESCATE_STEPS.forEach((seqStep, i) => {
    const { subject } = buildRescateMail(seqStep, p.name || '', p.variante);
    const entry: ScheduledEmail = {
      id: `ra_${Date.now()}_${seqStep}_${Math.random().toString(36).slice(2, 8)}`,
      email,
      name: p.name,
      tag: RESCATE_TAG,
      stepIndex: seqStep,
      templateId: 0,
      subject,
      sendAt: p.dates[i].toISOString(),
      status: 'pending',
      createdAt: nowIso,
      kind: RESCATE_KIND,
      seqStep,
      rescateVariante: p.variante || '',
      rescateRowIndex: p.rowIndex,
    };
    fields[entry.id] = JSON.stringify(entry);
  });
  return fields;
}

/**
 * Enrola un email en la secuencia de rescate (R2..R4).
 * `dates` = 3 instantes [R2, R3, R4] ya calculados por el caller
 * (computeRescateDates). R1 NO se encola acá: salió a mano.
 *
 * @param alreadyEnrolled set opcional para dedupe en bulk (evita re-encolar).
 */
export async function enrollRescate(
  params: RescateEnrollParams & { alreadyEnrolled?: Set<string> }
): Promise<{ scheduled: number; skipped?: 'already-enrolled' | 'bad-dates' }> {
  const email = (params.email || '').trim().toLowerCase();
  if (params.dates.length !== RESCATE_STEPS.length) return { scheduled: 0, skipped: 'bad-dates' };
  if (params.alreadyEnrolled?.has(email)) return { scheduled: 0, skipped: 'already-enrolled' };

  // Un solo hset con los 3 pasos.
  await kv.hset(DRIP_QUEUE_KEY, buildRescateEntries(params, new Date().toISOString()));

  params.alreadyEnrolled?.add(email);
  console.log(`Rescate enrolado: ${email} (variante ${params.variante || '-'}, 3 mails)`);
  return { scheduled: RESCATE_STEPS.length };
}

/**
 * Enrolamiento en bulk: agrupa `chunk` candidatos (× 3 entries) por hset →
 * ~16 llamadas a KV para 770 candidatos en vez de 770. Dedupe por
 * `alreadyEnrolled` (se actualiza en el camino) y dentro del propio lote.
 */
export async function enrollRescateBulk(
  candidatos: RescateEnrollParams[],
  alreadyEnrolled: Set<string> = new Set(),
  chunk = 50
): Promise<{ enrolados: number; yaEnrolados: number; badDates: number }> {
  const res = { enrolados: 0, yaEnrolados: 0, badDates: 0 };
  const nowIso = new Date().toISOString();
  let fields: Record<string, string> = {};
  let enChunk = 0;

  const flush = async () => {
    if (enChunk === 0) return;
    await kv.hset(DRIP_QUEUE_KEY, fields);
    res.enrolados += enChunk;
    fields = {};
    enChunk = 0;
  };

  for (const c of candidatos) {
    const email = (c.email || '').trim().toLowerCase();
    if (c.dates.length !== RESCATE_STEPS.length) {
      res.badDates++;
      continue;
    }
    if (alreadyEnrolled.has(email)) {
      res.yaEnrolados++;
      continue;
    }
    Object.assign(fields, buildRescateEntries(c, nowIso));
    alreadyEnrolled.add(email);
    enChunk++;
    if (enChunk >= chunk) await flush();
  }
  await flush();
  console.log(`Rescate enrolado en bulk: ${res.enrolados} (ya enrolados ${res.yaEnrolados})`);
  return res;
}

/**
 * Procesa los mails de rescate vencidos — espejo de processSecuenciaDue con
 * las guardas propias de un lote grande (cientos de R2 el mismo día):
 *   - domingo (calendario ART) → no sale nada (la regla domingo→lunes aplica
 *     también a la cola atrasada);
 *   - Sheet CRM o mapa de clientes inaccesibles → fail-CLOSED (se difiere todo:
 *     el Estado del Sheet es la única señal de que alguien respondió al R2);
 *   - deadline del motor: lo que no entra queda pending;
 *   - orden estricto R(N-1)→R(N) + gap mínimo de RESCATE_MIN_GAP_DIAS días
 *     desde el envío del paso anterior (nunca dos pasos el mismo día);
 *   - entries 'failed' se reintentan hasta RESCATE_MAX_ATTEMPTS; agotados, los
 *     pasos siguientes se cancelan (previo-fallido);
 *   - duplicados (mismo email + paso ya enviado) se cancelan;
 *   - re-chequeos antes de CADA envío: cliente, exclusión 1-a-1, "Estado
 *     seguimiento" NO vacío en la fila del rescate, blacklist Brevo.
 * Envíos en paralelo por grupos de email (RESCATE_CONCURRENCY); dentro de un
 * email siempre secuencial. Marca cada envío en la columna Secuencia
 * ("raN enviado dd/mm") con flush cada RESCATE_SHEET_FLUSH_EVERY envíos.
 *
 * @param budget   envíos disponibles en esta corrida (MAX_RESCATE_SENDS_PER_RUN).
 * @param deadline epoch ms: pasado este instante no se inicia ningún envío más.
 */
async function processRescateDue(
  due: Array<{ id: string; entry: ScheduledEmail }>,
  allEntries: Array<{ id: string; entry: ScheduledEmail }>,
  now: Date,
  budget: number,
  deadline: number
): Promise<SecuenciaRunResult> {
  const res: SecuenciaRunResult = { processed: 0, sent: 0, failed: 0, cancelled: 0, deferred: 0 };

  // Domingo (calendario ART): no se manda nada, ni la cola atrasada.
  if (esDomingoART(now)) {
    console.log(`Rescate: domingo ART, ${due.length} entries diferidas a mañana`);
    res.deferred = due.length;
    return res;
  }

  // Caches por corrida (una sola lectura cara de cada fuente). Fail-closed:
  // sin mapa de clientes o sin Sheet no se manda nada en esta corrida.
  let clientesMap: ClientesMap;
  try {
    clientesMap = await getClientes();
  } catch (err) {
    console.error(`Rescate: no se pudo cargar el mapa de clientes, ${due.length} entries diferidas:`, err);
    res.deferred = due.length;
    return res;
  }

  let snap: CrmSnapshot;
  const rowsByEmail = new Map<string, CrmRow[]>();
  try {
    snap = await readCrmSheet();
    for (const row of snap.rows) {
      if (!row.email) continue;
      const list = rowsByEmail.get(row.email);
      if (list) list.push(row);
      else rowsByEmail.set(row.email, [row]);
    }
  } catch (err) {
    console.error(`Rescate: no se pudo leer el Sheet CRM, ${due.length} entries diferidas:`, err);
    res.deferred = due.length;
    return res;
  }

  const blCache = new Map<string, boolean>();
  const blacklisted = async (email: string): Promise<boolean> => {
    const cached = blCache.get(email);
    if (cached !== undefined) return cached;
    const v = await isEmailBlacklisted(email);
    blCache.set(email, v);
    return v;
  };

  // Índice email → (step → entry canónica) para el guard de orden estricto y
  // el de duplicados. Si hay más de una entry por (email, paso) — doble
  // enrolamiento — gana la 'sent'; entre pendientes, la primera vista.
  const stepsByEmail = new Map<string, Map<number, ScheduledEmail>>();
  for (const { entry } of allEntries) {
    if (entry.kind !== RESCATE_KIND || !entry.seqStep) continue;
    const em = (entry.email || '').trim().toLowerCase();
    let m = stepsByEmail.get(em);
    if (!m) { m = new Map(); stepsByEmail.set(em, m); }
    const cur = m.get(entry.seqStep);
    if (!cur || (cur.status !== 'sent' && entry.status === 'sent')) m.set(entry.seqStep, entry);
  }

  // Orden determinístico: por fecha de envío y luego por paso; después se
  // agrupa por email (grupos en orden de primera aparición).
  const ordered = [...due].sort((a, b) => {
    const t = new Date(a.entry.sendAt).getTime() - new Date(b.entry.sendAt).getTime();
    return t !== 0 ? t : (a.entry.seqStep || 0) - (b.entry.seqStep || 0);
  });
  const groups: Array<Array<{ id: string; entry: ScheduledEmail }>> = [];
  const groupByEmail = new Map<string, Array<{ id: string; entry: ScheduledEmail }>>();
  for (const item of ordered) {
    const em = (item.entry.email || '').trim().toLowerCase();
    let g = groupByEmail.get(em);
    if (!g) { g = []; groupByEmail.set(em, g); groups.push(g); }
    g.push(item);
  }

  const sheetMarks: Array<{ rowIndex: number; text: string }> = [];
  const flushMarks = async () => {
    if (sheetMarks.length === 0) return;
    const batch = sheetMarks.splice(0, sheetMarks.length);
    try {
      await writeSecuenciaMarks(snap, batch);
    } catch (err) {
      console.error(`Rescate: no se pudieron registrar ${batch.length} marcas en el Sheet (non-blocking):`, err);
    }
  };

  const cancel = async (id: string, entry: ScheduledEmail, reason: string) => {
    entry.status = 'cancelled';
    entry.cancelledAt = now.toISOString();
    entry.cancelReason = reason;
    await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
    res.cancelled++;
    console.log(`Rescate cancelado (${reason}): ${entry.subject} → ${entry.email}`);
  };

  let reserved = 0; // cupo reservado (sync) antes de cada envío en paralelo

  const processEntry = async (id: string, entry: ScheduledEmail) => {
    const email = (entry.email || '').trim().toLowerCase();
    const step = entry.seqStep || 0;

    // Deadline del motor y cap de envíos: lo que no entra queda pending.
    if (Date.now() > deadline || reserved >= budget) {
      res.deferred++;
      return;
    }

    // ── Duplicado: otra entry del mismo email + paso ya salió ──
    const canon = stepsByEmail.get(email)?.get(step);
    if (canon && canon !== entry && canon.status === 'sent') {
      await cancel(id, entry, 'duplicado');
      return;
    }

    // ── Re-chequeo de exclusiones (antes de CADA envío) ──
    if (await esCliente(email, clientesMap)) {
      await cancel(id, entry, 'cliente');
      return;
    }
    if (isSecuenciaExcluido(email)) {
      await cancel(id, entry, 'excluido-1a1');
      return;
    }
    const rows = rowsByEmail.get(email) || [];
    // Fila del rescate (la evaluada al enrolar); si no está o cambió de email,
    // se cae a todas las filas del email.
    const propia = entry.rescateRowIndex
      ? rows.find((r) => r.rowIndex === entry.rescateRowIndex)
      : undefined;
    const rowsEstado = propia ? [propia] : rows;
    // Estado seguimiento cargado (cualquier valor) = gestión humana → corta.
    if (rowsEstado.some((r) => (r.estado || '').trim() !== '' || estadoPausaSecuencia(r.estado))) {
      await cancel(id, entry, 'estado-crm');
      return;
    }
    if (await blacklisted(email)) {
      await cancel(id, entry, 'blacklist');
      return;
    }

    // ── Orden estricto: no sale R_N si no salió R_(N-1) (R2 es el primero) ──
    if (step > RESCATE_STEPS[0]) {
      const prev = stepsByEmail.get(email)?.get(step - 1);
      if (prev?.status === 'cancelled') {
        await cancel(id, entry, 'previo-cancelado');
        return;
      }
      if (prev?.status === 'failed' && (prev.attempts || 1) >= RESCATE_MAX_ATTEMPTS) {
        await cancel(id, entry, 'previo-fallido');
        return;
      }
      if (!prev || prev.status !== 'sent') {
        // el previo aún no se envió (o se va a reintentar) → posponer este paso
        res.deferred++;
        return;
      }
      // Gap mínimo desde el envío del paso anterior (nunca el mismo día).
      if (prev.sentAt && diasArtEntre(new Date(prev.sentAt), now) < RESCATE_MIN_GAP_DIAS) {
        res.deferred++;
        return;
      }
    }

    // ── Envío ──
    reserved++;
    res.processed++;
    const attempt = (entry.attempts || 0) + 1;
    const mail = buildRescateMail(step as RescateStep, entry.name || '', entry.rescateVariante || '');
    const result = await sendPlainSecuencia(email, entry.name, mail.subject, mail.text, RESCATE_SENDER);

    entry.attempts = attempt;
    if (result.success) {
      res.sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      entry.error = undefined;
      // Esta entry pasa a ser la canónica del paso (duplicados posteriores se cancelan).
      stepsByEmail.get(email)?.set(step, entry);
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.log(`Rescate enviado: ra${step} → ${email}${attempt > 1 ? ` (intento ${attempt})` : ''}`);
      // Registro en el Sheet (marca raN enviado dd/mm) sobre la fila del rescate.
      const row = propia || rows[0];
      if (row) sheetMarks.push({ rowIndex: row.rowIndex, text: `ra${step} enviado ${fechaArgDDMM(now)}` });
    } else {
      res.failed++;
      entry.status = 'failed';
      entry.error = result.error;
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.error(
        `Rescate falló: ra${step} → ${email} (intento ${attempt}/${RESCATE_MAX_ATTEMPTS}): ${result.error}`
      );
    }
  };

  const processGroup = async (group: Array<{ id: string; entry: ScheduledEmail }>) => {
    for (const { id, entry } of group) {
      try {
        await processEntry(id, entry);
      } catch (err) {
        // Un error inesperado (KV, red) no tira la corrida: la entry queda como está.
        res.deferred++;
        console.error(`Rescate: error procesando ${entry.subject} → ${entry.email}:`, err);
      }
    }
  };

  for (let i = 0; i < groups.length; i += RESCATE_CONCURRENCY) {
    await Promise.all(groups.slice(i, i + RESCATE_CONCURRENCY).map(processGroup));
    if (sheetMarks.length >= RESCATE_SHEET_FLUSH_EVERY) await flushMarks();
  }
  await flushMarks();

  return res;
}

// ─── Recupero de carrito (T9) ───────────────────────────────────────

/**
 * Encola un mail de recupero de carrito (kind 'recupero', sendAt = +2 h) para
 * una orden cancelled/pending del programa 3740. Reglas:
 *   (b) NO encola si ya es cliente (pudo pagar con otra orden — caso nahuel.auge).
 *   (a) dedupe por email: máximo 1 recupero cada 30 días (KV SET NX + TTL).
 * El re-chequeo de cliente/blacklist antes del envío lo hace processRecuperoDue.
 */
export async function enqueueRecupero(params: {
  email: string;
  name?: string;
  orderId: string;
  orderKey?: string;
  productId?: number;
  curso?: string;
}): Promise<{ enqueued: boolean; reason?: 'cliente' | 'dedupe' | 'excluido-1a1' | 'error' }> {
  const email = (params.email || '').trim().toLowerCase();
  if (!email) return { enqueued: false, reason: 'error' };

  // En gestión 1-a-1 (carritos ya contactados a mano, teléfonos, upgrades):
  // el trato personal manda, el mail automático duplicaría el contacto.
  if (isSecuenciaExcluido(email)) {
    console.log(`Recupero: ${email} en gestión 1-a-1, no se encola`);
    return { enqueued: false, reason: 'excluido-1a1' };
  }

  // (b) Ya es cliente → no encolar. Fail-open: si la consulta falla, seguimos
  //     (el re-chequeo antes del envío es la red de seguridad).
  try {
    if (await esCliente(email)) {
      console.log(`Recupero: ${email} ya es cliente, no se encola`);
      return { enqueued: false, reason: 'cliente' };
    }
  } catch (err) {
    console.warn('Recupero: no se pudo chequear esCliente (fail-open):', err);
  }

  // (a) Dedupe 30 días: SET NX atómico. Si la clave ya existe → skip.
  const dedupeKey = `${RECUPERO_DEDUPE_PREFIX}${email}`;
  try {
    const claimed = await kv.set(dedupeKey, params.orderId, {
      ex: RECUPERO_DEDUPE_TTL_SECONDS,
      nx: true,
    });
    if (claimed === null) {
      console.log(`Recupero: ${email} ya recibió recupero en los últimos 30 días, skip`);
      return { enqueued: false, reason: 'dedupe' };
    }
  } catch (err) {
    // KV no disponible: seguimos (mejor un posible duplicado raro que perder el lead).
    console.warn('Recupero: dedupe KV falló (fail-open, se encola igual):', err);
  }

  const now = new Date();
  const base = {
    email,
    name: params.name,
    tag: RECUPERO_TAG,
    templateId: 0,
    status: 'pending' as const,
    createdAt: now.toISOString(),
    kind: 'recupero' as const,
    orderId: params.orderId,
    orderKey: params.orderKey,
    productId: params.productId,
    curso: params.curso,
  };
  const entries: ScheduledEmail[] = ([1, 2] as const).map((paso) => ({
    ...base,
    id: `rec${paso}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    stepIndex: paso - 1,
    seqStep: paso,
    subject: buildRecuperoMail(params.name || '', { paso, curso: params.curso }).subject,
    sendAt: new Date(now.getTime() + RECUPERO_DELAYS_MS[paso]).toISOString(),
  }));

  try {
    const payload: Record<string, string> = {};
    for (const e of entries) payload[e.id] = JSON.stringify(e);
    await kv.hset(DRIP_QUEUE_KEY, payload);
  } catch (err) {
    // Rollback del dedupe para permitir un reintento posterior.
    try {
      await kv.del(dedupeKey);
    } catch { /* best-effort */ }
    console.error('Recupero: hset falló, rollback dedupe:', err);
    return { enqueued: false, reason: 'error' };
  }

  console.log(`Recupero encolado: ${email} (orden ${params.orderId}) R1 ${entries[0].sendAt} · R2 ${entries[1].sendAt}`);
  return { enqueued: true };
}

interface RecuperoRunResult {
  processed: number;
  sent: number;
  failed: number;
  cancelled: number;
}

/**
 * Procesa los mails de recupero vencidos. Re-chequea ANTES de cada envío:
 * si ya es cliente o está blacklisted → cancela (no envía). Una sola lectura del
 * mapa de clientes por corrida; blacklist con cache por email.
 */
async function processRecuperoDue(
  due: Array<{ id: string; entry: ScheduledEmail }>,
  now: Date
): Promise<RecuperoRunResult> {
  const res: RecuperoRunResult = { processed: 0, sent: 0, failed: 0, cancelled: 0 };

  let clientesMap: ClientesMap | null = null;
  try {
    clientesMap = await getClientes();
  } catch (err) {
    console.warn('Recupero: no se pudo cargar el mapa de clientes (fail-open):', err);
  }

  const blCache = new Map<string, boolean>();
  const blacklisted = async (email: string): Promise<boolean> => {
    const cached = blCache.get(email);
    if (cached !== undefined) return cached;
    const v = await isEmailBlacklisted(email);
    blCache.set(email, v);
    return v;
  };

  const cancel = async (id: string, entry: ScheduledEmail, reason: string) => {
    entry.status = 'cancelled';
    entry.cancelledAt = now.toISOString();
    entry.cancelReason = reason;
    await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
    res.cancelled++;
    console.log(`Recupero cancelado (${reason}): → ${entry.email}`);
  };

  for (const { id, entry } of due) {
    const email = (entry.email || '').trim().toLowerCase();

    // ── Re-chequeo antes del envío (regla c) ──
    if (clientesMap && (await esCliente(email, clientesMap))) {
      await cancel(id, entry, 'cliente');
      continue;
    }
    if (await blacklisted(email)) {
      await cancel(id, entry, 'blacklist');
      continue;
    }

    // ── Estado real del pedido (fail-open: sin dato → link al carrito) ──
    const pedido = entry.orderId ? await estadoPedidoLite(entry.orderId) : null;
    if (pedido && PEDIDO_PAGADO.has(pedido.status)) {
      await cancel(id, entry, 'pagado');
      continue;
    }
    const paso: 1 | 2 = entry.seqStep === 2 ? 2 : 1;

    res.processed++;
    const mail = buildRecuperoMail(entry.name || '', { paso, curso: entry.curso, link: linkRecupero(entry, pedido) });
    const result = await sendPlainSecuencia(email, entry.name, mail.subject, mail.text);
    if (result.success) {
      res.sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.log(`Recupero enviado → ${email}`);
    } else {
      res.failed++;
      entry.status = 'failed';
      entry.error = result.error;
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.error(`Recupero falló → ${email}: ${result.error}`);
    }
  }

  return res;
}

/**
 * Process the drip queue — called by Vercel Cron daily.
 * Sends all emails that are due (drips por template + secuencia post-Typeform).
 */
export interface DripRunResult {
  processed: number;
  sent: number;
  failed: number;
  remaining: number;
  cancelled: number;
  deferred: number;
  skipped?: 'locked'; // otra corrida en curso: no se procesó nada
}

export async function processDripQueue(): Promise<DripRunResult> {
  const now = new Date();
  const empty: DripRunResult = { processed: 0, sent: 0, failed: 0, remaining: 0, cancelled: 0, deferred: 0 };

  // Lock de corrida (SET NX + TTL): dos corridas solapadas leerían la misma cola
  // con los mismos pending y mandarían todo dos veces. Si KV falla en el lock,
  // se sigue (fail-open): el hgetall siguiente fallaría igual si KV está caído.
  let locked = false;
  try {
    const got = await kv.set(DRIP_LOCK_KEY, now.toISOString(), { nx: true, ex: DRIP_LOCK_TTL_S });
    if (got === null) {
      console.warn('processDripQueue: otra corrida en curso (lock), se omite');
      return { ...empty, skipped: 'locked' };
    }
    locked = true;
  } catch (err) {
    console.warn('processDripQueue: no se pudo tomar el lock (fail-open):', err);
  }

  try {
    return await runDripQueue(now);
  } finally {
    if (locked) {
      try {
        await kv.del(DRIP_LOCK_KEY);
      } catch (err) {
        console.error('processDripQueue: no se pudo liberar el lock:', err);
      }
    }
  }
}

async function runDripQueue(now: Date): Promise<DripRunResult> {
  const deadline = Date.now() + DRIP_DEADLINE_MS;
  const allRaw = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);

  if (!allRaw) {
    return { processed: 0, sent: 0, failed: 0, remaining: 0, cancelled: 0, deferred: 0 };
  }

  const all = Object.entries(allRaw).map(([id, json]) => ({
    id,
    entry: (typeof json === 'string' ? JSON.parse(json) : json) as ScheduledEmail,
  }));

  let processed = 0;
  let sent = 0;
  let failed = 0;
  let remaining = 0;

  const secuenciaDue: Array<{ id: string; entry: ScheduledEmail }> = [];
  const recuperoDue: Array<{ id: string; entry: ScheduledEmail }> = [];
  const durarMasDue: Array<{ id: string; entry: ScheduledEmail }> = [];
  const firmeSeguroDue: Array<{ id: string; entry: ScheduledEmail }> = [];
  const comboDue: Array<{ id: string; entry: ScheduledEmail }> = [];
  const rescateDue: Array<{ id: string; entry: ScheduledEmail }> = [];

  for (const { id, entry } of all) {
    // Rescate: un envío 'failed' (Brevo 5xx/429, timeout) se reintenta en la
    // corrida siguiente hasta RESCATE_MAX_ATTEMPTS; si no, bloquearía R3/R4 para siempre.
    if (
      entry.kind === RESCATE_KIND &&
      entry.status === 'failed' &&
      (entry.attempts || 1) < RESCATE_MAX_ATTEMPTS
    ) {
      rescateDue.push({ id, entry });
      continue;
    }

    if (entry.status !== 'pending') continue;

    const sendAt = new Date(entry.sendAt);

    if (sendAt > now) {
      remaining++;
      continue;
    }

    if (entry.kind === 'secuencia') {
      // La secuencia se procesa en bloque (caches + re-chequeos + orden).
      secuenciaDue.push({ id, entry });
      continue;
    }

    if (entry.kind === 'recupero') {
      // El recupero se procesa en bloque (re-chequeo cliente/blacklist).
      recuperoDue.push({ id, entry });
      continue;
    }

    if (entry.kind === 'durar-mas') {
      // La secuencia durar-mas se procesa en bloque (re-chequeos + orden).
      durarMasDue.push({ id, entry });
      continue;
    }

    if (entry.kind === 'firme-seguro') {
      // La secuencia firme-seguro se procesa en bloque (re-chequeos + orden).
      firmeSeguroDue.push({ id, entry });
      continue;
    }

    if (entry.kind === 'combo') {
      // La secuencia del combo se procesa en bloque (re-chequeos + orden).
      comboDue.push({ id, entry });
      continue;
    }

    if (entry.kind === RESCATE_KIND) {
      // El rescate tier A se procesa en bloque (caches + re-chequeos + orden).
      rescateDue.push({ id, entry });
      continue;
    }

    // ── Drip por template (comportamiento existente, intacto) ──
    processed++;
    const result = await sendTemplate(entry.templateId, entry.email, entry.name);

    if (result.success) {
      sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      console.log(`Cron sent: ${entry.subject} → ${entry.email}`);
    } else {
      failed++;
      entry.status = 'failed';
      entry.error = result.error;
      console.error(`Cron failed: ${entry.subject} → ${entry.email}: ${result.error}`);
    }
    await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
  }

  let cancelled = 0;
  let deferred = 0;
  let secuenciaSent = 0;
  if (secuenciaDue.length > 0) {
    const secRes = await processSecuenciaDue(secuenciaDue, all, now);
    processed += secRes.processed;
    sent += secRes.sent;
    failed += secRes.failed;
    cancelled += secRes.cancelled;
    deferred += secRes.deferred;
    remaining += secRes.deferred; // los pospuestos siguen pendientes
    secuenciaSent = secRes.sent;
  }

  let durarMasSent = 0;
  if (durarMasDue.length > 0) {
    // Cap compartido con la secuencia post-Typeform: durar-mas usa el resto.
    const budget = Math.max(0, MAX_SECUENCIA_SENDS_PER_RUN - secuenciaSent);
    const dmRes = await processDurarMasDue(durarMasDue, all, now, budget);
    processed += dmRes.processed;
    sent += dmRes.sent;
    failed += dmRes.failed;
    cancelled += dmRes.cancelled;
    deferred += dmRes.deferred;
    remaining += dmRes.deferred; // los pospuestos siguen pendientes
    durarMasSent = dmRes.sent;
  }

  let firmeSeguroSent = 0;
  if (firmeSeguroDue.length > 0) {
    // Cap compartido: firme-seguro usa lo que dejaron las otras secuencias.
    const budget = Math.max(0, MAX_SECUENCIA_SENDS_PER_RUN - secuenciaSent - durarMasSent);
    const fsRes = await processFirmeSeguroDue(firmeSeguroDue, all, now, budget);
    processed += fsRes.processed;
    sent += fsRes.sent;
    failed += fsRes.failed;
    cancelled += fsRes.cancelled;
    deferred += fsRes.deferred;
    remaining += fsRes.deferred; // los pospuestos siguen pendientes
    firmeSeguroSent = fsRes.sent;
  }

  if (comboDue.length > 0) {
    // Cap compartido: el combo usa lo que dejaron las otras secuencias.
    const budget = Math.max(
      0,
      MAX_SECUENCIA_SENDS_PER_RUN - secuenciaSent - durarMasSent - firmeSeguroSent
    );
    const eiRes = await processComboDue(comboDue, all, now, budget);
    processed += eiRes.processed;
    sent += eiRes.sent;
    failed += eiRes.failed;
    cancelled += eiRes.cancelled;
    deferred += eiRes.deferred;
    remaining += eiRes.deferred; // los pospuestos siguen pendientes
  }

  if (recuperoDue.length > 0) {
    // Recupero de carrito (+2 h, chico y sensible al tiempo): siempre antes del
    // rescate, que puede ser un bloque grande.
    const recRes = await processRecuperoDue(recuperoDue, now);
    processed += recRes.processed;
    sent += recRes.sent;
    failed += recRes.failed;
    cancelled += recRes.cancelled;
  }

  if (rescateDue.length > 0) {
    // Cap propio (MAX_RESCATE_SENDS_PER_RUN): no compite con las otras secuencias.
    // Va último y con deadline: es el único bloque que puede traer cientos de
    // envíos vencidos el mismo día.
    const raRes = await processRescateDue(rescateDue, all, now, MAX_RESCATE_SENDS_PER_RUN, deadline);
    processed += raRes.processed;
    sent += raRes.sent;
    failed += raRes.failed;
    cancelled += raRes.cancelled;
    deferred += raRes.deferred;
    remaining += raRes.deferred; // los pospuestos siguen pendientes
  }

  return { processed, sent, failed, remaining, cancelled, deferred };
}

/**
 * Cancela (exit-on-purchase) todos los mails pendientes de un email en la cola,
 * de cualquier kind (secuencia, rescate-a, durar-mas, firme-seguro, combo,
 * recupero de carrito y drips por template): el filtro es por email + status,
 * sin mirar `kind`, así cualquier secuencia nueva queda cubierta.
 * Los marca 'cancelled' en vez de borrarlos, para dejar rastro auditable.
 * Llamado por el webhook WooCommerce cuando la persona compra.
 */
export async function cancelDripForEmail(
  email: string
): Promise<{ cancelled: number }> {
  const target = email.trim().toLowerCase();
  const allEntries = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);
  if (!allEntries) return { cancelled: 0 };

  const now = new Date().toISOString();
  let cancelled = 0;

  for (const [id, json] of Object.entries(allEntries)) {
    const entry: ScheduledEmail = typeof json === 'string' ? JSON.parse(json) : json;
    if (entry.status !== 'pending') continue;
    if (entry.email.trim().toLowerCase() !== target) continue;

    entry.status = 'cancelled';
    entry.cancelledAt = now;
    entry.cancelReason = 'compra';
    await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
    cancelled++;
    console.log(`Drip cancelled (compra): ${entry.subject} → ${entry.email}`);
  }

  return { cancelled };
}

/**
 * Get drip queue stats for dashboard.
 */
export async function getDripStats(): Promise<{
  pending: number;
  sent: number;
  failed: number;
  byTag: Record<string, number>;
}> {
  const allEntries = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);
  const stats = { pending: 0, sent: 0, failed: 0, byTag: {} as Record<string, number> };

  if (!allEntries) return stats;

  for (const json of Object.values(allEntries)) {
    const entry: ScheduledEmail = typeof json === 'string' ? JSON.parse(json) : json;
    if (entry.status === 'pending') stats.pending++;
    else if (entry.status === 'sent') stats.sent++;
    else if (entry.status === 'failed') stats.failed++;

    stats.byTag[entry.tag] = (stats.byTag[entry.tag] || 0) + 1;
  }

  return stats;
}
