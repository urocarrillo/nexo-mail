import { NextRequest, NextResponse } from 'next/server';
import {
  type WcOrder,
  type ResultadoPedido,
  getOrder,
  listarPedidos,
  esPedidoMp,
  edadMinutos,
  resolverPedido,
  enviarAvisoInterno,
  cerrarCasoAccesoPorPedido,
  nombreCliente,
  nombresCursos,
  linkPedidoAdmin,
} from '@/lib/mp-pedidos';

/**
 * Cron de reconciliación Mercado Pago ↔ WooCommerce.
 *
 * Problema que resuelve: la cola interna de notificaciones de MP a veces demora
 * o nunca entrega el aviso de pago aprobado, y el pedido queda en "pendiente"
 * sin mail, sin curso y sin Brevo (casos reales: #5501, #5505, #5578).
 *
 * Qué hace cada corrida (Hostinger cada 10 min + Vercel diario de respaldo):
 *  1. Busca pedidos WooCommerce "pending" u "on-hold" pagados con Mercado Pago,
 *     con más de 2 minutos y menos de 72 h de antigüedad (edad por
 *     date_created_gmt: date_created viene en hora del sitio, UTC-3).
 *  2. Para cada uno resuelve el pago contra la API de MP (lib mp-pedidos).
 *  3. Pago APROBADO y sin mediación → completa el pedido (mail al cliente,
 *     LearnDash y Brevo por los hooks normales), avisa por mail y, si había un
 *     caso "No puedo acceder" abierto, le manda al alumno "Listo, tu curso ya
 *     está activo" y lo marca resuelto.
 *  4. Pago EN MEDIACIÓN → NO toca el pedido, solo avisa por mail.
 *  5. Cualquier otro estado (pending/rejected/cancelled) → no hace nada.
 *
 * Auth: CRON_SECRET (header Authorization: Bearer …), igual que los otros crons.
 * Params: ?dry=1 solo reporta sin cambiar nada · ?test_email=1 manda un mail de
 * prueba del canal de aviso y termina · ?order=ID procesa ese pedido puntual
 * saltando la ventana de edad (y no encadena vigilante/postconsulta/drip).
 */

const MIN_EDAD_MIN = 2;
const MAX_EDAD_HORAS = 72;
const ORIGEN = 'cron reconciliar-mp';

interface Resultado {
  completados: number[];
  en_mediacion: number[];
  sin_pago_aprobado: number[];
  errores: number[];
  casos_cerrados: string[];
}

