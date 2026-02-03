# PRD - Lead Automation System

## Índice de Documentos

| Documento | Descripción | Subagente |
|-----------|-------------|-----------|
| `EPIC-01-webhook-receiver.md` | Webhook Google Sheet → API | Paralelo ✅ |
| `EPIC-02-brevo-integration.md` | Integración con Brevo API | Paralelo ✅ |
| `EPIC-03-woocommerce-webhook.md` | Webhook WooCommerce compras | Paralelo ✅ |
| `EPIC-04-dashboard.md` | Dashboard de monitoreo | Después de API ⏳ |

---

## Resumen del Proyecto

**Objetivo:** Automatizar el flujo de leads desde Instagram hasta la venta de un programa educativo.

**Flujo:**
```
Instagram (comentario) → ManyChat → Google Sheet → [NUESTRA APP] → Brevo (emails)
                                                         ↑
WooCommerce (compra) ────────────────────────────────────┘ (stop emails)
```

---

## Stack Tecnológico

| Componente | Tecnología | Notas |
|------------|------------|-------|
| Captación | ManyChat | Ya configurado, Instagram |
| Datos | Google Sheets | Columnas: NOMBRE, id contacto, tiempo, mail, TAG |
| Backend | Vercel Functions | Node.js, serverless |
| Emails | Brevo | Secuencias diferenciadas por TAG |
| Venta | WooCommerce | PayPal + MercadoLibre |
| Curso | LearnDash | WordPress |
| Dashboard | React | Deploy en Vercel |

---

## Arquitectura

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Instagram  │───▶│  ManyChat   │───▶│Google Sheet │
│ (comentario)│    │             │    │  + TAG      │
└─────────────┘    └─────────────┘    └──────┬──────┘
                                             │
                                    Apps Script (onEdit)
                                             │
                                             ▼
┌─────────────┐    ┌─────────────────────────────────┐    ┌─────────────┐
│ WooCommerce │───▶│         VERCEL APP              │───▶│    Brevo    │
│  (compra)   │    │                                 │    │ (secuencias)│
└─────────────┘    │  /api/webhook/sheet     [POST]  │    └─────────────┘
                   │  /api/webhook/woocommerce[POST] │
                   │  /api/leads             [GET]   │
                   │  /api/health            [GET]   │
                   └─────────────────────────────────┘
                                  │
                                  ▼
                          ┌─────────────┐
                          │  Dashboard  │
                          │   (React)   │
                          └─────────────┘
```

---

## Variables de Entorno Requeridas

```env
# Brevo
BREVO_API_KEY=xkeysib-xxxxx

# Google Sheets
GOOGLE_SHEET_ID=1xxxxx
GOOGLE_SERVICE_ACCOUNT_EMAIL=xxx@xxx.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."

# WooCommerce
WOOCOMMERCE_WEBHOOK_SECRET=tu-secret-seguro

# App
API_SECRET_KEY=clave-para-validar-webhooks
```

---

## Secuencias de Email por TAG

| TAG en Sheet | Lista Brevo | Secuencia | Emails |
|--------------|-------------|-----------|--------|
| `reel-fitness` | lista-fitness | Secuencia A | 3 |
| `reel-nutricion` | lista-nutricion | Secuencia B | 2 |
| `story-promo` | lista-promo | Secuencia C | 1 |
| (sin tag) | lista-general | Secuencia Default | 2 |

*Nota: Ajustar TAGs según las campañas reales*

---

## Orden de Desarrollo

```
FASE 1 (Paralelo):
├── Subagente A → EPIC-01 (Webhook Receiver)
├── Subagente B → EPIC-02 (Brevo Integration)  
└── Subagente C → EPIC-03 (WooCommerce Webhook)

FASE 2 (Secuencial):
└── Subagente D → EPIC-04 (Dashboard) - requiere API funcionando
```

---

## Instrucciones para Claude Code

### Iniciar proyecto
```bash
npx create-next-app@latest lead-automation --typescript --tailwind --app --src-dir
cd lead-automation
```

### Estructura de carpetas objetivo
```
/lead-automation
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── webhook/
│   │   │   │   ├── sheet/route.ts      # EPIC-01
│   │   │   │   └── woocommerce/route.ts # EPIC-03
│   │   │   ├── leads/route.ts          # EPIC-04
│   │   │   └── health/route.ts
│   │   ├── dashboard/
│   │   │   └── page.tsx                # EPIC-04
│   │   └── page.tsx
│   ├── lib/
│   │   ├── brevo.ts                    # EPIC-02
│   │   ├── sheets.ts
│   │   └── types.ts
│   └── components/                      # EPIC-04
├── scripts/
│   └── google-apps-script.js           # EPIC-01
└── tests/
    ├── webhook-sheet.test.ts
    ├── brevo.test.ts
    └── woocommerce.test.ts
```

### Ralph Loop One-Shot (aplicar en cada épica)

```
LOOP:
1. Leer épica completa
2. Implementar TODO el código
3. Escribir tests
4. Ejecutar tests
5. Si FAIL → fix y volver a 4
6. Si PASS → marcar épica DONE
```

---

## Criterios de Éxito del Proyecto

- [ ] Lead nuevo en Sheet → email automático en < 60 segundos
- [ ] TAG diferente → secuencia diferente en Brevo
- [ ] Compra en WooCommerce → lead marcado como comprador, emails detenidos
- [ ] Dashboard muestra leads en tiempo real
- [ ] Deploy funcionando en Vercel
