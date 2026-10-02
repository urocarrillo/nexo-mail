import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { getGoogleAccessToken } from '@/lib/google-auth';
import { CRM_SHEET_ID, CRM_TAB, colLetter } from '@/lib/crm-sheet';
import { getClientes, normalizeEmail, type ClientesMap } from '@/lib/clientes';
import { getEnrolledSecuenciaEmails } from '@/lib/email-drip';
import { tieneMailCEnviado } from '@/lib/secuencia-post-typeform';
import {
  calcularTier,
  respuestasCompletas,
  respuestaDesconocida,
  tierParaEnvio,
  type TierEnvio,
} from '@/lib/tier-programa';
import {
  dispatchPostTest,
  esErrorAmbiguo,
  validateEmail,
  SENT_KEY_PREFIX,
  SENT_TTL_S,
  type DispatchResult,
  type PendingMark,
} from '@/lib/postest';
import { enviarAlerta } from '@/lib/alertas';

/**
 * Vigilante del mail post-test del programa DE.
 *
 * Reemplaza al Apps Script del Sheet CRM (muerto por timeout el 15/07/2026).
 * Se dispara cada 15 min desde un cron externo (curl + secret) y una vez por
 * día desde vercel.json como respaldo.
 *
 * Por corrida: lee el Sheet CRM, calcula tiers faltantes, detecta filas con
 * Pantalla válida y "Mail enviado" vacío desde POSTEST_CUTOFF, manda el mail
 * post-test (dispatchPostTest) y marca "auto dd/mm/yyyy HH:MM" en la fila.
 *
 * Guardia KV en dos fases por email: `inflight` (TTL corto) antes del envío y
 * la fecha ISO (TTL 60 días) después. Si la función muere a mitad de camino la
 * key vence sola y la próxima corrida reintenta; si el envío fue exitoso la
 * key larga bloquea reenvíos aunque la fila no se haya podido marcar.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> o ?token=<CRON_SECRET>.
 * Params: ?dry=1 (no escribe ni envía) · ?max=N (tope de envíos, default 40, máx 100).
 */

export const maxDuration = 60;

const LOCK_KEY = 'lock:postest-vigilante';
const LOCK_TTL_S = 110;
const INFLIGHT_VALUE = 'inflight';
const INFLIGHT_TTL_S = 300; // si la función muere, la key vence antes de la próxima corrida
const HEARTBEAT_TTL_S = 60 * 60 * 24 * 2;
const ALERT_THROTTLE_S = 60 * 60; // alertas estructurales: máximo 1 por hora
const DEFAULT_CUTOFF = '2026-09-04T15:50:00.000Z';
const DEADLINE_MS = 50_000; // tope duro de trabajo (maxDuration 60 s)
const MIN_CANDIDATE_MS = 15_000; // no arrancar un candidato con menos margen que esto
const MAX_TIER_ROWS = 500;
const DEFAULT_MAX = 40;
const MAX_MAX = 100;
const SHEETS_TIMEOUT_MS = 10_000;
const AUX_LOAD_TIMEOUT_MS = 10_000; // set enrolados, una vez por corrida
const CLIENTES_LOAD_TIMEOUT_MS = 20_000; // mapa clientes (Woo pagina todo con cache fría)
const CLIENTES_MISS_KEY = 'vigilante:clientes-miss'; // corridas seguidas sin mapa
const SHEET_MISS_KEY = 'vigilante:sheet-miss'; // corridas seguidas sin poder leer el Sheet
const SHEET_MISS_ALERTA = 2; // pasajero (1 corrida) = silencio; 2 seguidas = alerta
const ART_OFFSET_MS = -3 * 60 * 60 * 1000; // hora Argentina (UTC-3, sin DST)
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Columnas requeridas (detección por nombre, nunca por índice) ────

type ColKey =
  | 'nombre'
  | 'email'
  | 'edad'
  | 'ereccion'
  | 'salud'
  | 'pareja'
  | 'consumo'
  | 'compromiso'
  | 'inversion'
  | 'submitted'
  | 'score'
  | 'forzador'
  | 'pantalla'
  | 'variante'
  | 'estado'
  | 'mailEnviado';

type OptColKey = 'cliente' | 'secuencia';

const COLUMN_SPECS: Array<{ key: ColKey; header: string; prefix?: boolean }> = [
  { key: 'nombre', header: '¿Cómo te llamás?' },
  { key: 'email', header: '¿Cuál es tu mejor email para contactarte?' },
  { key: 'edad', header: '¿En qué rango de edad estás?' },
  { key: 'ereccion', header: '¿Tu erección funciona bien', prefix: true },
  { key: 'salud', header: 'En cuanto a tu salud general', prefix: true },
  { key: 'pareja', header: '¿Cómo es tu situación de pareja hoy?' },
  { key: 'consumo', header: '¿Cuánto consumís de redes sociales', prefix: true },
  { key: 'compromiso', header: '¿Te comprometés a dedicar', prefix: true },
  { key: 'inversion', header: 'En este momento de tu vida', prefix: true },
  { key: 'submitted', header: 'Submitted At' },
  { key: 'score', header: 'Score' },
  { key: 'forzador', header: 'Forzador' },
  { key: 'pantalla', header: 'Pantalla' },
  { key: 'variante', header: 'Variante' },
  { key: 'estado', header: 'Estado seguimiento' },
  { key: 'mailEnviado', header: 'Mail enviado' },
];

