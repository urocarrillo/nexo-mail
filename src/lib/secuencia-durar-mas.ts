/**
 * Funnel "Durar más" (curso de eyaculación precoz, producto 3208) — mail de
 * entrega + secuencia de 6 mails (dm1..dm6). El dm6 sale sólo para quienes no
 * clickearon ningún mail anterior (filtro en el motor drip, email-drip.ts).
 *
 * Este módulo es PURO (sin IO), espejo de secuencia-post-typeform.ts: builders
 * de los mails y cálculo de fechas anclado al calendario de Argentina
 * (America/Argentina/Buenos_Aires, UTC-3 sin DST). El motor drip (email-drip.ts)
 * lo consume para encolar y enviar; el endpoint /api/form/durar-mas lo usa para
 * el mail de entrega inmediato.
 *
 * Copy fuente: OBSIDIAN/PROGRAMA y Producto/06-Procesos/secuencias-email/
 * durar-mas/secuencia-durar-mas.md (editar allá primero, pegar acá).
 */

export const DURARMAS_TAG = 'secuencia-durar-mas';

// Todo el funnel sale de mauro@ (decisión de Mauro 23/07/2026).
export const DURARMAS_SENDER_ENTREGA = { name: 'Mauro', email: 'mauro@urologia.ar' };
export const DURARMAS_SENDER_SECUENCIA = { name: 'Mauro Carrillo', email: 'mauro@urologia.ar' };

export interface DurarMasMail {
  subject: string;
  text: string;
}

interface MailCopy {
  subject: string;
  body: string;
}

// ─── Copy de los mails ──────────────────────────────────────────────
//
// Fuente: OBSIDIAN/PROGRAMA y Producto/06-Procesos/secuencias-email/durar-mas/
// secuencia-durar-mas.md. El saludo ("Hola Juan," / "Hola,") lo agrega el
// builder vía saludo(): el body arranca DESPUÉS del saludo. Atribución con
// sufijo ?mseq=dm0..dm6 en cada link.

const LANDING = 'https://urologia.ar/controla-tu-eyaculacion';

export const COPY_ENTREGA: MailCopy = {
  subject: 'Acá está lo que pediste (y una pregunta)',
  body: `Acá tenés lo que pediste: el método completo para entrenar el control y durar más, paso a paso.

${LANDING}?mseq=dm0

Antes de abrirlo, una pregunta: ¿hace cuánto venís con esto? ¿Meses? ¿Más? Casi nadie lleva esa cuenta, porque llevarla incomoda.

Hoy hiciste algo que corta esa inercia: dejaste tu email. El paso que sigue es igual de simple: abrí el link y mirá el temario. Fijate si te describe.

El curso es pregrabado: el día que entrás, empezás ese mismo día.

Abrazo,
Mauro

PD. En dos días te escribo con el ciclo exacto que hace que termines rápido. Cuando lo veas, vas a entender por qué se repite aunque le pongas toda tu voluntad.`,
};

export const COPY_M1: MailCopy = {
  subject: 'Cuanto más querés durar, más rápido terminás',
  body: `"Cuanto más me concentro en durar, más rápido termino."

Es la frase que más se repite cuando un hombre consulta por eyaculación precoz. Fijate si te suena.

Llegás al encuentro pensando en no terminar rápido. Tu cuerpo lee eso como peligro y activa el sistema de alerta: taquicardia, tensión, respiración corta. En ese estado, tu umbral de eyaculación baja. Terminás antes. El miedo se confirma. La próxima vez llegás peor.

Ahora, un dato: cerca del 30% de los hombres cree tener eyaculación precoz. Menos del 5% la tiene en el sentido clínico. La enorme mayoría está atrapada en este ciclo, comparándose con el porno. Si ese es tu caso, es una buena noticia: lo que se aprendió con repeticiones se reentrena con repeticiones.

¿Cuántas vueltas de ese ciclo llevás vos? Cada encuentro sin entrenar es una vuelta más. Los ejercicios que lo cortan, en orden y con progresión, están acá:

${LANDING}?mseq=dm1

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. En el próximo mail te cuento por qué lo que venís probando te alivia un rato y te deja en el mismo lugar.`,
};

