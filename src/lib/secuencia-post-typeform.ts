/**
 * Secuencia post-test del programa DE (v6, 24/09/2026): mails cortos y humanos.
 *
 *   Tier A: día 0 "tu resultado del test" → día 1 "¿la pudiste ver?" → día 4
 *           "¿hace cuánto que estás con esto?"
 *   Tier B: día 0 "sobre tu resultado" (frase según el factor que lo hace B)
 *           → día 3 "¿la pudiste ver?" (versión B)
 *
 * Copy aprobado por Mauro (06-Procesos/embudos/embudo-programa-v5-tier-a.md § 10.9).
 * Sin cuotas, sin Calendly, sin edad. El mail 0 pide una respuesta ("recibido")
 * para salir de spam; quien compra sale de la secuencia (webhook Woo + re-chequeo
 * antes de cada envío en email-drip.ts).
 *
 * Este módulo es PURO (sin IO): builders de los mails, cálculo de fechas anclado
 * al calendario de Argentina (UTC-3 sin DST), la lista de exclusión 1-a-1 y los
 * predicados de elegibilidad. El motor drip (email-drip.ts) lo consume.
 *
 * Mails "caseros" de mauro@ (plain text, firma "Mauro", sin branding HTML).
 * Los links llevan ?mseq=… para atribución en WooCommerce.
 */

export const SECUENCIA_TAG = 'secuencia-post-typeform';
export const SECUENCIA_SENDER = { name: 'Mauro Carrillo', email: 'mauro@urologia.ar' };
export const LANDING = 'https://urologia.ar/recuperatuereccion';

// Zona horaria de Argentina: UTC-3 fijo (no hay horario de verano vigente).
export const ART_OFFSET_HOURS = -3;

// Keywords de Estado del CRM que pausan/cortan la secuencia (conversación humana
// en curso). Comparación case-insensitive "contiene".
export const ESTADO_PAUSA_KEYWORDS = [
  'respondido',
  'en conversación',
  'en conversacion',
  'contactado',
  'compró',
  'compro',
];

/**
 * Emails en gestión 1-a-1 del Sprint 1 (carritos, teléfonos, Meet, upgrades) +
 * emails de prueba. NUNCA entran en el enrolamiento del stock ni reciben la
 * secuencia. Hardcodeada a pedido del spec (secuencia-post-typeform.md, "Reglas
 * de implementación").
 */
export const SECUENCIA_EXCLUIDOS: ReadonlyArray<string> = [
  'cuervoasa@hotmail.com',
  'mauriciodavidelgueta@gmail.com',
  'agusmulle09@hotmail.com',
  'agusmuller09@hotmail.com',
  'vitoriano0011@gmail.com',
  'iamaarongil@gmail.com',
  'miltonxavier85@gmail.com',
  'nahuel.auge@gmail.com',
  'abogado.josefrancisco@gmail.com',
  'fedefigarii@gmail.com',
  'jeroemre5886@gmail.com',
  'carlihevia2@gmail.com',
  'danielmenjivargg@gmail.com',
  'edgardo.sauco@gmail.com',
  'avendao_ivan@yahoo.com.ar',
  'valencianicolas80@gmail.com',
  'svelazquez6944@gmail.com',
  'fabiankpo82@gmail.com',
  'robertomariocarrion@gmail.com',
  'cuentaatkaay@gmail.com',
  'galettomarcelo74@gmail.com',
  'nunezjuanmaria@gmail.com',
  'pujolcajalelias@gmail.com',
  'elflow-dominicano@hotmail.com',
  'pena78234@gmail.com',
  'cristianarceu@gmail.com',
  'gustavoruhl921@gmail.com',
  'jormojim1205@gmail.com',
  'wdkegel2427@gmail.com',
  'nico_pucciarelli@hotmail.com',
  'edufvarela@hotmail.com',
  'gus_sil2006@hotmail.com',
  'lucasdisanto97@gmail.com',
  'samuel.monclou@gmail.com',
  'gdiaz.sercom@gmail.com',
  'arielcasaretto85@gmail.com',
  'martheyn.barbosa@gmail.com',
  'dani.cemborain58@gmail.com',
  'marcossbiglio@gmail.com',
  'szapata0901@gmail.com',
  'mati_lucchesi@hotmail.com',
  'gonzalo.aherrera94cba@gmail.com',
  'nahu.cabezas@gmail.com',
  'pruebatester7@gmail.com',
  'urologia.carrillo@gmail.com',
  'urologia.ar@gmail.com',
];

