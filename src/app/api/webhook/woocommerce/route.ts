import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { markAsPurchased } from '@/lib/brevo';
import { markLeadAsPurchased } from '@/lib/storage';
import { WooCommerceOrder, WebhookResponse } from '@/lib/types';
import { getAffiliate, logSale } from '@/lib/sheets-affiliates';
import { logSesion } from '@/lib/sheets-sesiones';
import { markClienteDurarMas } from '@/lib/sheets-durar-mas';
import { markClienteFirmeSeguro } from '@/lib/sheets-firme-seguro';
import { markClienteCombo } from '@/lib/sheets-combo';
import { sendAffiliateSaleNotification } from '@/lib/email-affiliate';
import { markClienteInCRM } from '@/lib/crm-sheet';
import { etiquetarCliente } from '@/lib/manychat';
import { cancelDripForEmail, enqueueRecupero } from '@/lib/email-drip';
import {
  clienteCellText,
  productosText,
  invalidateClientesCache,
  type ClienteInfo,
  type EstadoCliente,
} from '@/lib/clientes';
import { enviarBienvenida, cerrarCasoAccesoPorPedido } from '@/lib/mp-pedidos';
import { kv } from '@vercel/kv';

const PROGRAMA_DE_PRODUCT_ID = 3740;
const CURSO_EP_PRODUCT_ID = 3208;
const CURSO_PRESERVATIVO_PRODUCT_ID = 1043;
const COMBO_EI_PRODUCT_ID = 5243; // Combo Experto en Intimidad (programa + curso EP + consulta)
// Productos-curso con recupero de carrito (programa, EP, preservativo, combo, otros cursos).
const CURSO_PRODUCT_IDS = new Set([3740, 3208, 1043, 5243, 954, 2871]);

function verifyWooCommerceSignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64');

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  // Signatures must have the same length for timingSafeEqual
  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

function parseOrder(data: unknown): WooCommerceOrder | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const order = data as Record<string, unknown>;

  if (
    typeof order.id !== 'number' ||
    typeof order.status !== 'string' ||
    !order.billing ||
    typeof order.billing !== 'object'
  ) {
    return null;
  }

  const billing = order.billing as Record<string, unknown>;

  if (typeof billing.email !== 'string') {
    return null;
  }

  return {
    id: order.id,
    status: order.status,
    billing: {
      email: billing.email,
      first_name: (billing.first_name as string) || '',
      last_name: (billing.last_name as string) || '',
      phone: billing.phone as string | undefined,
    },
    line_items: (order.line_items as WooCommerceOrder['line_items']) || [],
    order_key: typeof order.order_key === 'string' ? order.order_key : undefined,
    meta_data: (order.meta_data as WooCommerceOrder['meta_data']) || [],
    total: (order.total as string) || '0',
    currency: (order.currency as string) || 'USD',
    date_created: (order.date_created as string) || new Date().toISOString(),
  };
}

// HEAD request for WooCommerce webhook verification
export async function HEAD(): Promise<NextResponse> {
  return new NextResponse(null, { status: 200 });
}

// GET request for testing
export async function GET(): Promise<NextResponse<WebhookResponse>> {
  return NextResponse.json({
    success: true,
    message: 'WooCommerce webhook endpoint is active. Use POST to process orders.',
  });
}

