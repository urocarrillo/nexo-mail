/**
 * Test propio del programa DE (public/test.html → /api/form/test-programa).
 * Reemplaza al Typeform bNbpXutl escribiendo en el mismo Sheet CRM
 * ("Cohorte 2 — Calificación") con los mismos textos de respuesta, para que
 * tier-programa.ts, el vigilante y los filter views de Mauro sigan funcionando.
 *
 * Este módulo es lógica pura (sin IO): mapeo letras→textos, validación de
 * payloads, formato de fecha Typeform, armado de la fila alineada a los
 * headers y token. El IO (Sheets, Brevo, KV) vive en la route.
 */
import crypto from 'crypto';
import type { RespuestasTier } from './tier-programa';

// ─── Textos exactos de las opciones (PRD form-01-calificacion-cohorte2) ──

export type Letra = 'a' | 'b' | 'c';
export type PreguntaKey = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7';
export type Contacto = 'meet' | 'wa' | 'tel';

export const PREGUNTAS: PreguntaKey[] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];

export const OPCIONES: Record<PreguntaKey, Partial<Record<Letra, string>>> = {
  p1: {
    a: '18 - 49 años',
    b: '50 años o más',
  },
  p2: {
    a: 'Sí, casi siempre',
    b: 'A veces sí, a veces no — especialmente cuando intento "ponerme a prueba" para ver si funciona',
    c: 'No, casi nunca',
  },
  p3: {
    a: 'No tengo enfermedades crónicas importantes, o tengo solo 1 condición controlada',
    b: 'Tengo enfermedad/es de base (diabetes, HTA, dislipemia) o tomo +2 medicamentos crónicos al día, o tuve cirugía pelviana',
    c: 'Tengo varias de esas condiciones y el problema de erección apareció cerca del momento del diagnóstico',
  },
  p4: {
    a: 'No tengo pareja estable (soltero, encuentros casuales u ocasionales)',
    b: 'Tengo pareja estable y la relación es buena (con o sin convivencia)',
    c: 'Tengo pareja estable pero hay problemas recientes, monotonía importante, o atravesamos una crisis vital',
  },
  p5: {
    a: 'Más de 1 hora diaria o más de lo que me gustaría',
    b: 'Diariamente pero poco tiempo, siento que lo controlo',
    c: 'Ocasional o no consumo',
  },
  p6: {
    a: 'Sí, me comprometo',
    b: 'Voy a intentarlo',
    c: 'No tengo esa disponibilidad',
  },
  p7: {
    a: 'Sí, es prioridad y estoy dispuesto a invertir en mejorar de una vez por todas',
    b: 'Me importa pero estoy ajustado de ingresos y/o tiempos',
    c: 'Tengo otras prioridades o en este momento no puedo',
  },
};

export const CONTACTO_TEXTOS: Record<Contacto, string> = {
  meet: 'Meet (Mejor opción — agenda automática)',
  wa: 'WhatsApp (mensajes o llamada de WA)',
  tel: 'Llamada telefónica (solo Argentina)',
};

/** Texto exacto de una opción, o '' si la letra no existe para esa pregunta. */
export function textoOpcion(p: PreguntaKey, letra: string): string {
  return OPCIONES[p][letra as Letra] || '';
}

// ─── Payloads ───────────────────────────────────────────────────────

export interface PartialData {
  name: string;
  email: string;
  pais: string; // ISO-2 mayúsculas o 'XX'
  src: string; // [a-z0-9-_]{1,40}, default 'web'
}

export interface FinalData extends PartialData {
  p1: Letra;
  p2: Letra;
  p3: Letra;
  p4: Letra;
  p5: Letra;
  p6: Letra;
  p7: Letra;
  verbatim: string;
}

export interface ContactoData {
  email: string;
  contacto: Contacto;
  telefono: string; // '' si meet
  /** Token 'form-…' devuelto por el 'final' (opcional: el front actual no lo manda). */
  token?: string;
}

export type Validacion<T> = { ok: true; data: T } | { ok: false; error: string };

