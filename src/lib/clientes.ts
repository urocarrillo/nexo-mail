/**
 * Módulo central del filtro "¿ya es cliente?" (PRD-filtro-cliente / T8).
 *
 * Fuente de verdad: WooCommerce, exclusivamente. Una persona es CLIENTE si
 * tiene ≥1 orden en status `completed` o `processing` (cualquier producto).
 * `billing_email` normalizado (lowercase + trim) es la clave.
 *
 * Este archivo es el único lugar donde vive la regla; los webhooks y el cron
 * la consumen vía esCliente() / estadoCliente() / getClientes().
 *
 * La parte de clasificación (classifyOrders / buildClientesMap / normalizeEmail
 * / buildReconciliationDiff) es pura y testeable sin red. Sólo getClientes()
 * hace IO (WooCommerce REST + cache KV, TTL 1 h).
 */
import { kv } from '@vercel/kv';

// ─── Constantes de negocio ──────────────────────────────────────────
export const PROGRAMA_DE_PRODUCT_ID = 3740;

// Emails de test — nunca cuentan como cliente (PRD "Exclusiones fijas").
export const TEST_EMAILS = new Set<string>([
  'urologia.ar@gmail.com',
  'urologia.carrillo@gmail.com',
  'pruebatester7@gmail.com',
]);

// Etiqueta legible por producto para la columna `Cliente` del Sheet CRM.
export const PRODUCT_LABELS: Record<number, string> = {
  3740: 'programa',
  1043: 'curso-preservativo',
  3208: 'curso-ep',
};

// Status de WooCommerce que cuentan como compra paga.
const PAID_STATUSES = new Set(['completed', 'processing']);
const REFUND_STATUSES = new Set(['refunded']);
// Cualquier otro status (pending, cancelled, on-hold, failed) es "no pago".

// Status que pedimos a la API (los relevantes para clasificar).
const RELEVANT_STATUSES = [
  'completed',
  'processing',
  'refunded',
  'cancelled',
  'pending',
  'on-hold',
];

const WC_BASE_URL = 'https://urologia.ar/wp-json/wc/v3';
const CACHE_KEY = 'clientes:map:v1';
const CACHE_TTL_SECONDS = 60 * 60; // 1 hora

// ─── Tipos ──────────────────────────────────────────────────────────
export type EstadoCliente =
  | 'cliente-programa'
  | 'cliente-otro'
  | 'carrito-caido'
  | 'refund'
  | 'lead';

export interface ClienteInfo {
  estado: EstadoCliente;
  productos: number[]; // IDs de producto relevantes al estado
  fechaUltimaCompra: string | null; // ISO de la orden más reciente que define el estado
}

export type ClientesMap = Map<string, ClienteInfo>;

/** Orden WooCommerce reducida a lo que necesitamos para clasificar. */
export interface WcOrderLite {
  id: number;
  status: string;
  email: string; // billing email, ya normalizado
  productIds: number[];
  dateCreated: string; // ISO
}

// ─── Helpers puros ──────────────────────────────────────────────────

/** Único lugar donde se normaliza un email: lowercase + trim. */
export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