const EXCLUIDOS_SET = new Set(SECUENCIA_EXCLUIDOS.map((e) => e.trim().toLowerCase()));

export function isSecuenciaExcluido(email: string): boolean {
  return EXCLUIDOS_SET.has((email || '').trim().toLowerCase());
}

/** ¿El Estado del CRM indica conversación humana en curso? → pausar/cortar. */
export function estadoPausaSecuencia(estado: string | undefined | null): boolean {
  const e = (estado || '').trim().toLowerCase();
  if (!e) return false;
  return ESTADO_PAUSA_KEYWORDS.some((k) => e.includes(k));
}

// ─── Builders de los mails (secuencia v6) ───────────────────────────

export type MailVariant = 'A' | 'B'; // legado (M1A/M1B): lo conservan las entries viejas de la cola
export type SeqTrack = 'A' | 'B';
export type FactorMailB = 'fisico' | 'vinculo';

export interface SecuenciaMail {
  subject: string;
  text: string;
}

/** Días desde el test de cada paso encolado, por tier (el día 0 es inmediato). */
export const SECUENCIA_DIAS: Record<SeqTrack, ReadonlyArray<number>> = { A: [1, 4], B: [3] };

function greeting(name: string): string {
  return name ? `Hola ${name},` : 'Hola,';
}

/**
 * Tier A, día 0: "tu resultado del test" (lo manda postest.ts al terminar el test).
 * `soloOk` = respondió que en solitario la erección funciona ("Sí"): habilita
 * la frase "el cuerpo funciona"; con "A veces" se omite.
 */
