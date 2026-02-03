# EPIC-03: WooCommerce Webhook (Compras → Stop Emails)

> **Subagente:** Puede ejecutarse en PARALELO con EPIC-01 y EPIC-02
> **Dependencias:** Usa `markAsPurchased` de EPIC-02 (puede mockear si EPIC-02 no está lista)
> **Output:** Endpoint `/api/webhook/woocommerce` + configuración en WordPress

---

## Contexto

Cuando un usuario compra el programa en WooCommerce (PayPal o MercadoLibre), necesitamos:
1. Recibir webhook de WooCommerce
2. Extraer email del comprador
3. Marcar como comprador en Brevo (detiene secuencias de venta)

WooCommerce está en WordPress con LearnDash, pagos via PayPal y MercadoPago.

---

## User Stories

### US-3.1: Recibir webhook de WooCommerce
**Como** sistema  
**Quiero** recibir notificación cuando se completa una orden  
**Para** saber que alguien compró

### US-3.2: Validar autenticidad del webhook
**Como** sistema  
**Quiero** verificar que el webhook viene realmente de WooCommerce  
**Para** evitar requests maliciosos

### US-3.3: Extraer datos del comprador
**Como** sistema  
**Quiero** obtener email y datos de la orden  
**Para** identificar al comprador

### US-3.4: Marcar como comprador
**Como** sistema  
**Quiero** actualizar el contacto en Brevo como comprador  
**Para** que se detengan los emails de venta

---

## Especificaciones Técnicas

### Webhook Payload de WooCommerce

WooCommerce envía este payload cuando una orden se completa:

```json
{
  "id": 12345,
  "status": "completed",
  "date_created": "2026-02-03T10:30:00",
  "total": "299.00",
  "billing": {
    "first_name": "Juan",
    "last_name": "Pérez",
    "email": "juan@example.com",
    "phone": "+5491155555555"
  },
  "line_items": [
    {
      "id": 1,
      "name": "Programa X",
      "product_id": 100,
      "quantity": 1,
      "total": "299.00"
    }
  ],
  "payment_method": "paypal",
  "payment_method_title": "PayPal"
}
```

### API Endpoint (Vercel)

```typescript
// src/app/api/webhook/woocommerce/route.ts

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { markAsPurchased } from '@/lib/brevo';

// Interface para el payload de WooCommerce
interface WooCommerceOrder {
  id: number;
  status: string;
  date_created: string;
  total: string;
  billing: {
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
  };
  line_items: Array<{
    id: number;
    name: string;
    product_id: number;
    quantity: number;
    total: string;
  }>;
  payment_method: string;
  payment_method_title: string;
}

/**
 * Verificar firma del webhook de WooCommerce
 * WooCommerce firma los webhooks con HMAC-SHA256
 */
function verifyWooCommerceSignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false;
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

export async function POST(request: NextRequest) {
  try {
    // 1. Obtener el body raw para verificar firma
    const rawBody = await request.text();
    
    // 2. Verificar firma de WooCommerce
    const signature = request.headers.get('x-wc-webhook-signature');
    const secret = process.env.WOOCOMMERCE_WEBHOOK_SECRET!;
    
    if (!verifyWooCommerceSignature(rawBody, signature, secret)) {
      console.error('[WOOCOMMERCE] Firma inválida');
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      );
    }
    
    // 3. Parsear el payload
    const order: WooCommerceOrder = JSON.parse(rawBody);
    
    // 4. Verificar que es una orden completada
    if (order.status !== 'completed') {
      console.log(`[WOOCOMMERCE] Orden ${order.id} ignorada, status: ${order.status}`);
      return NextResponse.json({
        success: true,
        message: 'Order status not completed, ignored',
        orderId: order.id
      });
    }
    
    // 5. Extraer email del comprador
    const buyerEmail = order.billing.email;
    if (!buyerEmail) {
      console.error('[WOOCOMMERCE] Orden sin email:', order.id);
      return NextResponse.json(
        { error: 'No billing email in order' },
        { status: 400 }
      );
    }
    
    // 6. Marcar como comprador en Brevo
    const brevoResult = await markAsPurchased(
      buyerEmail,
      order.id.toString()
    );
    
    // 7. Log detallado
    console.log(`[WOOCOMMERCE] Compra procesada:`, {
      orderId: order.id,
      email: buyerEmail,
      total: order.total,
      producto: order.line_items[0]?.name,
      paymentMethod: order.payment_method,
      brevoResult
    });
    
    // 8. Responder éxito
    return NextResponse.json({
      success: true,
      message: 'Purchase processed successfully',
      data: {
        orderId: order.id,
        email: buyerEmail,
        brevoUpdated: brevoResult.success
      }
    });
    
  } catch (error) {
    console.error('[WOOCOMMERCE] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Endpoint para verificar que WooCommerce puede conectarse
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    endpoint: 'webhook/woocommerce',
    message: 'WooCommerce webhook endpoint ready'
  });
}

// WooCommerce también hace un ping inicial con HEAD
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
```

### Configuración en WordPress/WooCommerce

**Paso 1: Agregar Webhook en WooCommerce**

1. WordPress Admin > WooCommerce > Settings > Advanced > Webhooks
2. Click "Add webhook"
3. Configurar:
   - Name: `Lead Automation - Order Completed`
   - Status: `Active`
   - Topic: `Order completed`
   - Delivery URL: `https://tu-app.vercel.app/api/webhook/woocommerce`
   - Secret: (generar uno seguro, guardar en Vercel como `WOOCOMMERCE_WEBHOOK_SECRET`)
   - API Version: `WP REST API Integration v3`

