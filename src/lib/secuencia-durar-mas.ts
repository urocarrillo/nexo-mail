/**
 * Funnel "Durar más" (curso de eyaculación precoz, producto 3208) — mail de
 * entrega (ep0, inmediato) + secuencia v3 de 2 mails: ep1 (día 1, sin link) y
 * ep2 (día 4). La v2 (dm1..dm6, 24/07/2026) se retiró el 30/09/2026: 6 de 7
 * compras eran del día 0 y los mails de contenido no vendían (análisis en
 * OBSIDIAN/06-Procesos/embudos/embudo-durar-mas.md). El ep2 no sale si el lead
 * ya respondió y hubo gestión humana (Estado del CRM, ver estadoCortaDurarMas).
 *
 * Este módulo es PURO (sin IO), espejo de secuencia-post-typeform.ts: builders
 * de los mails y cálculo de fechas anclado al calendario de Argentina
 * (America/Argentina/Buenos_Aires, UTC-3 sin DST). El motor drip (email-drip.ts)
 * lo consume para encolar y enviar; el endpoint /api/form/durar-mas lo usa para
 * el mail de entrega inmediato.
 *
 * Copy fuente: OBSIDIAN/PROGRAMA y Producto/06-Procesos/secuencias-email/
 * durar-mas/secuencia-durar-mas-v3.md (editar allá primero, pegar acá).
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

// ─── Copy de los mails (v3, aprobada por Mauro 30/09/2026) ─────────
//
// Fuente: OBSIDIAN/PROGRAMA y Producto/06-Procesos/secuencias-email/durar-mas/
// secuencia-durar-mas-v3.md. Principio: la página explica y vende; el mail es
// simple y tiene un solo pedido. El saludo ("Hola Juan," / "Hola,") lo agrega
// el builder vía saludo(): el body arranca DESPUÉS del saludo. Atribución con
// sufijo ?mseq=ep0 (entrega) y ?mseq=ep2 (día 4); el ep1 va sin link.

const LANDING = 'https://urologia.ar/controla-tu-eyaculacion';

/** ep0 — entrega inmediata. Un solo pedido: que entre a la página. */
export const COPY_ENTREGA: MailCopy = {
  subject: 'acá está lo que pediste',
  body: `Acá está lo que pediste:
${LANDING}?mseq=ep0

Ahí está el método completo para durar más y cómo empezar hoy.

Abrazo,
Mauro`,
};

/** ep1 — día 1, seguimiento. Sin link: que cuente qué le pareció. */
export const COPY_M1: MailCopy = {
  subject: '¿la pudiste ver?',
  body: `Ayer te mandé la página del curso para durar más. ¿La pudiste ver?

Contame qué te pareció.

Abrazo,
Mauro`,
};

/** ep2 — día 4, seguimiento profundo: seguridad de buena compra + empezar hoy. */
export const COPY_M2: MailCopy = {
  subject: '¿qué te gustaría saber antes de entrar?',
  body: `Hace unos días te mandé la página del curso y ya sabés de qué se trata. Lo que queda es que estés seguro de que es una buena decisión, y para eso estoy acá: respondeme este mail con lo que te gustaría saber antes de entrar y te contesto yo.

¿Hace cuánto que te gustaría estar bien con esto? Empezando hoy mismo, lo podés lograr antes de lo que te imaginás:
${LANDING}?mseq=ep2

Abrazo,
Mauro`,
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

/**
 * Devuelve el mail de un paso de la secuencia durar-mas.
 * @param step 1..2 (ep1 día 1, ep2 día 4)
 * @param name nombre (fallback: undefined → "Hola,")
 */
export function buildDurarMasMail(step: number, name?: string): DurarMasMail {
  switch (step) {
    case 1:
      return mail1(name);
    case 2:
      return mail2(name);
    default:
      throw new Error(`Paso de secuencia durar-mas inválido: ${step}`);
  }
}

/**
 * ¿El Estado seguimiento del CRM corta los mails automáticos que faltan?
 * Cualquier Estado cargado significa que el lead respondió y hubo gestión
 * humana ("Respondido — …", "COMPRÓ", "Cerrado", "Contactado…"), salvo los
 * acuses triviales que /responder-mails registra como "Recibido — …" (un
 * "gracias" solo): esos siguen recibiendo la secuencia. Pedido de Mauro
 * 30/09/2026: quien responde el mail 0 o el 1 no recibe el 2.
 */
export function estadoCortaDurarMas(estado: string | null | undefined): boolean {
  const e = (estado || '').trim().toLowerCase();
  if (!e) return false;
  return !e.startsWith('recibido');
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

/** Offsets en días (desde el día ART del alta) de ep1 y ep2 (v3, 30/09/2026). */
export const DURARMAS_OFFSETS_DIAS: ReadonlyArray<number> = [1, 4];

/** Cantidad de pasos encolados (ep1, ep2). El ep0 es el mail inmediato del endpoint. */
export const DURARMAS_STEPS = DURARMAS_OFFSETS_DIAS.length;

/** Versión de secuencia grabada en cada entry de la cola; sin versión = legado dm1..dm6. */
export const DURARMAS_SEQ_VERSION = 3;

/**
 * Fechas de ep1 y ep2 para un lead que entra en `enrolledAt`: +1 y +4 días del
 * día ART del alta, entregados en la corrida del cron de las 10:00 ART.
 */
export function computeDurarMasDates(enrolledAt: Date): Date[] {
  const base = artDayOf(enrolledAt);
  return DURARMAS_OFFSETS_DIAS.map((n) => addDays(base, n));
}
