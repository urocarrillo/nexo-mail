/**
 * Funnel "Combo Experto en Intimidad" (programa DE 3740 + curso EP 3208 +
 * consulta 1-1, producto Woo 5243) — mail de entrega + secuencia de 5 mails
 * (ei1..ei5).
 *
 * Este módulo es PURO (sin IO), espejo de secuencia-durar-mas.ts: builders
 * de los mails y cálculo de fechas anclado al calendario de Argentina
 * (America/Argentina/Buenos_Aires, UTC-3 sin DST). El motor drip (email-drip.ts)
 * lo consume para encolar y enviar; el endpoint /api/form/experto-en-intimidad
 * lo usa para el mail de entrega inmediato.
 *
 * Copy fuente: OBSIDIAN/PROGRAMA y Producto/06-Procesos/secuencias-email/
 * experto-en-intimidad/secuencia-experto-en-intimidad.md (editar allá primero,
 * pegar acá).
 */

export const COMBO_TAG = 'secuencia-combo';

// Igual que durar-mas (decisión de Mauro 23/07/2026): entrega y secuencia
// salen las dos de mauro@ — la serie continúa la conversación del ei0.
export const COMBO_SENDER_ENTREGA = { name: 'Mauro', email: 'mauro@urologia.ar' };
export const COMBO_SENDER_SECUENCIA = { name: 'Mauro Carrillo', email: 'mauro@urologia.ar' };

export interface ComboMail {
  subject: string;
  text: string;
}

interface MailCopy {
  subject: string;
  body: string;
}

// ─── Copy de los mails ──────────────────────────────────────────────
//
// El saludo ("Hola Juan," / "Hola,") lo agrega el builder vía saludo(): el
// body arranca DESPUÉS del saludo. Atribución con sufijo ?mseq=ei0..ei5 en
// cada link.

const LANDING = 'https://urologia.ar/experto-en-intimidad';

export const COPY_ENTREGA: MailCopy = {
  subject: 'Acá tenés lo que pediste',
  body: `Dejaste tu correo porque querés resolver dos cosas: que la erección no te falle y durar más en la cama.

Las dos tienen la misma raíz, la ansiedad de desempeño. Por eso las trabajo juntas: un programa para la mente y la erección, un curso para entrenar el control eyaculatorio, y una consulta privada conmigo para ordenar tu caso.

El combo completo está explicado acá:

${LANDING}?mseq=ei0

Miralo con calma, sobre todo la parte de qué incluye cada acceso.

Un favor para no perdernos: si este mail te llegó a Spam o Promociones, movelo a tu bandeja principal y marcá mi dirección como segura.

Abrazo,
Mauro`,
};

export const COPY_M1: MailCopy = {
  subject: 'Dos problemas, una misma raíz',
  body: `En el mail anterior te dije que la erección que falla y la eyaculación rápida tienen la misma raíz. Hoy te explico por qué.

Tu erección necesita un sistema nervioso en calma para sostenerse. Tu control eyaculatorio también: cuando el cuerpo entra en alerta, el umbral para terminar baja. Y la ansiedad de desempeño enciende exactamente esa alerta: taquicardia, tensión, respiración corta.

Con el cuerpo en ese estado pasan las dos cosas a la vez: la sangre deja de sostener la erección y el reflejo de eyacular se dispara antes. Dos síntomas distintos, un mismo interruptor.

Por eso atacar uno solo suele fallar. Entrenás el control eyaculatorio, pero si llegás al encuentro con miedo a que la erección no responda, la alerta se enciende igual y arrastra todo. Sostenés la erección con una pastilla, pero la ansiedad sigue ahí y terminás más rápido. Es achicar agua sin tapar el agujero del bote.

El camino que funciona apaga el interruptor y entrena las dos respuestas a la vez. Así está armado el combo:

${LANDING}?mseq=ei1

Abrazo,
Mauro

PD. En el próximo mail te cuento cómo se vive tener las dos cosas juntas, un círculo que conozco de cerca. Yo también estuve ahí adentro.`,
};

export const COPY_M2: MailCopy = {
  subject: 'Te falla, te apurás, terminás antes',
  body: `Cuando la erección falla y encima terminás rápido, los encuentros se convierten en esto:

Llegás pendiente de que responda. Responde a medias, o responde y sentís que en cualquier momento se baja. Entonces te apurás: querés aprovecharla antes de perderla. Y apurado, con el cuerpo en alerta, terminás enseguida.

Te quedás con las dos frustraciones juntas y una idea dando vueltas: "otra vez". La próxima vez llegás más pendiente todavía, y el círculo aprieta un poco más.

Yo perdí mi primera erección a los 18 años. Sé lo que es llegar al encuentro siguiente esperando que no se repita, y lo que hace ese miedo con la cabeza. De ese lado del problema también estuve. Por eso hoy trabajo esto con un método, el mismo con el que he ayudado a cientos de pacientes en consulta.

Para cortar ese círculo hace falta entrenar la calma y el control, en orden. El camino completo está acá:

${LANDING}?mseq=ei2

Abrazo,
Mauro

PD. En el próximo mail te muestro el plan pieza por pieza: qué hace el programa, qué hace el curso y por qué la consulta privada ordena todo.`,
};

