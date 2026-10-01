import crypto from 'crypto';

const WC_BASE_URL = 'https://urologia.ar/wp-json/wc/v3';
const WP_USER = process.env.WP_USER || '';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || '';

// Products eligible for post-consultation discount — every published course/program
const ELIGIBLE_PRODUCT_IDS = [3740, 3208, 5243, 1043, 954, 2871]; // Programa DE, EP, Combo, Preservativo, Mi Primera Vez, Adolescencia

export interface WcCoupon {
  id: number;
  code: string;
  amount: string;
  discount_type: string;
  date_expires: string | null;
  date_expires_gmt?: string | null; // UTC sin sufijo Z (WooCommerce)
  usage_count: number;
  usage_limit: number | null;
  product_ids: number[];
  description: string;
  meta_data?: { key: string; value: string }[];
}

export const POST_CONSULTATION_SOURCE = 'calendly-post-consultation';

/** ISO 8601 en UTC sin milisegundos, único formato con zona que WooCommerce respeta. */
export function toWcDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** WooCommerce devuelve `date_expires_gmt` en UTC sin sufijo Z. */
export function parseWcGmt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Lee una meta del cupón (undefined si no existe). */
export function couponMeta(c: WcCoupon, key: string): string | undefined {
  return c.meta_data?.find(m => m.key === key)?.value;
}

/**
 * Código de cupón amigable: Nombre + inicial del apellido ("CarlosD", "JuanP").
 * Solo letras y dígitos, sin acentos: el paciente lo copia o lo tipea sin
 * errores (pedido de Mauro, 30/09/2026; antes era PAC-XXXXXX aleatorio).
 * WooCommerce lo guarda en minúsculas y lo compara sin distinguir mayúsculas;
 * la forma "bonita" queda en la meta `_display_code` para el mail.
 * Si el código está ocupado por OTRO paciente, `intento` 2-5 da variantes que
 * siguen siendo un nombre: CarlosD → CarlosDi → CarlosDia → CarlosDiaz → CarlosD47.
 */
export function generarCodigoPaciente(patientName: string, intento = 1): string {
  const limpiar = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z]/g, '');
  const capitalizar = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase();
  const partes = patientName.trim().split(/\s+/).map(limpiar).filter(Boolean);
  const nombre = partes[0] ? capitalizar(partes[0].slice(0, 12)) : '';
  const apellido = partes.length > 1 ? capitalizar(partes[partes.length - 1].slice(0, 12)) : '';
  if (nombre.length < 2) return `Paciente${crypto.randomInt(100, 1000)}`;
  if (!apellido) return `${nombre}${crypto.randomInt(10, 100)}`;
  if (intento >= 5) return `${nombre}${apellido[0]}${crypto.randomInt(10, 100)}`;
  const letras = intento <= 3 ? intento : apellido.length;
  return `${nombre}${apellido.slice(0, letras)}`;
}

/** Cupón del embudo post-consulta: por meta `_source` (nuevos) o prefijo PAC- (legado). */
export function esCuponPaciente(c: WcCoupon): boolean {
  return (
    couponMeta(c, '_source') === POST_CONSULTATION_SOURCE ||
    c.code.toUpperCase().startsWith('PAC-')
  );
}

/** Código tal como se muestra al paciente (con mayúsculas); legado PAC- en mayúsculas. */
export function codigoVisible(c: WcCoupon): string {
  return couponMeta(c, '_display_code') || c.code.toUpperCase();
}

