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
} from './secuencia-post-typeform';

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
  // ── Secuencia post-Typeform (mails "caseros" inline de mauro@) ──
  kind?: 'template' | 'secuencia' | 'recupero'; // undefined = 'template' (retrocompat)
  seqStep?: number; // 1..8 (M1..M8)
  mailVariant?: MailVariant; // sólo relevante para M1 (A/B)
}

const DRIP_QUEUE_KEY = 'drip:queue';
const DRIP_SENT_KEY = 'drip:sent';

// ─── Recupero de carrito (T9) ───────────────────────────────────────
export const RECUPERO_TAG = 'recupero-carrito';
// Delay del mail de recupero desde que llega la orden cancelled/pending.
const RECUPERO_DELAY_MS = 2 * 60 * 60 * 1000; // +2 h
// Dedupe por email: máximo 1 recupero cada 30 días.
const RECUPERO_DEDUPE_PREFIX = 'recupero-dedupe:';
const RECUPERO_DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 días

// Tope de envíos de secuencia por corrida de cron (protege el timeout de 60s de
// la función; el resto queda 'pending' y sale en la próxima corrida). Configurable.
const MAX_SECUENCIA_SENDS_PER_RUN =
  parseInt(process.env.SECUENCIA_MAX_PER_RUN || '', 10) || 150;

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
 * click tracking queda OFF y los ?m=sqN llegan intactos.
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
  text: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { success: false, error: 'BREVO_API_KEY missing' };

  // Header de baja invisible: el cuerpo queda humano, Gmail/Outlook muestran
  // su propio "darse de baja" y el click corta la secuencia (blacklist Brevo).
  const unsubUrl = buildUnsubscribeUrl(email);
  const body = {
    sender: SECUENCIA_SENDER,
    to: [{ email, name: name || undefined }],
    replyTo: { email: SECUENCIA_SENDER.email },
    subject,
    textContent: unsubUrl
      ? `${text}\n\n--\nSi no quer\u00e9s recibir m\u00e1s estos mails, date de baja ac\u00e1: ${unsubUrl}`
      : text,
    htmlContent: plainToHtml(text, unsubUrl),
    headers: unsubUrl
      ? {
          'List-Unsubscribe': `<${unsubUrl}>, <mailto:${SECUENCIA_SENDER.email}?subject=baja>`,
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
 * Enrola un email en la secuencia post-Typeform (M1..M8).
 * `dates` = 8 instantes (M1..M8) ya calculados por el caller
 * (computeSequenceDates para leads nuevos, computeStockSequenceDates para stock).
 * M0 NO se encola acá: es el mail inmediato del webhook.
 *
 * @param alreadyEnrolled set opcional para dedupe en bulk (evita re-encolar).
 */
export async function enrollSecuencia(params: {
  email: string;
  name?: string;
  variant: MailVariant;
  dates: Date[]; // length 8, M1..M8
  alreadyEnrolled?: Set<string>;
}): Promise<{ scheduled: number; skipped?: 'already-enrolled' | 'bad-dates' }> {
  const email = (params.email || '').trim().toLowerCase();
  if (params.dates.length !== 8) return { scheduled: 0, skipped: 'bad-dates' };
  if (params.alreadyEnrolled?.has(email)) return { scheduled: 0, skipped: 'already-enrolled' };

  const now = new Date().toISOString();
  const fields: Record<string, string> = {};

  for (let i = 0; i < 8; i++) {
    const seqStep = i + 1; // M1..M8
    const variant: MailVariant = seqStep === 1 ? params.variant : 'A';
    const { subject } = buildSecuenciaMail(seqStep, params.name || '', variant);
    const entry: ScheduledEmail = {
      id: `sq_${Date.now()}_${seqStep}_${Math.random().toString(36).slice(2, 8)}`,
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
      mailVariant: seqStep === 1 ? params.variant : undefined,
    };
    fields[entry.id] = JSON.stringify(entry);
  }

  // Un solo hset con los 8 pasos (clave para el enrolamiento en bulk del stock).
  await kv.hset(DRIP_QUEUE_KEY, fields);

  params.alreadyEnrolled?.add(email);
  console.log(`Secuencia enrolada: ${email} (variante M1${params.variant}, 8 mails)`);
  return { scheduled: 8 };
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
    const mail = buildSecuenciaMail(step, entry.name || '', entry.mailVariant || 'A');
    const result = await sendPlainSecuencia(email, entry.name, mail.subject, mail.text);

    if (result.success) {
      res.sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
      console.log(`Secuencia enviada: sq${step} → ${email}`);
      // Registro en el Sheet (marca sqN enviado dd/mm) sobre la primera fila.
      const row = rows[0];
      if (row) sheetMarks.push({ rowIndex: row.rowIndex, text: `sq${step} enviado ${fechaArgDDMM(now)}` });
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
  const sendAt = new Date(now.getTime() + RECUPERO_DELAY_MS);
  const mail = buildRecuperoMail(params.name || '');
  const entry: ScheduledEmail = {
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    email,
    name: params.name,
    tag: RECUPERO_TAG,
    stepIndex: 0,
    templateId: 0,
    subject: mail.subject,
    sendAt: sendAt.toISOString(),
    status: 'pending',
    createdAt: now.toISOString(),
    kind: 'recupero',
  };

  try {
    await kv.hset(DRIP_QUEUE_KEY, { [entry.id]: JSON.stringify(entry) });
  } catch (err) {
    // Rollback del dedupe para permitir un reintento posterior.
    try {
      await kv.del(dedupeKey);
    } catch { /* best-effort */ }
    console.error('Recupero: hset falló, rollback dedupe:', err);
    return { enqueued: false, reason: 'error' };
  }

  console.log(`Recupero encolado: ${email} (orden ${params.orderId}) sendAt ${sendAt.toISOString()}`);
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

    res.processed++;
    const mail = buildRecuperoMail(entry.name || '');
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
export async function processDripQueue(): Promise<{
  processed: number;
  sent: number;
  failed: number;
  remaining: number;
  cancelled: number;
  deferred: number;
}> {
  const now = new Date();
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

  for (const { id, entry } of all) {
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
  if (secuenciaDue.length > 0) {
    const secRes = await processSecuenciaDue(secuenciaDue, all, now);
    processed += secRes.processed;
    sent += secRes.sent;
    failed += secRes.failed;
    cancelled += secRes.cancelled;
    deferred += secRes.deferred;
    remaining += secRes.deferred; // los pospuestos siguen pendientes
  }

  if (recuperoDue.length > 0) {
    const recRes = await processRecuperoDue(recuperoDue, now);
    processed += recRes.processed;
    sent += recRes.sent;
    failed += recRes.failed;
    cancelled += recRes.cancelled;
  }

  return { processed, sent, failed, remaining, cancelled, deferred };
}

/**
 * Cancela (exit-on-purchase) todos los mails pendientes de un email en la cola,
 * de cualquier kind (secuencia, recupero de carrito y drips por template).
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