// Opcionales: si faltan, el vigilante sigue (dispatchPostTest cae al camino legacy).
const OPT_COLUMN_SPECS: Array<{ key: OptColKey; header: string }> = [
  { key: 'cliente', header: 'Cliente' },
  { key: 'secuencia', header: 'Secuencia' },
];

type Cols = Record<ColKey, number> & Record<OptColKey, number>;

function cleanHeader(h: string | undefined): string {
  return (h || '').replace(/\u00a0/g, ' ').trim();
}

/** Resuelve índices 0-based de todas las columnas; lista las faltantes. */
function resolverColumnas(headers: string[]): { cols: Cols; missing: string[] } {
  const clean = headers.map(cleanHeader);
  const cols = {} as Cols;
  const missing: string[] = [];
  for (const spec of COLUMN_SPECS) {
    const idx = clean.findIndex((h) => (spec.prefix ? h.startsWith(spec.header) : h === spec.header));
    cols[spec.key] = idx;
    if (idx < 0) missing.push(spec.header);
  }
  for (const spec of OPT_COLUMN_SPECS) {
    cols[spec.key] = clean.findIndex((h) => h === spec.header);
  }
  return { cols, missing };
}

// ─── Fechas en hora Argentina ───────────────────────────────────────

function artParts(d: Date): { dd: string; mm: string; yyyy: string; HH: string; MM: string } {
  const a = new Date(d.getTime() + ART_OFFSET_MS);
  return {
    dd: String(a.getUTCDate()).padStart(2, '0'),
    mm: String(a.getUTCMonth() + 1).padStart(2, '0'),
    yyyy: String(a.getUTCFullYear()),
    HH: String(a.getUTCHours()).padStart(2, '0'),
    MM: String(a.getUTCMinutes()).padStart(2, '0'),
  };
}

function fechaArtDDMMYYYY(d: Date): string {
  const p = artParts(d);
  return `${p.dd}/${p.mm}/${p.yyyy}`;
}

function fechaHoraArt(d: Date): string {
  const p = artParts(d);
  return `${p.dd}/${p.mm}/${p.yyyy} ${p.HH}:${p.MM}`;
}

function fechaArtISO(d: Date): string {
  const p = artParts(d);
  return `${p.yyyy}-${p.mm}-${p.dd}`;
}

/**
 * "Submitted At" del Sheet: d/m/yyyy H:mm:ss EN UTC (Typeform lo escribe así;
 * verificado 04/09/2026: a las 16:43 ART la última fila decía 18:07:09).
 * NO usar parseArgDate (suma 3 h como si fuera hora Argentina).
 * Validamos día y mes antes de parsear (Date.UTC desborda meses > 12 en
 * silencio); lo que no cumple cuenta como sin_fecha.
 */
function parseSubmitted(raw: string): Date | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T]|$)/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const t = s.match(/^\d{1,2}\/\d{1,2}\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!t) return null;
  let y = parseInt(t[1], 10);
  if (y < 100) y += 2000;
  const hh = t[2] ? parseInt(t[2], 10) : 0;
  const mi = t[3] ? parseInt(t[3], 10) : 0;
  const ss = t[4] ? parseInt(t[4], 10) : 0;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, hh, mi, ss));
  return isNaN(dt.getTime()) ? null : dt;
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Promise.race con timer limpio; rechaza con TimeoutError. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TimeoutError: ${label} > ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Google Sheets (fetch directo, con timeout acotado al deadline) ──

// Deadline de la corrida en curso (Date.now()). El lock garantiza una corrida
// por vez, así que un módulo-level es seguro.
let runDeadline = 0;

function sheetsTimeoutMs(): number {
  const left = runDeadline > 0 ? runDeadline - Date.now() : SHEETS_TIMEOUT_MS;
  return Math.max(2000, Math.min(SHEETS_TIMEOUT_MS, left));
}

async function sheetsFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getGoogleAccessToken();
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CRM_SHEET_ID}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(sheetsTimeoutMs()),
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

/**
 * Lectura inicial con un reintento ante error transitorio (timeout, 429, 5xx):
 * un corte suelto de la API de Sheets no debe abortar la corrida ni alertar.
 */
async function readRangeConReintento(range: string): Promise<string[][]> {
  try {
    return await readRange(range);
  } catch (err) {
    const msg = errMsg(err);
    if (!/timeout|abort|fetch failed|econnreset|socket|\((429|5\d\d)\)/i.test(msg)) throw err;
    console.warn('postest-vigilante: reintento lectura Sheet', range, msg);
    await sleep(1500);
    return await readRange(range);
  }
}

/** PUT de una sola celda (RAW). Reintenta una vez ante 429 (cuota de escritura). */
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

interface RangeUpdate {
  range: string;
  values: Array<Array<string | number>>;
}

