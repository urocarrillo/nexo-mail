import crypto from 'crypto';
import { NextRequest, NextResponse, after } from 'next/server';
import { kv } from '@vercel/kv';
import { getGoogleAccessToken } from '@/lib/google-auth';
import { CRM_SHEET_ID, CRM_TAB, colLetter } from '@/lib/crm-sheet';
import { calcularTier, tierParaEnvio } from '@/lib/tier-programa';
import {
  SENT_KEY_PREFIX,
  SENT_TTL_S,
  dispatchPostTest,
  esErrorAmbiguo,
  type DispatchResult,
  type PendingMark,
} from '@/lib/postest';
import { enviarAlerta } from '@/lib/alertas';
import { etiquetarTier } from '@/lib/manychat';
import {
  CONTACTO_COL_KEYS,
  CONTACTO_TEXTOS,
  NEW_COLUMN_SPECS,
  TOKEN_PREFIX,
  buildRow,
  emailCanonico,
  fechaHoraArt,
  filaDesdeUpdatedRange,
  formatSubmittedAt,
  generarToken,
  getNewColumnsCache,
  maskEmail,
  parseSubmittedAt,
  primeraColumnaLibre,
  resolverColumnas,
  respuestasDesdeLetras,
  setNewColumnsCache,
  validateContacto,
  validateFinal,
  validatePartial,
  type Cols,
  type ContactoData,
  type FinalData,
  type PartialData,
} from '@/lib/test-programa';

/**
 * Test propio del programa DE (public/test.html → /test). Reemplaza al
 * Typeform bNbpXutl.
 *
 *  step 'partial'  → upsert Brevo #33 (best-effort). Nada más.
 *  step 'final'    → tier (tier-programa) → fila en el Sheet CRM (mismos textos
 *                    que Typeform) → respuesta al front → mail post-test
 *                    (dispatchPostTest, en background con `after`) → marca
 *                    "Mail enviado" = 'form dd/mm/yyyy HH:MM' en esa fila, así
 *                    el vigilante no la vuelve a mandar. En paralelo etiqueta
 *                    TIER A/B/C al contacto de ManyChat (lib/manychat, best-effort).
 *                    Idempotente por email
 *                    (KV testfinal:, 10 min) y participa de la guardia
 *                    postest-sent: del vigilante (inflight antes del append,
 *                    fecha tras el envío): un email que ya recibió el post-test
 *                    no lo recibe de nuevo (fila marcada 'form kv-dup …').
 *  step 'contacto' → B-CONTACTO: escribe P8 (+ teléfono en P14/P15) en la
 *                    fila 'form-…' más reciente del email y avisa a Mauro.
 *
 * Orden en 'final': primero Sheet, después mail. Si el append falla → 502 sin
 * mail (el front reintenta y reusa la fila si llegó a escribirse).
 */

export const maxDuration = 60;

