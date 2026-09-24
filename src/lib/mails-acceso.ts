/**
 * Mails de acceso a los cursos (post-compra y formulario "No puedo acceder").
 *
 * Módulo PURO (sin IO): builders de subject/text en plain-text, voz de Mauro
 * (rioplatense, cercano, sin "Dr."). El envío vive en mp-pedidos.ts.
 *
 * Todos los mails al alumno salen de mauro@ (mismo remitente que el dm0 del
 * funnel durar-mas) para que la respuesta con el comprobante llegue a Mauro.
 */
import { DURARMAS_SENDER_SECUENCIA } from './secuencia-durar-mas';

export const ACCESO_SENDER = DURARMAS_SENDER_SECUENCIA; // { Mauro Carrillo, mauro@urologia.ar }

export const MI_CUENTA_URL = 'https://urologia.ar/mi-cuenta';
export const NO_PUEDO_ACCEDER_URL = 'https://urologia.ar/no-puedo-acceder';

export interface MailAcceso {
  subject: string;
  text: string;
}

const FIRMA = `Un abrazo,
Mauro Carrillo, Urólogo
urologia.ar`;

/** "Hola Juan," / "Hola," — sólo el primer nombre. */
export function saludo(nombre?: string): string {
  const primero = (nombre || '').trim().split(/\s+/)[0] || '';
  return primero ? `Hola ${primero},` : 'Hola,';
}

/** `"Curso A"` / `"Curso A" y "Curso B"` / `"A", "B" y "C"`. */
function listaCursos(cursos: string[]): string {
  const c = cursos.map((n) => `"${n}"`);
  if (c.length === 0) return 'tu curso';
  if (c.length === 1) return c[0];
  return `${c.slice(0, -1).join(', ')} y ${c[c.length - 1]}`;
}

function bloqueAcceso(email: string): string {
  return `Cómo entrar:
1. Ingresá en ${MI_CUENTA_URL} con este mismo mail (${email}). Es el único con el que se puede entrar, aunque hayas pagado con otro correo en Mercado Pago o PayPal.
2. Si todavía no creaste tu contraseña, te llegó un mail de urologia.ar para crearla. Si no lo ves, revisá Spam o Promociones, o usá "¿Olvidaste la contraseña?" en Mi cuenta.
3. En "Mis cursos" tocá el curso y elegí el módulo para empezar.`;
}

/** D) Mail paralelo de bienvenida cuando el pedido pasa a completed. */
export function buildMailBienvenida(params: {
  nombre?: string;
  email: string;
  cursos: string[];
}): MailAcceso {
  const varios = params.cursos.length > 1;
  const nombres = listaCursos(params.cursos);
  return {
    subject: varios
      ? `Cómo entrar a tus cursos: ${params.cursos.join(', ')}`
      : `Cómo entrar a tu curso: ${params.cursos[0] || 'tu curso'}`,
    text: `${saludo(params.nombre)}

Tu compra ya está confirmada y ${varios ? `los cursos ${nombres} están activos. Son` : `el curso ${nombres} está activo. Es`} 100% online y se ${varios ? 'cursan' : 'cursa'} desde urologia.ar.

${bloqueAcceso(params.email)}

¿No ves el curso o no podés entrar? Completá este formulario y se resuelve en minutos: ${NO_PUEDO_ACCEDER_URL}

${FIRMA}`,
  };
}

/** Respuesta automática inmediata al formulario "No puedo acceder". */
export function buildMailRecibimos(nombre?: string): MailAcceso {
  return {
    subject: 'Recibimos tu consulta de acceso',
    text: `${saludo(nombre)}

Esta es una respuesta automática. Recibimos tu consulta y estamos revisando tu caso ahora mismo.

Si tu pago figura aprobado, el acceso se activa solo y te avisamos por este mismo medio en unos minutos. Si no, te escribo yo personalmente.

Mauro Carrillo, Urólogo
urologia.ar`,
  };
}

/** El pedido se completó recién (cron, verificación o formulario). */
export function buildMailListo(params: {
  nombre?: string;
  email: string;
  cursos: string[];
}): MailAcceso {
  const varios = params.cursos.length > 1;
  return {
    subject: varios ? 'Listo, tus cursos ya están activos' : 'Listo, tu curso ya está activo',
    text: `${saludo(params.nombre)}

Listo: tu pago ya figura aprobado y ${varios ? `los cursos ${listaCursos(params.cursos)} están activos` : `el curso ${listaCursos(params.cursos)} está activo`}.

${bloqueAcceso(params.email)}

Cualquier cosa, respondé este mail.

${FIRMA}`,
  };
}

/** El pedido ya estaba completed/processing: el problema es el login, no el pago. */
export function buildMailYaActivo(params: {
  nombre?: string;
  email: string;
  cursos: string[];
}): MailAcceso {
  const varios = params.cursos.length > 1;
  return {
    subject: varios ? 'Tus cursos ya están activos' : 'Tu curso ya está activo',
    text: `${saludo(params.nombre)}

${varios ? `Tus cursos ${listaCursos(params.cursos)} ya están activos` : `Tu curso ${listaCursos(params.cursos)} ya está activo`}: entrá en ${MI_CUENTA_URL} con el mail ${params.email}. Es el único con el que se puede entrar, aunque hayas pagado con otro correo.

Si no creaste tu contraseña, usá "¿Olvidaste la contraseña?" en Mi cuenta y revisá Spam o Promociones.

En "Mis cursos" tocá el curso y elegí el módulo para empezar.

Si aun así no podés entrar, respondé este mail y lo veo yo.

${FIRMA}`,
  };
}

/** Pago en revisión (pending / in_process / authorized). */
export function buildMailPagoPendiente(params: { nombre?: string; orderId: number }): MailAcceso {
  return {
    subject: 'Tu pago todavía está en revisión',
    text: `${saludo(params.nombre)}

Revisé tu pedido #${params.orderId}: el pago todavía figura en revisión en Mercado Pago/PayPal. Apenas se apruebe, el curso se activa solo y te avisamos por este mismo medio. No hace falta que vuelvas a pagar.

Si en 24 horas no te llegó nada, respondé este mail.

${FIRMA}`,
  };
}

/** Sin pago aprobado (no hay pago, o fue rechazado/cancelado). */
export function buildMailSinPago(params: { nombre?: string; orderId: number }): MailAcceso {
  return {
    subject: 'No encontramos un pago aprobado para tu pedido',
    text: `${saludo(params.nombre)}

Revisé tu pedido #${params.orderId} y no encontramos un pago aprobado. Si ya pagaste, respondé este mail con el comprobante (o el número de operación) y lo reviso yo.

${FIRMA}`,
  };
}

/** No se encontró ningún pedido con los datos del formulario. */
export function buildMailSinPedido(nombre?: string): MailAcceso {
  return {
    subject: 'No encontramos tu compra (la reviso yo)',
    text: `${saludo(nombre)}

No encontramos una compra con esos datos. Lo reviso personalmente y te escribo por acá.

Si tenés el comprobante de pago o el número de operación, respondé este mail y adjuntalo: eso acelera todo.

${FIRMA}`,
  };
}
