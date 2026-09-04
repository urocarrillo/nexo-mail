/**
 * Secuencia de rescate — Tier A que nunca recibió el mail post-test (R2, R3, R4).
 *
 * Spec de copy y reglas:
 *   06-Procesos/secuencias-email/rescate-tier-a/secuencia-rescate-tier-a.md
 *
 * R1 ("tu test quedó sin respuesta") se manda a mano con un script local que
 * escribe 'rescate dd/mm' en la columna "Mail enviado" del Sheet CRM. Este
 * módulo cubre lo que sigue: R2 (+3), R3 (+6) y R4 (+10), encolados en el motor
 * drip (email-drip.ts, kind 'rescate-a') con el MISMO tratamiento que la
 * secuencia post-Typeform: orden estricto, blacklist antes de cada envío, pausa
 * por Estado de seguimiento, salida al comprar, marca en la columna Secuencia.
 *
 * Módulo PURO (sin IO): builders de los mails, cálculo de fechas anclado al
 * calendario de Argentina (UTC-3 sin DST) y el filtro de candidatos.
 *
 * Mails "caseros" de mauro@ (plain text, firma "Mauro"). Links con ?mseq=raN.
 */
import { isSecuenciaExcluido, tierDePantalla } from './secuencia-post-typeform';

export const RESCATE_KIND = 'rescate-a';
export const RESCATE_TAG = 'secuencia-rescate-a';
export const RESCATE_SENDER = { name: 'Mauro Carrillo', email: 'mauro@urologia.ar' };
export const RESCATE_LANDING = 'https://urologia.ar/recuperatuereccion';
export const RESCATE_CALENDLY = 'https://calendly.com/urologocarrillo';

/** Pasos que encola el motor (R1 sale a mano). */
export type RescateStep = 2 | 3 | 4;
export const RESCATE_STEPS: ReadonlyArray<RescateStep> = [2, 3, 4];

/** Offsets en días desde R1 de R2, R3 y R4. */
export const RESCATE_OFFSETS_DIAS: ReadonlyArray<number> = [3, 6, 10];

/** Prefijo de la columna "Mail enviado" que identifica a quien recibió R1. */
export const RESCATE_MAIL_ENVIADO_PREFIX = 'rescate ';

export interface RescateMail {
  subject: string;
  text: string;
}

// ─── Builders de los mails ──────────────────────────────────────────

function greeting(name: string): string {
  return name ? `Hola ${name},` : 'Hola,';
}

/** ¿La variante del Sheet es "A-Cuotas" (ajustado de ingresos)? */
export function esVarianteCuotas(variante: string): boolean {
  return (variante || '').trim().toLowerCase() === 'a-cuotas';
}

/** PD del R3 según variante (A-Cuotas vs resto). */
export function pdR3(variante: string): string {
  return esVarianteCuotas(variante)
    ? 'PD: sé que la inversión pesa. Desde Argentina pagás en pesos con Mercado Pago y en cuotas sin interés. Desde otros países, con PayPal.'
    : 'PD: desde Argentina pagás en pesos por Mercado Pago y tenés cuotas.';
}

function mailR2(name: string): RescateMail {
  return {
    subject: 'una palabra',
    text:
      `${greeting(name)}\n\n` +
      `Te hago una sola pregunta, y en serio me interesa la respuesta.\n\n` +
      `Hiciste el test y tenés el programa a mano. Si todavía no arrancaste, algo hay. Contestame este mail con una palabra:\n\n` +
      `precio — dudas — momento — otra\n\n` +
      `Con esa palabra me alcanza. Te respondo yo, puntualmente sobre lo tuyo.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

function mailR3(name: string, variante: string): RescateMail {
  return {
    subject: 'cómo es por dentro',
    text:
      `${greeting(name)}\n\n` +
      `Te cuento cómo es el programa por dentro, así lo ves concreto:\n\n` +
      `8 semanas de trabajo, una por módulo. Videos y actividades de 15-30 minutos por día, a tu ritmo: nadie te corre y el acceso queda para vos. Herramientas descargables para cada semana. Y una consulta individual conmigo incluida, para revisar tu caso puntual cuando vos lo decidas.\n\n` +
      `Empezás hoy y en la primera semana ya estás trabajando con las primeras herramientas.\n\n` +
      `${RESCATE_LANDING}/?mseq=ra3\n\n` +
      `Cualquier pregunta, respondeme por acá.\n\n` +
      `Abrazo,\n` +
      `Mauro\n\n` +
      `${pdR3(variante)}\n`,
  };
}

function mailR4(name: string): RescateMail {
  return {
    subject: 'lo que sigue es tuyo',
    text:
      `${greeting(name)}\n\n` +
      `Ya te conté todo lo que tenía para contarte. Lo que sigue es tuyo, y así tiene que ser: esto funciona cuando el que decide sos vos.\n\n` +
      `Te dejo las dos puertas a mano.\n\n` +
      `Arrancar el programa hoy:\n` +
      `${RESCATE_LANDING}/?mseq=ra4\n\n` +
      `O verlo conmigo antes, en una consulta:\n` +
      `${RESCATE_CALENDLY}\n\n` +
      `Y si el momento es otro, guardá este mail. El día que lo retomes, respondeme y seguimos desde acá.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

/**
 * Devuelve el mail de un paso de la secuencia de rescate.
 * @param step     2 | 3 | 4 (R2, R3, R4)
 * @param name     nombre (fallback: "" → "Hola,")
 * @param variante valor de la columna Variante del Sheet (sólo afecta la PD de R3)
 */
export function buildRescateMail(step: RescateStep, name: string, variante: string): RescateMail {
  const n = (name || '').trim();
  switch (step) {
    case 2:
      return mailR2(n);
    case 3:
      return mailR3(n, variante || '');
    case 4:
      return mailR4(n);
    default:
      throw new Error(`Paso de rescate inválido: ${step}`);
  }
}

// ─── Cálculo de fechas (anclado al calendario de Argentina) ─────────
//
// Cada mail se agenda a las 10:00 ART = 13:00 UTC del día correspondiente, que
// es exactamente la hora de la corrida diaria del cron send-emails ("0 13 * * *").
// Argentina no tiene horario de verano → offset fijo -3; a las 13:00 UTC la fecha
// de calendario coincide en ambas zonas, así que getUTCDay() da el día ART.

const ART_OFFSET_HOURS = -3;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RESCATE_SEND_HOUR_UTC = 13;

/** Instante 13:00 UTC (10:00 ART) del día (y, m 0-based, d). */
function artDay(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d, RESCATE_SEND_HOUR_UTC, 0, 0, 0));
}

