/**
 * Pedidos WooCommerce ↔ pagos Mercado Pago: lógica compartida por el cron
 * reconciliar-mp, la verificación al volver de MP (/api/pago/verificar), el
 * formulario "No puedo acceder" (/api/form/no-puedo-acceder) y el webhook de
 * WooCommerce (mail de bienvenida).
 *
 * Reglas de resolución (resolverPedido):
 *  - completed/processing → ya_completado, no se toca.
 *  - pending/on-hold + pago approved y ningún pago in_mediation/charged_back →
 *    se completa (PUT status=completed + transaction_id + nota).
 *  - Cualquier pago in_mediation/charged_back → en_mediacion, no se toca.
 *  - Pago pending/in_process/authorized → pago_pendiente.
 *  - Sin pagos → sin_pago · sólo rejected/cancelled/refunded → pago_rechazado.
 *  - Pedido que no es de MP, o en estado no completable (cancelled/failed/
 *    refunded) con pago aprobado → revisar_manual (aviso, sin tocar).
 *
 * Edades SIEMPRE con date_created_gmt (+ 'Z'): `date_created` viene en hora del
 * sitio (UTC-3) sin offset y Vercel corre en UTC → 3 h de corrimiento.
 */
import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { parseWcGmt } from './woocommerce-coupons';
import { plainToHtml } from './email-drip';
import { ACCESO_SENDER, buildMailBienvenida, buildMailListo } from './mails-acceso';

const WC_BASE = 'https://urologia.ar/wp-json/wc/v3';
const MP_BASE = 'https://api.mercadopago.com';
const TIMEOUT_MS = 10_000;
const LOG = '[mp-pedidos]';

/** Productos-curso publicados (LearnDash). Cualquier line_item cuenta como curso igual. */
export const CURSO_PRODUCT_IDS = [3740, 3208, 1043, 5243, 954, 2871];

export const AVISO_INTERNO_SENDER = { email: 'info@urologia.ar', name: 'Nexo-mail · Pagos' };
const AVISO_INTERNO_TO = ['mauro@urologia.ar', 'contacto.urologocarrillo@gmail.com'];

// ─── Tipos ──────────────────────────────────────────────────────────

export interface WcOrder {
  id: number;
  status: string;
  order_key?: string;
  /** Usuario de WordPress dueño del pedido (0 = invitado). */
  customer_id?: number;
  date_created: string;
  date_created_gmt?: string;
  payment_method: string;
  payment_method_title?: string;
  transaction_id?: string;
  total: string;
  currency: string;
  billing: { first_name?: string; last_name?: string; email?: string };
  line_items: { product_id?: number; name: string }[];
  meta_data?: { key: string; value: unknown }[];
}

export interface MpPayment {
  id: number;
  status: string;
  status_detail?: string;
  external_reference?: string;
  transaction_amount?: number;
  currency_id?: string;
  date_approved?: string | null;
  date_created?: string;
  payer?: { email?: string };
}

export type AccionPedido =
  | 'completado'
  | 'ya_completado'
  | 'en_mediacion'
  | 'pago_pendiente'
  | 'sin_pago'
  | 'pago_rechazado'
  | 'revisar_manual';

export interface ResultadoPedido {
  accion: AccionPedido;
  order: WcOrder;
  pago?: MpPayment;
  pagos: MpPayment[];
  motivo?: string;
}

const ESTADOS_PAGOS = new Set(['completed', 'processing']);
const ESTADOS_COMPLETABLES = new Set(['pending', 'on-hold']);
const MP_MEDIACION = new Set(['in_mediation', 'charged_back']);
const MP_PENDIENTE = new Set(['pending', 'in_process', 'authorized']);

// ─── HTTP ───────────────────────────────────────────────────────────

function wcAuth(): string {
  const user = process.env.WP_USER || '';
  const pass = process.env.WP_APP_PASSWORD || '';
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export async function wcFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${WC_BASE}${endpoint}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: wcAuth(),
      ...options.headers,
    },
  });
}

