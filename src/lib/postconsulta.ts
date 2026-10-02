import { kv } from '@vercel/kv';
import {
  attachMessageIdToCoupon,
  couponMeta,
  createPatientCoupon,
  codigoVisible,
  findPatientCoupons,
  listPacCoupons,
  parseWcGmt,
  POST_CONSULTATION_SOURCE,
  type WcCoupon,
} from './woocommerce-coupons';

export { parseWcGmt };

/**
 * Embudo post-consulta Calendly: cupón NombreInicial, ej. CarlosD (30 %) + mail (template
 * Brevo #158) al terminar el turno de "Atención Prioritaria".
 *
 * Por qué existe este módulo (14/09/2026): Brevo rechaza programar un
 * transaccional a más de 3 días ("not allowed to schedule … more than 3 days"),
 * así que las reservas con más de 72 h de anticipación creaban el cupón pero
 * el mail nunca quedaba programado. Ahora el webhook solo ENCOLA la reserva en
 * KV; el cron `/api/cron/postconsulta` la procesa el mismo día del turno (hora
 * Argentina): crea el cupón (vence 24 h después del envío) y programa el mail
 * en Brevo para el fin del turno, que a esa altura siempre cae dentro de las
 * 72 h. Si el turno ya terminó (corridas perdidas), el mail sale al instante.
 *
 * Idempotencia: guardia KV en dos fases por turno (`postconsulta:done:<uri>`,
 * `inflight` con TTL corto antes de tocar nada; fecha ISO con TTL largo al
 * terminar). Además el cupón guarda `_brevo_message_id`, que es la marca
 * definitiva de "mail programado" y la que usa la cancelación para revocarlo.
 *
 * Red de seguridad: cupones PAC sin `_brevo_message_id` (huérfanos, p. ej. los
 * creados por el webhook viejo) reciben su mail cuando llega su día.
 */

export const PENDING_KEY = 'postconsulta:pending';
export const DONE_PREFIX = 'postconsulta:done:';
export const DONE_TTL_S = 60 * 60 * 24 * 45;
export const INFLIGHT_VALUE = 'inflight';
export const INFLIGHT_TTL_S = 300;
// Validez REAL del cupón: 15 días desde el envío del mail. El mail y lo que
// Mauro dice en consulta siguen hablando de 24 h (urgencia); el margen extra
// garantiza que funcione aunque el paciente lo use días después (Mauro, 01/10/2026).
export const COUPON_VALIDITY_MS = 15 * 24 * 60 * 60 * 1000;
// Cupones creados antes del 01/10/2026 (sin meta `_send_at`) vencían 24 h después del envío.
const LEGACY_COUPON_VALIDITY_MS = 24 * 60 * 60 * 1000;
const IMMEDIATE_WINDOW_MS = 60 * 1000; // si el envío cae dentro del próximo minuto, sale sin scheduledAt
const ART_OFFSET_MS = -3 * 60 * 60 * 1000; // Argentina no tiene horario de verano
const BREVO_TIMEOUT_MS = 10000;
// Copia oculta de cada mail post-consulta para verificar el envío y reenviarlo
// si el paciente dice que no le llegó (Mauro, 02/10/2026). Va en el mismo envío
// (mismo messageId), así que cancelar el turno también revoca la copia.
const COPIA_POSTCONSULTA = 'contacto.urologocarrillo@gmail.com';