/** Día ART (a las 13:00 UTC) correspondiente al instante `at`. */
export function artDayOf(at: Date): Date {
  const art = new Date(at.getTime() + ART_OFFSET_HOURS * 60 * 60 * 1000);
  return artDay(art.getUTCFullYear(), art.getUTCMonth(), art.getUTCDate());
}

export function addDays(day: Date, n: number): Date {
  return new Date(day.getTime() + n * DAY_MS);
}

/** Número de día ART (días enteros desde epoch, en hora Argentina). */
export function artDayNumber(at: Date): number {
  return Math.floor((at.getTime() + ART_OFFSET_HOURS * 60 * 60 * 1000) / DAY_MS);
}

/** Días de calendario ART entre `a` y `b` (b - a; negativo si b es anterior). */
export function diasArtEntre(a: Date, b: Date): number {
  return artDayNumber(b) - artDayNumber(a);
}

/** ¿El instante cae en domingo según el calendario de Argentina? */
export function esDomingoART(at: Date): boolean {
  return artDayOf(at).getUTCDay() === 0;
}

/**
 * Fechas de [R2, R3, R4] = R1 + 3, + 6, + 10 días, a las 10:00 ART (13:00 UTC).
 * Si alguna cae domingo, corre a lunes. `r1` se interpreta por su día ART.
 */
export function computeRescateDates(r1: Date): Date[] {
  const base = artDayOf(r1);
  return RESCATE_OFFSETS_DIAS.map((n) => {
    let d = addDays(base, n);
    if (d.getUTCDay() === 0) d = addDays(d, 1); // domingo → lunes
    return d;
  });
}

/**
 * Parsea la fecha del R1 que llega por query (?r1=). Acepta YYYY-MM-DD y
 * dd/mm/yyyy. Devuelve el instante 13:00 UTC de ese día, o null si es inválida.
 */
export function parseR1Date(raw: string): Date | null {
  const s = (raw || '').trim();
  let y: number, m: number, d: number;
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) {
    y = parseInt(mt[1], 10);
    m = parseInt(mt[2], 10);
    d = parseInt(mt[3], 10);
  } else {
    mt = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!mt) return null;
    d = parseInt(mt[1], 10);
    m = parseInt(mt[2], 10);
    y = parseInt(mt[3], 10);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = artDay(y, m - 1, d);
  if (isNaN(dt.getTime()) || dt.getUTCMonth() !== m - 1) return null;
  return dt;
}

/**
 * Fecha real del R1 registrada en la celda "Mail enviado" ('rescate dd/mm' o
 * 'rescate dd/mm/yyyy'). Sin año en la celda, usa `anio`. Devuelve el instante
 * 13:00 UTC de ese día, o null si la celda no trae una fecha parseable.
 */
export function parseRescateCellDate(mailEnviado: string, anio: number): Date | null {
  const s = (mailEnviado || '').trim().toLowerCase();
  if (!s.startsWith(RESCATE_MAIL_ENVIADO_PREFIX)) return null;
  const mt = s.slice(RESCATE_MAIL_ENVIADO_PREFIX.length).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (!mt) return null;
  const d = parseInt(mt[1], 10);
  const m = parseInt(mt[2], 10);
  const y = mt[3] ? parseInt(mt[3], 10) : anio;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = artDay(y, m - 1, d);
  if (isNaN(dt.getTime()) || dt.getUTCMonth() !== m - 1) return null;
  return dt;
}