const PROGRAMA_LIST_ID = 33; // "TIKTOK Leads PROGRAMA" en Brevo (pre-test)
const ALLOWED_ORIGINS = [
  'https://link.urologia.ar',
  'https://urologia.ar',
  'https://www.urologia.ar',
  'https://nexo-mail.vercel.app',
];
const MAX_BODY_BYTES = 8 * 1024;
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX = 10; // el front hace hasta 3 requests por persona
const FINALES_POR_EMAIL_DIA = 2; // filas nuevas por email (canónico) por día
const SHEETS_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 8_000;
const BREVO_TIMEOUT_MS = 8_000;
const KV_PREFIX = 'testfinal:';
const KV_TTL_S = 600;
const RL_IP_PREFIX = 'rl:ip:';
const RL_EMAIL_PREFIX = 'rl:email:';
const RL_EMAIL_TTL_S = 24 * 60 * 60;
const CONTACTO_ALERT_PREFIX = 'testcontacto:';
const CONTACTO_ALERT_TTL_S = 60 * 60;
const ALERT_THROTTLE_S = 60 * 60; // alertas estructurales: máximo 1 por hora
const SENT_INFLIGHT = 'inflight'; // mismo valor que usa el vigilante
const SENT_INFLIGHT_TTL_S = 300;
const CONTACTO_VENTANA_MS = 2 * 60 * 60 * 1000;
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${CRM_SHEET_ID}/edit`;
const LOG = 'test-programa';
const CONTACTO_MAIL = 'recuperatuereccion@urologia.ar';

// ─── CORS / seguridad ───────────────────────────────────────────────

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  };
}

/** Server-to-server: x-api-key válida (comparación en tiempo constante) saltea el chequeo de origin. */
function hasValidApiKey(request: NextRequest): boolean {
  const key = request.headers.get('x-api-key');
  const secret = process.env.API_SECRET_KEY;
  if (!key || !secret) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Rate limiting por IP: contador en KV (compartido entre instancias). Si KV
// falla, cae al Map en memoria de la instancia.
const submissions = new Map<string, number[]>();

function isRateLimitedMemoria(ip: string): boolean {
  const now = Date.now();
  const recent = (submissions.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_S * 1000);
  recent.push(now);
  submissions.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

async function isRateLimited(ip: string): Promise<boolean> {
  const key = `${RL_IP_PREFIX}${ip}`;
  try {
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, RATE_LIMIT_WINDOW_S);
    return n > RATE_LIMIT_MAX;
  } catch (err) {
    console.error(LOG, 'kv rate limit error (cae a memoria):', errMsg(err));
    return isRateLimitedMemoria(ip);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

type CorsHeaders = Record<string, string>;

function fail(headers: CorsHeaders, status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstName(name?: string): string {
  if (!name) return '';
  return name.trim().split(/\s+/)[0] || '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

/** Fecha de hoy (Argentina) como yyyy-mm-dd, para el contador diario por email. */
function diaArt(d: Date): string {
  const [dd, mm, yyyy] = fechaHoraArt(d).slice(0, 10).split('/');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Corre `task` después de responder (Next `after`, waitUntil en Vercel). Fuera
 * de un request scope (tests) corre inline. Nunca lanza.
 */
async function runAfter(task: () => Promise<void>): Promise<void> {
  const safe = async () => {
    try {
      await task();
    } catch (err) {
      console.error(LOG, 'error en tarea diferida:', errMsg(err));
    }
  };
  try {
    after(safe);
  } catch {
    await safe();
  }
}

/**
 * Error estructural del Sheet (columna faltante, 4xx que no sea 429): no es
 * transitorio, reintentar no lo arregla y hay que avisar a Mauro.
 */
function esErrorEstructural(msg: string): boolean {
  if (/Faltan columnas/i.test(msg)) return true;
  const m = msg.match(/\((4\d\d)\)/);
  return m !== null && m[1] !== '429';
}

/** Alerta a Mauro con throttle por asunto (1/h vía KV nx). Si KV falla, manda igual. */
async function alertaThrottled(subject: string, text: string): Promise<void> {
  try {
    const got = await kv.set(`alerta:${subject}`, new Date().toISOString(), { nx: true, ex: ALERT_THROTTLE_S });
    if (!got) return;
  } catch (err) {
    console.error(LOG, 'alert throttle kv error:', errMsg(err));
  }
  await enviarAlerta(subject, text);
}

async function avisarSiEstructural(step: string, err: unknown): Promise<void> {
  const msg = errMsg(err);
  if (!esErrorEstructural(msg)) return;
  await alertaThrottled(
    `TEST-PROGRAMA: error estructural del Sheet (${step})`,
    `El step '${step}' del test propio no puede escribir en "${CRM_TAB}" y responde 502 a TODOS los usuarios.\n` +
      `Error: ${msg}\n\nRevisar los headers de la fila 1 (columna renombrada/borrada) o los permisos.\n${SHEET_URL}`
  );
}

// ─── Google Sheets ──────────────────────────────────────────────────

async function sheetsFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await withTimeout(getGoogleAccessToken(), AUTH_TIMEOUT_MS, 'Google auth');
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CRM_SHEET_ID}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
  });
}

async function readRange(range: string): Promise<string[][]> {
  const res = await sheetsFetch(`/values/${encodeURIComponent(range)}`);
  if (!res.ok) {
    throw new Error(`Sheet read failed (${res.status}) [${range}]: ${await res.text()}`);
  }
  const data = (await res.json()) as { values?: string[][] };
  return data.values || [];
}

async function readRanges(ranges: string[]): Promise<string[][][]> {
  const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const res = await sheetsFetch(`/values:batchGet?${qs}`);
  if (!res.ok) {
    throw new Error(`Sheet batchGet failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { valueRanges?: Array<{ values?: string[][] }> };
  return ranges.map((_, i) => data.valueRanges?.[i]?.values || []);
}

/** PUT de una sola celda (RAW). Reintenta una vez ante 429. */
async function writeCell(range: string, value: string): Promise<void> {
  const put = () =>
    sheetsFetch(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ range, values: [[value]] }),
    });
  let res = await put();
  if (res.status === 429) {
    await sleep(1500);
    res = await put();
  }
  if (!res.ok) {
    throw new Error(`Sheet write failed (${res.status}) [${range}]: ${await res.text()}`);
  }
}

type CellUpdate = { range: string; values: Array<Array<string | number>> };

/** Varias celdas en un solo request (RAW). Reintenta una vez ante 429. */
async function batchUpdate(data: CellUpdate[]): Promise<void> {
  if (data.length === 0) return;
  const post = () =>
    sheetsFetch(`/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    });
  let res = await post();
  if (res.status === 429) {
    await sleep(1500);
    res = await post();
  }
  if (!res.ok) {
    throw new Error(`Sheet batchUpdate failed (${res.status}): ${await res.text()}`);
  }
}

/** Agrega columnas a la grilla del tab (para crear headers más allá del ancho actual). */
async function appendColumns(count: number): Promise<void> {
  const meta = await sheetsFetch(`?fields=sheets.properties(sheetId,title)`);
  if (!meta.ok) throw new Error(`Sheet metadata failed (${meta.status}): ${await meta.text()}`);
  const data = (await meta.json()) as { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> };
  const tab = (data.sheets || []).find((s) => s.properties?.title === CRM_TAB);
  if (!tab || typeof tab.properties?.sheetId !== 'number') throw new Error(`Tab "${CRM_TAB}" no encontrado`);
  const res = await sheetsFetch(`:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ appendDimension: { sheetId: tab.properties.sheetId, dimension: 'COLUMNS', length: count } }],
    }),
  });
  if (!res.ok) throw new Error(`Sheet appendDimension failed (${res.status}): ${await res.text()}`);
}