async function mpFetch(endpoint: string): Promise<Response> {
  return fetch(`${MP_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN || ''}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// ─── Pedidos WooCommerce ────────────────────────────────────────────

/** GET /orders/{id}. null si no existe (404); lanza en otros errores. */
export async function getOrder(id: number): Promise<WcOrder | null> {
  const res = await wcFetch(`/orders/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo GET /orders/${id} → ${res.status}`);
  return (await res.json()) as WcOrder;
}

/**
 * GET /orders con filtros. `status` acepta varios (WooCommerce REST: status[]=,
 * como en clientes.ts) o ['any'].
 */
export async function listarPedidos(params: {
  status: string[];
  search?: string;
  perPage?: number;
}): Promise<WcOrder[]> {
  const q: string[] = [];
  if (params.status.length === 1) q.push(`status=${encodeURIComponent(params.status[0])}`);
  else for (const s of params.status) q.push(`status[]=${encodeURIComponent(s)}`);
  if (params.search) q.push(`search=${encodeURIComponent(params.search)}`);
  q.push(`per_page=${params.perPage ?? 30}`, 'orderby=date', 'order=desc');
  const res = await wcFetch(`/orders?${q.join('&')}`);
  if (!res.ok) throw new Error(`Woo GET /orders → ${res.status}`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as WcOrder[]) : [];
}

export function esPedidoMp(order: Pick<WcOrder, 'payment_method'>): boolean {
  return (order.payment_method || '').startsWith('woo-mercado-pago');
}

/** Fecha de creación en UTC (date_created_gmt + 'Z'); cae a date_created si falta. */
export function fechaCreacion(order: Pick<WcOrder, 'date_created' | 'date_created_gmt'>): Date {
  return parseWcGmt(order.date_created_gmt) ?? new Date(order.date_created);
}

/** Edad del pedido en minutos, calculada sobre date_created_gmt. */
export function edadMinutos(
  order: Pick<WcOrder, 'date_created' | 'date_created_gmt'>,
  ahora: number = Date.now()
): number {
  return (ahora - fechaCreacion(order).getTime()) / 60_000;
}

export function nombreCliente(order: Pick<WcOrder, 'billing'>): string {
  return `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim();
}

export function nombresCursos(order: Pick<WcOrder, 'line_items'>): string[] {
  return (order.line_items || []).map((li) => li.name).filter(Boolean);
}

export function emailPedido(order: Pick<WcOrder, 'billing'>): string {
  return (order.billing?.email || '').toLowerCase().trim();
}

/**
 * Email con el que se entra al curso: el de la cuenta de WordPress dueña del
 * pedido (customer_id), que difiere del billing cuando el alumno compra
 * logueado con otra cuenta (caso #5604, 22/09/2026: LearnDash inscribió a la
 * cuenta logueada y los mails fueron al billing). Sin cuenta o si falla la
 * consulta → billing.
 */
export async function emailAccesoPedido(order: Pick<WcOrder, 'customer_id' | 'billing'>): Promise<string> {
  const billing = emailPedido(order);
  const uid = Number(order.customer_id || 0);
  if (!Number.isFinite(uid) || uid <= 0) return billing;
  try {
    const res = await wcFetch(`/customers/${uid}`);
    if (!res.ok) return billing;
    const c = (await res.json()) as { email?: string };
    return (c.email || '').toLowerCase().trim() || billing;
  } catch (err) {
    console.warn(LOG, `GET /customers/${uid} falló:`, errMsgLocal(err));
    return billing;
  }
}

function errMsgLocal(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function linkPedidoAdmin(orderId: number): string {
  return `https://urologia.ar/wp-admin/post.php?post=${orderId}&action=edit`;
}

/**
 * Elige el pedido que corresponde a una consulta de acceso: el más reciente con
 * line_items, priorizando los no cancelados y los que tienen un producto-curso
 * conocido. Puro (para tests).
 */
export function elegirPedido(orders: WcOrder[]): WcOrder | null {
  const conItems = orders.filter((o) => (o.line_items || []).length > 0);
  if (conItems.length === 0) return null;
  const rank = (o: WcOrder): number => {
    const vivo = !['cancelled', 'failed', 'refunded', 'trash'].includes(o.status);
    const curso = (o.line_items || []).some((li) => CURSO_PRODUCT_IDS.includes(li.product_id ?? -1));
    return (vivo ? 2 : 0) + (curso ? 1 : 0);
  };
  return [...conItems].sort((a, b) => {
    const dr = rank(b) - rank(a);
    if (dr !== 0) return dr;
    return fechaCreacion(b).getTime() - fechaCreacion(a).getTime();
  })[0];
}

// ─── Pagos Mercado Pago ─────────────────────────────────────────────

/** GET /v1/payments/{id}. null si no existe o MP devuelve error. */
export async function pagoPorId(paymentId: string | number): Promise<MpPayment | null> {
  const id = String(paymentId).trim();
  if (!/^\d+$/.test(id)) return null;
  const res = await mpFetch(`/v1/payments/${id}`);
  if (!res.ok) return null;
  return (await res.json()) as MpPayment;
}

/** Pedido al que pertenece un pago según external_reference "Curso-{id}". */
export function orderIdDeReferencia(pago: Pick<MpPayment, 'external_reference'>): number | null {
  const m = /^Curso-(\d+)$/.exec((pago.external_reference || '').trim());
  return m ? parseInt(m[1], 10) : null;
}

/** Pagos MP de un pedido: por meta _Mercado_Pago_Payment_IDs, si no por external_reference. */
export async function pagosDelPedido(order: WcOrder): Promise<MpPayment[]> {
  const idsMeta = order.meta_data?.find((m) => m.key === '_Mercado_Pago_Payment_IDs');
  const ids = String(idsMeta?.value || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));

  if (ids.length > 0) {
    const pagos: MpPayment[] = [];
    for (const id of ids) {
      const p = await pagoPorId(id);
      if (p) pagos.push(p);
    }
    if (pagos.length > 0) return pagos;
  }

  const res = await mpFetch(
    `/v1/payments/search?external_reference=${encodeURIComponent(`Curso-${order.id}`)}&sort=date_created&criteria=desc`
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: MpPayment[] };
  return data.results || [];
}

export function clasificarPagos(pagos: MpPayment[]): {
  aprobados: MpPayment[];
  enMediacion?: MpPayment;
  pendiente?: MpPayment;
  rechazado?: MpPayment;
} {
  return {
    aprobados: pagos.filter((p) => p.status === 'approved'),
    enMediacion: pagos.find((p) => MP_MEDIACION.has(p.status)),
    pendiente: pagos.find((p) => MP_PENDIENTE.has(p.status)),
    rechazado: pagos.find((p) => ['rejected', 'cancelled', 'refunded'].includes(p.status)),
  };
}

// ─── Completar / resolver ───────────────────────────────────────────

/**
 * PUT status=completed + transaction_id y nota en el pedido. Lanza si el PUT
 * falla (la nota es best-effort). Devuelve el pedido actualizado.
 */
export async function completarPedido(
  order: WcOrder,
  pago: MpPayment,
  opts: { origen: string }
): Promise<WcOrder> {
  const upd = await wcFetch(`/orders/${order.id}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'completed', transaction_id: String(pago.id) }),
  });
  if (!upd.ok) throw new Error(`Woo PUT /orders/${order.id} → ${upd.status}`);

  let actualizado: Partial<WcOrder> = {};
  try {
    actualizado = (await upd.json()) as Partial<WcOrder>;
  } catch {
    /* respuesta sin JSON: seguimos con el pedido local */
  }

  try {
    await wcFetch(`/orders/${order.id}/notes`, {
      method: 'POST',
      body: JSON.stringify({
        note: `Completado automáticamente por Nexo-mail (${opts.origen}): pago Mercado Pago ${pago.id} aprobado (${pago.date_approved || 's/f'}) pero la notificación de MP no había impactado en la tienda.`,
      }),
    });
  } catch (err) {
    console.error(LOG, `nota del pedido #${order.id} falló:`, err);
  }

  return { ...order, ...actualizado, status: 'completed', transaction_id: String(pago.id) };
}

/**
 * Decide y (salvo dry) aplica la acción sobre un pedido. Idempotente: un pedido
 * ya completed/processing devuelve ya_completado sin tocar nada. `pagos`
 * permite pasar un pago ya verificado (ej. payment_id que vuelve de MP) y
 * saltear la búsqueda.
 */
export async function resolverPedido(
  order: WcOrder,
  opts: { dry?: boolean; origen: string; pagos?: MpPayment[] }
): Promise<ResultadoPedido> {
  if (ESTADOS_PAGOS.has(order.status)) {
    return { accion: 'ya_completado', order, pagos: [] };
  }
  if (!esPedidoMp(order)) {
    return {
      accion: 'revisar_manual',
      order,
      pagos: [],
      motivo: `gateway ${order.payment_method_title || order.payment_method || 's/gateway'} (no Mercado Pago)`,
    };
  }

  const pagos = opts.pagos ?? (await pagosDelPedido(order));
  const c = clasificarPagos(pagos);
  const aprobado = c.aprobados[0];

  if (c.enMediacion) {
    return { accion: 'en_mediacion', order, pago: c.enMediacion, pagos };
  }
  if (aprobado) {
    if (!ESTADOS_COMPLETABLES.has(order.status)) {
      return {
        accion: 'revisar_manual',
        order,
        pago: aprobado,
        pagos,
        motivo: `pedido en estado "${order.status}" con pago aprobado ${aprobado.id}`,
      };
    }
    if (opts.dry) return { accion: 'completado', order, pago: aprobado, pagos };
    const actualizado = await completarPedido(order, aprobado, { origen: opts.origen });
    return { accion: 'completado', order: actualizado, pago: aprobado, pagos };
  }
  if (c.pendiente) {
    return { accion: 'pago_pendiente', order, pago: c.pendiente, pagos };
  }
  if (pagos.length === 0) {
    return { accion: 'sin_pago', order, pagos };
  }
  return { accion: 'pago_rechazado', order, pago: c.rechazado ?? pagos[0], pagos };
}

// ─── Mails ──────────────────────────────────────────────────────────

/** Destinatarios de los avisos internos: APPROVAL_EMAIL + fijos, sin repetir. */
export function destinatariosAviso(): string[] {
  const set = new Set<string>();
  for (const e of [process.env.APPROVAL_EMAIL || '', ...AVISO_INTERNO_TO]) {
    const n = e.toLowerCase().trim();
    if (n) set.add(n);
  }
  return [...set];
}

/** Aviso interno (a Mauro) desde info@. Nunca lanza. */
export async function enviarAvisoInterno(subject: string, text: string): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error(LOG, 'enviarAvisoInterno: falta BREVO_API_KEY', { subject });
    return false;
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        sender: AVISO_INTERNO_SENDER,
        to: destinatariosAviso().map((email) => ({ email })),
        subject,
        textContent: text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 201) {
      console.error(LOG, `enviarAvisoInterno: Brevo ${res.status}`, { subject });
      return false;
    }
    return true;
  } catch (err) {
    console.error(LOG, 'enviarAvisoInterno: error', { subject, err });
    return false;
  }
}