export interface ReservaPendiente {
  eventUri: string;
  email: string;
  name: string;
  endTime: string; // ISO UTC — fin del turno = momento del envío
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export type EstadoProceso =
  | 'programado' // cupón creado (o reutilizado) y mail programado/enviado
  | 'ya-procesada' // otra corrida ya lo hizo (guardia KV o cupón con messageId)
  | 'en-curso' // otra corrida lo está haciendo ahora mismo
  | 'dry'
  | 'error';

export interface ResultadoProceso {
  estado: EstadoProceso;
  eventUri: string;
  email: string;
  couponCode?: string;
  couponCreado?: boolean;
  sendAt?: string;
  messageId?: string;
  error?: string;
}

// ─── Fechas ─────────────────────────────────────────────────────────

function fechaArgentina(d: Date): string {
  return new Date(d.getTime() + ART_OFFSET_MS).toISOString().slice(0, 10);
}

/** true si `fecha` cae en el mismo día calendario de Argentina que `now`. */
export function esHoyEnArgentina(fecha: Date, now: Date): boolean {
  return fechaArgentina(fecha) === fechaArgentina(now);
}

/** Se procesa el mismo día del turno (hora Argentina) o si el turno ya pasó. */
export function debeProcesarse(endTime: Date, now: Date): boolean {
  if (Number.isNaN(endTime.getTime())) return false;
  return endTime.getTime() <= now.getTime() || esHoyEnArgentina(endTime, now);
}

// ─── Cola en KV ─────────────────────────────────────────────────────

function parseReserva(raw: unknown): ReservaPendiente | null {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    const r = obj as Partial<ReservaPendiente>;
    if (!r.eventUri || !r.email || !r.endTime) return null;
    return {
      eventUri: r.eventUri,
      email: r.email,
      name: r.name || 'Paciente',
      endTime: r.endTime,
      createdAt: r.createdAt || new Date().toISOString(),
      attempts: r.attempts || 0,
      lastError: r.lastError,
    };
  } catch {
    return null;
  }
}

export async function encolarReserva(r: ReservaPendiente): Promise<void> {
  await kv.hset(PENDING_KEY, { [r.eventUri]: JSON.stringify(r) });
}

export async function desencolarReserva(eventUri: string): Promise<void> {
  await kv.hdel(PENDING_KEY, eventUri);
}

export async function listarPendientes(): Promise<ReservaPendiente[]> {
  const all = (await kv.hgetall<Record<string, unknown>>(PENDING_KEY)) || {};
  return Object.values(all)
    .map(parseReserva)
    .filter((r): r is ReservaPendiente => r !== null)
    .sort((a, b) => a.endTime.localeCompare(b.endTime));
}

// ─── Brevo ──────────────────────────────────────────────────────────

/**
 * Manda (o programa) el mail post-consulta con el template #158. Si `sendAt`
 * ya pasó o cae dentro del próximo minuto, sale inmediato (Brevo rechaza
 * scheduledAt en el pasado). Nunca lanza.
 */
export async function enviarMailPostConsulta(params: {
  email: string;
  name: string;
  couponCode: string;
  sendAt: Date;
  now?: Date;
  bcc?: string[];
}): Promise<{ success: boolean; messageId?: string; scheduledAt?: string; error?: string }> {
  const { email, name, couponCode, sendAt, bcc = [COPIA_POSTCONSULTA] } = params;
  const now = params.now ?? new Date();
  const templateId = parseInt(process.env.CALENDLY_EMAIL_TEMPLATE_ID || '0', 10);
  const apiKey = process.env.BREVO_API_KEY || '';
  if (!templateId || !apiKey) {
    return { success: false, error: 'Falta CALENDLY_EMAIL_TEMPLATE_ID o BREVO_API_KEY' };
  }

  const scheduledAt =
    sendAt.getTime() - now.getTime() > IMMEDIATE_WINDOW_MS ? sendAt.toISOString() : undefined;

  const body: Record<string, unknown> = {
    templateId,
    to: [{ email, name }],
    params: { NOMBRE: name.split(' ')[0] || 'Paciente', COUPON_CODE: couponCode },
    tags: ['post-consulta'],
  };
  if (scheduledAt) body.scheduledAt = scheduledAt;
  const copias = bcc.filter(e => e.toLowerCase() !== email.toLowerCase());
  if (copias.length > 0) body.bcc = copias.map(e => ({ email: e }));

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { messageId?: string; message?: string };
    if (!res.ok || !data.messageId) {
      const error = data.message || `Brevo HTTP ${res.status}`;
      console.error(`Post-consulta: Brevo rechazó el mail a ${email}: ${error}`);
      return { success: false, error };
    }
    console.log(
      `Post-consulta: mail ${scheduledAt ? `programado para ${scheduledAt}` : 'enviado ahora'} a ${email} (cupón ${couponCode})`
    );
    return { success: true, messageId: data.messageId, scheduledAt };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Post-consulta: error enviando a ${email}:`, error);
    return { success: false, error };
  }
}

/**
 * Revoca un mail programado y todavía no enviado, por messageId (por batchId
 * Brevo da 404, verificado 18/08/2026). 404 = nada pendiente, no es error.
 */
export async function cancelarMailProgramado(messageId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.brevo.com/v3/smtp/email/${encodeURIComponent(messageId)}`,
      {
        method: 'DELETE',
        headers: { 'api-key': process.env.BREVO_API_KEY || '' },
        signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
      }
    );
    if (res.ok || res.status === 204) {
      console.log(`Post-consulta: mail programado ${messageId} revocado`);
      return true;
    }
    console.log(`Post-consulta: nada que revocar para ${messageId} (HTTP ${res.status})`);
    return false;
  } catch (err) {
    console.error('Post-consulta: error revocando mail programado:', err);
    return false;
  }
}