export const COPY_M2: MailCopy = {
  subject: '¿Hace cuánto venís probando trucos?',
  body: `Pensar en otra cosa. Mirar para cualquier lado. Apurar el encuentro para sacarte la presión de encima.

Si ya probaste alguna de esas, hacé memoria: ¿hace cuánto empezaste? Esos trucos no se inventan la primera vez. Se acumulan con los meses, y son la señal de que esto viene ocupando lugar hace rato.

El problema es que todos hacen lo mismo: te desconectan del momento, pero tu cuerpo sigue acelerado y la ansiedad sigue ahí. Tapan el síntoma un rato. La causa queda intacta.

Lo que funciona es entrenar la respuesta: reconocer tus señales antes del punto de no retorno y regular tu sistema nervioso para quedarte en la zona donde disfrutás con control. Eso se entrena con ejercicios concretos y una progresión:

${LANDING}?mseq=dm2

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. En unos días te muestro el camino completo, paso por paso. Si sentís que ya sabés qué hacer pero no por dónde empezar, ese mail es para vos.`,
};

export const COPY_M3: MailCopy = {
  subject: 'Sabés qué hacer. Te falta el plan.',
  body: `Muchos hombres que consultan por eyaculación precoz ya leyeron de todo. Conocen los ejercicios, saben que la ansiedad influye. Y en la cama todo sigue igual, porque los consejos sueltos no arman un camino.

Lo que falta es el plan: qué hacer primero, cómo progresar, cuándo sumar a la pareja, cómo sostener los avances. El curso es ese plan, en 10 módulos y en orden:

- Primero entendés qué te pasa y qué mantiene vivo el problema.
- Después preparás la base: hábitos, expectativas, pareja.
- Después entrenás: ejercicios por niveles, con resultados en 4 a 12 semanas de práctica.
- Al final armás tu propio plan para sostenerlo.

Es pregrabado: entrás hoy, empezás hoy. Sin horarios y sin dar la cara.

"Hice tratamiento con otros urólogos pero nadie me explicó ni un poco de lo que se habla en este curso. Solo me dieron pastillas sin mirarme la cara." — D.L.

El temario completo está acá:

${LANDING}?mseq=dm3

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. En el próximo mail respondo la duda que más frena antes de empezar: qué pasa con las pastillas.`,
};

export const COPY_M4: MailCopy = {
  subject: '¿Pastilla o entrenamiento?',
  body: `La duda que más aparece antes de empezar: "¿No es más fácil una pastilla?"

Las pastillas y las cremas hacen su trabajo mientras las usás. Cuando las dejás, el control se va con ellas. El entrenamiento funciona distinto: lo que aprendés queda, porque el que cambia sos vos. Por eso el curso incluye un módulo de farmacología, informativo y sin vender nada, para que decidas sabiendo.

La otra duda: "¿Sirve para mi caso?" El método entrena lo mismo en todos: reconocer tus señales y regular tu respuesta. Funciona para la eyaculación precoz de toda la vida y para la que apareció después de años sin problemas.

"Es increíble cómo con conocimiento, entendiendo la fisiología y cómo abordar un encuentro, pude mejorar sin pastillas." — R.M.

Si tu duda es otra, contestame este mail y te respondo yo.

El temario completo está acá:

${LANDING}?mseq=dm4

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. El próximo es el último de la serie. Te llevo una cuenta hecha: la de los meses que ya pasaron y la de los que vienen.`,
};

export const COPY_M5: MailCopy = {
  subject: '¿Hace cuánto venís así?',
  body: `Último mail de esta serie. Te dejo una cuenta en dos partes.

Hacia atrás: ¿hace cuánto que cada encuentro es estar pendiente de no terminar? ¿Meses? ¿Años? Ese tiempo ya lo pagaste.

Hacia adelante: los ejercicios muestran resultados en 4 a 12 semanas de práctica. Empezando hoy, en uno o dos meses podés estar viviendo otra cosa en la cama. Cada semana que lo corras, corre también ese resultado.

Seguir igual también es una decisión. Solo que se toma sola, cada día que pasa sin hacer nada distinto.

"La claridad que tiene Mauro para explicar y empatizar te motiva a mejorar cada día. Es muy fácil de entender y con un poco de esfuerzo se puede mejorar." — F.A.

Vos ya sabés que hay que hacer algo. Lo supiste el día que dejaste tu email. Empezar es un click:

${LANDING}?mseq=dm5

Si algo todavía te frena, contestame este mail y te respondo yo.

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. Acá termina la serie, pero el curso queda disponible. Este link te va a estar esperando. La cuenta, mientras tanto, sigue corriendo.`,
};