export async function POST(request: NextRequest): Promise<NextResponse<WebhookResponse>> {
  const secret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('WOOCOMMERCE_WEBHOOK_SECRET not configured');
    return NextResponse.json(
      { success: false, message: 'Server configuration error', error: 'Webhook secret not configured' },
      { status: 500 }
    );
  }

  // Get the raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get('x-wc-webhook-signature');

  // Verify signature
  if (!verifyWooCommerceSignature(rawBody, signature, secret)) {
    console.warn('Invalid WooCommerce webhook signature');
    return NextResponse.json(
      { success: false, message: 'Unauthorized', error: 'Invalid signature' },
      { status: 401 }
    );
  }

  // Parse the order
  let orderData: unknown;
  try {
    orderData = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON', error: 'Could not parse request body' },
      { status: 400 }
    );
  }

  const order = parseOrder(orderData);
  if (!order) {
    return NextResponse.json(
      { success: false, message: 'Invalid order data', error: 'Missing required fields' },
      { status: 400 }
    );
  }

  const email = order.billing.email.toLowerCase().trim();

  // Recupero de carrito (T9 v2): ~40% de las órdenes con MP se cancela en el
  // redirect y nadie las recontacta. Ante una orden cancelled/pending de un
  // curso encolamos R1 (+1 h, link de pago del pedido) y R2 (+20 h). El dedupe
  // por email (30 d), el skip-si-cliente y el re-chequeo (cliente, blacklist,
  // pedido ya pagado) viven en enqueueRecupero / el motor drip.
  const itemCurso = order.line_items.find((item) => CURSO_PRODUCT_IDS.has(item.product_id));
  if ((order.status === 'cancelled' || order.status === 'pending') && itemCurso) {
    try {
      const r = await enqueueRecupero({
        email,
        name: order.billing.first_name?.trim() || undefined,
        orderId: order.id.toString(),
        orderKey: order.order_key,
        productId: itemCurso.product_id,
        curso: itemCurso.name,
      });
      return NextResponse.json({
        success: true,
        message: `Order ${order.id} (${order.status}) → recupero ${
          r.enqueued ? 'encolado' : `skip (${r.reason})`
        }`,
      });
    } catch (err) {
      console.error('Recupero enqueue error (non-blocking):', err);
      return NextResponse.json({
        success: true,
        message: `Order ${order.id} (${order.status}) → recupero error (non-blocking)`,
      });
    }
  }

  // Only process completed orders
  if (order.status !== 'completed') {
    return NextResponse.json({
      success: true,
      message: `Order ${order.id} status is "${order.status}", skipping (only "completed" orders are processed)`,
    });
  }

  const orderId = order.id.toString();

  // Idempotencia: WP dispara order.updated varias veces por orden completada
  // (pago MP, enrolamiento LearnDash, notas). Procesar una sola vez por orden.
  const processedKey = `wc-processed:${orderId}`;
  try {
    if (await kv.get(processedKey)) {
      return NextResponse.json({
        success: true,
        message: `Order ${orderId} already processed, skipping duplicate delivery`,
      });
    }
  } catch { /* KV no disponible: seguir (logSesion tiene su propio dedupe) */ }

  try {
    // Extract product IDs for buyer-list assignment (cross-sell)
    const productIds = order.line_items.map(item => item.product_id);

    // Estado de cliente derivado de esta orden (filtro-cliente / T8).
    // El combo 5243 incluye el programa → cuenta como cliente-programa.
    const clienteInfo: ClienteInfo = {
      estado: (productIds.includes(PROGRAMA_DE_PRODUCT_ID) || productIds.includes(COMBO_EI_PRODUCT_ID)
        ? 'cliente-programa'
        : 'cliente-otro') as EstadoCliente,
      productos: productIds,
      fechaUltimaCompra: order.date_created,
    };
    const productos = productosText(clienteInfo);
    const fechaCompra = order.date_created;
    const clienteText = clienteCellText(clienteInfo);

    // Mark as purchased in Brevo (adds to list #18 + product-specific buyer lists
    // + lista Compradores 3740 si aplica) con atributos PRODUCTOS / FECHA_COMPRA.
    const brevoResult = await markAsPurchased(email, orderId, productIds, {
      productos,
      fechaCompra,
    });

    // Update lead status in storage
    await markLeadAsPurchased(email, orderId);

    // Marcar la columna Cliente + Estado "COMPRÓ" en el Sheet CRM (best-effort).
    try {
      const crmResult = await markClienteInCRM(email, clienteText);
      if (!crmResult.found) {
        console.log(`CRM: ${email} no está en el Sheet, no se marcó (esperado para compras directas)`);
      }
    } catch (crmErr) {
      console.error('CRM sheet marking error (non-blocking):', crmErr);
    }

    // Exit-on-purchase: cancelar mails pendientes del drip para este email.
    try {
      const { cancelled } = await cancelDripForEmail(email);
      if (cancelled > 0) console.log(`Drip: ${cancelled} mail(s) cancelado(s) para ${email} (compra)`);
    } catch (dripErr) {
      console.error('Drip cancel error (non-blocking):', dripErr);
    }

    // Invalidar la cache del mapa de clientes para que la compra se refleje ya.
    await invalidateClientesCache();

    // Mail paralelo de bienvenida ("Cómo entrar a tu curso") desde mauro@, una
    // vez por pedido (KV bienvenida:{orderId}). Best-effort: si Brevo falla se
    // loguea y se sigue; la marca se libera para reintentar en otra entrega.
    try {
      const bienvenida = await enviarBienvenida({
        orderId,
        email,
        nombre: order.billing.first_name?.trim() || undefined,
        cursos: order.line_items.map((item) => item.name).filter(Boolean),
      });
      console.log(`Bienvenida #${orderId}: ${bienvenida.enviado ? 'enviada' : `no enviada (${bienvenida.motivo})`}`);
    } catch (bienErr) {
      console.error('Bienvenida error (non-blocking):', bienErr);
    }

    // Si había un caso "No puedo acceder" abierto para este pedido (la
    // notificación de MP llegó después del formulario), cerrarlo: mail "Listo,
    // tu curso ya está activo" + aviso. Con claim en KV, no duplica al cron.
    try {
      const caso = await cerrarCasoAccesoPorPedido(
        { id: order.id, billing: order.billing, line_items: order.line_items },
        { origen: 'webhook woocommerce' }
      );
      if (caso.cerrado) console.log(`Caso de acceso ${caso.casoId} cerrado por webhook (#${orderId})`);
    } catch (casoErr) {
      console.error('Cierre de caso de acceso error (non-blocking):', casoErr);
    }

    // If buyer purchased Programa DE (o el combo, que incluye la consulta 1-1)
    // → log to Sesiones 1-1 sheet
    if (productIds.includes(PROGRAMA_DE_PRODUCT_ID) || productIds.includes(COMBO_EI_PRODUCT_ID)) {
      try {
        const nombre = `${order.billing.first_name} ${order.billing.last_name}`.trim();
        const fechaCompra = new Date(order.date_created).toLocaleDateString('es-AR');
        await logSesion({ nombre, email, fechaCompra });
      } catch (sesErr) {
        console.error('Sesiones sheet logging error (non-blocking):', sesErr);
      }
      // Etiqueta CLIENTE en el contacto de ManyChat (DM de IG/TikTok), best-effort.
      try {
        await etiquetarCliente(email);
      } catch (mcErr) {
        console.error('ManyChat CLIENTE error (non-blocking):', mcErr);
      }
    }

    // Si compró el curso EP (3208) o el combo (5243, que lo incluye) → marcar
    // Cliente en el Sheet de leads durar-mas (best-effort; nunca lanza).
    if (productIds.includes(CURSO_EP_PRODUCT_ID) || productIds.includes(COMBO_EI_PRODUCT_ID)) {
      try {
        const fechaEP = new Date(order.date_created).toLocaleDateString('es-AR');
        const textoEP = productIds.includes(COMBO_EI_PRODUCT_ID) ? `combo EI ${fechaEP}` : `curso EP ${fechaEP}`;
        await markClienteDurarMas(email, textoEP);
      } catch (dmErr) {
        console.error('Durar-mas sheet marking error (non-blocking):', dmErr);
      }
    }

    // Si compró el combo (5243), el programa (3740) o el curso EP (3208) →
    // marcar Cliente en el Sheet de leads del combo (best-effort; nunca lanza).
    if (
      productIds.includes(COMBO_EI_PRODUCT_ID) ||
      productIds.includes(PROGRAMA_DE_PRODUCT_ID) ||
      productIds.includes(CURSO_EP_PRODUCT_ID)
    ) {
      try {
        const fechaEI = new Date(order.date_created).toLocaleDateString('es-AR');
        const textoEI = productIds.includes(COMBO_EI_PRODUCT_ID)
          ? `combo Experto en Intimidad ${fechaEI}`
          : productIds.includes(PROGRAMA_DE_PRODUCT_ID)
            ? `programa DE ${fechaEI}`
            : `curso EP ${fechaEI}`;
        await markClienteCombo(email, textoEI);
      } catch (eiErr) {
        console.error('Combo sheet marking error (non-blocking):', eiErr);
      }
    }

    // Si compró el curso Erección con Preservativo (1043) → marcar Cliente en
    // el Sheet de leads firme-y-seguro (best-effort; nunca lanza).
    if (productIds.includes(CURSO_PRESERVATIVO_PRODUCT_ID)) {
      try {
        const fechaFS = new Date(order.date_created).toLocaleDateString('es-AR');
        await markClienteFirmeSeguro(email, `curso preservativo ${fechaFS}`);
      } catch (fsErr) {
        console.error('Firme-seguro sheet marking error (non-blocking):', fsErr);
      }
    }

    // Check for affiliate referrer (order meta from WP hook, OR KV from checkout JS pixel)
    const referrerMeta = order.meta_data.find((m) => m.key === '_referrer');
    let refCode = referrerMeta?.value || '';
    if (!refCode) {
      try {
        const kvRef = await kv.get<string>(`affiliate-ref:${email}`);
        if (kvRef) {
          refCode = kvRef;
          await kv.del(`affiliate-ref:${email}`);
        }
      } catch { /* KV lookup failed, continue without */ }
    }
    if (refCode) {
      try {
        const affiliate = await getAffiliate(refCode);
        if (affiliate) {
          const total = parseFloat(order.total) || 0;
          const commission = total * (affiliate.comision_pct / 100);

          await logSale({
            pedido: orderId,
            monto: total,
            codigo: affiliate.codigo,
            nombre: affiliate.nombre,
            comision: commission,
          });

          await sendAffiliateSaleNotification({
            orderId,
            total: order.total,
            currency: order.currency,
            affiliateCode: affiliate.codigo,
            affiliateName: affiliate.nombre,
            commission,
          });

          console.log(`Affiliate sale logged: ${affiliate.codigo} → $${commission.toFixed(2)}`);
        }
      } catch (affErr) {
        console.error('Affiliate tracking error (non-blocking):', affErr);
      }
    }

    try {
      await kv.set(processedKey, Date.now(), { ex: 60 * 60 * 24 * 90 });
    } catch { /* best-effort */ }

    if (brevoResult.success) {
      return NextResponse.json({
        success: true,
        message: `Order ${orderId} processed - ${email} marked as purchased${refCode ? ` (referrer: ${refCode})` : ''}`,
      });
    } else {
      console.warn(`Brevo update failed for ${email}:`, brevoResult.error);
      return NextResponse.json({
        success: true,
        message: `Order ${orderId} processed with warning: Brevo update failed`,
      });
    }
  } catch (error) {
    console.error('WooCommerce webhook processing error:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