export const COPY_M3: MailCopy = {
  subject: 'El plan, pieza por pieza',
  body: `Te muestro cómo está armado el combo Experto en Intimidad y por qué son tres piezas.

1. Programa "Controla tu Mente, Recupera tu Erección". Ocho semanas de contenido en video para desarmar la ansiedad de desempeño desde la raíz: entender qué te pasa, regular tu sistema nervioso y volver a confiar en tu erección. Acá se apaga el interruptor del que te hablé.

2. Curso "Durá más". Diez módulos en video para entrenar el control eyaculatorio: reconocer tus señales antes del punto de no retorno y quedarte en la zona donde disfrutás con control, con ejercicios por niveles.

3. Consulta privada conmigo, uno a uno. Es la pieza que ordena todo: miramos tu caso puntual, definimos por dónde arrancar y qué priorizar según tu situación. Salís con un mapa para tu caso.

Las tres se complementan: el programa trabaja la raíz, el curso entrena el control, la consulta lo adapta a vos.

Todo es pregrabado y el acceso es inmediato y de por vida: entrás desde "Mis Cursos" en urologia.ar y empezás el mismo día. El detalle completo está acá:

${LANDING}?mseq=ei3

Abrazo,
Mauro

PD. En el próximo mail respondo las tres frases que más frenan antes de empezar: "ya probé cosas", "lo mío es físico" y "no tengo tiempo".`,
};

export const COPY_M4: MailCopy = {
  subject: 'Las tres frases que más frenan',
  body: `Antes de decidir, casi siempre aparece alguna de estas tres. Te las respondo cortas.

"Ya probé cosas." Trucos, pastillas sueltas, consejos de internet. Lo que casi nadie probó es un plan con orden: primero la raíz, después el entrenamiento, con una progresión y alguien que mire su caso. Piezas sueltas y camino completo dan resultados muy distintos.

"Lo mío es físico." Hay una pista simple: si tenés erecciones normales al despertar o cuando estás solo, y el problema aparece con otra persona, el origen es casi siempre ansioso. Si falla en todas las situaciones, o tenés diabetes, hipertensión o fumás, lo primero es una evaluación urológica. Y para tu caso puntual está la consulta privada del combo: la usamos para despejar exactamente esa duda.

"No tengo tiempo." Todo es pregrabado: lo mirás cuando podés, al ritmo que podés, y los ejercicios se integran a tu semana. El tiempo que hoy se te va en darle vueltas al problema alcanza de sobra.

Si tu duda es otra, contestame este mail y te respondo yo.

El combo está acá:

${LANDING}?mseq=ei4

Abrazo,
Mauro

PD. El próximo es el último mail de la serie.`,
};

export const COPY_M5: MailCopy = {
  subject: 'Último mail (la puerta queda abierta)',
  body: `Último mail de esta serie.

Te escribí estos días por una razón simple: la erección que falla y la eyaculación rápida comparten raíz, la ansiedad de desempeño, y por eso se entrenan juntas. El combo encara las dos: el programa trabaja la raíz, el curso entrena el control, la consulta privada lo ordena para tu caso.

No hay apuro de mi lado. El acceso es de por vida y todo es pregrabado: el día que decidas entrar, empezás ese mismo día. Lo único que sigue corriendo mientras tanto es lo tuyo: cada encuentro se juega con las mismas reglas de siempre hasta que algo cambie.

Si hay algo que todavía te frena, contestame este mail. Lo leo yo y te respondo yo.

Y si ya lo tenés claro, el camino empieza acá:

${LANDING}?mseq=ei5

Abrazo,
Mauro

PD. Acá termina la serie, pero el link queda disponible. El día que lo decidas, te va a estar esperando.`,
};

// ─── Builders ───────────────────────────────────────────────────────

/** Saludo con primer nombre: "Hola Juan," / "Hola," si no hay nombre. */
export function saludo(name?: string): string {
  const n = (name || '').trim();
  return n ? `Hola ${n},` : 'Hola,';
}

function renderMail(copy: MailCopy, name?: string): ComboMail {
  return {
    subject: copy.subject,
    text: `${saludo(name)}\n\n${copy.body}\n`,
  };
}

export function mailEntrega(name?: string): ComboMail {
  return renderMail(COPY_ENTREGA, name);
}

/**
 * Devuelve el mail de un paso de la secuencia del combo.
 * @param step 1..5 (ei1..ei5)
 * @param name nombre (fallback: undefined → "Hola,")
 */
export function buildComboMail(step: number, name?: string): ComboMail {
  switch (step) {
    case 1:
      return renderMail(COPY_M1, name);
    case 2:
      return renderMail(COPY_M2, name);
    case 3:
      return renderMail(COPY_M3, name);
    case 4:
      return renderMail(COPY_M4, name);
    case 5:
      return renderMail(COPY_M5, name);
    default:
      throw new Error(`Paso de secuencia combo inválido: ${step}`);
  }
}

// ─── Cálculo de fechas (anclado al calendario de Argentina) ─────────
//
// Mismo esquema que secuencia-durar-mas: cada "día ART" se representa como un
// instante a las 12:00 UTC de esa fecha (= 09:00 ART, misma fecha de calendario
// en ambas zonas). Como el cron corre 13:00 UTC (10:00 ART), un mail marcado
// 12:00 UTC del día D se entrega SIEMPRE en la corrida de las 10:00 ART del
// día D. Argentina no tiene horario de verano → offset fijo -3, sin edge.

const ART_OFFSET_HOURS = -3;
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

/** Offsets en días (desde el día ART del alta) de ei1..ei5. */
export const COMBO_OFFSETS_DIAS: ReadonlyArray<number> = [2, 4, 7, 10, 14];

/**
 * Fechas de ei1..ei5 para un lead que entra en `enrolledAt`:
 * +2, +4, +7, +10 y +14 días del día ART del alta, entregados en la corrida
 * del cron de las 10:00 ART de cada día.
 */
export function computeComboDates(enrolledAt: Date): Date[] {
  const base = artDayOf(enrolledAt);
  return COMBO_OFFSETS_DIAS.map((n) => addDays(base, n));
}