// ─── Candidatos del enrolamiento (puro, testeable) ──────────────────

export interface RescateRow {
  email: string;
  nombre: string;
  pantalla: string;
  estado: string; // "Estado seguimiento"
  cliente: string; // columna Cliente
  mailEnviado: string; // columna "Mail enviado"
  variante: string; // columna Variante
  rowIndex: number; // 1-based
}

export interface RescateCandidato {
  email: string;
  nombre: string;
  variante: string;
  rowIndex: number;
  /** Fecha del R1 leída de la celda 'rescate dd/mm' (null si no parsea → usar ?r1=). */
  r1Celda: Date | null;
}

export type RescateDescarteRazon =
  | 'sin-rescate'
  | 'email-invalido'
  | 'duplicado'
  | 'no-pantalla-a'
  | 'estado-no-vacio'
  | 'cliente-col'
  | 'excluido-1a1'
  | 'cliente'
  | 'ya-enrolado'
  | 'en-secuencia'
  | 'max';

export interface RescateCandidatosResult {
  candidatos: RescateCandidato[];
  descartes: Record<RescateDescarteRazon, number>;
  totalRows: number;
  conRescate: number; // filas con 'rescate ' en Mail enviado (antes de descartes)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailValido(email: string): boolean {
  return EMAIL_RE.test((email || '').trim());
}

/** ¿La celda "Mail enviado" registra el R1 del rescate ('rescate dd/mm')? */
export function tieneRescateR1(mailEnviado: string): boolean {
  return (mailEnviado || '').trim().toLowerCase().startsWith(RESCATE_MAIL_ENVIADO_PREFIX);
}

/**
 * Candidatos del rescate: filas con "Mail enviado" que empieza con 'rescate ',
 * Pantalla A, Estado seguimiento vacío, Cliente vacío, email válido y único,
 * no en la exclusión 1-a-1, no cliente (WooCommerce), no enrolados ya en
 * rescate-a y sin secuencia post-Typeform pendiente (`enSecuencia`: evita dos
 * secuencias en paralelo al mismo lead). `max` corta la lista (los que sobran
 * cuentan como 'max'). `anioR1` es el año para interpretar 'rescate dd/mm'.
 * La blacklist NO se chequea acá: se re-chequea antes de CADA envío en el motor.
 */
export function computeRescateCandidatos(
  rows: RescateRow[],
  opts: {
    esCliente: (email: string) => boolean;
    yaEnrolados: Set<string>;
    max: number;
    enSecuencia?: Set<string>;
    anioR1?: number;
  }
): RescateCandidatosResult {
  const anioR1 = opts.anioR1 ?? new Date().getUTCFullYear();
  const descartes: Record<RescateDescarteRazon, number> = {
    'sin-rescate': 0,
    'email-invalido': 0,
    duplicado: 0,
    'no-pantalla-a': 0,
    'estado-no-vacio': 0,
    'cliente-col': 0,
    'excluido-1a1': 0,
    cliente: 0,
    'ya-enrolado': 0,
    'en-secuencia': 0,
    max: 0,
  };
  const seen = new Set<string>();
  const candidatos: RescateCandidato[] = [];
  let conRescate = 0;

  for (const row of rows) {
    if (!tieneRescateR1(row.mailEnviado)) {
      descartes['sin-rescate']++;
      continue;
    }
    conRescate++;

    const email = (row.email || '').trim().toLowerCase();
    if (!emailValido(email)) {
      descartes['email-invalido']++;
      continue;
    }
    if (seen.has(email)) {
      descartes.duplicado++;
      continue;
    }
    seen.add(email);

    if (tierDePantalla(row.pantalla) !== 'A') {
      descartes['no-pantalla-a']++;
      continue;
    }
    if ((row.estado || '').trim() !== '') {
      descartes['estado-no-vacio']++;
      continue;
    }
    if ((row.cliente || '').trim() !== '') {
      descartes['cliente-col']++;
      continue;
    }
    if (isSecuenciaExcluido(email)) {
      descartes['excluido-1a1']++;
      continue;
    }
    if (opts.esCliente(email)) {
      descartes.cliente++;
      continue;
    }
    if (opts.yaEnrolados.has(email)) {
      descartes['ya-enrolado']++;
      continue;
    }
    if (opts.enSecuencia?.has(email)) {
      descartes['en-secuencia']++;
      continue;
    }
    if (candidatos.length >= opts.max) {
      descartes.max++;
      continue;
    }

    candidatos.push({
      email,
      nombre: (row.nombre || '').trim(),
      variante: (row.variante || '').trim(),
      rowIndex: row.rowIndex,
      r1Celda: parseRescateCellDate(row.mailEnviado, anioR1),
    });
  }

  return { candidatos, descartes, totalRows: rows.length, conRescate };
}
