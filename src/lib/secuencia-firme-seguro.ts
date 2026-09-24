/**
 * Funnel "Firme y Seguro" (curso Erección con Preservativo, producto 1043) —
 * mail de entrega + secuencia de 5 mails (fs1..fs5).
 *
 * Este módulo es PURO (sin IO), espejo de secuencia-durar-mas.ts: builders
 * de los mails y cálculo de fechas anclado al calendario de Argentina
 * (America/Argentina/Buenos_Aires, UTC-3 sin DST). El motor drip (email-drip.ts)
 * lo consume para encolar y enviar; el endpoint /api/form/firme-y-seguro lo usa
 * para el mail de entrega inmediato.
 *
 * Copy fuente: OBSIDIAN/PROGRAMA y Producto/06-Procesos/secuencias-email/
 * firme-y-seguro/secuencia-firme-y-seguro.md (editar allá primero, pegar acá).
 */

export const FIRMESEGURO_TAG = 'secuencia-firme-seguro';

// El mail de entrega sale "casero" de mauro@ (como los post-Typeform); la
// secuencia fs1..fs5 sale de info@ (nurture masivo, no quema al usuario).
export const FIRMESEGURO_SENDER_ENTREGA = { name: 'Mauro', email: 'mauro@urologia.ar' };
export const FIRMESEGURO_SENDER_SECUENCIA = {
  name: 'Urólogo Mauro Carrillo',
  email: 'info@urologia.ar',
};

export interface FirmeSeguroMail {
  subject: string;
  text: string;
}

interface MailCopy {
  subject: string;
  body: string;
}

// ─── Copy de los mails ──────────────────────────────────────────────
//
// Fuente: OBSIDIAN/PROGRAMA y Producto/06-Procesos/secuencias-email/
// firme-y-seguro/secuencia-firme-y-seguro.md. El saludo ("Hola Juan," /
// "Hola,") lo agrega el builder vía saludo(): el body arranca DESPUÉS del
// saludo. Atribución con sufijo ?mseq=fs0..fs5 en cada link.

const LANDING = 'https://urologia.ar/seguridad-en-la-intimidad';

export const COPY_ENTREGA: MailCopy = {
  subject: 'Acá tenés lo que pediste',
  body: `Dejaste tu email porque el momento del preservativo te está jugando en contra.

Eso tiene un camino concreto: entender por qué se baja justo ahí y entrenar ese momento con técnicas simples.

Armé el método completo, paso a paso. Está acá:

${LANDING}?mseq=fs0

Miralo con calma, sobre todo el temario.

Abrazo,
Mauro

PD. En dos días te escribo de nuevo: te voy a explicar el ciclo que hace que se baje justo cuando vas a ponértelo. Cuando lo veas, muchas cosas van a cerrar.`,
};

export const COPY_M1: MailCopy = {
  subject: 'Justo cuando vas a ponértelo, se baja',
  body: `"Solo funciona todo perfecto. El problema aparece cuando saco el preservativo."

Es de las frases que más escucho en consulta. Y tiene explicación física.

La erección necesita que tu sistema nervioso esté en calma. Ponerte el preservativo mete una pausa en el encuentro, y si en esa pausa aparece el miedo a que se baje, tu cuerpo entra en alerta: taquicardia, tensión, y la sangre deja de ir adonde tenía que ir.

Se baja. El miedo se confirma. La próxima vez llegás más nervioso a ese mismo momento, y el ciclo aprieta un poco más.

La parte buena: es de los cuadros que más rápido mejoran con entrenamiento, porque el problema vive en un momento muy puntual. Y ese momento se puede entrenar.

El método completo está acá:

${LANDING}?mseq=fs1

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. En el próximo mail te cuento por qué ponértelo a toda velocidad "antes de que se baje" lo empeora, y qué hacer en su lugar.`,
};

export const COPY_M2: MailCopy = {
  subject: 'Por qué ponértelo rápido no funciona',
  body: `Seguro ya probaste alguna de estas: ponértelo a toda velocidad antes de que se baje, pedirle a tu pareja que lo ponga mientras intentás no pensar, o directamente evitar el preservativo.

Y seguro notaste que el alivio dura poco.

Apurarte convierte la colocación en una carrera contra tu propia erección: más presión, más alerta, más chances de que se baje. Y evitarlo te deja expuesto a infecciones y embarazos no buscados, con la preocupación después dando vueltas en la cabeza.

Lo que funciona va para el otro lado: entrenar la colocación hasta que sea un movimiento automático, mantener los estímulos durante la pausa y regular tu sistema nervioso para que el cuerpo siga respondiendo.

Eso se entrena con un protocolo concreto. Es exactamente lo que hacemos en el curso:

${LANDING}?mseq=fs2

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. En unos días te muestro qué hay adentro, módulo por módulo. Hay uno sobre cómo incorporar el preservativo al juego que te va a cambiar la forma de verlo.`,
};

