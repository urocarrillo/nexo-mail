# EPIC-01: Webhook Receiver (Google Sheet → API)

> **Subagente:** Puede ejecutarse en PARALELO con EPIC-02 y EPIC-03
> **Dependencias:** Ninguna
> **Output:** Endpoint `/api/webhook/sheet` + Google Apps Script

---

## Contexto

ManyChat guarda leads en Google Sheet con estas columnas:
- NOMBRE
- id de contacto  
- tiempo
- mail
- TAG (agregado manualmente para identificar origen)

Necesitamos detectar nuevas filas y enviar webhook a nuestra API.

---

## User Stories

### US-1.1: Detectar nuevo lead en Sheet
**Como** sistema  
**Quiero** detectar cuando se agrega una fila nueva en Google Sheet  
**Para** iniciar el proceso de automatización

### US-1.2: Enviar webhook a API
**Como** sistema  
**Quiero** enviar los datos del lead a la API de Vercel  
**Para** que se procese y agregue a Brevo

### US-1.3: Recibir y validar webhook
**Como** API  
**Quiero** recibir el webhook y validar que viene de nuestra Sheet  
**Para** evitar requests maliciosos

### US-1.4: Responder con confirmación
**Como** API  
**Quiero** confirmar la recepción del lead  
**Para** que el Apps Script sepa que se procesó

---

## Especificaciones Técnicas

### Google Apps Script (ejecuta en Sheet)

```javascript
// Archivo: scripts/google-apps-script.js
// INSTALAR: Extensions > Apps Script > pegar código

const WEBHOOK_URL = 'https://tu-app.vercel.app/api/webhook/sheet';
const API_SECRET = 'tu-secret-compartido';

function onEdit(e) {
  // Solo trigger en ediciones de la columna de mail (D)
  const sheet = e.source.getActiveSheet();
  const range = e.range;
  
  // Ignorar si no es la hoja principal o no es columna mail
  if (sheet.getName() !== 'Sheet1') return; // Ajustar nombre
  if (range.getColumn() !== 4) return; // Columna D = mail
  
  const row = range.getRow();
  if (row === 1) return; // Ignorar header
  
  const data = {
    nombre: sheet.getRange(row, 1).getValue(),
    idContacto: sheet.getRange(row, 2).getValue(),
    tiempo: sheet.getRange(row, 3).getValue(),
    mail: sheet.getRange(row, 4).getValue(),
    tag: sheet.getRange(row, 5).getValue() || 'general',
    row: row
  };
  
  // Validar que hay email
  if (!data.mail || !data.mail.includes('@')) return;
  
  sendWebhook(data);
}

function sendWebhook(data) {
  const payload = {
    ...data,
    timestamp: new Date().toISOString(),
    source: 'google-sheet'
  };
  
  const options = {
    method: 'POST',
    contentType: 'application/json',
    headers: {
      'X-API-Key': API_SECRET
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  try {
    const response = UrlFetchApp.fetch(WEBHOOK_URL, options);
    Logger.log('Webhook sent: ' + response.getContentText());
  } catch (error) {
    Logger.log('Webhook error: ' + error);
  }
}

// Trigger manual para probar
function testWebhook() {
  const testData = {
    nombre: 'Test User',
    idContacto: '123456',
    tiempo: new Date().toISOString(),
    mail: 'test@example.com',
    tag: 'test',
    row: 2
  };
  sendWebhook(testData);
}
```

### API Endpoint (Vercel)

```typescript
// src/app/api/webhook/sheet/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { addContactToBrevo } from '@/lib/brevo';

interface SheetWebhookPayload {
  nombre: string;
  idContacto: string;
  tiempo: string;
  mail: string;
  tag: string;
  row: number;
  timestamp: string;
  source: string;
}

export async function POST(request: NextRequest) {
  try {
    // 1. Validar API Key
    const apiKey = request.headers.get('X-API-Key');
    if (apiKey !== process.env.API_SECRET_KEY) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 2. Parsear body
    const payload: SheetWebhookPayload = await request.json();

    // 3. Validar campos requeridos
    if (!payload.mail || !payload.nombre) {
      return NextResponse.json(
        { error: 'Missing required fields: mail, nombre' },
        { status: 400 }
      );
    }

    // 4. Validar formato email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(payload.mail)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      );
    }

    // 5. Procesar: agregar a Brevo
    const brevoResult = await addContactToBrevo({
      email: payload.mail,
      nombre: payload.nombre,
      tag: payload.tag || 'general',
      idContacto: payload.idContacto,
      source: 'manychat-instagram'
    });

    // 6. Log para debugging
    console.log(`[WEBHOOK-SHEET] Lead procesado: ${payload.mail}, tag: ${payload.tag}`);

    // 7. Responder éxito
    return NextResponse.json({
      success: true,
      message: 'Lead processed successfully',
      data: {
        email: payload.mail,
        tag: payload.tag,
        brevoContactId: brevoResult.id
      }
    });

  } catch (error) {
    console.error('[WEBHOOK-SHEET] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Health check para el endpoint
export async function GET() {
  return NextResponse.json({ 
    status: 'ok', 
    endpoint: 'webhook/sheet' 
  });
}
```