/** Escribe un header; si la grilla es angosta, la ensancha y reintenta. */
async function writeHeader(col: number, header: string): Promise<void> {
  const range = `${CRM_TAB}!${colLetter(col)}1`;
  try {
    await writeCell(range, header);
  } catch (err) {
    if (!/grid limits/i.test(errMsg(err))) throw err;
    await appendColumns(2);
    await writeCell(range, header);
  }
}

/**
 * Lee los headers y resuelve columnas por nombre. País y Verbatim se crean
 * (una sola vez) en la primera columna con header vacío a la derecha de la
 * última usada; su índice se cachea en memoria 10 min.
 */
async function resolverColumnasSheet(): Promise<Cols> {
  const headers = (await readRange(`${CRM_TAB}!1:1`))[0] || [];
  const { cols, missing } = resolverColumnas(headers);
  if (missing.length > 0) {
    throw new Error(`Faltan columnas en "${CRM_TAB}": ${missing.join(' | ')}`);
  }

  const faltantes = NEW_COLUMN_SPECS.filter((s) => cols[s.key] < 0);
  if (faltantes.length === 0) return cols;

  const cache = getNewColumnsCache();
  if (cache) {
    for (const s of faltantes) cols[s.key] = cache[s.key];
    return cols;
  }

  let next = primeraColumnaLibre(headers);
  for (const s of faltantes) {
    await writeHeader(next, s.header);
    cols[s.key] = next;
    next++;
  }
  setNewColumnsCache({ pais: cols.pais, verbatim: cols.verbatim });
  console.log(LOG, 'columnas creadas', faltantes.map((s) => `${s.header}=${colLetter(cols[s.key])}`).join(', '));
  return cols;
}

async function appendRow(row: Array<string | number>): Promise<number | null> {
  const res = await sheetsFetch(
    `/values/${encodeURIComponent(CRM_TAB)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: [row] }) }
  );
  if (!res.ok) {
    throw new Error(`Sheet append failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { updates?: { updatedRange?: string } };
  return filaDesdeUpdatedRange(data.updates?.updatedRange);
}

/** Fila (1-based) cuyo Token es `token`, o null. Se usa al reprocesar un final. */
async function buscarFilaPorToken(cols: Cols, token: string): Promise<number | null> {
  const tCol = colLetter(cols.token);
  const tokens = await readRange(`${CRM_TAB}!${tCol}2:${tCol}`);
  for (let i = 0; i < tokens.length; i++) {
    if (((tokens[i] || [])[0] || '').trim() === token) return i + 2;
  }
  return null;
}

// ─── Brevo ──────────────────────────────────────────────────────────

const brevoHeaders = (apiKey: string) => ({
  accept: 'application/json',
  'content-type': 'application/json',
  'api-key': apiKey,
});

/** GET del contacto: 'existe' (con sus atributos), 'nuevo' (404) o 'desconocido' (error/timeout). */
async function brevoGetContact(
  apiKey: string,
  email: string
): Promise<{ estado: 'existe'; attributes: Record<string, unknown> } | { estado: 'nuevo' } | { estado: 'desconocido' }> {
  try {
    const res = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
      headers: brevoHeaders(apiKey),
      signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
    });
    if (res.status === 404) return { estado: 'nuevo' };
    if (!res.ok) return { estado: 'desconocido' };
    const data = (await res.json()) as { attributes?: Record<string, unknown> };
    return { estado: 'existe', attributes: data.attributes || {} };
  } catch {
    return { estado: 'desconocido' };
  }
}

/**
 * Upsert en la lista #33. Un contacto que ya existe NO recibe NOMBRE (un
 * formulario público no debe pisar el nombre de un cliente real) y conserva
 * su LEAD_SOURCE/PAIS si ya los tenía; solo se le agregan los que le faltan.
 */
async function brevoUpsertPartial(p: PartialData): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY missing' };

  const existente = await brevoGetContact(apiKey, p.email);
  // Atributos reales de la cuenta Brevo (FIRSTNAME/SOURCE no existen).
  let attributes: Record<string, string>;
  if (existente.estado === 'nuevo') {
    attributes = { NOMBRE: firstName(p.name), PAIS: p.pais, LEAD_SOURCE: `test-${p.src}` };
  } else {
    const prev = existente.estado === 'existe' ? existente.attributes : {};
    const vacio = (k: string) => prev[k] === undefined || prev[k] === null || String(prev[k]).trim() === '';
    attributes = {};
    if (vacio('PAIS')) attributes.PAIS = p.pais;
    // Con GET fallido no sabemos si tenía canal: solo pisamos con un src explícito.
    if (vacio('LEAD_SOURCE') && (existente.estado === 'existe' || p.src !== 'web')) {
      attributes.LEAD_SOURCE = `test-${p.src}`;
    }
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: brevoHeaders(apiKey),
      body: JSON.stringify({ email: p.email, attributes, listIds: [PROGRAMA_LIST_ID], updateEnabled: true }),
      signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
    });
    if (res.status === 201 || res.status === 204) return { ok: true };
    const raw = await res.text();
    if (res.status === 400 && raw.toLowerCase().includes('already')) return { ok: true };
    return { ok: false, error: `Brevo contact ${res.status}: ${raw}` };
  } catch (err) {
    return { ok: false, error: `Brevo contact error: ${errMsg(err)}` };
  }
}