async function wcFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${WC_BASE_URL}${endpoint}`;
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
      ...options.headers,
    },
  });
}

/**
 * Create a unique WooCommerce coupon for a post-consultation patient.
 * 30% off, single use, only for the published courses/programs. Real validity
 * comes from `expiresAt` (15 days since 01/10/2026; the email still says 24 h).
 */
export async function createPatientCoupon(params: {
  patientName: string;
  patientEmail: string;
  expiresAt?: Date; // default: 24h from now — pass event-based expiry so the code is alive when the email lands
  sendAt?: Date; // momento del envío del mail; queda en meta `_send_at` (la red de seguridad de huérfanos lo usa)
  eventUri?: string; // Calendly event URI, stored to target deletion on cancellation
}): Promise<{ success: boolean; code?: string; couponId?: number; error?: string; reutilizado?: boolean }> {
  const { patientName, patientEmail, eventUri, sendAt } = params;
  const expiresAt = params.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Si "CarlosD" ya existe: agotado o vencido → se borra y se reusa el código;
  // del mismo paciente → se extiende su validez (mismo código, Mauro 01/10/2026);
  // vivo y de otro paciente → variante que sigue siendo un nombre (CarlosDi, …).
  for (let intento = 1; intento <= 5; intento++) {
    const code = generarCodigoPaciente(patientName, intento);
    const datos = { code, patientName, patientEmail, eventUri, expiresAt, sendAt };
    let result = await crearCuponWc(datos);
    if (!result.duplicado) return result;

    const ocupado = await resolverCodigoOcupado({ code, patientEmail, expiresAt, sendAt, eventUri });
    if (ocupado.estado === 'liberado') {
      result = await crearCuponWc(datos);
      if (!result.duplicado) return result;
    } else if (ocupado.estado === 'reutilizado') {
      console.log(`Coupon ${code} reutilizado para ${patientEmail} con validez extendida (WC ID: ${ocupado.couponId})`);
      return { success: true, code, couponId: ocupado.couponId, reutilizado: true };
    }
    console.log(`Coupon ${code} en uso por otro paciente, probando variante`);
  }
  return { success: false, error: 'No se encontró un código de cupón libre en 5 intentos' };
}

/**
 * Qué hacer cuando el código ya existe en WooCommerce:
 *  - cupón post-consulta agotado (usos ≥ límite) o vencido → se borra ("liberado")
 *  - cupón post-consulta vivo del MISMO paciente (otra consulta dentro de la
 *    validez) → se extiende la fecha y se apunta al turno nuevo ("reutilizado")
 *  - cupón vivo de otro paciente, o cupón manual de Mauro → no se toca ("ocupado")
 */
async function resolverCodigoOcupado(params: {
  code: string;
  patientEmail: string;
  expiresAt: Date;
  sendAt?: Date;
  eventUri?: string;
}): Promise<{ estado: 'liberado' | 'ocupado' } | { estado: 'reutilizado'; couponId: number }> {
  const { code, patientEmail, expiresAt, sendAt, eventUri } = params;
  try {
    const response = await wcFetch(`/coupons?code=${encodeURIComponent(code)}&per_page=5`);
    if (!response.ok) return { estado: 'ocupado' };
    const lista: WcCoupon[] = await response.json();
    const existente = lista.find(c => c.code.toLowerCase() === code.toLowerCase());
    if (!existente || !esCuponPaciente(existente)) return { estado: 'ocupado' };

    const expira = parseWcGmt(existente.date_expires_gmt ?? existente.date_expires);
    const agotado = existente.usage_limit !== null && existente.usage_count >= existente.usage_limit;
    const vencido = !!expira && expira.getTime() <= Date.now();
    if (agotado || vencido) {
      const del = await wcFetch(`/coupons/${existente.id}?force=true`, { method: 'DELETE' });
      if (del.ok) console.log(`Coupon ${code} ${agotado ? 'agotado' : 'vencido'} borrado para reusar el código`);
      return { estado: del.ok ? 'liberado' : 'ocupado' };
    }

    if (couponMeta(existente, '_patient_email') === patientEmail) {
      const put = await wcFetch(`/coupons/${existente.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          date_expires: toWcDateTime(expiresAt),
          meta_data: [
            { key: '_display_code', value: code },
            ...(sendAt ? [{ key: '_send_at', value: toWcDateTime(sendAt) }] : []),
            ...(eventUri ? [{ key: '_event_uri', value: eventUri }] : []),
          ],
        }),
      });
      return put.ok ? { estado: 'reutilizado', couponId: existente.id } : { estado: 'ocupado' };
    }
    return { estado: 'ocupado' };
  } catch (error) {
    console.error('Error resolviendo código de cupón ocupado:', error);
    return { estado: 'ocupado' };
  }
}

