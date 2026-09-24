import { NextRequest, NextResponse } from 'next/server';
import {
  type CasoAcceso,
  type ResultadoPedido,
  type WcOrder,
  getOrder,
  listarPedidos,
  elegirPedido,
  pagoPorId,
  orderIdDeReferencia,
  resolverPedido,
  enviarAvisoInterno,
  enviarMailAlumno,
  nuevoCaso,
  guardarCaso,
  vincularCasoPedido,
  actualizarCaso,
  cerrarCaso,
  destinatariosCaso,
  nombresCursos,
  emailPedido,
  linkPedidoAdmin,
} from '@/lib/mp-pedidos';
import {
  buildMailRecibimos,
  buildMailYaActivo,
  buildMailPagoPendiente,
  buildMailSinPago,
  buildMailSinPedido,
} from '@/lib/mails-acceso';
import { corsHeaders, isOriginAllowed, clientIp, isRateLimited, validateEmail, errMsg } from '@/lib/public-form';

/**
 * POST /api/form/no-puedo-acceder — formulario público "No puedo acceder".
 *
 * Flujo (en este orden):
 *  1. Guarda el caso en KV (caso-acceso:{uuid}; caso-acceso:pedido:{orderId}
 *     cuando se identifica el pedido).
 *  2. Respuesta automática al alumno (email_compra + email_pago si difiere).
 *  3. Busca el pedido: por N.º de operación de MP (external_reference
 *     "Curso-{id}") o por búsqueda de pedidos por email.
 *  4. Resuelve: ya activo → mail de acceso · pending/on-hold MP → resolverPedido
 *     (completa si el pago está aprobado) · sin pedido → mail "lo reviso yo".
 *  5. Un solo aviso a Mauro con todo.
 *  6. Actualiza el caso y responde { ok, accion } sin datos sensibles.
 *
 * Body JSON: { nombre, email_compra, email_pago?, operacion?, mensaje?,
 * website? (honeypot) }.
 */

const ORIGEN = 'form no-puedo-acceder';
const RL = { prefix: 'rl:no-puedo-acceder:', max: 5, windowS: 600 };
const LOG = '[no-puedo-acceder]';

type AccionForm =
  | 'ya_activo'
  | 'completado'
  | 'pago_pendiente'
  | 'en_mediacion'
  | 'sin_pago'
  | 'pago_rechazado'
  | 'revisar_manual'
  | 'sin_pedido';

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, message: 'Formulario "No puedo acceder" activo.' });
}