async function batchUpdate(data: RangeUpdate[]): Promise<void> {
  if (data.length === 0) return;
  const res = await sheetsFetch(`/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
  if (!res.ok) {
    throw new Error(`Sheet batchUpdate failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * Relee SOLO la celda de email de una fila y la compara con el esperado.
 * Un error transitorio (429, timeout) NO es "fila movida": se reintenta una
 * vez y, si persiste, se devuelve 'error' para que el caller decida.
 */
type Verificacion = { r: 'ok' } | { r: 'mismatch'; found: string } | { r: 'error'; error: string };

async function verificarEmailFila(emailCol: string, rowIndex: number, esperado: string): Promise<Verificacion> {
  let lastErr = '';
  for (let intento = 0; intento < 2; intento++) {
    try {
      const v = await readRange(`${CRM_TAB}!${emailCol}${rowIndex}`);
      const celda = normalizeEmail((v[0] || [])[0] || '');
      return celda === esperado ? { r: 'ok' } : { r: 'mismatch', found: celda };
    } catch (err) {
      lastErr = errMsg(err);
      if (intento === 0) await sleep(1000);
    }
  }
  return { r: 'error', error: lastErr };
}

// ─── Modelo de fila ─────────────────────────────────────────────────

interface Fila {
  rowIndex: number; // 1-based en el Sheet
  email: string; // normalizado
  nombre: string;
  submitted: Date | null;
  pantalla: string;
  variante: string;
  score: number | undefined;
  estado: string;
  mailEnviado: string;
  secuencia: string;
  respuestas: {
    edad: string;
    ereccion: string;
    salud: string;
    pareja: string;
    consumo: string;
    compromiso: string;
    inversion: string;
  };
}

function leerFila(r: string[], i: number, cols: Cols): Fila {
  const cell = (k: ColKey | OptColKey) => (cols[k] >= 0 ? r[cols[k]] || '' : '').trim();
  const scoreRaw = cell('score');
  const scoreNum = scoreRaw === '' ? NaN : Number(scoreRaw);
  return {
    rowIndex: i + 2,
    email: normalizeEmail(cell('email')),
    nombre: cell('nombre'),
    submitted: parseSubmitted(cell('submitted')),
    pantalla: cell('pantalla'),
    variante: cell('variante'),
    score: Number.isFinite(scoreNum) ? scoreNum : undefined,
    estado: cell('estado'),
    mailEnviado: cell('mailEnviado'),
    secuencia: cell('secuencia'),
    respuestas: {
      edad: cell('edad'),
      ereccion: cell('ereccion'),
      salud: cell('salud'),
      pareja: cell('pareja'),
      consumo: cell('consumo'),
      compromiso: cell('compromiso'),
      inversion: cell('inversion'),
    },
  };
}

// ─── Corrida ────────────────────────────────────────────────────────

interface Stats {
  ok: boolean;
  dry: boolean;
  elapsed_ms: number;
  rows: number;
  tiered: number;
  candidates: number;
  sent: { A: number; B: number; C: number };
  skipped: {
    dup: number;
    kvdup: number;
    estado: number;
    cliente: number;
    sin_fecha: number;
    futuro: number;
    email_invalido: number;
    pantalla_invalida: number;
    sin_tier: number;
  };
  failed: number;
  /** Envíos sin respuesta definitiva de Brevo: marcados "auto?" y NO reintentados. */
  ambiguous: number;
  remaining: number;
  alerts: string[];
  alert_sent: boolean;
  sample?: Array<{ row: number; email: string; pantalla: string; submitted: string }>;
}

function cutoffDate(): Date {
  const raw = process.env.POSTEST_CUTOFF || DEFAULT_CUTOFF;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date(DEFAULT_CUTOFF) : d;
}

/**
 * Alerta estructural (columna faltante, Sheet caído, filas movidas): el cron
 * externo corre cada 15 min, así que se limita a 1 mail por hora por asunto.
 * En dry no se toca KV: se manda siempre.
 */
async function alertaThrottled(stats: Stats, dry: boolean, subject: string, text: string): Promise<void> {
  if (!dry) {
    try {
      const got = await kv.set(`alerta:${subject}`, new Date().toISOString(), { nx: true, ex: ALERT_THROTTLE_S });
      if (!got) return;
    } catch (err) {
      console.error('vigilante alert throttle kv error:', err);
    }
  }
  const ok = await enviarAlerta(subject, text);
  stats.alert_sent = stats.alert_sent || ok;
}

async function correr(dry: boolean, max: number, t0: number): Promise<NextResponse> {
  runDeadline = t0 + DEADLINE_MS;
  const stats: Stats = {
    ok: true,
    dry,
    elapsed_ms: 0,
    rows: 0,
    tiered: 0,
    candidates: 0,
    sent: { A: 0, B: 0, C: 0 },
    skipped: {
      dup: 0,
      kvdup: 0,
      estado: 0,
      cliente: 0,
      sin_fecha: 0,
      futuro: 0,
      email_invalido: 0,
      pantalla_invalida: 0,
      sin_tier: 0,
    },
    failed: 0,
    ambiguous: 0,
    remaining: 0,
    alerts: [],
    alert_sent: false,
  };
  const finish = (status = 200) => {
    stats.elapsed_ms = Date.now() - t0;
    const { sample: _sample, ...log } = stats;
    void _sample;
    console.log('postest-vigilante', JSON.stringify(log));
    return NextResponse.json(stats, { status });
  };

  // b. Lectura del Sheet + resolución de columnas por nombre
  let headers: string[];
  let values: string[][];
  let cols: Cols;
  try {
    headers = (await readRangeConReintento(`${CRM_TAB}!1:1`))[0] || [];
    const resolved = resolverColumnas(headers);
    if (resolved.missing.length > 0) {
      const detalle =
        `Faltan columnas en "${CRM_TAB}": ${resolved.missing.join(' | ')}\n\n` +
        `Headers actuales: ${headers.join(' | ')}\n\nNo se procesó nada. Nunca se crean columnas.`;
      stats.ok = false;
      stats.alerts.push(`columna faltante: ${resolved.missing.join(', ')}`);
      await alertaThrottled(stats, dry, 'VIGILANTE: columna faltante', detalle);
      return finish(500);
    }
    cols = resolved.cols;
    values = await readRangeConReintento(`${CRM_TAB}!A2:${colLetter(headers.length - 1)}`);
  } catch (err) {
    const msg = errMsg(err);
    stats.ok = false;
    stats.alerts.push(`lectura del Sheet falló: ${msg}`);
    // Un corte suelto de Google se resuelve solo en la corrida siguiente (las
    // filas pendientes se toman igual): solo avisamos si falla corridas seguidas.
    let seguidas = SHEET_MISS_ALERTA;
    if (!dry) {
      try {
        seguidas = await kv.incr(SHEET_MISS_KEY);
        await kv.expire(SHEET_MISS_KEY, 2 * 60 * 60);
      } catch { /* KV: ante la duda, avisar */ }
    }
    if (seguidas >= SHEET_MISS_ALERTA) {
      await alertaThrottled(
        stats,
        dry,
        'VIGILANTE: error leyendo el Sheet',
        `${msg}\n\nFalló ${seguidas} corridas seguidas. No se procesó nada.`,
      );
    }
    return finish(500);
  }
  if (!dry) {
    try { await kv.del(SHEET_MISS_KEY); } catch { /* KV: ignorar */ }
  }

  const now = new Date();
  const cutoff = cutoffDate();
  const filas = values.map((r, i) => leerFila(r, i, cols));
  stats.rows = filas.length;
  const emailCol = colLetter(cols.email);
  const mailCol = colLetter(cols.mailEnviado);
  const anomalias: string[] = []; // estructurales, throttled 1 h

  // c. Fechas inválidas / futuras
  for (const f of filas) {
    if (!f.submitted) stats.skipped.sin_fecha++;
    else if (f.submitted.getTime() > now.getTime()) stats.skipped.futuro++;
  }
  const ultima = filas[filas.length - 1];
  if (ultima && !ultima.submitted) {
    anomalias.push(
      `la última fila (${ultima.rowIndex}) no tiene "Submitted At" parseable: ¿cambió el formato de fecha del Sheet?`
    );
  }
  if (stats.skipped.futuro > 0) {
    anomalias.push(`${stats.skipped.futuro} fila(s) con "Submitted At" en el futuro (formato m/d/yyyy?)`);
  }

  // d. Tiers faltantes → una sola batchUpdate (máx 500 filas)
  const contiguo =
    cols.forzador === cols.score + 1 &&
    cols.pantalla === cols.score + 2 &&
    cols.variante === cols.score + 3;
  const tierUpdates: RangeUpdate[] = [];
  const tieredRows: Fila[] = [];
  const sinTierEjemplos: string[] = [];
  for (const f of filas) {
    if (stats.tiered >= MAX_TIER_ROWS) break;
    if (f.pantalla) continue;
    if (!respuestasCompletas(f.respuestas)) continue;
    const t = calcularTier(f.respuestas);
    if (!t) {
      // 6 respuestas presentes pero alguna no es reconocible: cambió el Typeform.
      stats.skipped.sin_tier++;
      if (sinTierEjemplos.length < 3) {
        const campo = respuestaDesconocida(f.respuestas) || '?';
        sinTierEjemplos.push(`fila ${f.rowIndex}: ${campo} = "${f.respuestas[campo as keyof Fila['respuestas']] || ''}"`);
      }
      continue;
    }
    f.pantalla = t.pantalla;
    f.variante = t.variante;
    f.score = t.score;
    stats.tiered++;
    tieredRows.push(f);
    if (contiguo) {
      tierUpdates.push({
        range: `${CRM_TAB}!${colLetter(cols.score)}${f.rowIndex}:${colLetter(cols.variante)}${f.rowIndex}`,
        values: [[t.score, t.forzador, t.pantalla, t.variante]],
      });
    } else {
      const uno = (col: number, v: string | number) => ({
        range: `${CRM_TAB}!${colLetter(col)}${f.rowIndex}`,
        values: [[v]],
      });
      tierUpdates.push(
        uno(cols.score, t.score),
        uno(cols.forzador, t.forzador),
        uno(cols.pantalla, t.pantalla),
        uno(cols.variante, t.variante)
      );
    }
  }
  if (stats.skipped.sin_tier > 0) {
    anomalias.push(
      `${stats.skipped.sin_tier} fila(s) con respuestas completas pero no reconocibles (¿cambió una opción del Typeform?): ` +
        sinTierEjemplos.join(' · ')
    );
  }

  if (!dry && tierUpdates.length > 0) {
    // Antes de escribir por número de fila, confirmar que la columna de email
    // sigue alineada con lo leído (un sort/insert entre la lectura y el batch
    // pisaría Pantallas ajenas). Si la relectura falla, se escribe igual: la
    // ventana es de segundos y la lectura principal acaba de pasar.
    try {
      const colEmails = await readRange(`${CRM_TAB}!${emailCol}2:${emailCol}`);
      const movidas = tieredRows.filter((f) => normalizeEmail((colEmails[f.rowIndex - 2] || [])[0] || '') !== f.email);
      if (movidas.length > 0) {
        const detalle =
          `Entre la lectura del Sheet y la escritura de tiers, ${movidas.length} fila(s) cambiaron de email ` +
          `(filas ${movidas.slice(0, 10).map((f) => f.rowIndex).join(', ')}). ` +
          `¿Alguien ordenó o insertó filas? No se escribió nada ni se envió ningún mail en esta corrida.`;
        stats.ok = false;
        stats.alerts.push(`filas movidas antes de escribir tiers: ${movidas.length}`);
        await alertaThrottled(stats, dry, 'VIGILANTE: filas movidas', detalle);
        return finish(500);
      }
    } catch (err) {
      stats.alerts.push(`no se pudo verificar la columna de email antes de escribir tiers: ${errMsg(err)}`);
    }
    try {
      await batchUpdate(tierUpdates);
    } catch (err) {
      const msg = errMsg(err);
      stats.ok = false;
      stats.alerts.push(`escritura de tiers falló: ${msg}`);
      await alertaThrottled(
        stats,
        dry,
        'VIGILANTE: error escribiendo tiers',
        `${msg}\n\nNo se envió ningún mail en esta corrida.`
      );
      return finish(500);
    }
  }

  // e. Candidatos
  const conMail = new Set<string>();
  for (const f of filas) if (f.email && f.mailEnviado) conMail.add(f.email);

  const candidatos: Fila[] = [];
  for (const f of filas) {
    if (!f.pantalla) continue;
    if (!tierParaEnvio(f.pantalla)) {
      stats.skipped.pantalla_invalida++;
      continue;
    }
    if (f.mailEnviado) continue;
    if (!f.submitted) continue;
    if (f.submitted.getTime() < cutoff.getTime() || f.submitted.getTime() > now.getTime()) continue;
    if (!f.email || !validateEmail(f.email)) {
      stats.skipped.email_invalido++;
      continue;
    }
    if (f.estado) {
      stats.skipped.estado++;
      continue;
    }
    candidatos.push(f);
  }
  candidatos.sort((a, b) => a.submitted!.getTime() - b.submitted!.getTime());
  stats.candidates = candidatos.length;
  if (stats.skipped.pantalla_invalida > 0) {
    anomalias.push(`${stats.skipped.pantalla_invalida} fila(s) con Pantalla no reconocida (no A / B-CONTACTO / B-AUTO / C)`);
  }

  /** Dedupe: otra fila con mail, ya enviado en esta corrida, o tier C ya marcado en Secuencia (backfill). */
  const esDuplicado = (f: Fila, enviadosCorrida: Set<string>): boolean =>
    conMail.has(f.email) ||
    enviadosCorrida.has(f.email) ||
    (tierParaEnvio(f.pantalla) === 'C' && tieneMailCEnviado(f.secuencia));

  if (dry) {
    stats.sample = candidatos.slice(0, 5).map((f) => ({
      row: f.rowIndex,
      email: maskEmail(f.email),
      pantalla: f.pantalla,
      submitted: f.submitted!.toISOString(),
    }));
    // Dedupe se cuenta igual para que el reporte sea fiel
    const vistos = new Set<string>();
    for (const f of candidatos) {
      if (esDuplicado(f, vistos)) stats.skipped.dup++;
      else vistos.add(f.email);
    }
    if (anomalias.length) stats.alerts.push(...anomalias);
    return finish();
  }

  // Cargas auxiliares una vez por corrida (fail-open: si no llegan, dispatch
  // hace su propia consulta acotada por candidato).
  const hayAB = candidatos.some((f) => tierParaEnvio(f.pantalla) !== 'C');
  const hayA = candidatos.some((f) => tierParaEnvio(f.pantalla) === 'A');
  let clientes: ClientesMap | undefined;
  let alreadyEnrolled: Set<string> | undefined;
  if (hayAB) {
    try {
      clientes = await withTimeout(getClientes(), CLIENTES_LOAD_TIMEOUT_MS, 'getClientes');
      try { await kv.del(CLIENTES_MISS_KEY); } catch { /* KV: ignorar */ }
    } catch (err) {
      // Cache de WooCommerce fría (pagina todas las órdenes, TTL 1 h): no es un
      // error del embudo, cada candidato se consulta aparte (fail-open). Avisamos
      // solo si pasa 3 corridas seguidas, para no llenar la casilla de alertas.
      console.warn('vigilante getClientes no disponible:', errMsg(err));
      let seguidas = 0;
      try {
        seguidas = await kv.incr(CLIENTES_MISS_KEY);
        await kv.expire(CLIENTES_MISS_KEY, 6 * 60 * 60);
      } catch { /* KV: ignorar */ }
      if (seguidas >= 3) {
        stats.alerts.push(`mapa de clientes no disponible ${seguidas} corridas seguidas (${errMsg(err)}): se consulta por candidato, fail-open`);
      }
    }
  }
  if (hayA) {
    try {
      alreadyEnrolled = await withTimeout(getEnrolledSecuenciaEmails(), AUX_LOAD_TIMEOUT_MS, 'getEnrolledSecuenciaEmails');
    } catch (err) {
      console.error('vigilante getEnrolledSecuenciaEmails error (non-blocking):', err);
    }
  }
  const deferMarks = cols.cliente >= 0 && cols.secuencia >= 0;
  const markCol = (m: PendingMark): number =>
    m.col === 'secuencia' ? cols.secuencia : m.col === 'cliente' ? cols.cliente : cols.estado;

  // f. Envíos
  const marcasPendientes: Array<{ f: Fila; value: string }> = []; // dup / kv-dup (se verifican y escriben al final)
  const enviadosCorrida = new Set<string>();
  let procesados = 0;
  let fallosSeguidos = 0;
  let critico: { subject: string; detalle: string } | null = null;
  let idx = 0;

  for (; idx < candidatos.length; idx++) {
    const f = candidatos[idx];

    // g. Presupuesto de tiempo: no arrancar un candidato sin margen para terminarlo
    if (runDeadline - Date.now() < MIN_CANDIDATE_MS) break;
    if (procesados >= max) break;

    if (esDuplicado(f, enviadosCorrida)) {
      marcasPendientes.push({ f, value: `dup ${fechaArtDDMMYYYY(now)}` });
      stats.skipped.dup++;
      continue;
    }

    // Guardia KV fase 1: inflight con TTL corto
    const kvKey = `${SENT_KEY_PREFIX}${f.email}`;
    const got = await kv.set(kvKey, INFLIGHT_VALUE, { nx: true, ex: INFLIGHT_TTL_S });
    if (!got) {
      let previo: unknown = null;
      try {
        previo = await kv.get(kvKey);
      } catch (err) {
        console.error('vigilante kv.get error:', err);
      }
      stats.skipped.kvdup++;
      if (previo === INFLIGHT_VALUE) {
        // Una corrida anterior murió hace < 5 min con este email a medio enviar.
        // No marcamos: la key vence sola y la próxima corrida reintenta.
        stats.alerts.push(`inflight fila ${f.rowIndex} (${maskEmail(f.email)}): corrida anterior interrumpida, se reintenta`);
      } else {
        // Ya se envió (por el webhook o por una corrida que no pudo marcar la fila).
        marcasPendientes.push({ f, value: `kv-dup ${fechaArtDDMMYYYY(now)}` });
        stats.alerts.push(
          `kv-dup fila ${f.rowIndex} (${maskEmail(f.email)}): ya enviado ${typeof previo === 'string' ? previo : ''}`.trim()
        );
      }
      continue;
    }

    procesados++;
    const tier = tierParaEnvio(f.pantalla) as TierEnvio;
    let r: DispatchResult;
    try {
      r = await dispatchPostTest(
        {
          email: f.email,
          name: f.nombre || undefined,
          pantalla: f.pantalla,
          variante: f.variante || undefined,
          score: f.score,
          tier,
          respuestas: f.respuestas,
        },
        { clientes, alreadyEnrolled, deferMarks }
      );
    } catch (err) {
      r = { success: false, tier, pantalla: f.pantalla, error: errMsg(err) };
    }

    const enviado = r.success && !r.skipped && r.sent !== false;
    const clientePrograma = Boolean(r.skipped) && r.reason === 'cliente-programa';
    const errorEnvio = r.success ? r.sendError : r.stage === 'send' ? r.error : undefined;
    const ambiguo = !enviado && !clientePrograma && Boolean(errorEnvio) && esErrorAmbiguo(errorEnvio);

    if (enviado || clientePrograma || ambiguo) {
      // Guardia KV fase 2: key larga. En el caso ambiguo también: Brevo pudo
      // haber aceptado el POST y reintentar duplicaría el mail.
      try {
        await kv.set(kvKey, `${ambiguo ? 'ambiguo ' : ''}${new Date().toISOString()}`, { ex: SENT_TTL_S });
      } catch (err) {
        console.error('vigilante kv sent-mark error:', err);
      }

      // Verificar que la fila sigue siendo la misma antes de marcar
      const ver = await verificarEmailFila(emailCol, f.rowIndex, f.email);
      if (ver.r === 'mismatch') {
        critico = {
          subject: 'VIGILANTE: fila movida',
          detalle:
            `La fila ${f.rowIndex} ya no contiene el email esperado.\n` +
            `Esperado: ${f.email}\nEncontrado: ${ver.found || '(vacío)'}\n\n` +
            `El mail a ${f.email} ${
              clientePrograma ? 'no se envió (cliente-programa)' : ambiguo ? 'quedó en estado ambiguo' : 'SÍ se envió'
            } pero NO se marcó "Mail enviado". La guardia KV evita el reenvío por 60 días. ` +
            `Revisar el Sheet a mano y marcar la fila correcta.`,
        };
        stats.alerts.push(`fila movida en ${f.rowIndex} (${maskEmail(f.email)})`);
        idx++;
        break;
      }
      if (ver.r === 'error') {
        stats.alerts.push(`no se pudo verificar fila ${f.rowIndex} (${maskEmail(f.email)}): ${ver.error}; se marcó igual`);
      }

      const marca = `${ambiguo ? 'auto?' : 'auto'} ${fechaHoraArt(new Date())}`;
      try {
        await writeCell(`${CRM_TAB}!${mailCol}${f.rowIndex}`, marca);
      } catch (err) {
        // El mail salió; la key KV evita el reenvío. Avisar y seguir.
        stats.alerts.push(`no se pudo marcar fila ${f.rowIndex} (${maskEmail(f.email)}): ${errMsg(err)}`);
      }
      // Marcas Secuencia / Cliente / Estado que dispatch dejó para esta fila
      for (const m of r.pendingMarks || []) {
        const col = markCol(m);
        if (col < 0) continue;
        try {
          await writeCell(`${CRM_TAB}!${colLetter(col)}${f.rowIndex}`, m.text);
        } catch (err) {
          stats.alerts.push(`no se pudo marcar ${m.col} en fila ${f.rowIndex}: ${errMsg(err)}`);
        }
      }

      enviadosCorrida.add(f.email);
      if (ambiguo) {
        stats.ambiguous++;
        fallosSeguidos++;
        stats.alerts.push(
          `envío ambiguo ${maskEmail(f.email)} (fila ${f.rowIndex}): ${errorEnvio}. ` +
            `Marcado "auto?" y NO se reintenta (Brevo pudo haberlo aceptado). Verificar en Brevo y reenviar a mano si hace falta.`
        );
        if (fallosSeguidos >= 3) {
          stats.alerts.push('3 fallos consecutivos: corrida cortada');
          idx++;
          break;
        }
      } else {
        fallosSeguidos = 0;
        if (clientePrograma) stats.skipped.cliente++;
        else stats.sent[tier]++;
      }
    } else {
      // Falló con respuesta definitiva: liberar la key para reintentar en la próxima corrida
      try {
        await kv.del(kvKey);
      } catch (err) {
        console.error('vigilante kv.del error:', err);
      }
      stats.failed++;
      fallosSeguidos++;
      stats.alerts.push(`fallo ${maskEmail(f.email)} (fila ${f.rowIndex}): ${r.sendError || r.error || 'sin detalle'}`);
      if (fallosSeguidos >= 3) {
        stats.alerts.push('3 fallos consecutivos: corrida cortada');
        idx++;
        break;
      }
    }
  }

  stats.remaining = candidatos.length - idx;

  // Marcas dup / kv-dup acumuladas: se escriben por número de fila, así que
  // antes se relee el email de cada una. Nunca tras un "fila movida".
  if (!critico && marcasPendientes.length > 0) {
    const data: RangeUpdate[] = [];
    for (const m of marcasPendientes) {
      if (runDeadline - Date.now() < 3000) {
        stats.alerts.push(`sin tiempo para escribir ${marcasPendientes.length - data.length} marca(s) dup; próxima corrida`);
        break;
      }
      const ver = await verificarEmailFila(emailCol, m.f.rowIndex, m.f.email);
      if (ver.r === 'ok') {
        data.push({ range: `${CRM_TAB}!${mailCol}${m.f.rowIndex}`, values: [[m.value]] });
      } else if (ver.r === 'mismatch') {
        stats.alerts.push(
          `marca "${m.value}" NO escrita: fila ${m.f.rowIndex} ya no contiene ${maskEmail(m.f.email)} (encontrado: ${ver.found || 'vacío'})`
        );
      } else {
        stats.alerts.push(`marca "${m.value}" NO escrita: no se pudo verificar fila ${m.f.rowIndex}: ${ver.error}`);
      }
    }
    try {
      await batchUpdate(data);
    } catch (err) {
      stats.alerts.push(`no se pudieron escribir marcas dup: ${errMsg(err)}`);
    }
  }

  // Anomalías estructurales: entran al resumen como máximo una vez por hora
  if (anomalias.length > 0) {
    let avisar = true;
    try {
      const got = await kv.set('alerta:vigilante-anomalias', now.toISOString(), { nx: true, ex: ALERT_THROTTLE_S });
      avisar = Boolean(got);
    } catch (err) {
      console.error('vigilante anomalias throttle kv error:', err);
    }
    if (avisar) stats.alerts.push(...anomalias);
  }

  // h. Alertas: una sola por corrida
  const sk = stats.skipped;
  const resumen =
    `Filas: ${stats.rows} · tiers calculados: ${stats.tiered} · candidatos: ${stats.candidates}\n` +
    `Enviados: A=${stats.sent.A} B=${stats.sent.B} C=${stats.sent.C}\n` +
    `Saltados: dup=${sk.dup} kv-dup=${sk.kvdup} estado=${sk.estado} cliente=${sk.cliente} ` +
    `sin_fecha=${sk.sin_fecha} futuro=${sk.futuro} email_invalido=${sk.email_invalido} ` +
    `pantalla_invalida=${sk.pantalla_invalida} sin_tier=${sk.sin_tier}\n` +
    `Fallidos: ${stats.failed} · Ambiguos: ${stats.ambiguous} · Pendientes: ${stats.remaining}\n` +
    (stats.alerts.length ? `\nDetalle:\n- ${stats.alerts.join('\n- ')}\n` : '');

  if (critico) {
    stats.ok = false;
    const ok = await enviarAlerta(critico.subject, `${critico.detalle}\n\n${resumen}`);
    stats.alert_sent = stats.alert_sent || ok;
  } else if (stats.failed > 0 || stats.remaining > 0 || stats.skipped.kvdup > 0 || stats.alerts.length > 0) {
    const extra = stats.alerts.length > 0 ? ` · ${stats.alerts.length} aviso(s)` : '';
    const ok = await enviarAlerta(
      `VIGILANTE: ${stats.failed} fallidos, ${stats.remaining} pendientes${extra}`,
      `${resumen}\nLos pendientes y fallidos se reintentan en la próxima corrida.`
    );
    stats.alert_sent = stats.alert_sent || ok;
  }

  // Heartbeat diario (se salta si no queda margen: la key NX no se tomó, así que
  // la próxima corrida lo manda)
  if (Date.now() - t0 < DEADLINE_MS) {
    await heartbeat(filas, stats, now);
  }

  return finish();
}

/** Mail "VIGILANTE OK" una vez por día (hora Argentina). */
async function heartbeat(filas: Fila[], stats: Stats, now: Date): Promise<void> {
  const hoy = fechaArtISO(now);
  const key = `vigilante:heartbeat:${hoy}`;
  let got: unknown;
  try {
    got = await kv.set(key, now.toISOString(), { nx: true, ex: HEARTBEAT_TTL_S });
  } catch (err) {
    console.error('vigilante heartbeat kv error:', err);
    const ok = await enviarAlerta('VIGILANTE: KV no disponible (heartbeat)', errMsg(err));
    stats.alert_sent = stats.alert_sent || ok;
    return;
  }
  if (!got) return;

  const h24 = now.getTime() - DAY_MS;
  const h48 = now.getTime() - 2 * DAY_MS;
  let nuevas24 = 0;
  let nuevas48 = 0;
  for (const f of filas) {
    if (!f.submitted) continue;
    const t = f.submitted.getTime();
    if (t >= h24) nuevas24++;
    if (t >= h48) nuevas48++;
  }

  // Enviados en 24 h: marcas "auto dd/mm/yyyy ..." (o "auto? ...") de hoy o ayer
  const ayer = fechaArtDDMMYYYY(new Date(h24));
  const hoyDDMM = fechaArtDDMMYYYY(now);
  const enviados = { A: 0, B: 0, C: 0 };
  for (const f of filas) {
    const m = f.mailEnviado.match(/^(?:auto|form)\??\s+(\d{2}\/\d{2}\/\d{4})/);
    if (!m) continue;
    if (m[1] !== hoyDDMM && m[1] !== ayer) continue;
    const t = tierParaEnvio(f.pantalla);
    if (t) enviados[t]++;
  }

  const pendientes = stats.remaining + stats.failed;
  const subject = `VIGILANTE OK ${hoy}${nuevas48 === 0 ? ' · SIN TESTS 48H' : ''}`;
  const text =
    `Filas totales: ${filas.length}\n` +
    `Filas nuevas en 24 h: ${nuevas24}\n` +
    `Enviados en 24 h: A=${enviados.A} B=${enviados.B} C=${enviados.C}\n` +
    `Pendientes: ${pendientes}\n` +
    `Sin fecha parseable: ${stats.skipped.sin_fecha} · sin tier: ${stats.skipped.sin_tier}\n` +
    (nuevas48 === 0 ? `\nATENCIÓN: 0 tests nuevos en 48 h. Revisar Typeform → Sheet.\n` : '') +
    `\n— Nexo-mail`;
  const ok = await enviarAlerta(subject, text);
  stats.alert_sent = stats.alert_sent || ok;
  if (!ok) {
    // Que se reintente en la próxima corrida del día: sin el OK diario no se
    // distingue un cron muerto de un Brevo caído.
    try {
      await kv.del(key);
    } catch (err) {
      console.error('vigilante heartbeat kv.del error:', err);
    }
  }
}

// ─── Handler ────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const t0 = Date.now();
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET no configurado' }, { status: 500 });
  }

  const url = new URL(request.url);
  const auth = request.headers.get('authorization');
  const token = url.searchParams.get('token');
  if (auth !== `Bearer ${secret}` && token !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  // Sin alertas configuradas el vigilante fallaría en silencio: mejor 500 visible.
  if (!process.env.APPROVAL_EMAIL || !process.env.BREVO_API_KEY) {
    return NextResponse.json(
      { ok: false, error: 'alertas no configuradas: faltan APPROVAL_EMAIL y/o BREVO_API_KEY' },
      { status: 500 }
    );
  }

  const dry = url.searchParams.get('dry') === '1';
  const maxRaw = parseInt(url.searchParams.get('max') || '', 10);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, MAX_MAX) : DEFAULT_MAX;

  // a. Lock (no en dry)
  let locked = false;
  if (!dry) {
    try {
      const got = await kv.set(LOCK_KEY, new Date().toISOString(), { nx: true, ex: LOCK_TTL_S });
      if (!got) return NextResponse.json({ ok: true, skipped: 'locked' });
      locked = true;
    } catch (err) {
      const msg = `KV lock error: ${errMsg(err)}`;
      console.error('postest-vigilante', msg);
      // enviarAlerta no depende de KV: sin esto un outage de KV mata el cron en silencio.
      await enviarAlerta('VIGILANTE: KV no disponible', `${msg}\n\nNo se procesó nada.`);
      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }
  }

  try {
    return await correr(dry, max, t0);
  } catch (err) {
    const msg = errMsg(err);
    console.error('postest-vigilante error:', err);
    await enviarAlerta('VIGILANTE: error inesperado', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  } finally {
    runDeadline = 0;
    if (locked) {
      try {
        await kv.del(LOCK_KEY);
      } catch (err) {
        console.error('vigilante lock release error:', err);
      }
    }
  }
}
