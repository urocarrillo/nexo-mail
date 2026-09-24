import { NextRequest, NextResponse } from 'next/server';
import {
  type MpPayment,
  getOrder,
  pagoPorId,
  orderIdDeReferencia,
  resolverPedido,
  enviarAvisoInterno,
  cerrarCasoAccesoPorPedido,
  nombreCliente,
  nombresCursos,
  emailPedido,
  emailAccesoPedido,
  linkPedidoAdmin,
} from '@/lib/mp-pedidos';
import { corsHeaders, isOriginAllowed, clientIp, isRateLimited, errMsg } from '@/lib/public-form';

/**
 * POST /api/pago/verificar — verificación del pago al volver de Mercado Pago.
 *
 * La página de "gracias" de WooCommerce lo llama desde el navegador con el
 * order_id + order_key de la URL (y el payment_id que MP agrega al volver).
 * Si el pedido sigue pending/on-hold y MP dice approved, lo completa ahí mismo
 * (misma lógica que el cron reconciliar-mp) y el alumno ve el curso sin
 * esperar la notificación de MP. Idempotente: un pedido ya completado devuelve
 * ya_completado sin tocar nada.
 *
 * Body JSON: { order_id, key, payment_id? } · Respuesta: { ok, estado, accion,
 * curso[], email (billing, donde fueron los mails), email_acceso (cuenta de
 * WordPress dueña del pedido, con la que se entra al curso) } · 404 genérico
 * si el order_key no coincide.
 */

const ORIGEN = 'verificación al volver de MP';
const RL = { prefix: 'rl:pago-verificar:', max: 20, windowS: 600 };

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);
  const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, headers });

  if (!isOriginAllowed(origin)) return fail(403, 'Origin not allowed');
  if (await isRateLimited(RL.prefix, clientIp(request), RL)) return fail(429, 'Too many requests');

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const orderId = Number.parseInt(String(body.order_id ?? ''), 10);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const paymentId = String(body.payment_id ?? '').trim();
  if (!Number.isFinite(orderId) || orderId <= 0 || !key || key.length > 64) {
    return fail(400, 'Datos inválidos');
  }

  try {
    const order = await getOrder(orderId);
    if (!order || !order.order_key || order.order_key !== key) return fail(404, 'No encontrado');

    // payment_id que vuelve de MP: sólo se usa si pertenece a este pedido.
    let pagos: MpPayment[] | undefined;
    if (/^\d+$/.test(paymentId)) {
      const pago = await pagoPorId(paymentId);
      if (pago && orderIdDeReferencia(pago) === order.id) pagos = [pago];
    }

    const r = await resolverPedido(order, { origen: ORIGEN, pagos });

    if (r.accion === 'completado' && r.pago) {
      await enviarAvisoInterno(
        `Pedido #${order.id} completado al volver de MP (pago aprobado)`,
        `El alumno volvió de Mercado Pago y la verificación completó el pedido antes que la notificación de MP:\n\nPedido: #${order.id}\nCliente: ${nombreCliente(order)} (${emailPedido(order) || 's/email'})\nProducto: ${nombresCursos(order).join(', ')}\nMonto: ${order.total} ${order.currency}\nPago MP: ${r.pago.id} (aprobado ${r.pago.date_approved || 's/f'})\n\nVer pedido: ${linkPedidoAdmin(order.id)}\n\n— Nexo-mail`
      );
      await cerrarCasoAccesoPorPedido(r.order, { origen: ORIGEN });
    }

    return NextResponse.json(
      {
        ok: true,
        estado: r.order.status,
        accion: r.accion,
        curso: nombresCursos(order),
        email: emailPedido(order),
        email_acceso: await emailAccesoPedido(order),
      },
      { headers }
    );
  } catch (err) {
    console.error('[pago/verificar] error:', errMsg(err));
    return fail(502, 'Error al verificar');
  }
}