// ─── KV (idempotencia del final, 10 min) ────────────────────────────

interface FinalStored {
  status: 'inflight' | 'done' | 'retry';
  ts: number; // Date.now() del intento en curso (stale = función muerta)
  t0?: number; // Date.now() del primer intento (para reconocer un envío propio)
  token?: string; // Token de la fila (se reusa al reprocesar)
  pantalla?: string;
  variante?: string;
}

/** Un 'inflight' más viejo que esto es una función que murió a mitad: se reprocesa. */
const INFLIGHT_STALE_MS = 90_000;

async function kvSetNx(key: string, value: FinalStored): Promise<'set' | 'exists' | 'error'> {
  try {
    const got = await kv.set(key, value, { nx: true, ex: KV_TTL_S });
    return got ? 'set' : 'exists';
  } catch (err) {
    console.error(LOG, 'kv.set error (sigue sin idempotencia):', errMsg(err));
    return 'error';
  }
}

async function kvGet(key: string): Promise<FinalStored | null> {
  try {
    const v = await kv.get<FinalStored | string>(key);
    if (!v) return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v) as FinalStored;
      } catch {
        return null;
      }
    }
    return v;
  } catch (err) {
    console.error(LOG, 'kv.get error:', errMsg(err));
    return null;
  }
}

async function kvSet(key: string, value: FinalStored): Promise<void> {
  try {
    await kv.set(key, value, { ex: KV_TTL_S });
  } catch (err) {
    console.error(LOG, 'kv.set (resultado) error:', errMsg(err));
  }
}

async function kvDel(key: string): Promise<void> {
  try {
    await kv.del(key);
  } catch (err) {
    console.error(LOG, 'kv.del error:', errMsg(err));
  }
}

async function kvGetString(key: string): Promise<string | null> {
  try {
    const v = await kv.get<unknown>(key);
    return typeof v === 'string' ? v : v == null ? null : String(v);
  } catch (err) {
    console.error(LOG, 'kv.get error:', errMsg(err));
    return null;
  }
}

/** Filas nuevas de este email (canónico) hoy. Si KV falla, 0 (no bloquea). */
async function finalesHoy(canon: string, now: Date): Promise<{ key: string; n: number }> {
  const key = `${RL_EMAIL_PREFIX}${canon}:${diaArt(now)}`;
  try {
    const v = await kv.get<number | string>(key);
    const n = typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10);
    return { key, n: Number.isFinite(n) ? n : 0 };
  } catch (err) {
    console.error(LOG, 'kv rl:email get error:', errMsg(err));
    return { key, n: 0 };
  }
}

async function contarFinalHoy(key: string): Promise<void> {
  try {
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, RL_EMAIL_TTL_S);
  } catch (err) {
    console.error(LOG, 'kv rl:email incr error:', errMsg(err));
  }
}

// ─── Guardia postest-sent (compartida con el vigilante) ─────────────

type SentGuard =
  | { r: 'tomada' } // key inflight puesta por nosotros: hay que despachar
  | { r: 'inflight' } // otro proceso (vigilante o función muerta) la tiene
  | { r: 'enviado'; previo: string }; // ya se mandó (fecha ISO, opcionalmente 'ambiguo ')

/**
 * Antes del append: kv.set nx 'inflight' (TTL 5 min). Así el vigilante, si
 * lee la fila mientras dura el dispatch, ve 'inflight' y no manda.
 */
async function tomarGuardiaSent(email: string, reprocesando: boolean): Promise<SentGuard> {
  const key = `${SENT_KEY_PREFIX}${email}`;
  let got: unknown;
  try {
    got = await kv.set(key, SENT_INFLIGHT, { nx: true, ex: SENT_INFLIGHT_TTL_S });
  } catch (err) {
    console.error(LOG, 'kv postest-sent set error (sigue sin guardia):', errMsg(err));
    return { r: 'tomada' };
  }
  if (got) return { r: 'tomada' };
  const previo = await kvGetString(key);
  if (previo === SENT_INFLIGHT && !reprocesando) return { r: 'inflight' };
  if (previo === SENT_INFLIGHT || previo === null) {
    // Nuestra función anterior murió con la key inflight (o la key venció /
    // kv.get falló entre medio): la tomamos sin nx.
    try {
      await kv.set(key, SENT_INFLIGHT, { ex: SENT_INFLIGHT_TTL_S });
    } catch (err) {
      console.error(LOG, 'kv postest-sent retomar error:', errMsg(err));
    }
    return { r: 'tomada' };
  }
  return { r: 'enviado', previo };
}

async function setSent(email: string, value: string): Promise<void> {
  try {
    await kv.set(`${SENT_KEY_PREFIX}${email}`, value, { ex: SENT_TTL_S });
  } catch (err) {
    console.error(LOG, 'kv postest-sent mark error:', errMsg(err));
  }
}

async function delSent(email: string): Promise<void> {
  try {
    await kv.del(`${SENT_KEY_PREFIX}${email}`);
  } catch (err) {
    console.error(LOG, 'kv postest-sent del error:', errMsg(err));
  }
}