**Paso 2: Verificar que funciona**

1. WooCommerce envía un ping al guardar
2. Revisar logs en Vercel
3. Debería responder 200

---

## Criterios de Aceptación

- [ ] Endpoint responde 200 a GET y HEAD (health check)
- [ ] Rechaza requests sin firma válida (401)
- [ ] Ignora órdenes con status != "completed" (200 con mensaje)
- [ ] Extrae email correctamente del payload
- [ ] Llama a `markAsPurchased` con email y orderId
- [ ] Loguea toda la información relevante
- [ ] Maneja errores sin romper (500 con mensaje)
- [ ] Responde < 5 segundos (requisito de WooCommerce)

---

## Tests

```typescript
// tests/woocommerce.test.ts

import { POST, GET, HEAD } from '@/app/api/webhook/woocommerce/route';
import { NextRequest } from 'next/server';
import crypto from 'crypto';

describe('WooCommerce Webhook Endpoint', () => {
  
  const secret = process.env.WOOCOMMERCE_WEBHOOK_SECRET || 'test-secret';
  
  const validOrder = {
    id: 12345,
    status: 'completed',
    date_created: '2026-02-03T10:30:00',
    total: '299.00',
    billing: {
      first_name: 'Juan',
      last_name: 'Pérez',
      email: 'juan@example.com'
    },
    line_items: [{
      id: 1,
      name: 'Programa X',
      product_id: 100,
      quantity: 1,
      total: '299.00'
    }],
    payment_method: 'paypal',
    payment_method_title: 'PayPal'
  };
  
  const createSignature = (payload: string): string => {
    return crypto
      .createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('base64');
  };
  
  const createRequest = (body: any, includeSignature: boolean = true) => {
    const payload = JSON.stringify(body);
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    
    if (includeSignature) {
      headers.set('x-wc-webhook-signature', createSignature(payload));
    }
    
    return new NextRequest('http://localhost/api/webhook/woocommerce', {
      method: 'POST',
      headers,
      body: payload
    });
  };
  
  test('GET retorna health check', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.status).toBe('ok');
  });
  
  test('HEAD retorna 200', async () => {
    const res = await HEAD();
    expect(res.status).toBe(200);
  });
  
  test('rechaza request sin firma', async () => {
    const req = createRequest(validOrder, false);
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
  
  test('rechaza request con firma inválida', async () => {
    const payload = JSON.stringify(validOrder);
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('x-wc-webhook-signature', 'firma-invalida');
    
    const req = new NextRequest('http://localhost/api/webhook/woocommerce', {
      method: 'POST',
      headers,
      body: payload
    });
    
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
  
  test('ignora orden no completada', async () => {
    const pendingOrder = { ...validOrder, status: 'pending' };
    const req = createRequest(pendingOrder);
    const res = await POST(req);
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toContain('ignored');
  });
  
  test('procesa orden completada correctamente', async () => {
    const req = createRequest(validOrder);
    const res = await POST(req);
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.email).toBe('juan@example.com');
    expect(data.data.orderId).toBe(12345);
  });
  
  test('maneja orden sin email', async () => {
    const orderSinEmail = {
      ...validOrder,
      billing: { first_name: 'Juan', last_name: 'Pérez', email: '' }
    };
    const req = createRequest(orderSinEmail);
    const res = await POST(req);
    
    expect(res.status).toBe(400);
  });
});
```

---

## Ralph Loop One-Shot

```
1. ✅ Leer esta épica completa
2. Crear archivo src/app/api/webhook/woocommerce/route.ts
3. Crear archivo tests/woocommerce.test.ts
4. Agregar WOOCOMMERCE_WEBHOOK_SECRET a .env.local
5. Ejecutar: npm test -- woocommerce
6. Si FAIL → fix y volver a 5
7. Si PASS → EPIC-03 DONE ✅
```

---

## Configuración Post-Deploy

### 1. Generar Secret Seguro

```bash
openssl rand -base64 32
```

Guardar este valor como:
- `WOOCOMMERCE_WEBHOOK_SECRET` en Vercel
- En WooCommerce al crear el webhook

### 2. Crear Webhook en WooCommerce

WordPress Admin > WooCommerce > Settings > Advanced > Webhooks > Add webhook

| Campo | Valor |
|-------|-------|
| Name | Lead Automation - Order Completed |
| Status | Active |
| Topic | Order completed |
| Delivery URL | https://tu-app.vercel.app/api/webhook/woocommerce |
| Secret | (el que generaste) |
| API Version | WP REST API Integration v3 |

### 3. Test Manual

1. Crear orden de prueba en WooCommerce
2. Marcarla como "Completed"
3. Verificar logs en Vercel
4. Verificar que contacto se marcó como comprador en Brevo

---

## Troubleshooting

**Webhook no llega:**
- Verificar que la URL es accesible públicamente
- Revisar logs de WooCommerce (WooCommerce > Status > Logs)
- Verificar que el webhook está activo

**Error 401 (firma inválida):**
- Verificar que el secret es exactamente igual en ambos lados
- No debe tener espacios extra

**Orden no se procesa:**
- Verificar que el status es "completed"
- Revisar logs en Vercel Functions

**Brevo no se actualiza:**
- Verificar que EPIC-02 está implementada
- Verificar que el email existe en Brevo
