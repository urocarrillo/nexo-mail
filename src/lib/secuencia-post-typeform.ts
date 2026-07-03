/**
 * Secuencia post-Typeform — 9 mails (M0, M1A/M1B, M2..M8).
 *
 * Spec de copy y reglas:
 *   06-Procesos/reportes/auditoria-jul2026/sprint1-mensajes/secuencia-post-typeform.md
 *
 * Este módulo es PURO (sin IO): builders de los mails, cálculo de fechas anclado
 * al calendario de Argentina (America/Argentina/Buenos_Aires, UTC-3 sin DST),
 * la lista de exclusión 1-a-1 y los predicados de elegibilidad. El motor drip
 * (email-drip.ts) lo consume para encolar y enviar; los tests cubren las partes
 * puras (fechas, exclusiones, skip por Estado).
 *
 * Mails "caseros" de mauro@ (plain text, firma "Mauro", sin branding HTML).
 * Los links ya vienen con ?m=sq0..sq8 en el copy — se respetan tal cual.
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

// ─── Builders de los mails ──────────────────────────────────────────

export type MailVariant = 'A' | 'B';
export interface SecuenciaMail {
  subject: string;
  text: string;
}

function greeting(name: string): string {
  return name ? `Hola ${name},` : 'Hola,';
}

function mail0(name: string): SecuenciaMail {
  return {
    subject: 'Buenas noticias',
    text:
      `${greeting(name)}\n\n` +
      `Vi tus respuestas del test. Hay un dato ahí que vale más que todo el resto: me contaste que en solitario tu erección funciona bien. Guardá ese dato — vamos a volver a él.\n\n` +
      `Te dejo el programa para que lo veas con calma:\n\n` +
      `${LANDING}/?m=sq0\n\n` +
      `Si te queda alguna pregunta, respondeme este mismo mail y lo conversamos.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

function mail1A(name: string): SecuenciaMail {
  return {
    subject: '¿lo pudiste ver?',
    text:
      `${greeting(name)}\n\n` +
      `Hace unos días completaste el test y te mandé el link del programa. ¿Lo pudiste ver?\n\n` +
      `Te pregunto porque en tus respuestas hay algo que vale la pena mirar de nuevo: en solitario funcionás bien. Pensá un segundo lo que eso significa. Tu cuerpo está sano. Lo que se enciende cuando estás con otra persona es un circuito que se aprendió — y todo lo que se aprende se puede entrenar.\n\n` +
      `Si ya lo viste y te quedó alguna pregunta, contestame este mail. Las leo todas.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

function mail1B(name: string): SecuenciaMail {
  return {
    subject: '¿lo pudiste ver?',
    text:
      `${greeting(name)}\n\n` +
      `Hace un tiempo completaste el test del programa y te mandé el link. Estas semanas estuve enfocado en los encuentros con pacientes y recién ahora retomo los mails — así que te escribo hoy: ¿lo pudiste ver?\n\n` +
      `Antes de que contestes, mirá de nuevo un dato tuyo: en el test me contaste que en solitario funcionás bien. Pensá lo que eso significa. Tu cuerpo está sano. Lo que se enciende cuando estás con otra persona es un circuito que se aprendió — y todo lo que se aprende se puede entrenar.\n\n` +
      `Si te quedó alguna pregunta, contestame este mail. Las leo todas.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

function mail2(name: string): SecuenciaMail {
  return {
    subject: 'la frase que me dijo un amigo',
    text:
      `${greeting(name)}\n\n` +
      `Tenía 18 años la primera vez que no se me paró. Y lo que vino después fue peor que esa noche: cada encuentro se convirtió en un examen. Yo entraba a la cama pensando "que funcione, que funcione" — y así no funciona nada.\n\n` +
      `Un amigo me dijo una frase que no me olvido más: "si no mejorás, vas a necesitar pastillas toda tu vida".\n\n` +
      `Se equivocó. No porque la cosa mejorara sola — sino porque entendí dónde estaba el problema de verdad. No era mi cuerpo. Era ese examen que yo mismo me tomaba cada vez.\n\n` +
      `Hoy me dedico a esto. Y cada vez que un paciente me describe esa sensación de entrar a la cama a rendir, sé exactamente de qué me está hablando.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

function mail3(name: string): SecuenciaMail {
  return {
    subject: 'tu cuerpo ya te dio la respuesta',
    text:
      `${greeting(name)}\n\n` +
      `Retomo el dato de tu test: en solitario, todo funciona. Eso es tu cuerpo diciéndote que el circuito físico está intacto.\n\n` +
      `Entonces, ¿qué pasa cuando hay otra persona? Se prende un sistema distinto: el de alerta. Tu cabeza se pone a observar, a anticipar, a medir. Y la erección necesita exactamente lo contrario — presencia, no vigilancia.\n\n` +
      `Eso es lo que el programa entrena durante 8 semanas: bajar el sistema de alerta y volver a estar presente. La erección vuelve por añadidura, porque nunca se fue: la tuya funciona, ya lo sabés.\n\n` +
      `Cuando quieras verlo en detalle:\n\n` +
      `${LANDING}/?m=sq3\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

function mail4(name: string): SecuenciaMail {
  return {
    subject: 'una palabra',
    text:
      `${greeting(name)}\n\n` +
      `Te hago una sola pregunta, y en serio me interesa la respuesta.\n\n` +
      `Hiciste el test, viste el programa. Si todavía no arrancaste, algo hay. Contestame este mail con una palabra:\n\n` +
      `precio — dudas — momento — otra\n\n` +
      `Con esa palabra me alcanza. Te respondo yo, puntualmente sobre lo tuyo, sin vueltas de vendedor.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

function mail5(name: string): SecuenciaMail {
  return {
    subject: 'cómo es por dentro',
    text:
      `${greeting(name)}\n\n` +
      `Te cuento cómo es el programa por dentro, así lo ves concreto:\n\n` +
      `8 semanas de trabajo, una por módulo. Videos y actividades de 15-30 minutos por día, a tu ritmo: nadie te corre, el acceso queda para vos. Herramientas descargables para cada semana. Y una consulta individual conmigo incluida, para revisar tu caso puntual cuando vos lo decidas.\n\n` +
      `Empezás hoy y en la primera semana ya estás trabajando con las primeras herramientas.\n\n` +
      `${LANDING}/?m=sq5\n\n` +
      `Cualquier pregunta, respondeme por acá.\n\n` +
      `Abrazo,\n` +
      `Mauro\n\n` +
      `PD: desde Argentina pagás en pesos por MercadoPago y tenés cuotas.\n`,
  };
}

function mail6(name: string): SecuenciaMail {
  return {
    subject: 'los findes se repiten',
    text:
      `${greeting(name)}\n\n` +
      `Domingo. Te escribo corto.\n\n` +
      `Los fines de semana van a seguir llegando, uno atrás de otro. La diferencia entre uno y el siguiente no la hace el calendario — la hace lo que vos entrenaste entre uno y otro.\n\n` +
      `Ocho semanas son dos meses de findes. Los que arrancaron hoy llegan distintos al noveno.\n\n` +
      `${LANDING}/?m=sq6\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

function mail7(name: string): SecuenciaMail {
  return {
    subject: 'esto es lo que te propongo',
    text:
      `${greeting(name)}\n\n` +
      `Te lo pongo simple, porque de esto estoy seguro.\n\n` +
      `El programa son 8 semanas para entrenar lo que hoy se te enciende en la cama: el sistema de alerta. Incluye los 8 módulos, las herramientas de cada semana y una consulta individual conmigo. Acceso inmediato, y queda para siempre.\n\n` +
      `Vos ya hiciste la parte más difícil: ponerle nombre a lo que te pasa. Tu propio test te lo mostró — en solitario funcionás bien, tu cuerpo está sano, lo que queda es entrenar la cabeza que te examina. Releé tus respuestas y contestate esta pregunta: ¿de verdad esto no es para vos?\n\n` +
      `${LANDING}/?m=sq7\n\n` +
      `Yo pongo el método y el seguimiento. Vos ponés el compromiso: 8 semanas.\n\n` +
      `Abrazo,\n` +
      `Mauro\n\n` +
      `PD: desde Argentina pagás en pesos por MercadoPago y tenés cuotas.\n`,
  };
}

function mail8(name: string): SecuenciaMail {
  return {
    subject: 'lo que sigue es tuyo',
    text:
      `${greeting(name)}\n\n` +
      `Ya te conté todo lo que tenía para contarte. Lo que sigue es tuyo — y así tiene que ser: esto funciona cuando el que decide sos vos.\n\n` +
      `Te dejo las dos puertas a mano.\n\n` +
      `Arrancar el programa hoy:\n` +
      `${LANDING}/?m=sq8\n\n` +
      `O verlo conmigo antes, en una consulta:\n` +
      `https://calendly.com/urologocarrillo\n\n` +
      `Y si el momento es otro, guardá este mail. El día que lo retomes, respondeme y seguimos desde acá.\n\n` +
      `Abrazo,\n` +
      `Mauro\n`,
  };
}

/**
 * Recupero de carrito (T9) — mail único disparado por una orden cancelled/pending
 * del programa 3740 (redirect fallido de MercadoPago). Copy aprobado por Mauro,
 * plain text, firma "Mauro". El link lleva ?m=rec1 para atribución.
 */