/** Fecha del valor 'postest-sent' ('2026-…' o 'ambiguo 2026-…'), o NaN. */
function fechaSent(previo: string): number {
  return Date.parse(previo.replace(/^ambiguo\s+/, ''));
}

// ─── Steps ──────────────────────────────────────────────────────────

async function stepPartial(body: unknown, headers: CorsHeaders): Promise<NextResponse> {
  const v = validatePartial(body);
  if (!v.ok) return fail(headers, 400, v.error);
  const p = v.data;

  const r = await brevoUpsertPartial(p);
  if (!r.ok) {
    // Best-effort: el 'final' vuelve a dar de alta el contacto (lista 24).
    console.error(LOG, 'partial brevo error (non-blocking):', maskEmail(p.email), r.error);
  }
  console.log(LOG, 'partial', { email: maskEmail(p.email), pais: p.pais, src: p.src, brevo: r.ok });
  return NextResponse.json({ ok: true }, { headers });
}

interface MarcasFila {
  cols: Cols;
  rowIndex: number | null;
  marca: string;
  pendingMarks: PendingMark[];
}

/** 'Mail enviado' + marcas diferidas (Secuencia/Cliente/Estado) en un solo batchUpdate. */
async function escribirMarcas(f: FinalData, pantalla: string, m: MarcasFila): Promise<void> {
  const { cols, rowIndex, marca } = m;
  const masked = maskEmail(f.email);
  if (!rowIndex) {
    console.error(LOG, 'append sin updatedRange: no se pudo marcar la fila', masked);
    await enviarAlerta(
      'TEST-PROGRAMA: fila sin número',
      `El append de ${f.email} (${pantalla}) no devolvió updatedRange; la fila quedó sin "Mail enviado" (${marca}).\n` +
        `Marcarla a mano para que el vigilante no la reenvíe.\n${SHEET_URL}`
    );
    return;
  }
  const markCol = (pm: PendingMark): number =>
    pm.col === 'secuencia' ? cols.secuencia : pm.col === 'cliente' ? cols.cliente : cols.estado;
  const updates: CellUpdate[] = [{ range: `${CRM_TAB}!${colLetter(cols.mailEnviado)}${rowIndex}`, values: [[marca]] }];
  for (const pm of m.pendingMarks) {
    const col = markCol(pm);
    if (col < 0) continue;
    updates.push({ range: `${CRM_TAB}!${colLetter(col)}${rowIndex}`, values: [[pm.text]] });
  }
  try {
    await batchUpdate(updates);
  } catch (err) {
    console.error(LOG, 'no se pudo marcar Mail enviado:', masked, rowIndex, errMsg(err));
    await enviarAlerta(
      'TEST-PROGRAMA: no se pudo marcar "Mail enviado"',
      `Fila ${rowIndex} (${f.email}, ${pantalla}) quedó sin marca "${marca}": ${errMsg(err)}\n` +
        `Si el mail salió, el vigilante lo ve por la huella KV; si no, revisar a mano.\n${SHEET_URL}`
    );
  }
}

/**
 * Mail post-test + marcas. Corre después de responder al front (runAfter).
 * Si `yaEnviado` viene con la fecha previa de postest-sent, no se manda nada.
 */