function uniqueSorted(ids: number[]): number[] {
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

function latestDate(orders: WcOrderLite[]): string | null {
  let latest: string | null = null;
  for (const o of orders) {
    if (!o.dateCreated) continue;
    if (!latest || new Date(o.dateCreated).getTime() > new Date(latest).getTime()) {
      latest = o.dateCreated;
    }
  }
  return latest;
}

/**
 * Clasifica el conjunto de órdenes de UN email en un ClienteInfo.
 *
 * Precedencia (de mayor a menor):
 *   1. Compra paga (completed/processing) de 3740  → cliente-programa
 *   2. Compra paga de otro producto                → cliente-otro
 *   3. Orden refunded                              → refund (cliente, excluido de venta)
 *   4. Sólo órdenes no pagas de 3740               → carrito-caido
 *   5. Nada de lo anterior                         → lead
 *
 * Nota (caso nahuel.auge): una orden cancelled/refunded posterior no le quita
 * el estado a una compra paga — la paga siempre manda (pasos 1-2 antes que 3-4).
 */
export function classifyOrders(orders: WcOrderLite[]): ClienteInfo {
  const paid = orders.filter((o) => PAID_STATUSES.has(o.status));
  const refunded = orders.filter((o) => REFUND_STATUSES.has(o.status));

  if (paid.length > 0) {
    const productos = uniqueSorted(paid.flatMap((o) => o.productIds));
    const estado: EstadoCliente = productos.includes(PROGRAMA_DE_PRODUCT_ID)
      ? 'cliente-programa'
      : 'cliente-otro';
    return { estado, productos, fechaUltimaCompra: latestDate(paid) };
  }

  if (refunded.length > 0) {
    const productos = uniqueSorted(refunded.flatMap((o) => o.productIds));
    return { estado: 'refund', productos, fechaUltimaCompra: latestDate(refunded) };
  }

  // Sólo órdenes no pagas: carrito-caido si alguna es del programa 3740.
  const programaAbandonado = orders.filter((o) =>
    o.productIds.includes(PROGRAMA_DE_PRODUCT_ID)
  );
  if (programaAbandonado.length > 0) {
    return {
      estado: 'carrito-caido',
      productos: [PROGRAMA_DE_PRODUCT_ID],
      fechaUltimaCompra: latestDate(programaAbandonado),
    };
  }

  return { estado: 'lead', productos: [], fechaUltimaCompra: null };
}

/**
 * Agrupa órdenes por email normalizado, excluye los emails de test y clasifica.
 * Sólo guarda entradas con estado distinto de 'lead' (un email sin señal de
 * cliente simplemente no está en el mapa → estadoCliente() devuelve 'lead').
 */
export function buildClientesMap(orders: WcOrderLite[]): ClientesMap {
  const byEmail = new Map<string, WcOrderLite[]>();
  for (const order of orders) {
    const email = normalizeEmail(order.email);
    if (!email || TEST_EMAILS.has(email)) continue;
    const list = byEmail.get(email);
    if (list) list.push(order);
    else byEmail.set(email, [order]);
  }

  const map: ClientesMap = new Map();
  for (const [email, list] of byEmail) {
    const info = classifyOrders(list);
    if (info.estado !== 'lead') {
      map.set(email, info);
    }
  }
  return map;
}

/** Texto para la columna `Cliente` del Sheet CRM (ej: "programa 29/06/2026"). */
export function clienteCellText(info: ClienteInfo): string {
  const fecha = info.fechaUltimaCompra
    ? new Date(info.fechaUltimaCompra).toLocaleDateString('es-AR')
    : '';
  let label: string;
  if (info.estado === 'cliente-programa') {
    label = 'programa';
  } else if (info.estado === 'refund') {
    label = 'refund';
  } else if (info.estado === 'carrito-caido') {
    label = 'carrito-caido';
  } else {
    const primary = info.productos[0];
    label = PRODUCT_LABELS[primary] || (primary ? `producto-${primary}` : 'cliente');
  }
  return fecha ? `${label} ${fecha}` : label;
}

/** Texto para el atributo PRODUCTOS de Brevo (ej: "programa, curso-ep"). */
export function productosText(info: ClienteInfo): string {
  return info.productos
    .map((id) => PRODUCT_LABELS[id] || `producto-${id}`)
    .join(', ');
}

// ─── IO: WooCommerce + cache KV ─────────────────────────────────────

interface RawWcOrder {
  id: number;
  status: string;
  billing?: { email?: string };
  line_items?: Array<{ product_id?: number }>;
  date_created?: string;
  date_created_gmt?: string;
}

function mapRawOrder(raw: RawWcOrder): WcOrderLite | null {
  const email = raw.billing?.email;
  if (!email || typeof raw.id !== 'number' || typeof raw.status !== 'string') {
    return null;
  }
  const productIds = (raw.line_items || [])
    .map((li) => li.product_id)
    .filter((id): id is number => typeof id === 'number');
  return {
    id: raw.id,
    status: raw.status,
    email: normalizeEmail(email),
    productIds,
    dateCreated: raw.date_created || raw.date_created_gmt || '',
  };
}

function wcAuthHeader(): string {
  const user = process.env.WP_USER || '';
  const pass = process.env.WP_APP_PASSWORD || '';
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Trae órdenes de WooCommerce paginando per_page=100.
 * @param modifiedAfter ISO date — si se pasa, sólo órdenes modificadas después
 *   (usado por el cron reconciliador para mirar las últimas 48 h).
 */
export async function fetchWooOrders(modifiedAfter?: string): Promise<WcOrderLite[]> {
  if (!process.env.WP_USER || !process.env.WP_APP_PASSWORD) {
    throw new Error('WP_USER / WP_APP_PASSWORD no configurados (lectura de órdenes WC)');
  }

  const statusParams = RELEVANT_STATUSES.map(
    (s) => `status[]=${encodeURIComponent(s)}`
  ).join('&');

  const orders: WcOrderLite[] = [];
  let page = 1;
  const maxPages = 200; // guarda contra loops infinitos

  while (page <= maxPages) {
    let url =
      `${WC_BASE_URL}/orders?${statusParams}` +
      `&per_page=100&page=${page}&orderby=date&order=desc`;
    if (modifiedAfter) {
      url += `&modified_after=${encodeURIComponent(modifiedAfter)}`;
    }

    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: wcAuthHeader(),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WooCommerce orders fetch failed (${res.status}) page ${page}: ${body}`);
    }

    const batch = (await res.json()) as RawWcOrder[];
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const raw of batch) {
      const mapped = mapRawOrder(raw);
      if (mapped) orders.push(mapped);
    }

    if (batch.length < 100) break;
    page++;
    // Pausa corta para no golpear rate limits del hosting.
    await new Promise((r) => setTimeout(r, 250));
  }

  return orders;
}

// Serialización del mapa para KV (Map no es JSON-serializable).
interface CachedClientes {
  builtAt: string;
  entries: Record<string, ClienteInfo>;
}

function mapToCache(map: ClientesMap): CachedClientes {
  const entries: Record<string, ClienteInfo> = {};
  for (const [email, info] of map) entries[email] = info;
  return { builtAt: new Date().toISOString(), entries };
}

function cacheToMap(cached: CachedClientes): ClientesMap {
  return new Map(Object.entries(cached.entries));
}

/**
 * Devuelve el mapa completo email → ClienteInfo.
 * Cachea en KV con TTL 1 h. `force` salta la cache (backfill / cron / webhook).
 */
export async function getClientes(opts?: { force?: boolean }): Promise<ClientesMap> {
  if (!opts?.force) {
    try {
      const cached = await kv.get<CachedClientes>(CACHE_KEY);
      if (cached && cached.entries) {
        return cacheToMap(cached);
      }
    } catch (err) {
      console.warn('clientes cache read failed, rebuilding:', err);
    }
  }

  const orders = await fetchWooOrders();
  const map = buildClientesMap(orders);

  try {
    await kv.set(CACHE_KEY, mapToCache(map), { ex: CACHE_TTL_SECONDS });
  } catch (err) {
    console.warn('clientes cache write failed (non-blocking):', err);
  }

  return map;
}

/** Invalida la cache del mapa (llamar tras una compra nueva vía webhook). */
export async function invalidateClientesCache(): Promise<void> {
  try {
    await kv.del(CACHE_KEY);
  } catch (err) {
    console.warn('clientes cache invalidate failed (non-blocking):', err);
  }
}

/**
 * Estado del cliente. Devuelve 'lead' si el email no tiene señal de cliente.
 * Si se pasa un `map` precargado, no toca la red.
 */
export async function estadoCliente(
  email: string,
  map?: ClientesMap
): Promise<EstadoCliente> {
  const m = map || (await getClientes());
  return m.get(normalizeEmail(email))?.estado || 'lead';
}

/** Info completa del cliente, o null si es lead/desconocido. */
export async function getClienteInfo(
  email: string,
  map?: ClientesMap
): Promise<ClienteInfo | null> {
  const m = map || (await getClientes());
  return m.get(normalizeEmail(email)) || null;
}

/**
 * ¿Es cliente pago? true sólo para cliente-programa / cliente-otro.
 * (refund y carrito-caido NO son "cliente pago" según la definición del PRD,
 * pero igual están excluidos de venta — usar estadoCliente() para esa lógica.)
 */
export async function esCliente(email: string, map?: ClientesMap): Promise<boolean> {
  const estado = await estadoCliente(email, map);
  return estado === 'cliente-programa' || estado === 'cliente-otro';
}

// ─── Reconciliación (diff puro y testeable) ─────────────────────────

export type DiffTipo =
  | 'falta-en-sheet' // cliente en Woo, sin marca en el Sheet CRM
  | 'falta-en-brevo' // cliente en Woo, sin HAS_PURCHASED en Brevo
  | 'texto-sheet-distinto'; // marca del Sheet no coincide con la esperada

export interface DiffEntry {
  email: string;
  tipo: DiffTipo;
  estado: EstadoCliente;
  esperado: string; // texto/valor esperado
  actual: string; // texto/valor actual
}

/**
 * Arma la lista de discrepancias entre WooCommerce (fuente de verdad) y lo
 * registrado en el Sheet CRM + Brevo. Función pura → testeable.
 *
 * @param wooMap         mapa email → ClienteInfo desde WooCommerce
 * @param sheetMarcas    email → texto actual de la columna `Cliente` ('' si vacío)
 * @param brevoComprados set de emails con HAS_PURCHASED=true en Brevo
 */
export function buildReconciliationDiff(params: {
  wooMap: ClientesMap;
  sheetMarcas: Map<string, string>;
  brevoComprados: Set<string>;
}): DiffEntry[] {
  const { wooMap, sheetMarcas, brevoComprados } = params;
  const diffs: DiffEntry[] = [];

  for (const [email, info] of wooMap) {
    const esperadoTexto = clienteCellText(info);
    const esPago = info.estado === 'cliente-programa' || info.estado === 'cliente-otro';

    // Sheet: comparar marca
    const marcaActual = (sheetMarcas.get(email) || '').trim();
    if (!marcaActual) {
      diffs.push({
        email,
        tipo: 'falta-en-sheet',
        estado: info.estado,
        esperado: esperadoTexto,
        actual: '',
      });
    } else if (marcaActual !== esperadoTexto) {
      diffs.push({
        email,
        tipo: 'texto-sheet-distinto',
        estado: info.estado,
        esperado: esperadoTexto,
        actual: marcaActual,
      });
    }

    // Brevo: sólo exigimos HAS_PURCHASED para clientes pagos.
    if (esPago && !brevoComprados.has(email)) {
      diffs.push({
        email,
        tipo: 'falta-en-brevo',
        estado: info.estado,
        esperado: 'HAS_PURCHASED=true',
        actual: 'HAS_PURCHASED=false',
      });
    }
  }

  return diffs;
}