async function crearCuponWc(params: {
  code: string;
  patientName: string;
  patientEmail: string;
  eventUri?: string;
  expiresAt: Date;
  sendAt?: Date;
}): Promise<{ success: boolean; code?: string; couponId?: number; error?: string; duplicado?: boolean }> {
  const { code, patientName, patientEmail, eventUri, expiresAt, sendAt } = params;

  const body = {
    code,
    discount_type: 'percent',
    amount: '30',
    individual_use: true,
    usage_limit: 1,
    usage_limit_per_user: 1,
    // Sin milisegundos: con ".000Z" WooCommerce ignora la zona y toma la hora
    // como local del sitio (UTC-3) → el cupón vencía 3 h tarde (verificado 14/09/2026).
    date_expires: toWcDateTime(expiresAt),
    product_ids: ELIGIBLE_PRODUCT_IDS,
    description: `Post-consulta ${patientName} (${patientEmail}) — ${new Date().toISOString().split('T')[0]}`,
    meta_data: [
      { key: '_patient_email', value: patientEmail },
      { key: '_source', value: POST_CONSULTATION_SOURCE },
      { key: '_display_code', value: code },
      ...(sendAt ? [{ key: '_send_at', value: toWcDateTime(sendAt) }] : []),
      ...(eventUri ? [{ key: '_event_uri', value: eventUri }] : []),
    ],
  };

  try {
    const response = await wcFetch('/coupons', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json();
      if (response.status === 400 && errorData.code === 'woocommerce_rest_coupon_code_already_exists') {
        return { success: false, duplicado: true, error: errorData.message };
      }
      console.error('WooCommerce coupon creation failed:', errorData);
      return {
        success: false,
        error: errorData.message || `HTTP ${response.status}`,
      };
    }

    const coupon = await response.json();
    console.log(`Coupon created: ${code} for ${patientEmail} (WC ID: ${coupon.id})`);
    return { success: true, code, couponId: coupon.id };
  } catch (error) {
    console.error('WooCommerce coupon error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Store the Brevo messageId of the scheduled post-consultation email in the
 * coupon's meta, so a later cancellation can revoke that exact send.
 */
export async function attachMessageIdToCoupon(
  couponId: number,
  messageId: string
): Promise<boolean> {
  try {
    const response = await wcFetch(`/coupons/${couponId}`, {
      method: 'PUT',
      body: JSON.stringify({
        meta_data: [{ key: '_brevo_message_id', value: messageId }],
      }),
    });
    if (!response.ok) {
      console.error(`Failed to attach messageId to coupon ${couponId}:`, response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error attaching messageId to coupon:', error);
    return false;
  }
}

/**
 * Delete unused post-consultation coupons for a patient who canceled their booking.
 * With an eventUri only that event's coupons are deleted; without one (legacy
 * payload) any unused PAC coupon of that email.
 * Returns the Brevo messageIds stored in the deleted coupons so the caller
 * can revoke the scheduled emails.
 */
export async function deleteUnusedPatientCoupons(params: {
  patientEmail: string;
  eventUri?: string;
}): Promise<{ deleted: string[]; messageIds: string[]; errors: number }> {
  const { patientEmail, eventUri } = params;
  const deleted: string[] = [];
  const messageIds: string[] = [];
  let errors = 0;

  const response = await wcFetch(
    `/coupons?search=${encodeURIComponent(patientEmail)}&per_page=100`
  );
  if (!response.ok) {
    console.error('Failed to search coupons for cancellation:', response.status);
    return { deleted, messageIds, errors: 1 };
  }

  const coupons: WcCoupon[] = await response.json();
  const meta = (c: WcCoupon, key: string) =>
    c.meta_data?.find(m => m.key === key)?.value;

  const candidates = coupons.filter(
    c =>
      esCuponPaciente(c) &&
      c.usage_count === 0 &&
      meta(c, '_patient_email') === patientEmail
  );

  // Con eventUri solo se borran los cupones de ESE turno: si el paciente tiene
  // otra reserva activa, su cupón sigue vivo. Sin eventUri (payload viejo) se
  // cae al comportamiento anterior: cualquier PAC sin usar del email.
  const toDelete = eventUri
    ? candidates.filter(c => meta(c, '_event_uri') === eventUri)
    : candidates;

  for (const coupon of toDelete) {
    try {
      const delResponse = await wcFetch(`/coupons/${coupon.id}?force=true`, {
        method: 'DELETE',
      });
      if (delResponse.ok) {
        deleted.push(coupon.code);
        const messageId = meta(coupon, '_brevo_message_id');
        if (messageId) messageIds.push(messageId);
        console.log(`Deleted coupon after cancellation: ${coupon.code} (${patientEmail})`);
      } else {
        errors++;
      }
    } catch {
      errors++;
    }
  }

  return { deleted, messageIds, errors };
}

/**
 * Cupones post-consulta (sin usar o usados) de un paciente, buscados por email.
 */
export async function findPatientCoupons(patientEmail: string): Promise<WcCoupon[]> {
  const response = await wcFetch(
    `/coupons?search=${encodeURIComponent(patientEmail)}&per_page=100`
  );
  if (!response.ok) {
    throw new Error(`WooCommerce coupons search HTTP ${response.status}`);
  }
  const coupons: WcCoupon[] = await response.json();
  return coupons.filter(
    c => esCuponPaciente(c) && couponMeta(c, '_patient_email') === patientEmail
  );
}

/**
 * Todos los cupones del embudo post-consulta (paginado sobre TODOS los cupones
 * de la tienda, porque el código ya no lleva prefijo). Lanza si WooCommerce falla.
 */
export async function listPacCoupons(): Promise<WcCoupon[]> {
  const all: WcCoupon[] = [];
  let page = 1;
  while (page <= 10) {
    const response = await wcFetch(`/coupons?per_page=100&page=${page}`);
    if (!response.ok) {
      throw new Error(`WooCommerce coupons list HTTP ${response.status} (page ${page})`);
    }
    const coupons: WcCoupon[] = await response.json();
    if (coupons.length === 0) break;
    all.push(...coupons.filter(esCuponPaciente));
    if (coupons.length < 100) break;
    page++;
  }
  return all;
}

/**
 * Delete all expired post-consultation coupons from WooCommerce (only those:
 * manual/campaign coupons with an expiry date are never touched).
 * Called by the cleanup cron job.
 */
export async function cleanupExpiredCoupons(): Promise<{
  checked: number;
  deleted: number;
  errors: number;
}> {
  let checked = 0;
  let deleted = 0;
  let errors = 0;
  let page = 1;
  const now = new Date();

  // Paginate through all coupons; only post-consultation ones are candidates
  while (true) {
    const response = await wcFetch(`/coupons?per_page=100&page=${page}`);

    if (!response.ok) {
      console.error(`Failed to fetch coupons page ${page}:`, response.status);
      break;
    }

    const coupons: WcCoupon[] = await response.json();
    if (coupons.length === 0) break;

    for (const coupon of coupons) {
      if (!esCuponPaciente(coupon)) continue;
      checked++;

      // Skip coupons without expiration. `date_expires` viene en hora del sitio
      // sin zona (Node lo leería como UTC → 3 h de error): usamos la versión GMT.
      const expiresAt = parseWcGmt(coupon.date_expires_gmt ?? coupon.date_expires);
      if (!expiresAt) continue;
      if (expiresAt >= now) continue;

      // Expired — delete it
      try {
        const delResponse = await wcFetch(`/coupons/${coupon.id}?force=true`, {
          method: 'DELETE',
        });

        if (delResponse.ok) {
          deleted++;
          console.log(`Deleted expired coupon: ${coupon.code} (ID ${coupon.id})`);
        } else {
          errors++;
          console.error(`Failed to delete coupon ${coupon.code}:`, delResponse.status);
        }
      } catch (err) {
        errors++;
        console.error(`Error deleting coupon ${coupon.code}:`, err);
      }
    }

    page++;
  }

  return { checked, deleted, errors };
}