### Types compartidos

```typescript
// src/lib/types.ts

export interface Lead {
  email: string;
  nombre: string;
  tag: string;
  idContacto: string;
  source: string;
  createdAt: string;
  status: 'new' | 'subscribed' | 'purchased';
  brevoContactId?: string;
}

export interface WebhookResponse {
  success: boolean;
  message: string;
  data?: Record<string, any>;
  error?: string;
}
```

---

## Criterios de Aceptación

- [ ] Apps Script se dispara cuando se agrega email en columna D
- [ ] Apps Script envía webhook con todos los campos (nombre, mail, tag, idContacto)
- [ ] API valida X-API-Key y rechaza requests sin ella (401)
- [ ] API valida campos requeridos (400 si faltan)
- [ ] API valida formato de email (400 si inválido)
- [ ] API llama a función de Brevo (integración EPIC-02)
- [ ] API responde 200 con datos del lead procesado
- [ ] API loguea cada lead para debugging

---

## Tests

```typescript
// tests/webhook-sheet.test.ts

import { POST, GET } from '@/app/api/webhook/sheet/route';
import { NextRequest } from 'next/server';

describe('Webhook Sheet Endpoint', () => {
  
  const validPayload = {
    nombre: 'Juan Pérez',
    idContacto: 'mc_123456',
    tiempo: '2026-02-03T10:00:00Z',
    mail: 'juan@example.com',
    tag: 'reel-fitness',
    row: 5,
    timestamp: '2026-02-03T10:00:01Z',
    source: 'google-sheet'
  };

  const createRequest = (body: any, apiKey?: string) => {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    if (apiKey) headers.set('X-API-Key', apiKey);
    
    return new NextRequest('http://localhost/api/webhook/sheet', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  };

  test('rechaza request sin API key', async () => {
    const req = createRequest(validPayload);
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  test('rechaza request con API key inválida', async () => {
    const req = createRequest(validPayload, 'wrong-key');
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  test('rechaza payload sin email', async () => {
    const req = createRequest(
      { ...validPayload, mail: '' },
      process.env.API_SECRET_KEY
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  test('rechaza email inválido', async () => {
    const req = createRequest(
      { ...validPayload, mail: 'no-es-email' },
      process.env.API_SECRET_KEY
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  test('procesa lead válido correctamente', async () => {
    const req = createRequest(validPayload, process.env.API_SECRET_KEY);
    const res = await POST(req);
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.email).toBe(validPayload.mail);
  });

  test('GET retorna health check', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
```

---

## Ralph Loop One-Shot

```
1. ✅ Leer esta épica completa
2. Crear archivo src/lib/types.ts
3. Crear archivo src/app/api/webhook/sheet/route.ts  
4. Crear archivo scripts/google-apps-script.js
5. Crear archivo tests/webhook-sheet.test.ts
6. Ejecutar: npm test -- webhook-sheet
7. Si FAIL → fix y volver a 6
8. Si PASS → EPIC-01 DONE ✅
```

---

## Configuración Post-Deploy

1. **En Google Sheet:**
   - Abrir Extensions > Apps Script
   - Pegar código de `scripts/google-apps-script.js`
   - Actualizar `WEBHOOK_URL` con URL de Vercel
   - Actualizar `API_SECRET` con el secret compartido
   - Guardar y autorizar permisos

2. **En Vercel:**
   - Agregar variable `API_SECRET_KEY` con el mismo valor

3. **Test manual:**
   - Ejecutar función `testWebhook()` desde Apps Script
   - Verificar logs en Vercel