/**
 * Mail plano al alumno desde mauro@ (reply-to mauro@), sin pie de baja: son
 * mails transaccionales de acceso, no de secuencia. HTML mínimo (plainToHtml)
 * para que los links sean clickeables. Un envío por destinatario. Nunca lanza.
 */
export async function enviarMailAlumno(
  to: string[],
  nombre: string | undefined,
  subject: string,
  text: string
): Promise<{ ok: boolean; enviados: number; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, enviados: 0, error: 'BREVO_API_KEY missing' };

  const destinos = [...new Set(to.map((e) => e.toLowerCase().trim()).filter(Boolean))];
  let enviados = 0;
  let error: string | undefined;
  for (const email of destinos) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          sender: ACCESO_SENDER,
          to: [{ email, name: nombre || undefined }],
          replyTo: { email: ACCESO_SENDER.email },
          subject,
          textContent: text,
          htmlContent: plainToHtml(text, ''),
          tags: ['acceso'],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 201) enviados++;
      else error = `Brevo send ${res.status}: ${await res.text()}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  if (error) console.error(LOG, `mail "${subject}" →`, error);
  return { ok: enviados > 0 && !error, enviados, error };
}

// ─── Bienvenida (webhook completed) ─────────────────────────────────

const BIENVENIDA_TTL_S = 60 * 60 * 24 * 90;

/**
 * Mail "Cómo entrar a tu curso" al billing email, una sola vez por pedido
 * (KV bienvenida:{orderId}, 90 d). Si Brevo falla libera la marca para que la
 * próxima entrega del webhook lo reintente. Nunca lanza.
 */
export async function enviarBienvenida(params: {
  orderId: number | string;
  email: string;
  nombre?: string;
  cursos: string[];
}): Promise<{ enviado: boolean; motivo?: string }> {
  const key = `bienvenida:${params.orderId}`;
  let marcado = false;
  try {
    const got = await kv.set(key, new Date().toISOString(), { nx: true, ex: BIENVENIDA_TTL_S });
    if (!got) return { enviado: false, motivo: 'ya enviada' };
    marcado = true;
  } catch (err) {
    console.error(LOG, 'bienvenida: kv error (sigue sin idempotencia):', err);
  }

  const mail = buildMailBienvenida({ nombre: params.nombre, email: params.email, cursos: params.cursos });
  const r = await enviarMailAlumno([params.email], params.nombre, mail.subject, mail.text);
  if (!r.ok) {
    if (marcado) {
      try {
        await kv.del(key);
      } catch {
        /* best-effort */
      }
    }
    return { enviado: false, motivo: r.error };
  }
  return { enviado: true };
}

// ─── Casos "No puedo acceder" (KV) ──────────────────────────────────

export type EstadoCaso = 'abierto' | 'resuelto' | 'derivado';

export interface CasoAcceso {
  id: string;
  creado: string;
  actualizado?: string;
  estado: EstadoCaso;
  accion?: string;
  resueltoPor?: string;
  nombre: string;
  email_compra: string;
  email_pago?: string;
  operacion?: string;
  mensaje?: string;
  ip?: string;
  orderId?: number;
}

const CASO_TTL_S = 60 * 60 * 24 * 90;
const CASO_CIERRE_TTL_S = 60 * 60 * 24;
const casoKey = (id: string) => `caso-acceso:${id}`;
const casoPedidoKey = (orderId: number | string) => `caso-acceso:pedido:${orderId}`;

export function nuevoCaso(datos: Omit<CasoAcceso, 'id' | 'creado' | 'estado'>): CasoAcceso {
  return { id: crypto.randomUUID(), creado: new Date().toISOString(), estado: 'abierto', ...datos };
}

/** Destinatarios del alumno: email_compra + email_pago si es distinto. */
export function destinatariosCaso(caso: Pick<CasoAcceso, 'email_compra' | 'email_pago'>): string[] {
  return [...new Set([caso.email_compra, caso.email_pago || ''].map((e) => e.toLowerCase().trim()).filter(Boolean))];
}

export async function guardarCaso(caso: CasoAcceso): Promise<boolean> {
  try {
    await kv.set(casoKey(caso.id), caso, { ex: CASO_TTL_S });
    return true;
  } catch (err) {
    console.error(LOG, 'guardarCaso: kv error', err);
    return false;
  }
}

export async function vincularCasoPedido(orderId: number, casoId: string): Promise<void> {
  try {
    await kv.set(casoPedidoKey(orderId), casoId, { ex: CASO_TTL_S });
  } catch (err) {
    console.error(LOG, 'vincularCasoPedido: kv error', err);
  }
}

export async function getCaso(id: string): Promise<CasoAcceso | null> {
  try {
    return (await kv.get<CasoAcceso>(casoKey(id))) || null;
  } catch (err) {
    console.error(LOG, 'getCaso: kv error', err);
    return null;
  }
}

export async function actualizarCaso(id: string, patch: Partial<CasoAcceso>): Promise<CasoAcceso | null> {
  const actual = await getCaso(id);
  if (!actual) return null;
  const nuevo: CasoAcceso = { ...actual, ...patch, actualizado: new Date().toISOString() };
  return (await guardarCaso(nuevo)) ? nuevo : null;
}

/** Caso abierto vinculado a un pedido (null si no hay o ya se resolvió). */
export async function casoAbiertoPorPedido(orderId: number | string): Promise<CasoAcceso | null> {
  try {
    const casoId = await kv.get<string>(casoPedidoKey(orderId));
    if (!casoId) return null;
    const caso = await getCaso(casoId);
    return caso && caso.estado === 'abierto' ? caso : null;
  } catch (err) {
    console.error(LOG, 'casoAbiertoPorPedido: kv error', err);
    return null;
  }
}

/**
 * Cierra un caso cuyo pedido acaba de completarse: mail "Listo, tu curso ya
 * está activo" al alumno, aviso a Mauro y estado resuelto. Con claim nx en KV
 * para que cron, formulario y webhook no dupliquen el mail. Nunca lanza.
 */
export async function cerrarCaso(
  caso: CasoAcceso,
  order: Pick<WcOrder, 'id' | 'billing' | 'line_items'>,
  opts: { origen: string; accion?: string }
): Promise<{ cerrado: boolean; motivo?: string }> {
  try {
    const got = await kv.set(`caso-acceso:cierre:${caso.id}`, opts.origen, { nx: true, ex: CASO_CIERRE_TTL_S });
    if (!got) return { cerrado: false, motivo: 'ya cerrado por otro proceso' };
  } catch (err) {
    console.error(LOG, 'cerrarCaso: kv claim error (sigue):', err);
  }

  const cursos = nombresCursos(order);
  const mail = buildMailListo({ nombre: caso.nombre, email: emailPedido(order), cursos });
  const envio = await enviarMailAlumno(destinatariosCaso(caso), caso.nombre, mail.subject, mail.text);

  await actualizarCaso(caso.id, {
    estado: 'resuelto',
    accion: opts.accion || 'completado',
    resueltoPor: opts.origen,
    orderId: order.id,
  });

  await enviarAvisoInterno(
    `[Acceso] resuelto — ${caso.email_compra}`,
    `Resuelto automáticamente (${opts.origen}).\n\nEl pedido #${order.id} se completó y se le mandó al alumno el mail "${mail.subject}" (${envio.ok ? `enviado a ${destinatariosCaso(caso).join(', ')}` : `FALLÓ el envío: ${envio.error}`}).\n\nCaso: ${caso.id}\nNombre: ${caso.nombre}\nEmail de compra: ${caso.email_compra}\nEmail de pago: ${caso.email_pago || '-'}\nN.º de operación: ${caso.operacion || '-'}\nMensaje: ${caso.mensaje || '-'}\nAbierto: ${caso.creado}\n\nCursos: ${cursos.join(', ') || '-'}\nBilling email: ${emailPedido(order)}\n\nVer pedido: ${linkPedidoAdmin(order.id)}\n\n— Nexo-mail`
  );

  return { cerrado: true };
}

/** Si hay un caso abierto para el pedido, lo cierra (ver cerrarCaso). */
export async function cerrarCasoAccesoPorPedido(
  order: Pick<WcOrder, 'id' | 'billing' | 'line_items'>,
  opts: { origen: string }
): Promise<{ cerrado: boolean; casoId?: string; motivo?: string }> {
  const caso = await casoAbiertoPorPedido(order.id);
  if (!caso) return { cerrado: false, motivo: 'sin caso abierto' };
  const r = await cerrarCaso(caso, order, opts);
  return { ...r, casoId: caso.id };
}