// ─── Guardia KV ─────────────────────────────────────────────────────

type Guardia = 'ok' | 'ya-procesada' | 'en-curso' | 'sin-kv';

async function tomarGuardia(key: string): Promise<Guardia> {
  try {
    const got = await kv.set(key, INFLIGHT_VALUE, { nx: true, ex: INFLIGHT_TTL_S });
    if (got) return 'ok';
    const previo = await kv.get<string>(key);
    return previo === INFLIGHT_VALUE ? 'en-curso' : 'ya-procesada';
  } catch (err) {
    // Sin KV seguimos igual: la marca definitiva es el _brevo_message_id del cupón.
    console.error('Post-consulta: KV no disponible (guardia):', err);
    return 'sin-kv';
  }
}

async function cerrarGuardia(key: string, exito: boolean, now: Date): Promise<void> {
  try {
    if (exito) await kv.set(key, now.toISOString(), { ex: DONE_TTL_S });
    else await kv.del(key);
  } catch (err) {
    console.error('Post-consulta: KV no disponible (cierre guardia):', err);
  }
}

// ─── Núcleo: cupón + mail para un turno ─────────────────────────────

/**
 * Deja al paciente con cupón y mail programado para `sendAt` (fin del turno o
 * ahora si ya pasó). Reutiliza un cupón existente del mismo turno si lo hay;
 * si ese cupón ya tiene `_brevo_message_id`, no hace nada.
 */