export function buildRecuperoMail(name: string): SecuenciaMail {
  const n = (name || '').trim();
  return {
    subject: 'se trabó tu inscripción',
    text:
      `${greeting(n)}\n\n` +
      `Vi que empezaste la inscripción al programa Controla tu Mente, Recupera tu Erección y el pago no llegó a completarse. Pasa seguido con el redirect de MercadoPago, así que quería asegurarme de que no te quedaras afuera por un tema técnico.\n\n` +
      `Si querés retomarla: https://urologia.ar/carrito/?add-to-cart=3740&m=rec1\n\n` +
      `Si fue el medio de pago, respondeme y lo resolvemos por otro lado. Y si te apareció una duda antes de confirmar, contame y la vemos.\n\n` +
      `Abrazo,\n` +
      `Mauro\n\n` +
      `PD: desde Argentina pagás en pesos por MercadoPago y tenés cuotas.\n`,
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
 * Devuelve el mail de un paso de la secuencia.
 * @param step 0..8 (0 = M0, 1 = M1, 2..8 = M2..M8)
 * @param name  nombre (fallback: "" → "Hola,")
 * @param variant sólo relevante para step 1 (M1A vs M1B)
 */
export function buildSecuenciaMail(
  step: number,
  name: string,
  variant: MailVariant = 'A'
): SecuenciaMail {
  const n = (name || '').trim();
  switch (step) {
    case 0:
      return mail0(n);
    case 1:
      return variant === 'B' ? mail1B(n) : mail1A(n);
    case 2:
      return mail2(n);
    case 3:
      return mail3(n);
    case 4:
      return mail4(n);
    case 5:
      return mail5(n);
    case 6:
      return mail6(n);
    case 7:
      return mail7(n);
    case 8:
      return mail8(n);
    default:
      throw new Error(`Paso de secuencia inválido: ${step}`);
  }
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

/** 0 = domingo … 6 = sábado (día de la semana ART). */
function dow(day: Date): number {
  return day.getUTCDay();
}

function firstSundayAfter(day: Date): Date {
  let d = addDays(day, 1);
  while (dow(d) !== 0) d = addDays(d, 1);
  return d;
}

/**
 * Dado M1 (un "día ART"), calcula M1..M8 según la cadencia del spec:
 *   M2 = primer domingo después de M1
 *   M3 = M2 + 2 días (martes)
 *   M4 = M3 + 3 días (viernes)   (spec dice +2-3; elegimos 3)
 *   M5 = M4 + 3 días (lunes)
 *   M6 = primer domingo después de M5 (segundo domingo)
 *   M7 = M6 + 2 días (martes)
 *   M8 = M7 + 3 días (viernes)
 * Devuelve 8 instantes (índice 0 = M1 … índice 7 = M8).
 */
export function computeSequenceDatesFromM1(m1: Date): Date[] {
  const M1 = artDay(m1.getUTCFullYear(), m1.getUTCMonth(), m1.getUTCDate());
  const M2 = firstSundayAfter(M1);
  const M3 = addDays(M2, 2);
  const M4 = addDays(M3, 3);
  const M5 = addDays(M4, 3);
  const M6 = firstSundayAfter(M5);
  const M7 = addDays(M6, 2);
  const M8 = addDays(M7, 3);
  return [M1, M2, M3, M4, M5, M6, M7, M8];
}

/**
 * Cadencia para un lead que entra por el webhook (nuevo o del stock reciente):
 *   M1 = enrolledAt + 2 días; si cae domingo → corre a lunes.
 * El resto se deriva con computeSequenceDatesFromM1.
 */
export function computeSequenceDates(enrolledAt: Date): Date[] {
  const base = artDayOf(enrolledAt);
  let m1 = addDays(base, 2);
  if (dow(m1) === 0) m1 = addDays(m1, 1); // domingo → lunes
  return computeSequenceDatesFromM1(m1);
}

/**
 * M1 para el enrolamiento del STOCK: "próximo día hábil 10:00 ART".
 * Regla (spec: "si se corre jueves/viernes, M1 = viernes"):
 *   - viernes  → mismo viernes
 *   - sábado   → lunes (+2)
 *   - domingo  → lunes (+1)
 *   - lunes..jueves → día siguiente (próximo día hábil)
 * Se entrega en la corrida de las 10:00 ART de ese día.
 */
export function computeStockM1(runAt: Date): Date {
  const base = artDayOf(runAt);
  switch (dow(base)) {
    case 5: // viernes
      return base;
    case 6: // sábado → lunes
      return addDays(base, 2);
    case 0: // domingo → lunes
      return addDays(base, 1);
    default: // lunes..jueves → día siguiente
      return addDays(base, 1);
  }
}

/** Fechas M1..M8 para el stock, ancladas al M1 = próximo día hábil. */
export function computeStockSequenceDates(runAt: Date): Date[] {
  return computeSequenceDatesFromM1(computeStockM1(runAt));
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