async function despacharYMarcar(
  f: FinalData,
  tier: { pantalla: string; variante: string; score: number },
  tierEnvio: 'A' | 'B' | 'C',
  cols: Cols,
  rowIndex: number | null,
  yaEnviado: { previo: string; propio: boolean } | null
): Promise<void> {
  const masked = maskEmail(f.email);
  const ahora = new Date();

  if (yaEnviado) {
    // Envío previo: propio (intento anterior de este mismo test que murió tras
    // mandar) → 'form'; ajeno (Typeform/vigilante en los últimos 60 días) → 'form kv-dup'.
    const marca = `${yaEnviado.propio ? 'form' : 'form kv-dup'} ${fechaHoraArt(ahora)}`;
    console.log(LOG, 'final sin mail (postest-sent previo)', { email: masked, previo: yaEnviado.previo, marca });
    await escribirMarcas(f, tier.pantalla, { cols, rowIndex, marca, pendingMarks: [] });
    return;
  }

  // Con la fila conocida, las marcas Secuencia/Cliente/Estado se escriben acá
  // (deferMarks) si esas columnas existen.
  const deferMarks = cols.cliente >= 0 && cols.secuencia >= 0;
  let r: DispatchResult;
  try {
    r = await dispatchPostTest(
      {
        email: f.email,
        name: f.name,
        pantalla: tier.pantalla,
        variante: tier.variante,
        score: tier.score,
        tier: tierEnvio,
        pais: f.pais,
        respuestas: respuestasDesdeLetras(f),
      },
      { deferMarks }
    );
  } catch (err) {
    r = { success: false, tier: tierEnvio, pantalla: tier.pantalla, error: errMsg(err) };
  }
  const enviado = r.success && !r.skipped && r.sent !== false;
  const skipped = r.success && Boolean(r.skipped);
  const errorEnvio = enviado || skipped ? undefined : r.sendError || r.error || 'sin detalle';
  // Ambiguo = timeout/abort en la etapa de envío: Brevo pudo haber aceptado el
  // POST. Un fallo en la etapa 'contact' (sin mail) es definitivo.
  const ambiguo =
    Boolean(errorEnvio) && (r.success ? Boolean(r.sendError) : r.stage === 'send') && esErrorAmbiguo(errorEnvio);

  // Guardia KV fase 2 (como el vigilante): fecha larga si salió, si se salteó
  // (cliente-programa) o si quedó ambiguo; se libera si el fallo es definitivo.
  if (enviado || skipped) await setSent(f.email, ahora.toISOString());
  else if (ambiguo) await setSent(f.email, `ambiguo ${ahora.toISOString()}`);
  else await delSent(f.email);

  // Marca en la fila: 'form …' (enviado/skipped), 'form? …' (ambiguo) o
  // 'form-error …' (falló). Se marca igual en el error para que el vigilante
  // NO la reintente solo.
  const prefijo = !errorEnvio ? 'form' : ambiguo ? 'form?' : 'form-error';
  const marca = `${prefijo} ${fechaHoraArt(ahora)}`;
  await escribirMarcas(f, tier.pantalla, { cols, rowIndex, marca, pendingMarks: r.pendingMarks || [] });

  if (errorEnvio) {
    console.error(LOG, `final dispatch ${ambiguo ? 'ambiguo' : 'falló'}:`, masked, errorEnvio);
    await enviarAlerta(
      `TEST-PROGRAMA: ${ambiguo ? 'envío ambiguo del' : 'falló el'} mail post-test (${tier.pantalla})`,
      `${ambiguo ? 'No hubo respuesta definitiva de Brevo al mandar' : 'No se pudo mandar'} el mail post-test a ${f.name} <${f.email}> ` +
        `(fila ${rowIndex ?? '?'}, ${tier.variante}, score ${tier.score}).\n` +
        `Error: ${errorEnvio}\n\n` +
        `La fila quedó marcada "${marca}" para que el vigilante no la reintente sola. ` +
        (ambiguo
          ? 'Brevo pudo haberlo aceptado igual: verificar en Brevo antes de reenviar.'
          : 'Reenviar a mano.') +
        `\n${SHEET_URL}`
    );
  } else {
    console.log(LOG, 'final mail', { email: masked, tier: tierEnvio, enviado, skipped: r.skipped ? r.reason : false, enrolled: r.enrolled });
  }
}