async function asegurarCuponYMail(params: {
  eventUri: string;
  email: string;
  name: string;
  endTime: Date;
  now: Date;
  dry: boolean;
  cuponExistente?: WcCoupon;
}): Promise<ResultadoProceso> {
  const { eventUri, email, name, endTime, now, dry } = params;
  const base = { eventUri, email };
  const sendAt = endTime.getTime() > now.getTime() ? endTime : now;

  let cupon = params.cuponExistente;
  if (!cupon) {
    try {
      const existentes = await findPatientCoupons(email);
      cupon = existentes.find(c => couponMeta(c, '_event_uri') === eventUri);
    } catch (err) {
      return { ...base, estado: 'error', error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }
  if (cupon && couponMeta(cupon, '_brevo_message_id')) {
    return { ...base, estado: 'ya-procesada', couponCode: codigoVisible(cupon) };
  }

  if (dry) {
    return {
      ...base,
      estado: 'dry',
      couponCode: (cupon ? codigoVisible(cupon) : undefined),
      couponCreado: !cupon,
      sendAt: sendAt.toISOString(),
    };
  }

  const guardKey = `${DONE_PREFIX}${eventUri}`;
  const guardia = await tomarGuardia(guardKey);
  if (guardia === 'ya-procesada' || guardia === 'en-curso') {
    return { ...base, estado: guardia, couponCode: (cupon ? codigoVisible(cupon) : undefined) };
  }

  let couponCode = (cupon ? codigoVisible(cupon) : undefined);
  let couponId = cupon?.id;
  let couponCreado = false;
  try {
    if (!couponCode || !couponId) {
      const creado = await createPatientCoupon({
        patientName: name,
        patientEmail: email,
        expiresAt: new Date(sendAt.getTime() + COUPON_VALIDITY_MS),
        sendAt,
        eventUri,
      });
      if (!creado.success || !creado.code || !creado.couponId) {
        throw new Error(`No se pudo crear el cupón: ${creado.error || 'sin detalle'}`);
      }
      couponCode = creado.code;
      couponId = creado.couponId;
      couponCreado = !creado.reutilizado;
    }

    const mail = await enviarMailPostConsulta({ email, name, couponCode, sendAt, now });
    if (!mail.success || !mail.messageId) {
      throw new Error(`No se pudo programar el mail (cupón ${couponCode} ya existe): ${mail.error || 'sin detalle'}`);
    }

    const attached = await attachMessageIdToCoupon(couponId, mail.messageId);
    if (!attached) {
      // El mail ya está programado: la guardia KV evita el duplicado; solo avisamos.
      console.error(`Post-consulta: mail ${mail.messageId} programado pero no se pudo guardar en el cupón ${couponCode}`);
    }

    await cerrarGuardia(guardKey, true, now);
    return {
      ...base,
      estado: 'programado',
      couponCode,
      couponCreado,
      sendAt: sendAt.toISOString(),
      messageId: mail.messageId,
    };
  } catch (err) {
    await cerrarGuardia(guardKey, false, now);
    return {
      ...base,
      estado: 'error',
      couponCode,
      couponCreado,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Procesa una reserva de la cola. Si termina bien (o ya estaba hecha) la saca
 * de la cola; si falla la deja con `attempts`+1 para reintentar en la próxima.
 */
export async function procesarReserva(
  r: ReservaPendiente,
  opts: { now?: Date; dry?: boolean } = {}
): Promise<ResultadoProceso> {
  const now = opts.now ?? new Date();
  const dry = opts.dry ?? false;
  const endTime = new Date(r.endTime);

  if (Number.isNaN(endTime.getTime())) {
    if (!dry) await desencolarReserva(r.eventUri).catch(() => undefined);
    return { estado: 'error', eventUri: r.eventUri, email: r.email, error: `endTime inválido: ${r.endTime}` };
  }

  const resultado = await asegurarCuponYMail({
    eventUri: r.eventUri,
    email: r.email,
    name: r.name,
    endTime,
    now,
    dry,
  });

  if (dry) return resultado;

  if (resultado.estado === 'programado' || resultado.estado === 'ya-procesada') {
    await desencolarReserva(r.eventUri).catch(err =>
      console.error('Post-consulta: no se pudo desencolar', r.eventUri, err)
    );
  } else if (resultado.estado === 'error') {
    await encolarReserva({ ...r, attempts: r.attempts + 1, lastError: resultado.error }).catch(
      err => console.error('Post-consulta: no se pudo actualizar la cola', r.eventUri, err)
    );
  }
  return resultado;
}

/**
 * Red de seguridad: cupones post-consulta sin `_brevo_message_id` y sin usar
 * cuyo día de envío (vencimiento − 24 h) ya llegó → se les programa el mail.
 * Cubre los cupones creados por el webhook viejo y cualquier corrida que haya
 * muerto entre crear el cupón y programar el mail.
 */
export async function procesarCuponesHuerfanos(opts: {
  now?: Date;
  dry?: boolean;
  deadline?: number; // Date.now() límite para seguir procesando
}): Promise<ResultadoProceso[]> {
  const now = opts.now ?? new Date();
  const dry = opts.dry ?? false;
  const resultados: ResultadoProceso[] = [];

  const cupones = await listPacCoupons();
  for (const c of cupones) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    if (couponMeta(c, '_source') !== POST_CONSULTATION_SOURCE) continue;
    if (couponMeta(c, '_brevo_message_id')) continue;
    if (c.usage_count > 0) continue;
    const email = couponMeta(c, '_patient_email');
    if (!email) continue;
    const expira = parseWcGmt(c.date_expires_gmt ?? c.date_expires);
    if (!expira || expira.getTime() <= now.getTime()) continue; // vencido: lo borra el cron de limpieza
    const sendAtMeta = couponMeta(c, '_send_at');
    const sendAt = sendAtMeta && !Number.isNaN(Date.parse(sendAtMeta))
      ? new Date(sendAtMeta)
      : new Date(expira.getTime() - LEGACY_COUPON_VALIDITY_MS);
    if (!debeProcesarse(sendAt, now)) continue;

    const eventUri = couponMeta(c, '_event_uri') || `cupon:${c.code.toUpperCase()}`;
    const name = nombreDesdeDescripcion(c.description) || 'Paciente';
    resultados.push(
      await asegurarCuponYMail({ eventUri, email, name, endTime: sendAt, now, dry, cuponExistente: c })
    );
  }
  return resultados;
}

/** "Post-consulta Ivan Ponce (mail@x.com) — 2026-09-07" → "Ivan Ponce" */
export function nombreDesdeDescripcion(desc: string | undefined): string | null {
  if (!desc) return null;
  const m = desc.match(/^Post-consulta\s+(.+?)\s*\(/);
  return m ? m[1].trim() : null;
}
