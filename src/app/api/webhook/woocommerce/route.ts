import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { markAsPurchased } from '@/lib/brevo';
import { markLeadAsPurchased } from '@/lib/storage';
import { WooCommerceOrder, WebhookResponse } from '@/lib/types';

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

  // Only process completed orders
  if (order.status !== 'completed') {
    return NextResponse.json({
      success: true,
      message: `Order ${order.id} status is "${order.status}", skipping (only "completed" orders are processed)`,
    });
  }

  const email = order.billing.email.toLowerCase().trim();
  const orderId = order.id.toString();

  try {
    // Mark as purchased in Brevo
    const brevoResult = await markAsPurchased(email, orderId);

    // Update lead status in storage
    await markLeadAsPurchased(email, orderId);

    if (brevoResult.success) {
      return NextResponse.json({
        success: true,
        message: `Order ${orderId} processed - ${email} marked as purchased`,
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