async function stepFinal(body: unknown, headers: CorsHeaders): Promise<NextResponse> {
  const v = validateFinal(body);
  if (!v.ok) return fail(headers, 400, v.error);
  const f: FinalData = v.data;
  const masked = maskEmail(f.email);
  const canon = emailCanonico(f.email);
  const kvKey = `${KV_PREFIX}${canon}`;
  const now = Date.now();

  // Idempotencia: un solo procesamiento por email (canónico) cada 10 min.
  let token = generarToken();
  let t0 = now;
  let reprocesando = false;
  const nx = await kvSetNx(kvKey, { status: 'inflight', ts: now, t0, token });
  if (nx === 'exists') {
    const prev = await kvGet(kvKey);
    if (prev?.status === 'done' && prev.pantalla) {
      console.log(LOG, 'final repetido → resultado guardado', { email: masked, pantalla: prev.pantalla });
      return NextResponse.json(
        { ok: true, pantalla: prev.pantalla, variante: prev.variante || prev.pantalla, token: prev.token },
        { headers }
      );
    }
    const stale = !prev || !Number.isFinite(prev.ts) || now - prev.ts > INFLIGHT_STALE_MS;
    if (prev?.status === 'inflight' && !stale) {
      console.log(LOG, 'final en curso (inflight)', { email: masked });
      return fail(headers, 409, 'Estamos procesando tus respuestas. Esperá unos segundos y probá de nuevo.');
    }
    // 'retry' (append fallido) o inflight vencido (función muerta): se
    // reprocesa con el MISMO token, y si la fila llegó a escribirse se reusa.
    reprocesando = true;
    if (prev?.token) token = prev.token;
    if (prev && Number.isFinite(prev.t0)) t0 = prev.t0 as number;
    console.log(LOG, `final ${prev?.status === 'retry' ? 'reintento' : 'inflight vencido'} → reprocesa`, { email: masked, token });
    await kvSet(kvKey, { status: 'inflight', ts: now, t0, token });
  }
  const liberar = () => kvDel(kvKey);

  // (1) Tier
  const respuestas = respuestasDesdeLetras(f);
  const tier = calcularTier(respuestas);
  if (!tier) {
    await liberar();
    return fail(headers, 400, 'No pudimos evaluar tus respuestas. Revisá que estén todas completas.');
  }
  const tierEnvio = tierParaEnvio(tier.pantalla);
  if (!tierEnvio) {
    await liberar();
    return fail(headers, 400, 'No pudimos evaluar tus respuestas. Probá de nuevo.');
  }

  // (2) Columnas + fila existente (solo al reprocesar)
  let cols: Cols;
  let rowIndex: number | null = null;
  try {
    cols = await resolverColumnasSheet();
    if (reprocesando) rowIndex = await buscarFilaPorToken(cols, token);
  } catch (err) {
    console.error(LOG, 'final sheet error:', masked, errMsg(err));
    await kvSet(kvKey, { status: 'retry', ts: now, t0, token });
    await avisarSiEstructural('final', err);
    return fail(headers, 502, 'No pude guardar tus respuestas. Probá de nuevo.');
  }

  // Tope diario de filas nuevas por email (canónico): frena scripts que llenan
  // el CRM y mandan mails a terceros con plus-addressing.
  const hoy = new Date();
  const rl = rowIndex ? null : await finalesHoy(canon, hoy);
  if (rl && rl.n >= FINALES_POR_EMAIL_DIA) {
    await liberar();
    console.log(LOG, 'final bloqueado: tope diario por email', { email: masked, n: rl.n });
    return fail(headers, 429, `Ya registramos tu test hoy. Si querés cambiar algo, escribime a ${CONTACTO_MAIL}.`);
  }

  // (3) Guardia postest-sent (compartida con el vigilante), ANTES del append.
  const guardia = await tomarGuardiaSent(f.email, reprocesando);
  if (guardia.r === 'inflight') {
    await liberar();
    console.log(LOG, 'final: postest-sent inflight de otro proceso', { email: masked });
    return fail(headers, 409, 'Estamos procesando tus respuestas. Esperá unos segundos y probá de nuevo.');
  }
  const yaEnviado =
    guardia.r === 'enviado' ? { previo: guardia.previo, propio: fechaSent(guardia.previo) >= t0 } : null;

  // (4) Fila en el Sheet (antes del mail: si falla, el front reintenta)
  if (!rowIndex) {
    const submittedAt = formatSubmittedAt(hoy);
    try {
      const row = buildRow(cols, {
        data: f,
        respuestas,
        submittedAt,
        token,
        score: tier.score,
        forzador: tier.forzador,
        pantalla: tier.pantalla,
        variante: tier.variante,
      });
      rowIndex = await appendRow(row);
    } catch (err) {
      console.error(LOG, 'final sheet error:', masked, errMsg(err));
      // El reintento reusa el token: si Google aceptó el append pese al
      // timeout, la fila se encuentra por Token y no se duplica.
      await kvSet(kvKey, { status: 'retry', ts: now, t0, token });
      if (guardia.r === 'tomada') await delSent(f.email);
      await avisarSiEstructural('final', err);
      return fail(headers, 502, 'No pude guardar tus respuestas. Probá de nuevo.');
    }
    if (rl) await contarFinalHoy(rl.key);
    console.log(LOG, 'final fila guardada', {
      email: masked,
      row: rowIndex,
      token,
      pantalla: tier.pantalla,
      variante: tier.variante,
      score: tier.score,
    });
  } else {
    console.log(LOG, 'final fila reusada (reproceso)', { email: masked, row: rowIndex, token });
  }

  // (5) Resultado en KV antes de responder; mail + marcas después de responder.
  await kvSet(kvKey, { status: 'done', ts: Date.now(), t0, token, pantalla: tier.pantalla, variante: tier.variante });
  const rowFinal = rowIndex;
  await runAfter(async () => {
    const [mail, mc] = await Promise.allSettled([
      despacharYMarcar(f, { pantalla: tier.pantalla, variante: tier.variante, score: tier.score }, tierEnvio, cols, rowFinal, yaEnviado),
      etiquetarTier(f.email, tierEnvio),
    ]);
    if (mail.status === 'rejected') console.error(LOG, 'despacharYMarcar error:', errMsg(mail.reason));
    if (mc.status === 'rejected') console.error(LOG, 'manychat tier error:', errMsg(mc.reason));
    else if (mc.value.motivo !== 'sin-token') console.log(LOG, 'manychat tier', { email: masked, tier: tierEnvio, ...mc.value });
  });
  return NextResponse.json({ ok: true, pantalla: tier.pantalla, variante: tier.variante, token }, { headers });
}