export const COPY_M3: MailCopy = {
  subject: 'Qué hay adentro del curso, módulo por módulo',
  body: `Esto es lo que vas a encontrar adentro, traducido a lo que te llevás:

- Por qué se baja con el preservativo y qué mantiene vivo el problema: entenderlo ya te saca un peso de encima.
- Cómo funciona tu erección y qué la corta: fisiología clara, sin tecnicismos.
- El círculo de la ansiedad de desempeño y cómo romperlo.
- Las claves para evitar la pérdida, antes y durante el encuentro.
- 7 pasos prácticos para el momento de la colocación.
- Qué hacer si se baja igual, la tuya o la de tu pareja, sin frustración.
- Cómo incorporar el preservativo al juego para que sume en vez de interrumpir.
- Consejos finales y un bonus para una vida íntima plena.

Lo que más me repiten los que lo hicieron: que es claro y práctico, y que dejaron de pelearse con el preservativo.

El detalle completo está acá:

${LANDING}?mseq=fs3

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. En el próximo mail respondo la duda más repetida: "¿y si lo mío es físico?"`,
};

export const COPY_M4: MailCopy = {
  subject: '¿Físico o mental? Cómo saberlo',
  body: `La duda que más aparece antes de empezar: "¿Y si lo mío es físico?"

Hay una pista simple. Si tenés erecciones normales al despertar, en la masturbación o en momentos sin presión, y falla justo con el preservativo o en pareja, el origen es casi siempre ansioso. Ahí el entrenamiento es el camino.

Si en cambio falla en todas las situaciones, también solo, o tenés factores de riesgo como diabetes, hipertensión o tabaquismo, lo primero es una consulta con un urólogo para evaluarlo.

La otra pregunta frecuente: "¿No es más fácil una pastilla?" Las pastillas pueden ser un apoyo puntual, pero mientras la ansiedad siga ahí, el problema vuelve con o sin fármaco. En el curso te muestro cómo reconocer tu caso y qué papel puede jugar cada cosa, para que decidas informado.

Mirá el temario completo acá:

${LANDING}?mseq=fs4

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. En el próximo mail te escribo por última vez sobre esto, con una cuenta simple que conviene hacer antes de decidir.`,
};

export const COPY_M5: MailCopy = {
  subject: 'Último mail (y una cuenta simple)',
  body: `Último mail de esta serie.

La cuenta que te debía: el curso cuesta 89 dólares, pago único. Las pastillas y las cremas se compran cada vez. El entrenamiento lo pagás una sola vez, y la seguridad queda con vos para cada encuentro que viene.

El otro camino ya lo conocés: seguir esquivando el preservativo, o llegar a ese momento con el corazón a mil esperando que esta vez sea distinto.

Las dos opciones cuestan algo. Una cuesta unas semanas de práctica. La otra cuesta seguir igual, con fecha abierta.

Si querés empezar, el método está acá:

${LANDING}?mseq=fs5

Abrazo,
Urólogo Mauro Carrillo
urologia.ar

PD. Acá termina la serie, pero el curso queda disponible. El día que decidas encararlo, este mismo link te va a estar esperando.`,
};

// ─── Builders ───────────────────────────────────────────────────────

/** Saludo con primer nombre: "Hola Juan," / "Hola," si no hay nombre. */
export function saludo(name?: string): string {
  const n = (name || '').trim();
  return n ? `Hola ${n},` : 'Hola,';
}

function renderMail(copy: MailCopy, name?: string): FirmeSeguroMail {
  return {
    subject: copy.subject,
    text: `${saludo(name)}\n\n${copy.body}\n`,
  };
}

export function mailEntrega(name?: string): FirmeSeguroMail {
  return renderMail(COPY_ENTREGA, name);
}

/**
 * Devuelve el mail de un paso de la secuencia firme-y-seguro.
 * @param step 1..5 (fs1..fs5)
 * @param name nombre (fallback: undefined → "Hola,")
 */
export function buildFirmeSeguroMail(step: number, name?: string): FirmeSeguroMail {
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
      throw new Error(`Paso de secuencia firme-y-seguro inválido: ${step}`);
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

/** Offsets en días (desde el día ART del alta) de fs1..fs5. */
export const FIRMESEGURO_OFFSETS_DIAS: ReadonlyArray<number> = [2, 4, 7, 10, 14];

/**
 * Fechas de fs1..fs5 para un lead que entra en `enrolledAt`:
 * +2, +4, +7, +10 y +14 días del día ART del alta, entregados en la corrida
 * del cron de las 10:00 ART de cada día.
 */
export function computeFirmeSeguroDates(enrolledAt: Date): Date[] {
  const base = artDayOf(enrolledAt);
  return FIRMESEGURO_OFFSETS_DIAS.map((n) => addDays(base, n));
}