async function procesarPedido(order: WcOrder, dry: boolean, resultado: Resultado): Promise<ResultadoPedido | null> {
  const cliente = nombreCliente(order);
  const producto = nombresCursos(order).join(', ');
  const emailCliente = order.billing.email || 's/email';

  let r: ResultadoPedido;
  try {
    r = await resolverPedido(order, { dry, origen: ORIGEN });
  } catch (err) {
    resultado.errores.push(order.id);
    await enviarAvisoInterno(
      `Fallo al completar pedido #${order.id} (pago MP aprobado)`,
      `El cron de reconciliación detectó un pago aprobado para el pedido #${order.id} (${cliente}, ${order.total} ${order.currency}) pero WooCommerce devolvió error al completarlo: ${err instanceof Error ? err.message : String(err)}. Revisar a mano: ${linkPedidoAdmin(order.id)}`
    );
    return null;
  }

  if (r.accion === 'completado') {
    resultado.completados.push(order.id);
    if (!dry && r.pago) {
      const aprobados = r.pagos.filter((p) => p.status === 'approved');
      const doble =
        aprobados.length > 1
          ? `\n\nATENCIÓN: hay ${aprobados.length} pagos aprobados para este pedido (${aprobados.map((p) => p.id).join(', ')}): posible cobro doble, revisar devolución en Mercado Pago.`
          : '';
      await enviarAvisoInterno(
        `Pedido #${order.id} completado automáticamente (pago MP aprobado)`,
        `El cron de reconciliación rescató un pedido trabado:\n\nPedido: #${order.id}\nCliente: ${cliente} (${emailCliente})\nProducto: ${producto}\nMonto: ${order.total} ${order.currency}\nPago MP: ${r.pago.id} (aprobado ${r.pago.date_approved || 's/f'})\n\nLa notificación de Mercado Pago no había llegado a la tienda; el pedido fue completado y se dispararon el mail al cliente, el acceso al curso y Brevo.${doble}\n\nVer pedido: ${linkPedidoAdmin(order.id)}\n\n— Nexo-mail`
      );
      const caso = await cerrarCasoAccesoPorPedido(r.order, { origen: ORIGEN });
      if (caso.cerrado && caso.casoId) resultado.casos_cerrados.push(caso.casoId);
    }
  } else if (r.accion === 'en_mediacion') {
    resultado.en_mediacion.push(order.id);
    if (!dry && r.pago) {
      await enviarAvisoInterno(
        `Pedido #${order.id}: pago de MP en mediación (no se tocó)`,
        `El cron de reconciliación encontró el pedido #${order.id} ${order.status} con su pago de Mercado Pago EN MEDIACIÓN (reclamo del comprador).\n\nCliente: ${cliente} (${emailCliente})\nProducto: ${producto}\nMonto: ${order.total} ${order.currency}\nPago MP: ${r.pago.id}\n\nNo se modificó nada: resolvé el reclamo desde el panel de Mercado Pago.\n\n— Nexo-mail`
      );
    }
  } else if (r.accion !== 'ya_completado') {
    resultado.sin_pago_aprobado.push(order.id);
  }
  return r;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const dry = params.get('dry') === '1';

  if (params.get('test_email') === '1') {
    const ok = await enviarAvisoInterno(
      'Prueba: aviso de reconciliación MP',
      'Este es un mail de prueba del cron de reconciliación Mercado Pago ↔ WooCommerce.\n\nSi lo estás leyendo, el canal de aviso funciona: cuando el cron rescate un pedido trabado vas a recibir un mail como este con los datos de la venta.\n\n— Nexo-mail'
    );
    return NextResponse.json({ test_email: ok ? 'enviado' : 'fallo (revisar BREVO_API_KEY)' });
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return NextResponse.json({ error: 'Falta MP_ACCESS_TOKEN' }, { status: 500 });
  }

  const resultado: Resultado = {
    completados: [],
    en_mediacion: [],
    sin_pago_aprobado: [],
    errores: [],
    casos_cerrados: [],
  };

  try {
    // Pedido puntual (?order=ID): sin ventana de edad, sin encadenar otros crons.
    const orderParam = params.get('order');
    if (orderParam) {
      const id = parseInt(orderParam, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return NextResponse.json({ error: 'order inválido' }, { status: 400 });
      }
      const order = await getOrder(id);
      if (!order) return NextResponse.json({ error: `Pedido #${id} no existe` }, { status: 404 });
      if (!esPedidoMp(order)) {
        return NextResponse.json({
          dry,
          pedido: id,
          estado: order.status,
          accion: 'revisar_manual',
          motivo: `gateway ${order.payment_method} (no Mercado Pago)`,
        });
      }
      const r = await procesarPedido(order, dry, resultado);
      return NextResponse.json({
        dry,
        pedido: id,
        estado: r?.order.status ?? order.status,
        accion: r?.accion ?? 'error',
        pago_id: r?.pago?.id ?? null,
        pago_status: r?.pago?.status ?? null,
        motivo: r?.motivo,
        ...resultado,
      });
    }

    const pendientes = await listarPedidos({ status: ['pending', 'on-hold'], perPage: 30 });

    const ahora = Date.now();
    const candidatos = pendientes.filter((o) => {
      if (!esPedidoMp(o)) return false;
      const edadMin = edadMinutos(o, ahora);
      return edadMin >= MIN_EDAD_MIN && edadMin <= MAX_EDAD_HORAS * 60;
    });

    for (const order of candidatos) {
      await procesarPedido(order, dry, resultado);
    }

    // Encadena el vigilante post-test: Hostinger dispara este cron cada 10 min y
    // Vercel Hobby no permite crons frecuentes. Esperamos como máximo 20 s; la
    // función del vigilante sigue corriendo del lado de Vercel aunque dejemos de
    // esperar (tiene su propio lock y presupuesto de tiempo).
    let vigilante = 'skip';
    if (!dry && cronSecret) {
      try {
        const base = process.env.PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';
        vigilante = await Promise.race([
          fetch(`${base}/api/cron/postest-vigilante`, {
            headers: { authorization: `Bearer ${cronSecret}` },
            signal: AbortSignal.timeout(55000),
          }).then((r) => `http ${r.status}`),
          new Promise<string>((resolve) => setTimeout(() => resolve('en curso (no esperado)'), 20000)),
        ]);
      } catch (e) {
        vigilante = `error ${e instanceof Error ? e.message : 'unknown'}`;
      }
    }

    // Embudo post-consulta Calendly: la cola de reservas se procesa el día del
    // turno (cupón + mail programado en Brevo). Mismo esquema: esperamos como
    // máximo 10 s; el cron tiene lock propio.
    let postconsulta = 'skip';
    if (!dry && cronSecret) {
      try {
        const base = process.env.PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';
        postconsulta = await Promise.race([
          fetch(`${base}/api/cron/postconsulta`, {
            headers: { authorization: `Bearer ${cronSecret}` },
            signal: AbortSignal.timeout(55000),
          }).then((r) => `http ${r.status}`),
          new Promise<string>((resolve) => setTimeout(() => resolve('en curso (no esperado)'), 10000)),
        ]);
      } catch (e) {
        postconsulta = `error ${e instanceof Error ? e.message : 'unknown'}`;
      }
    }

    // Cola drip (secuencias, rescate R2-R4): además del cron diario de Vercel
    // (13:00 UTC), entre las 13:00 y las 16:00 UTC (10 a 13 hora Argentina) cada
    // corrida de Hostinger dispara send-emails para drenar picos en varias
    // tandas (cap por corrida + lock propio del motor drip).
    let drip = 'skip';
    const hourUtc = new Date().getUTCHours();
    if (!dry && cronSecret && hourUtc >= 13 && hourUtc < 16) {
      try {
        const base = process.env.PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';
        drip = await Promise.race([
          fetch(`${base}/api/cron/send-emails`, {
            headers: { authorization: `Bearer ${cronSecret}` },
            signal: AbortSignal.timeout(55000),
          }).then((r) => `http ${r.status}`),
          new Promise<string>((resolve) => setTimeout(() => resolve('en curso (no esperado)'), 15000)),
        ]);
      } catch (e) {
        drip = `error ${e instanceof Error ? e.message : 'unknown'}`;
      }
    }

    return NextResponse.json({
      dry,
      pendientes_mp_revisados: candidatos.length,
      ...resultado,
      vigilante,
      postconsulta,
      drip,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