const MAX_NAME = 80;
const MAX_VERBATIM = 300;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function rec(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/**
 * Un texto que arranca con = + - @ (o tab/CR) se interpreta como fórmula al
 * exportar a CSV / abrir en Excel / copiar-pegar la celda (inyección de
 * fórmula). Un nombre o comentario real nunca empieza así: se recorta.
 */
const FORMULA_LEAD_RE = /^[=+\-@\t\r\s]+/;

export function stripFormulaLead(raw: string): string {
  return raw.replace(FORMULA_LEAD_RE, '');
}

/** Colapsa espacios internos; sin saltos de línea; sin prefijo de fórmula. */
export function cleanName(raw: string): string {
  return stripFormulaLead(raw.replace(/\s+/g, ' ').trim()).trim();
}

/** Recorta a 300 chars; sin más de un salto de línea seguido; sin espacios colgantes; sin prefijo de fórmula. */
export function cleanVerbatim(raw: string): string {
  const v = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return stripFormulaLead(v).trim().slice(0, MAX_VERBATIM).trim();
}

/**
 * Forma canónica del email para keys de idempotencia / rate limit (NO para
 * guardar): sin sufijo +algo en el local part y, en gmail/googlemail, sin
 * puntos y con dominio gmail.com. Así juan+1@gmail.com y j.uan@gmail.com no
 * cuentan como personas distintas.
 */
export function emailCanonico(email: string): string {
  const e = (email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

export function sanitizeSrc(raw: unknown): string {
  const s = str(raw).toLowerCase().replace(/[^a-z0-9\-_]/g, '').slice(0, 40);
  return s || 'web';
}

export function validatePais(raw: unknown): string | null {
  const p = str(raw).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(p) ? p : null;
}

/**
 * Teléfono: el front manda lo que el usuario tipeó (type=tel, máx 25 chars).
 * Se tolera puntuación habitual ( ) - . y se normaliza a dígitos/+/espacios;
 * el resultado debe tener 6-20 chars.
 */
export function normalizeTelefono(raw: unknown): string | null {
  const t = str(raw)
    .replace(/[().\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^[0-9+ ]{6,20}$/.test(t)) return null;
  if (t.indexOf('+') > 0) return null; // '+' solo al inicio
  if (t.replace(/\D/g, '').length < 6) return null;
  return t;
}

function validateBase(b: Record<string, unknown>): Validacion<PartialData> {
  const name = cleanName(str(b.name));
  if (!name || name.length > MAX_NAME) {
    return { ok: false, error: 'Escribí tu nombre (hasta 80 caracteres).' };
  }
  const email = str(b.email).trim().toLowerCase();
  if (!validateEmail(email)) {
    return { ok: false, error: 'Revisá tu email, parece que tiene un error.' };
  }
  const pais = validatePais(b.pais);
  if (!pais) {
    return { ok: false, error: 'Elegí tu país.' };
  }
  return { ok: true, data: { name, email, pais, src: sanitizeSrc(b.src) } };
}

export function validatePartial(body: unknown): Validacion<PartialData> {
  const b = rec(body);
  if (!b) return { ok: false, error: 'Datos inválidos.' };
  return validateBase(b);
}

export function validateFinal(body: unknown): Validacion<FinalData> {
  const b = rec(body);
  if (!b) return { ok: false, error: 'Datos inválidos.' };
  const base = validateBase(b);
  if (!base.ok) return base;

  const letras: Partial<Record<PreguntaKey, Letra>> = {};
  for (let i = 0; i < PREGUNTAS.length; i++) {
    const p = PREGUNTAS[i];
    const v = str(b[p]).trim().toLowerCase();
    if (!textoOpcion(p, v)) {
      return { ok: false, error: `Falta responder la pregunta ${i + 1}.` };
    }
    letras[p] = v as Letra;
  }

  const verbatimRaw = str(b.verbatim);
  const verbatim = cleanVerbatim(verbatimRaw);

  return {
    ok: true,
    data: {
      ...base.data,
      p1: letras.p1!,
      p2: letras.p2!,
      p3: letras.p3!,
      p4: letras.p4!,
      p5: letras.p5!,
      p6: letras.p6!,
      p7: letras.p7!,
      verbatim,
    },
  };
}

export function validateContacto(body: unknown): Validacion<ContactoData> {
  const b = rec(body);
  if (!b) return { ok: false, error: 'Datos inválidos.' };
  const email = str(b.email).trim().toLowerCase();
  if (!validateEmail(email)) {
    return { ok: false, error: 'Revisá tu email, parece que tiene un error.' };
  }
  const contacto = str(b.contacto).trim().toLowerCase();
  if (contacto !== 'meet' && contacto !== 'wa' && contacto !== 'tel') {
    return { ok: false, error: 'Elegí cómo querés que te contacte.' };
  }
  let telefono = '';
  if (contacto !== 'meet') {
    const t = normalizeTelefono(b.telefono);
    if (!t) {
      return {
        ok: false,
        error:
          contacto === 'wa'
            ? 'Incluí el código de país con el + al inicio y el número completo.'
            : 'Escribí código de área + número, sin el 15.',
      };
    }
    telefono = t;
  }
  const tokenRaw = str(b.token).trim();
  const token = TOKEN_RE.test(tokenRaw) ? tokenRaw : undefined;
  return { ok: true, data: { email, contacto, telefono, ...(token ? { token } : {}) } };
}

// ─── Respuestas → textos del Sheet ──────────────────────────────────

export function respuestasDesdeLetras(f: FinalData): RespuestasTier {
  return {
    edad: textoOpcion('p1', f.p1),
    ereccion: textoOpcion('p2', f.p2),
    salud: textoOpcion('p3', f.p3),
    pareja: textoOpcion('p4', f.p4),
    consumo: textoOpcion('p5', f.p5),
    compromiso: textoOpcion('p6', f.p6),
    inversion: textoOpcion('p7', f.p7),
  };
}

// ─── Fechas ─────────────────────────────────────────────────────────

/**
 * "Submitted At" como lo escribe Typeform: d/M/yyyy H:mm:ss EN UTC, sin ceros
 * a la izquierda en día/mes/hora (ej: '4/9/2026 18:07:09'). El vigilante lo
 * parsea con ese formato.
 */
export function formatSubmittedAt(d: Date): string {
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()} ${d.getUTCHours()}:${mm}:${ss}`;
}

/** Parse inverso de formatSubmittedAt (UTC). null si no matchea. */
export function parseSubmittedAt(raw: string): Date | null {
  const s = (raw || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  const hh = m[4] ? parseInt(m[4], 10) : 0;
  const mi = m[5] ? parseInt(m[5], 10) : 0;
  const ss = m[6] ? parseInt(m[6], 10) : 0;
  if (d < 1 || d > 31 || mo < 1 || mo > 12 || hh > 23 || mi > 59 || ss > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, hh, mi, ss));
  return isNaN(dt.getTime()) ? null : dt;
}

const ART_OFFSET_MS = -3 * 60 * 60 * 1000; // hora Argentina (UTC-3, sin DST)

/** 'dd/mm/yyyy HH:MM' en hora Argentina (misma marca que usa el vigilante). */
export function fechaHoraArt(d: Date): string {
  const a = new Date(d.getTime() + ART_OFFSET_MS);
  const dd = String(a.getUTCDate()).padStart(2, '0');
  const mm = String(a.getUTCMonth() + 1).padStart(2, '0');
  const HH = String(a.getUTCHours()).padStart(2, '0');
  const MM = String(a.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${a.getUTCFullYear()} ${HH}:${MM}`;
}

// ─── Token ──────────────────────────────────────────────────────────

/** 'form-' + 12 hex aleatorios. Distingue las filas del test propio de las de Typeform. */
export function generarToken(): string {
  return `form-${crypto.randomBytes(6).toString('hex')}`;
}

export const TOKEN_PREFIX = 'form-';
export const TOKEN_RE = /^form-[0-9a-f]{12}$/;

// ─── Columnas del Sheet (detección por nombre, nunca por índice) ────

export type ColKey =
  | 'nombre'
  | 'email'
  | 'edad'
  | 'ereccion'
  | 'salud'
  | 'pareja'
  | 'consumo'
  | 'compromiso'
  | 'inversion'
  | 'contacto' // P8
  | 'telefonoWa' // P14
  | 'telefonoAr' // P15
  | 'utmSource'
  | 'utmMedium'
  | 'utmCampaign'
  | 'utmContent'
  | 'scoreTypeform' // 'score' (variable de Typeform)
  | 'submitted'
  | 'token'
  | 'score' // 'Score' (calculado)
  | 'forzador'
  | 'pantalla'
  | 'variante'
  | 'estado'
  | 'mailEnviado';

/** Columnas que se crean si faltan. */
export type NewColKey = 'pais' | 'verbatim';
/** Columnas opcionales (marcas diferidas de dispatchPostTest). */
export type OptColKey = 'cliente' | 'secuencia';

export interface ColumnSpec {
  key: ColKey;
  header: string;
  /** true → matchea por prefijo (los headers largos de Typeform). */
  prefix?: boolean;
  /** Prefijos alternativos aceptados (el header real del Sheet puede diferir del PRD). */
  alt?: string[];
  /**
   * true → si falta no es error: buildRow no la escribe. Las utm_* las llena
   * Typeform (acá nunca se escriben) y P8/P14/P15 solo las necesita el step
   * 'contacto', que las exige aparte (CONTACTO_COL_KEYS).
   */
  optional?: boolean;
}

/** Columnas que el step 'contacto' exige aunque sean opcionales para el 'final'. */
export const CONTACTO_COL_KEYS: ColKey[] = ['contacto', 'telefonoWa', 'telefonoAr'];

export const COLUMN_SPECS: ColumnSpec[] = [
  { key: 'nombre', header: '¿Cómo te llamás?' },
  { key: 'email', header: '¿Cuál es tu mejor email para contactarte?' },
  { key: 'edad', header: '¿En qué rango de edad estás?' },
  { key: 'ereccion', header: '¿Tu erección funciona bien', prefix: true },
  { key: 'salud', header: 'En cuanto a tu salud general', prefix: true },
  { key: 'pareja', header: '¿Cómo es tu situación de pareja hoy?' },
  { key: 'consumo', header: '¿Cuánto consumís de redes sociales', prefix: true },
  { key: 'compromiso', header: '¿Te comprometés a dedicar', prefix: true },
  { key: 'inversion', header: 'En este momento de tu vida', prefix: true },
  { key: 'contacto', header: 'Por lo que me contás, el programa puede funcionar', prefix: true, optional: true },
  // P14: el JSON del Typeform dice 'Dejame tu número completo…'; el PRD (más nuevo) 'Dejame tu WhatsApp…'.
  { key: 'telefonoWa', header: 'Dejame tu número completo', prefix: true, alt: ['Dejame tu WhatsApp'], optional: true },
  { key: 'telefonoAr', header: 'Dejame tu número de teléfono (Argentina)', prefix: true, optional: true },
  { key: 'utmSource', header: 'utm_source' },
  { key: 'utmMedium', header: 'utm_medium', optional: true },
  { key: 'utmCampaign', header: 'utm_campaign', optional: true },
  { key: 'utmContent', header: 'utm_content', optional: true },
  { key: 'scoreTypeform', header: 'score' },
  { key: 'submitted', header: 'Submitted At' },
  { key: 'token', header: 'Token' },
  { key: 'score', header: 'Score' },
  { key: 'forzador', header: 'Forzador' },
  { key: 'pantalla', header: 'Pantalla' },
  { key: 'variante', header: 'Variante' },
  { key: 'estado', header: 'Estado seguimiento' },
  { key: 'mailEnviado', header: 'Mail enviado' },
];

export const NEW_COLUMN_SPECS: Array<{ key: NewColKey; header: string }> = [
  { key: 'pais', header: 'País' },
  { key: 'verbatim', header: 'Verbatim' },
];

export const OPT_COLUMN_SPECS: Array<{ key: OptColKey; header: string }> = [
  { key: 'cliente', header: 'Cliente' },
  { key: 'secuencia', header: 'Secuencia' },
];

export type Cols = Record<ColKey, number> & Record<NewColKey, number> & Record<OptColKey, number>;

export function cleanHeader(h: string | undefined): string {
  return (h || '').replace(/\u00a0/g, ' ').trim();
}

/**
 * Resuelve índices 0-based de todas las columnas. `missing` lista las
 * requeridas que faltan; las opcionales, País/Verbatim y Cliente/Secuencia
 * quedan en -1 si no existen (País/Verbatim las crea la route).
 */
export function resolverColumnas(headers: string[]): { cols: Cols; missing: string[] } {
  const clean = headers.map(cleanHeader);
  const cols = {} as Cols;
  const missing: string[] = [];
  for (const spec of COLUMN_SPECS) {
    const prefijos = [spec.header, ...(spec.alt || [])];
    const idx = clean.findIndex((h) =>
      spec.prefix ? prefijos.some((p) => h.startsWith(p)) : prefijos.some((p) => h === p)
    );
    cols[spec.key] = idx;
    if (idx < 0 && !spec.optional) missing.push(spec.header);
  }
  for (const spec of NEW_COLUMN_SPECS) {
    cols[spec.key] = clean.findIndex((h) => h === spec.header);
  }
  for (const spec of OPT_COLUMN_SPECS) {
    cols[spec.key] = clean.findIndex((h) => h === spec.header);
  }
  return { cols, missing };
}

/** Índice de la primera columna con header vacío a la derecha de la última usada. */
export function primeraColumnaLibre(headers: string[]): number {
  let last = -1;
  for (let i = 0; i < headers.length; i++) {
    if (cleanHeader(headers[i]) !== '') last = i;
  }
  return last + 1;
}

// ─── Fila ───────────────────────────────────────────────────────────

export interface FilaInput {
  data: FinalData;
  respuestas: RespuestasTier;
  submittedAt: string;
  token: string;
  score: number;
  forzador: string;
  pantalla: string;
  variante: string;
}

/**
 * Fila alineada a los headers del Sheet (misma posición que las filas de
 * Typeform). Celdas no aplicables quedan ''. El largo es max(índice usado)+1.
 */
export function buildRow(cols: Cols, input: FilaInput): Array<string | number> {
  const { data, respuestas } = input;
  const cells: Array<[number, string | number]> = [
    [cols.nombre, data.name],
    [cols.email, data.email],
    [cols.edad, respuestas.edad],
    [cols.ereccion, respuestas.ereccion],
    [cols.salud, respuestas.salud],
    [cols.pareja, respuestas.pareja],
    [cols.consumo, respuestas.consumo],
    [cols.compromiso, respuestas.compromiso],
    [cols.inversion, respuestas.inversion],
    [cols.utmSource, `test-${data.src}`],
    [cols.scoreTypeform, input.score],
    [cols.submitted, input.submittedAt],
    [cols.token, input.token],
    [cols.score, input.score],
    [cols.forzador, input.forzador],
    [cols.pantalla, input.pantalla],
    [cols.variante, input.variante],
    [cols.pais, data.pais],
    [cols.verbatim, data.verbatim],
  ];
  let max = -1;
  for (const [i] of cells) if (i > max) max = i;
  const row: Array<string | number> = Array.from({ length: max + 1 }, () => '');
  for (const [i, v] of cells) if (i >= 0) row[i] = v;
  return row;
}

/** Número de fila (1-based) a partir del updatedRange de values:append. */
export function filaDesdeUpdatedRange(updatedRange: string | undefined): number | null {
  const m = (updatedRange || '').match(/!\$?[A-Z]+\$?(\d+)(?::\$?[A-Z]+\$?\d+)?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 2 ? n : null;
}

// ─── Misc ───────────────────────────────────────────────────────────

export function maskEmail(email: string): string {
  const [user, domain] = (email || '').split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

/**
 * Cache en memoria del módulo (10 min) del índice de las columnas País y
 * Verbatim recién creadas, para no volver a crearlas en cada request.
 */
export const COLUMN_CACHE_TTL_MS = 10 * 60 * 1000;

export interface NewColumnsCache {
  pais: number;
  verbatim: number;
  ts: number;
}

let newColumnsCache: NewColumnsCache | null = null;

export function getNewColumnsCache(now = Date.now()): NewColumnsCache | null {
  if (newColumnsCache && now - newColumnsCache.ts < COLUMN_CACHE_TTL_MS) return newColumnsCache;
  return null;
}

export function setNewColumnsCache(c: { pais: number; verbatim: number }, now = Date.now()): void {
  newColumnsCache = { ...c, ts: now };
}

export function resetNewColumnsCache(): void {
  newColumnsCache = null;
}