export const COPY_M6: MailCopy = {
  subject: 'Lo que tu pareja completa en silencio',
  body: `Una de las frases que más escucho: "No sé cómo hablarlo con mi pareja."

Y mientras nadie lo nombra, pasan dos cosas: vos llegás a cada encuentro pendiente de aguantar, y tu pareja completa el silencio por su cuenta, casi siempre con una explicación peor que la real.

El curso tiene un módulo entero sobre esto: cómo hablarlo sin que se vuelva presión, cuándo sumar a tu pareja al entrenamiento, y cómo manejarlo si hoy no tenés pareja estable.

Está acá, junto con todo el resto:

${LANDING}?mseq=dm6

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. Este sí es el último de la serie. El curso queda disponible; si te quedó una duda puntual, contestame este mail y te respondo yo.`,
};

// ─── Builders ───────────────────────────────────────────────────────

/** Saludo con primer nombre: "Hola Juan," / "Hola," si no hay nombre. */
export function saludo(name?: string): string {
  const n = (name || '').trim();
  return n ? `Hola ${n},` : 'Hola,';
}

function renderMail(copy: MailCopy, name?: string): DurarMasMail {
  return {
    subject: copy.subject,
    text: `${saludo(name)}\n\n${copy.body}\n`,
  };
}

export function mailEntrega(name?: string): DurarMasMail {
  return renderMail(COPY_ENTREGA, name);
}

export function mail1(name?: string): DurarMasMail {
  return renderMail(COPY_M1, name);
}

export function mail2(name?: string): DurarMasMail {
  return renderMail(COPY_M2, name);
}

export function mail3(name?: string): DurarMasMail {
  return renderMail(COPY_M3, name);
}

export function mail4(name?: string): DurarMasMail {
  return renderMail(COPY_M4, name);
}

export function mail5(name?: string): DurarMasMail {
  return renderMail(COPY_M5, name);
}

export function mail6(name?: string): DurarMasMail {
  return renderMail(COPY_M6, name);
}

/**
 * Devuelve el mail de un paso de la secuencia durar-mas.
 * @param step 1..6 (dm1..dm6)
 * @param name nombre (fallback: undefined → "Hola,")
 */
export function buildDurarMasMail(step: number, name?: string): DurarMasMail {
  switch (step) {
    case 1:
      return mail1(name);
    case 2:
      return mail2(name);
    case 3:
      return mail3(name);
    case 4:
      return mail4(name);
    case 5:
      return mail5(name);
    case 6:
      return mail6(name);
    default:
      throw new Error(`Paso de secuencia durar-mas inválido: ${step}`);
  }
}

// ─── Cálculo de fechas (anclado al calendario de Argentina) ─────────
//
// Mismo esquema que secuencia-post-typeform (helpers privados allá → duplicados
// acá): cada "día ART" se representa como un instante a las 12:00 UTC de esa
// fecha (= 09:00 ART, misma fecha de calendario en ambas zonas). Como el cron
// corre 13:00 UTC (10:00 ART), un mail marcado 12:00 UTC del día D se entrega
// SIEMPRE en la corrida de las 10:00 ART del día D. Argentina no tiene horario
// de verano → offset fijo -3, sin edge.

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

/** Offsets en días (desde el día ART del alta) de dm1..dm6. */
export const DURARMAS_OFFSETS_DIAS: ReadonlyArray<number> = [2, 4, 7, 10, 12, 21];

/**
 * Fechas de dm1..dm6 para un lead que entra en `enrolledAt`:
 * +2, +4, +7, +10, +12 y +21 días del día ART del alta, entregados en la
 * corrida del cron de las 10:00 ART de cada día.
 */
export function computeDurarMasDates(enrolledAt: Date): Date[] {
  const base = artDayOf(enrolledAt);
  return DURARMAS_OFFSETS_DIAS.map((n) => addDays(base, n));
}
