import { NextRequest, NextResponse } from 'next/server';

/**
 * Cron de reconciliación Mercado Pago ↔ WooCommerce.
 *
 * Problema que resuelve: la cola interna de notificaciones de MP a veces demora
 * o nunca entrega el aviso de pago aprobado, y el pedido queda en "pendiente"
 * sin mail, sin curso y sin Brevo (casos reales: #5501 y #5505, 24/08/2026).
 *
 * Qué hace cada corrida (cada 10 min via Vercel Cron):
 *  1. Busca pedidos WooCommerce en estado "pending" pagados con Mercado Pago,
 *     con más de 10 minutos y menos de 72 h de antigüedad.
 *  2. Para cada uno consulta el pago directo en la API de MP (por payment ID
 *     guardado en el pedido, o por external_reference "Curso-{id}").
 *  3. Si el pago está APROBADO → completa el pedido (dispara mail al cliente,
 *     enrolamiento LearnDash y Brevo por los hooks normales) y avisa por mail.
 *  4. Si el pago está EN MEDIACIÓN → NO toca el pedido, solo avisa por mail.
 *  5. Cualquier otro estado (pending/rejected/cancelled) → no hace nada.
 *
 * Auth: CRON_SECRET (header Authorization: Bearer …), igual que los otros crons.
 * Params: ?dry=1 solo reporta sin cambiar nada · ?test_email=1 manda un mail de
 * prueba del canal de aviso y termina.
 */

const WC_BASE = 'https://urologia.ar/wp-json/wc/v3';
const MP_BASE = 'https://api.mercadopago.com';
const ALERT_EMAIL = process.env.APPROVAL_EMAIL || '';
const MIN_EDAD_MIN = 10;
const MAX_EDAD_HORAS = 72;

interface WcOrder {
  id: number;
  status: string;
  date_created: string;
  payment_method: string;
  total: string;
  currency: string;
  billing: { first_name?: string; last_name?: string; email?: string };
  line_items: { name: string }[];
  meta_data?: { key: string; value: unknown }[];
}

interface MpPayment {
  id: number;
  status: string;
  status_detail?: string;
  external_reference?: string;
  transaction_amount?: number;
  currency_id?: string;
  date_approved?: string | null;
}

function wcAuth(): string {
  const user = process.env.WP_USER || '';
  const pass = process.env.WP_APP_PASSWORD || '';
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

async function wcFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${WC_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: wcAuth(),
      ...options.headers,
    },
  });
}

async function mpFetch(endpoint: string): Promise<Response> {
  return fetch(`${MP_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN || ''}` },
  });
}

/** Busca los pagos MP de un pedido: primero por payment ID guardado, si no por external_reference. */
async function pagosDelPedido(order: WcOrder): Promise<MpPayment[]> {
  const idsMeta = order.meta_data?.find((m) => m.key === '_Mercado_Pago_Payment_IDs');
  const ids = String(idsMeta?.value || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));

  if (ids.length > 0) {
    const pagos: MpPayment[] = [];
    for (const id of ids) {
      const res = await mpFetch(`/v1/payments/${id}`);
      if (res.ok) pagos.push((await res.json()) as MpPayment);
    }
    if (pagos.length > 0) return pagos;
  }

  const res = await mpFetch(
    `/v1/payments/search?external_reference=${encodeURIComponent(`Curso-${order.id}`)}&sort=date_created&criteria=desc`
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: MpPayment[] };
  return data.results || [];
}