async function stepContacto(body: unknown, headers: CorsHeaders): Promise<NextResponse> {
  const v = validateContacto(body);
  if (!v.ok) return fail(headers, 400, v.error);
  const c: ContactoData = v.data;
  const masked = maskEmail(c.email);
  const texto = CONTACTO_TEXTOS[c.contacto];

  let cols: Cols;
  let rowIndex: number | null = null;
  let nombre = '';
  let pantallaFila = '';
  let p8Previo = '';
  let tokenFila = '';
  try {
    cols = await resolverColumnasSheet();
    const sinCol = CONTACTO_COL_KEYS.filter((k) => cols[k] < 0);
    if (sinCol.length > 0) throw new Error(`Faltan columnas en "${CRM_TAB}" (contacto): ${sinCol.join(' | ')}`);
    const col = (i: number) => `${CRM_TAB}!${colLetter(i)}2:${colLetter(i)}`;
    const [emails, tokens, submitted, nombres, pantallas, contactos] = await readRanges([
      col(cols.email),
      col(cols.token),
      col(cols.submitted),
      col(cols.nombre),
      col(cols.pantalla),
      col(cols.contacto),
    ]);
    const desde = Date.now() - CONTACTO_VENTANA_MS;
    let mejor = -Infinity;
    for (let i = 0; i < emails.length; i++) {
      const email = ((emails[i] || [])[0] || '').trim().toLowerCase();
      if (email !== c.email) continue;
      const token = ((tokens[i] || [])[0] || '').trim();
      if (!token.startsWith(TOKEN_PREFIX)) continue;
      const fecha = parseSubmittedAt((submitted[i] || [])[0] || '');
      if (!fecha || fecha.getTime() < desde) continue;
      if (fecha.getTime() >= mejor) {
        mejor = fecha.getTime();
        rowIndex = i + 2;
        nombre = ((nombres[i] || [])[0] || '').trim();
        pantallaFila = ((pantallas[i] || [])[0] || '').trim();
        p8Previo = ((contactos[i] || [])[0] || '').trim();
        tokenFila = token;
      }
    }
  } catch (err) {
    console.error(LOG, 'contacto sheet read error:', masked, errMsg(err));
    await avisarSiEstructural('contacto', err);
    return fail(headers, 502, 'No pude guardar tu elección. Probá de nuevo.');
  }

  if (!rowIndex) {
    console.log(LOG, 'contacto sin fila reciente', { email: masked });
    return fail(headers, 404, 'No encontramos tu test reciente. Volvé a hacerlo y elegí cómo te contacto.');
  }
  if (pantallaFila !== 'B-CONTACTO') {
    console.log(LOG, 'contacto en fila que no es B-CONTACTO', { email: masked, row: rowIndex, pantalla: pantallaFila });
    return fail(headers, 400, 'Tu resultado no requiere elegir cómo te contacto.');
  }

  // Autorización: sin token (front actual) solo se escribe una vez por fila
  // (P8 vacío). Con token del 'final' que coincide, se puede corregir.
  const autorizado = Boolean(c.token) && c.token === tokenFila;
  if (p8Previo && !autorizado) {
    if (p8Previo === texto) {
      // Reintento del front tras un timeout: ya estaba guardado.
      console.log(LOG, 'contacto repetido (ya guardado)', { email: masked, row: rowIndex, contacto: c.contacto });
      return NextResponse.json({ ok: true }, { headers });
    }
    console.log(LOG, 'contacto: P8 ya tenía otro valor', { email: masked, row: rowIndex });
    return fail(headers, 409, `Ya registramos cómo contactarte. Si querés cambiarlo, escribime a ${CONTACTO_MAIL}.`);
  }

  const updates: CellUpdate[] = [{ range: `${CRM_TAB}!${colLetter(cols.contacto)}${rowIndex}`, values: [[texto]] }];
  if (c.contacto === 'wa') {
    updates.push({ range: `${CRM_TAB}!${colLetter(cols.telefonoWa)}${rowIndex}`, values: [[c.telefono]] });
  } else if (c.contacto === 'tel') {
    updates.push({ range: `${CRM_TAB}!${colLetter(cols.telefonoAr)}${rowIndex}`, values: [[c.telefono]] });
  }
  try {
    await batchUpdate(updates);
  } catch (err) {
    console.error(LOG, 'contacto sheet write error:', masked, rowIndex, errMsg(err));
    return fail(headers, 502, 'No pude guardar tu elección. Probá de nuevo.');
  }
  console.log(LOG, 'contacto', { email: masked, row: rowIndex, contacto: c.contacto });

  if (c.contacto !== 'meet') {
    // Una alerta por fila y hora: un reintento del front no duplica el aviso.
    let avisar = true;
    try {
      const got = await kv.set(`${CONTACTO_ALERT_PREFIX}${c.email}:${rowIndex}`, 1, { nx: true, ex: CONTACTO_ALERT_TTL_S });
      avisar = Boolean(got);
    } catch (err) {
      console.error(LOG, 'kv testcontacto error (avisa igual):', errMsg(err));
    }
    if (avisar) {
      const canal = c.contacto === 'wa' ? 'WhatsApp' : 'llamada telefónica';
      await enviarAlerta(
        `Lead B-CONTACTO pidió ${canal}`,
        `${nombre || '(sin nombre)'} <${c.email}> eligió ${canal}.\n` +
          `Teléfono: ${c.telefono}\n` +
          `Fila ${rowIndex} del CRM: ${SHEET_URL}`
      );
    }
  }
  return NextResponse.json({ ok: true }, { headers });
}

// ─── Handlers ───────────────────────────────────────────────────────

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (await isRateLimited(ip)) {
    return fail(headers, 429, 'Demasiados intentos. Esperá un minuto y probá de nuevo.');
  }

  if (!hasValidApiKey(request) && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
    return fail(headers, 403, 'Origen no permitido.');
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail(headers, 400, 'Datos inválidos.');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return fail(headers, 413, 'Los datos son demasiado largos.');
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(headers, 400, 'Datos inválidos.');
  }

  // Honeypot: si _hp tiene valor, es un bot. Aceptamos en silencio.
  if (typeof body._hp === 'string' && body._hp.trim() !== '') {
    return NextResponse.json({ ok: true }, { headers });
  }

  const step = typeof body.step === 'string' ? body.step : '';
  try {
    if (step === 'partial') return await stepPartial(body, headers);
    if (step === 'final') return await stepFinal(body, headers);
    if (step === 'contacto') return await stepContacto(body, headers);
    return fail(headers, 400, 'Paso desconocido.');
  } catch (err) {
    console.error(LOG, `error inesperado en step ${step}:`, errMsg(err));
    return fail(headers, 500, 'Algo falló de nuestro lado. Probá de nuevo en un momento.');
  }
}