export function buildMailA0(name: string, opts: { soloOk?: boolean } = {}): SecuenciaMail {
  const n = (name || '').trim();
  const perfil = opts.soloOk
    ? 'el cuerpo funciona, y la cabeza se acelera y desconecta cuando hay otra persona'
    : 'la cabeza se acelera y desconecta cuando hay otra persona';
  return {
    subject: 'tu resultado del test',
    text:
      `${greeting(n)}\n\n` +
      `Por lo que respondiste, tu caso es de los que mejor responden al programa: ${perfil}. Lo sé no solo como urólogo: yo pasé por lo mismo, lo solucioné y desde entonces he ayudado a cientos de hombres.\n\n` +
      `El objetivo es uno: que tu erección responda con otra persona igual que cuando estás solo. Y para eso hay que aprender a dejar de pensar en la erección y conectar con ese momento.\n\n` +
      `Cómo se entrena eso, está explicado acá: ${LANDING}/?mseq=sq0\n\n` +
      `Respondé este mail con un "recibido", así estamos en contacto.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

/** "¿la pudiste ver?": día 1 del tier A · día 3 del tier B (pide la situación en dos líneas). */
export function buildMailPudisteVer(name: string, track: SeqTrack): SecuenciaMail {
  const n = (name || '').trim();
  const cuerpo =
    track === 'B'
      ? '¿Pudiste ver la página del programa? Si te interesa, contame en dos líneas cómo es lo tuyo y te digo si es para vos.'
      : '¿Pudiste ver el programa? Contame qué te pareció y qué te gustaría saber antes de arrancar.';
  return {
    subject: '¿la pudiste ver?',
    text: `${greeting(n)}\n\n${cuerpo}\n\nAbrazo,\nMauro\n`,
  };
}

/** Tier A, día 4: cierre con valor apilado, plan ordenado semana a semana y gatillo reflexivo. */
export function buildMailA4(name: string): SecuenciaMail {
  const n = (name || '').trim();
  return {
    subject: '¿hace cuánto que estás con esto?',
    text:
      `${greeting(n)}\n\n` +
      `Pensá por un segundo hace cuánto que estás con esto. Todo ese tiempo se resuelve en 8 semanas, empezando hoy.\n\n` +
      `Lo que te llevás al entrar es un plan ordenado, semana a semana. Cada semana trae sus videos, sus actividades de 15 a 30 minutos por día y sus herramientas descargables, en el orden justo para que cada paso se apoye en el anterior. Es lo que más me destacan los que ya lo hicieron: saber exactamente qué hacer cada día.\n\n` +
      `Sumale una consulta individual conmigo para ajustar el plan a tu caso, acceso inmediato y para siempre, a tu ritmo. Todo eso entra completo en una sola inscripción, y queda tuyo desde el primer día.\n\n` +
      `${LANDING}/?mseq=sq2\n\n` +
      `Si algo te frena, respondé este mail y lo conversamos. Lo leo yo.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

const FRASE_FACTOR_B: Record<FactorMailB, string> = {
  fisico: 'También puede haber una parte física para revisar, y eso lo vemos en la consulta individual que viene incluida.',
  vinculo: 'También pesa lo que pasa en la pareja, y eso conviene mirarlo aparte del entrenamiento.',
};

/**
 * Tier B, día 0: "sobre tu resultado". La frase por factor (físico / vínculo)
 * nombra lo propio del caso; la respuesta del lead es la que lo califica.
 */
export function buildMailB0(name: string, factor: FactorMailB | null): SecuenciaMail {
  const n = (name || '').trim();
  const extra = factor ? ` ${FRASE_FACTOR_B[factor]}` : '';
  return {
    subject: 'sobre tu resultado',
    text:
      `${greeting(n)}\n\n` +
      `Por lo que respondiste, en tu caso hay un componente de ansiedad que se entrena, y ahí el programa puede ayudarte.${extra}\n\n` +
      `Lo sé como urólogo y porque yo pasé por lo mismo y lo solucioné.\n\n` +
      `Mirá la página del programa: ahí están las 8 semanas, los videos y actividades de 15 a 30 minutos por día, las herramientas descargables y la consulta individual conmigo incluida.\n\n` +
      `${LANDING}/?mseq=sqb0\n\n` +
      `Cuando la veas, si te interesa, respondé este mail y contame en dos líneas cómo es lo tuyo. Con eso te digo si es para vos y cuál es el mejor camino.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

/** Nombre del curso legible: colapsa espacios y saca caracteres invisibles del título de Woo. */
function nombreCurso(curso?: string): string {
  const c = (curso || '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  return c || 'el programa Controla tu Mente, Recupera tu Erección';
}

/**
 * Recupero de carrito (R1 a la hora, R2 a las 20 h). Plain text, firma "Mauro".
 * Genérico para cualquier curso (usa el nombre del producto del pedido). Copy
 * esperanzador y en positivo: "todavía estás a tiempo", la solución está a un
 * paso sin decirlo. El link lleva al pago del mismo pedido si sigue pendiente
 * o al carrito del curso si ya se canceló.
 */
export function buildRecuperoMail(
  name: string,
  opts: { paso?: 1 | 2; curso?: string; link?: string } = {}
): SecuenciaMail {
  const n = (name || '').trim();
  const curso = nombreCurso(opts.curso);
  const paso = opts.paso === 2 ? 2 : 1;
  const link = opts.link || `https://urologia.ar/carrito/?add-to-cart=3740&mseq=rec${paso}`;
  if (paso === 2) {
    return {
      subject: 'hoy es un gran día para empezar',
      text:
        `${greeting(n)}\n\n` +
        `Todavía estás a tiempo de empezar ${curso}. Lo que cargaste ayer sigue guardado hasta esta noche; después lo podés retomar desde la página del curso.\n\n` +
        `Es el momento: entrás, elegís cómo pagar y arrancás hoy mismo:\n${link}\n\n` +
        `Lo que viniste a resolver ya tiene un camino armado, paso a paso. El primer módulo te espera.\n\n` +
        `Cualquier duda, respondeme este mail. Estoy del otro lado.\n\n` +
        `Abrazo,\n` +
        `Mauro\n`,
    };
  }
  return {
    subject: 'todavía estás a tiempo',
    text:
      `${greeting(n)}\n\n` +
      `Vi que empezaste tu inscripción a ${curso} y el pago quedó a mitad de camino. Pasa seguido al saltar a la plataforma de pago, y tiene arreglo fácil.\n\n` +
      `Todavía estás a tiempo, y es un gran momento para empezar: lo que dejaste cargado sigue ahí, esperándote, y en un minuto lo tenés resuelto:\n${link}\n\n` +
      `Cuanto antes empieces, antes vas a notar el cambio. Hoy puede ser ese día.\n\n` +
      `Si te trabó el medio de pago o te quedó una duda, respondeme este mail y lo resolvemos juntos.\n\n` +
      `Abrazo,\n` +
      `Mauro\n\n` +
      `PD: desde Argentina pagás en pesos por Mercado Pago, con cuotas.\n`,
  };
}

/**
 * Tier C (T12) — el test detectó red flags médicos: el caso merece consulta
 * individual antes que un programa. Redirige a Calendly. Plain text, firma "Mauro".
 */
export function buildMailTierC(name: string): SecuenciaMail {
  const n = (name || '').trim();
  return {
    subject: 'sobre tu test',
    text:
      `${greeting(n)}\n\n` +
      `Vi tus respuestas del test y quiero ser honesto con vos, porque para eso lo hiciste: por lo que me contás, tu caso merece una consulta individual antes que un programa. Hay cosas que corresponde revisar bien primero — y no te voy a ofrecer otra cosa cuando lo que necesitás es eso.\n\n` +
      `Podés agendar conmigo acá: https://calendly.com/urologocarrillo\n\n` +
      `Salís de esa consulta con un rumbo claro.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

/**
 * Mail de un paso encolado de la secuencia (lo llama el motor drip al enviar).
 *   track A: 1 → "¿la pudiste ver?" · 2 → "¿hace cuánto que estás con esto?"
 *   track B: 1 → "¿la pudiste ver?" (versión B)
 * step 0 = mail inmediato (sin datos del test: postest.ts usa buildMailA0/B0 con datos).
 */
export function buildSecuenciaMail(step: number, name: string, track: SeqTrack = 'A'): SecuenciaMail {
  const n = (name || '').trim();
  if (step === 0) return track === 'B' ? buildMailB0(n, null) : buildMailA0(n);
  if (track === 'B') {
    if (step === 1) return buildMailPudisteVer(n, 'B');
  } else {
    if (step === 1) return buildMailPudisteVer(n, 'A');
    if (step === 2) return buildMailA4(n);
  }
  throw new Error(`Paso de secuencia inválido: ${track}${step}`);
}

// ─── Cálculo de fechas (anclado al calendario de Argentina) ─────────
//
// Representamos cada "día ART" como un instante a las 12:00 UTC de esa fecha
// (= 09:00 ART, misma fecha de calendario en ambas zonas). Ese instante es el
// `sendAt` del mail: como el cron corre 13:00 UTC (10:00 ART), un mail marcado
// 12:00 UTC del día D se entrega SIEMPRE en la corrida de las 10:00 ART del día D
// (12:00 UTC ≤ 13:00 UTC). getUTCDay() sobre ese instante da el día de la semana
// ART correcto. Argentina no tiene horario de verano → offset fijo -3, sin edge.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Instante 12:00 UTC del día ART (y, m, d 0-based month). */
function artDay(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d, 12, 0, 0, 0));
}

/** Fecha ART (a las 12:00 UTC) correspondiente al instante `at`. */
function artDayOf(at: Date): Date {
  const art = new Date(at.getTime() + ART_OFFSET_HOURS * 60 * 60 * 1000);
  return artDay(art.getUTCFullYear(), art.getUTCMonth(), art.getUTCDate());
}

function addDays(day: Date, n: number): Date {
  return new Date(day.getTime() + n * DAY_MS);
}


/**
 * Fechas de los pasos encolados para un lead que hizo el test en `testAt`:
 * día ART del test + SECUENCIA_DIAS[track], cada uno a las 12:00 UTC (09:00 ART),
 * así sale en la corrida de las 10:00 ART de ese día.
 *   A → [día 1, día 4] · B → [día 3]
 */
export function computeSequenceDates(testAt: Date, track: SeqTrack = 'A'): Date[] {
  const base = artDayOf(testAt);
  return SECUENCIA_DIAS[track].map((d) => addDays(base, d));
}

/**
 * Variante de M1 según antigüedad del test al momento del enrolamiento.
 *   ≤ 7 días → 'A' (lead reciente) · 8+ días o fecha desconocida → 'B'.
 */
export function m1VariantForAge(testDate: Date | null, now: Date): MailVariant {
  if (!testDate || isNaN(testDate.getTime())) return 'B';
  const days = Math.floor((now.getTime() - testDate.getTime()) / DAY_MS);
  return days <= 7 ? 'A' : 'B';
}

/**
 * Parsea la fecha del test del Sheet. Tolera dd/mm/yyyy con hora opcional
 * (locale es-AR de Google Sheets, interpretado como hora ART) y formatos ISO. Devuelve
 * null si no se puede parsear (→ variante B por defecto).
 */
export function parseArgDate(raw: string): Date | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const hh = m[4] ? parseInt(m[4], 10) : 12;
    const mi = m[5] ? parseInt(m[5], 10) : 0;
    const ss = m[6] ? parseInt(m[6], 10) : 0;
    // hora ART (UTC-3) → sumamos 3 para el instante UTC
    const dt = new Date(Date.UTC(y, mo, d, hh - ART_OFFSET_HOURS, mi, ss));
    if (!isNaN(dt.getTime())) return dt;
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

/** Extrae la letra de tier (A/B/C) de un valor de la columna Pantalla. */
export function tierDePantalla(v: string): '' | 'A' | 'B' | 'C' {
  const m = (v || '').toUpperCase().match(/\b([ABC])\b/);
  return m ? (m[1] as 'A' | 'B' | 'C') : '';
}

// ─── Elegibilidad del enrolamiento del stock (pura, testeable) ──────

export interface StockRow {
  email: string;
  pantalla: string;
  estado: string;
  fecha: string;
  nombre: string;
}

export interface Elegible {
  email: string;
  nombre: string;
  variant: MailVariant;
}

export type DescarteRazon =
  | 'sin-email'
  | 'duplicado'
  | 'no-pantalla-a'
  | 'estado-no-vacio'
  | 'excluido-1a1'
  | 'cliente';

export interface ElegiblesResult {
  elegibles: Elegible[];
  descartes: Record<DescarteRazon, number>;
  totalRows: number;
  uniques: number;
}

/**
 * Calcula los elegibles del enrolamiento del stock (spec "Reglas de
 * implementación"). Filtros, en orden: email presente → email único (primera
 * fila) → Pantalla A → Estado vacío → no en exclusión 1-a-1 → no cliente.
 * La blacklist NO se chequea acá (es cara en bulk): se re-chequea antes de CADA
 * envío en el motor drip. `esCliente` se inyecta (predicado sync sobre el mapa).
 */
export function computeElegibles(
  rows: StockRow[],
  opts: { esCliente: (email: string) => boolean; now: Date }
): ElegiblesResult {
  const descartes: Record<DescarteRazon, number> = {
    'sin-email': 0,
    duplicado: 0,
    'no-pantalla-a': 0,
    'estado-no-vacio': 0,
    'excluido-1a1': 0,
    cliente: 0,
  };
  const seen = new Set<string>();
  const elegibles: Elegible[] = [];

  for (const row of rows) {
    const email = (row.email || '').trim().toLowerCase();
    if (!email) {
      descartes['sin-email']++;
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
    if (isSecuenciaExcluido(email)) {
      descartes['excluido-1a1']++;
      continue;
    }
    if (opts.esCliente(email)) {
      descartes.cliente++;
      continue;
    }

    const variant = m1VariantForAge(parseArgDate(row.fecha), opts.now);
    elegibles.push({ email, nombre: (row.nombre || '').trim(), variant });
  }

  return { elegibles, descartes, totalRows: rows.length, uniques: seen.size };
}

// ─── Fecha dd/mm en hora de Argentina (marca del Sheet CRM) ─────────

/** dd/mm del instante `d` en hora ART (UTC-3). Usado en las marcas del Sheet. */
export function fechaArgDDMM(d: Date): string {
  const art = new Date(d.getTime() + ART_OFFSET_HOURS * 60 * 60 * 1000);
  const dd = String(art.getUTCDate()).padStart(2, '0');
  const mm = String(art.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

// ─── Backfill Tier C → Calendly (T12): filtro puro y testeable ──────

export interface TierCRow {
  email: string;
  pantalla: string;
  estado: string;
  secuencia: string; // valor actual de la columna Secuencia del CRM
  nombre: string;
  rowIndex: number; // 1-based, para marcar la fila
}

export interface TierCCandidato {
  email: string;
  nombre: string;
  rowIndex: number;
}

export type TierCDescarteRazon = 'duplicado' | 'ya-enviado' | 'estado-no-vacio' | 'cliente';

export interface TierCResult {
  candidatos: TierCCandidato[];
  descartes: Record<TierCDescarteRazon, number>;
  tierCTotal: number; // filas tier C únicas (antes de descartes)
}

/** ¿La celda Secuencia ya registra el envío del mail C? */
export function tieneMailCEnviado(secuencia: string): boolean {
  return /mail\s*c\s*enviad/i.test(secuencia || '');
}

/**
 * Candidatos del backfill tier C: filas Pantalla C, email único, SIN "Mail C
 * enviado" en Secuencia, Estado vacío y NO cliente. La blacklist NO se filtra
 * acá (es IO cara): se re-chequea antes de CADA envío en el endpoint.
 * `esCliente` se inyecta (predicado sync sobre el mapa de clientes).
 */
export function computeTierCCandidates(
  rows: TierCRow[],
  opts: { esCliente: (email: string) => boolean }
): TierCResult {
  const descartes: Record<TierCDescarteRazon, number> = {
    duplicado: 0,
    'ya-enviado': 0,
    'estado-no-vacio': 0,
    cliente: 0,
  };
  const seen = new Set<string>();
  const candidatos: TierCCandidato[] = [];

  for (const row of rows) {
    const email = (row.email || '').trim().toLowerCase();
    if (!email) continue;
    if (tierDePantalla(row.pantalla) !== 'C') continue; // sólo tier C
    if (seen.has(email)) {
      descartes.duplicado++;
      continue;
    }
    seen.add(email);

    if (tieneMailCEnviado(row.secuencia)) {
      descartes['ya-enviado']++;
      continue;
    }
    if ((row.estado || '').trim() !== '') {
      descartes['estado-no-vacio']++;
      continue;
    }
    if (opts.esCliente(email)) {
      descartes.cliente++;
      continue;
    }

    candidatos.push({ email, nombre: (row.nombre || '').trim(), rowIndex: row.rowIndex });
  }

  return { candidatos, descartes, tierCTotal: seen.size };
}