async function enviarAviso(subject: string, text: string): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey || !ALERT_EMAIL) return false;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: { email: 'info@urologia.ar', name: 'Nexo-mail · Pagos' },
      to: [{ email: ALERT_EMAIL }],
      subject,
      textContent: text,
    }),
  });
  return res.status === 201;
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
    const ok = await enviarAviso(
      'Prueba: aviso de reconciliación MP',
      'Este es un mail de prueba del cron de reconciliación Mercado Pago ↔ WooCommerce.\n\nSi lo estás leyendo, el canal de aviso funciona: cuando el cron rescate un pedido trabado vas a recibir un mail como este con los datos de la venta.\n\n— Nexo-mail'
    );
    return NextResponse.json({ test_email: ok ? 'enviado' : 'fallo (revisar BREVO_API_KEY / APPROVAL_EMAIL)' });
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return NextResponse.json({ error: 'Falta MP_ACCESS_TOKEN' }, { status: 500 });
  }

  try {
    const res = await wcFetch('/orders?status=pending&per_page=30&orderby=date&order=desc');
    if (!res.ok) {
      return NextResponse.json({ error: `Woo orders ${res.status}` }, { status: 502 });
    }
    const pendientes = (await res.json()) as WcOrder[];

    const ahora = Date.now();
    const candidatos = pendientes.filter((o) => {
      if (!o.payment_method.startsWith('woo-mercado-pago')) return false;
      const edadMin = (ahora - new Date(o.date_created).getTime()) / 60000;
      return edadMin >= MIN_EDAD_MIN && edadMin <= MAX_EDAD_HORAS * 60;
    });

    const resultado: {
      completados: number[];
      en_mediacion: number[];
      sin_pago_aprobado: number[];
    } = { completados: [], en_mediacion: [], sin_pago_aprobado: [] };

    for (const order of candidatos) {
      const pagos = await pagosDelPedido(order);
      const aprobado = pagos.find((p) => p.status === 'approved');
      const enMediacion = pagos.find((p) => p.status === 'in_mediation');
      const cliente = `${order.billing.first_name || ''} ${order.billing.last_name || ''}`.trim();
      const producto = order.line_items.map((li) => li.name).join(', ');

      if (aprobado) {
        if (!dry) {
          const upd = await wcFetch(`/orders/${order.id}`, {
            method: 'PUT',
            body: JSON.stringify({ status: 'completed', transaction_id: String(aprobado.id) }),
          });
          if (!upd.ok) {
            await enviarAviso(
              `Fallo al completar pedido #${order.id} (pago MP aprobado)`,
              `El cron de reconciliación detectó el pago aprobado ${aprobado.id} para el pedido #${order.id} (${cliente}, ${order.total} ${order.currency}) pero WooCommerce devolvió error ${upd.status} al completarlo. Revisar a mano: https://urologia.ar/wp-admin/post.php?post=${order.id}&action=edit`
            );
            continue;
          }
          await wcFetch(`/orders/${order.id}/notes`, {
            method: 'POST',
            body: JSON.stringify({
              note: `Completado automáticamente por Nexo-mail: pago Mercado Pago ${aprobado.id} aprobado (${aprobado.date_approved || 's/f'}) pero la notificación de MP no había impactado en la tienda.`,
            }),
          });
          await enviarAviso(
            `Pedido #${order.id} completado automáticamente (pago MP aprobado)`,
            `El cron de reconciliación rescató un pedido trabado:\n\nPedido: #${order.id}\nCliente: ${cliente} (${order.billing.email || 's/email'})\nProducto: ${producto}\nMonto: ${order.total} ${order.currency}\nPago MP: ${aprobado.id} (aprobado ${aprobado.date_approved || 's/f'})\n\nLa notificación de Mercado Pago no había llegado a la tienda; el pedido fue completado y se dispararon el mail al cliente, el acceso al curso y Brevo.\n\nVer pedido: https://urologia.ar/wp-admin/post.php?post=${order.id}&action=edit\n\n— Nexo-mail`
          );
        }
        resultado.completados.push(order.id);
      } else if (enMediacion) {
        if (!dry) {
          await enviarAviso(
            `Pedido #${order.id}: pago de MP en mediación (no se tocó)`,
            `El cron de reconciliación encontró el pedido #${order.id} pendiente con su pago de Mercado Pago EN MEDIACIÓN (reclamo del comprador).\n\nCliente: ${cliente} (${order.billing.email || 's/email'})\nProducto: ${producto}\nMonto: ${order.total} ${order.currency}\nPago MP: ${enMediacion.id}\n\nNo se modificó nada: resolvé el reclamo desde el panel de Mercado Pago.\n\n— Nexo-mail`
          );
        }
        resultado.en_mediacion.push(order.id);
      } else {
        resultado.sin_pago_aprobado.push(order.id);
      }
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