/** Paso 3: pedido por N.º de operación de MP, si no por email (compra y pago). */
async function buscarPedido(caso: CasoAcceso): Promise<{ order: WcOrder | null; pagoOperacion?: ResultadoPedido['pago'] }> {
  if (caso.operacion && /^\d+$/.test(caso.operacion)) {
    const pago = await pagoPorId(caso.operacion);
    const id = pago ? orderIdDeReferencia(pago) : null;
    if (pago && id) {
      const order = await getOrder(id);
      if (order) return { order, pagoOperacion: pago };
    }
  }

  const candidatos: WcOrder[] = [];
  for (const email of destinatariosCaso(caso)) {
    const encontrados = await listarPedidos({ status: ['any'], search: email, perPage: 10 });
    for (const o of encontrados) {
      if (emailPedido(o) === email && !candidatos.some((c) => c.id === o.id)) candidatos.push(o);
    }
  }
  return { order: elegirPedido(candidatos) };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);
  const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, headers });

  if (!isOriginAllowed(origin)) return fail(403, 'Origin not allowed');
  const ip = clientIp(request);
  if (await isRateLimited(RL.prefix, ip, RL)) return fail(429, 'Too many requests');

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }

  // Honeypot: un bot lo completa; aceptamos en silencio.
  if (str(body.website)) return NextResponse.json({ ok: true }, { headers });

  const emailCompra = str(body.email_compra, 200).toLowerCase();
  if (!emailCompra || !validateEmail(emailCompra)) return fail(400, 'Email inválido');
  const emailPagoRaw = str(body.email_pago, 200).toLowerCase();
  const emailPago = emailPagoRaw && validateEmail(emailPagoRaw) && emailPagoRaw !== emailCompra ? emailPagoRaw : undefined;

  // 1. Caso en KV.
  const caso = nuevoCaso({
    nombre: str(body.nombre, 120),
    email_compra: emailCompra,
    email_pago: emailPago,
    operacion: str(body.operacion, 60) || undefined,
    mensaje: str(body.mensaje, 2000) || undefined,
    ip,
  });
  await guardarCaso(caso);

  // 2. Respuesta automática al alumno.
  const recibimos = buildMailRecibimos(caso.nombre);
  const autoRespuesta = await enviarMailAlumno(destinatariosCaso(caso), caso.nombre, recibimos.subject, recibimos.text);

  let accion: AccionForm = 'sin_pedido';
  let order: WcOrder | null = null;
  let resultado: ResultadoPedido | null = null;
  let mailAlumno = '(ninguno)';
  let error: string | undefined;

  try {
    // 3. Pedido.
    const busqueda = await buscarPedido(caso);
    order = busqueda.order;

    if (order) {
      await vincularCasoPedido(order.id, caso.id);
      const cursos = nombresCursos(order);
      const emailAcceso = emailPedido(order);

      // 4. Resolver.
      resultado = await resolverPedido(order, {
        origen: ORIGEN,
        pagos: busqueda.pagoOperacion ? [busqueda.pagoOperacion] : undefined,
      });

      if (resultado.accion === 'ya_completado') {
        accion = 'ya_activo';
        const mail = buildMailYaActivo({ nombre: caso.nombre, email: emailAcceso, cursos });
        await actualizarCaso(caso.id, { estado: 'resuelto', accion, resueltoPor: ORIGEN, orderId: order.id });
        const r = await enviarMailAlumno(destinatariosCaso(caso), caso.nombre, mail.subject, mail.text);
        mailAlumno = `"${mail.subject}" ${r.ok ? 'enviado' : `FALLÓ (${r.error})`}`;
      } else if (resultado.accion === 'completado') {
        accion = 'completado';
        // cerrarCaso manda "Listo, tu curso ya está activo", marca resuelto y
        // avisa a Mauro (con claim: si el webhook lo cerró antes, no duplica).
        const c = await cerrarCaso({ ...caso, orderId: order.id }, resultado.order, { origen: ORIGEN, accion });
        mailAlumno = c.cerrado ? '"Listo, tu curso ya está activo" enviado' : `(${c.motivo})`;
      } else if (resultado.accion === 'pago_pendiente') {
        accion = 'pago_pendiente';
        const mail = buildMailPagoPendiente({ nombre: caso.nombre, orderId: order.id });
        const r = await enviarMailAlumno(destinatariosCaso(caso), caso.nombre, mail.subject, mail.text);
        mailAlumno = `"${mail.subject}" ${r.ok ? 'enviado' : `FALLÓ (${r.error})`}`;
      } else if (resultado.accion === 'sin_pago' || resultado.accion === 'pago_rechazado') {
        accion = resultado.accion;
        const mail = buildMailSinPago({ nombre: caso.nombre, orderId: order.id });
        const r = await enviarMailAlumno(destinatariosCaso(caso), caso.nombre, mail.subject, mail.text);
        mailAlumno = `"${mail.subject}" ${r.ok ? 'enviado' : `FALLÓ (${r.error})`}`;
      } else {
        // en_mediacion / revisar_manual: no se toca el pedido; el alumno ya
        // recibió la respuesta automática ("te escribo yo personalmente").
        accion = resultado.accion;
      }
    } else {
      accion = 'sin_pedido';
      const mail = buildMailSinPedido(caso.nombre);
      const r = await enviarMailAlumno(destinatariosCaso(caso), caso.nombre, mail.subject, mail.text);
      mailAlumno = `"${mail.subject}" ${r.ok ? 'enviado' : `FALLÓ (${r.error})`}`;
    }
  } catch (err) {
    error = errMsg(err);
    accion = 'revisar_manual';
    console.error(LOG, 'error resolviendo caso', caso.id, error);
  }

  // 5. Aviso a Mauro (si el caso se cerró con cerrarCaso, ese aviso ya salió).
  if (accion !== 'completado') {
    const pago = resultado?.pago;
    const lineas = [
      accion === 'ya_activo' ? 'Resuelto automáticamente: el pedido ya estaba completado, se le mandó el mail de acceso.' : '',
      accion === 'sin_pedido' ? 'No se encontró ningún pedido con esos datos: hay que revisarlo a mano.' : '',
      accion === 'en_mediacion' ? 'Pago EN MEDIACIÓN: no se tocó el pedido, resolver desde el panel de MP.' : '',
      accion === 'revisar_manual' ? `Requiere revisión manual${resultado?.motivo ? `: ${resultado.motivo}` : ''}${error ? ` (error: ${error})` : ''}.` : '',
      accion === 'pago_pendiente' ? 'Pago en revisión en MP: el cron lo completa solo cuando se apruebe y le avisa al alumno.' : '',
      accion === 'sin_pago' || accion === 'pago_rechazado' ? 'Sin pago aprobado: se le pidió el comprobante al alumno.' : '',
      '',
      '— Formulario —',
      `Nombre: ${caso.nombre || '-'}`,
      `Email de compra: ${caso.email_compra}`,
      `Email de pago: ${caso.email_pago || '-'}`,
      `N.º de operación: ${caso.operacion || '-'}`,
      `Mensaje: ${caso.mensaje || '-'}`,
      `Caso: ${caso.id} · IP ${ip}`,
      `Respuesta automática: ${autoRespuesta.ok ? 'enviada' : `FALLÓ (${autoRespuesta.error})`}`,
      '',
      '— Pedido —',
      order
        ? [
            `#${order.id} · estado ${resultado?.order.status ?? order.status}`,
            `Producto: ${nombresCursos(order).join(', ') || '-'}`,
            `Billing email: ${emailPedido(order) || '-'}`,
            `Gateway: ${order.payment_method_title || order.payment_method || '-'}`,
            `Transaction ID: ${resultado?.order.transaction_id || order.transaction_id || '-'}`,
            `Monto: ${order.total} ${order.currency}`,
            `Ver pedido: ${linkPedidoAdmin(order.id)}`,
          ].join('\n')
        : 'No encontrado',
      '',
      '— Pago MP —',
      pago ? `${pago.id} · ${pago.status}${pago.status_detail ? ` (${pago.status_detail})` : ''}${pago.payer?.email ? ` · pagador ${pago.payer.email}` : ''}` : 'Sin pago asociado',
      resultado && resultado.pagos.length > 1 ? `Todos los pagos: ${resultado.pagos.map((p) => `${p.id}:${p.status}`).join(', ')}` : '',
      '',
      `Acción tomada: ${accion}`,
      `Mail al alumno: ${mailAlumno}`,
      '',
      '— Nexo-mail',
    ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '');
    await enviarAvisoInterno(`[Acceso] ${accion} — ${caso.email_compra}`, lineas.join('\n'));
  }

  // 6. Caso actualizado (cerrarCaso / ya_activo ya lo marcaron resuelto).
  if (accion !== 'completado' && accion !== 'ya_activo') {
    await actualizarCaso(caso.id, {
      // en_mediacion queda abierto: si la mediación se resuelve y el cron completa
      // el pedido, el alumno recibe el "Listo" solo.
      estado: accion === 'sin_pedido' || accion === 'revisar_manual' ? 'derivado' : 'abierto',
      accion,
      orderId: order?.id,
    });
  }

  return NextResponse.json({ ok: true, accion }, { headers });
}
