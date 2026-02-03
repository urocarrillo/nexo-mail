# EPIC-04: Dashboard de Monitoreo

> **Subagente:** Ejecutar DESPUÉS de que EPIC-01, 02, 03 estén completas
> **Dependencias:** API funcionando (endpoints de EPIC-01 y EPIC-03)
> **Output:** Dashboard en `/dashboard` + endpoint `/api/leads`

---

## Contexto

Necesitamos un dashboard simple para:
1. Ver leads capturados
2. Ver su estado (nuevo, suscrito, comprador)
3. Ver métricas básicas
4. Monitorear el sistema

---

## User Stories

### US-4.1: Ver lista de leads
**Como** usuario  
**Quiero** ver todos los leads capturados  
**Para** saber quiénes están en el embudo

### US-4.2: Filtrar por estado
**Como** usuario  
**Quiero** filtrar leads por estado (nuevo, suscrito, comprador)  
**Para** ver conversiones

### US-4.3: Ver métricas
**Como** usuario  
**Quiero** ver estadísticas (total leads, conversiones, por tag)  
**Para** medir el rendimiento

### US-4.4: Ver actividad reciente
**Como** usuario  
**Quiero** ver los últimos leads y compras  
**Para** monitorear en tiempo real

---

## Especificaciones Técnicas

### Almacenamiento de Leads

Opción simple: Vercel KV (Redis) para almacenar estado de leads.

```typescript
// src/lib/storage.ts

import { kv } from '@vercel/kv';

export interface StoredLead {
  email: string;
  nombre: string;
  tag: string;
  idContacto: string;
  status: 'new' | 'subscribed' | 'purchased';
  createdAt: string;
  updatedAt: string;
  brevoContactId?: string;
  orderId?: string;
  purchasedAt?: string;
}

// Guardar lead
export async function saveLead(lead: StoredLead): Promise<void> {
  const key = `lead:${lead.email}`;
  await kv.set(key, lead);
  
  // Agregar a índice por fecha
  await kv.zadd('leads:byDate', {
    score: new Date(lead.createdAt).getTime(),
    member: lead.email
  });
  
  // Agregar a índice por tag
  await kv.sadd(`leads:tag:${lead.tag}`, lead.email);
  
  // Agregar a índice por status
  await kv.sadd(`leads:status:${lead.status}`, lead.email);
}

// Actualizar status
export async function updateLeadStatus(
  email: string,
  status: StoredLead['status'],
  extra?: Partial<StoredLead>
): Promise<void> {
  const key = `lead:${email}`;
  const lead = await kv.get<StoredLead>(key);
  
  if (!lead) return;
  
  // Remover del índice anterior
  await kv.srem(`leads:status:${lead.status}`, email);
  
  // Actualizar lead
  const updated: StoredLead = {
    ...lead,
    ...extra,
    status,
    updatedAt: new Date().toISOString()
  };
  
  await kv.set(key, updated);
  
  // Agregar al nuevo índice
  await kv.sadd(`leads:status:${status}`, email);
}

// Obtener lead por email
export async function getLead(email: string): Promise<StoredLead | null> {
  return kv.get<StoredLead>(`lead:${email}`);
}

// Obtener leads con paginación
export async function getLeads(options: {
  limit?: number;
  offset?: number;
  status?: StoredLead['status'];
  tag?: string;
}): Promise<{ leads: StoredLead[]; total: number }> {
  const { limit = 50, offset = 0, status, tag } = options;
  
  let emails: string[];
  
  if (status) {
    emails = await kv.smembers(`leads:status:${status}`);
  } else if (tag) {
    emails = await kv.smembers(`leads:tag:${tag}`);
  } else {
    // Todos los leads ordenados por fecha
    emails = await kv.zrange('leads:byDate', offset, offset + limit - 1, { rev: true });
  }
  
  const total = emails.length;
  const paginatedEmails = emails.slice(offset, offset + limit);
  
  const leads: StoredLead[] = [];
  for (const email of paginatedEmails) {
    const lead = await kv.get<StoredLead>(`lead:${email}`);
    if (lead) leads.push(lead);
  }
  
  return { leads, total };
}

// Obtener métricas
export async function getMetrics(): Promise<{
  total: number;
  byStatus: Record<string, number>;
  byTag: Record<string, number>;
  today: number;
  thisWeek: number;
}> {
  const [newCount, subscribedCount, purchasedCount] = await Promise.all([
    kv.scard('leads:status:new'),
    kv.scard('leads:status:subscribed'),
    kv.scard('leads:status:purchased')
  ]);
  
  const total = (newCount || 0) + (subscribedCount || 0) + (purchasedCount || 0);
  
  // Obtener conteo por tags (simplificado)
  const tags = ['general', 'reel-fitness', 'reel-nutricion', 'story-promo'];
  const byTag: Record<string, number> = {};
  
  for (const tag of tags) {
    byTag[tag] = await kv.scard(`leads:tag:${tag}`) || 0;
  }
  
  // Leads de hoy y esta semana (simplificado)
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  
  const today = await kv.zcount('leads:byDate', dayAgo, now);
  const thisWeek = await kv.zcount('leads:byDate', weekAgo, now);
  
  return {
    total,
    byStatus: {
      new: newCount || 0,
      subscribed: subscribedCount || 0,
      purchased: purchasedCount || 0
    },
    byTag,
    today: today || 0,
    thisWeek: thisWeek || 0
  };
}
```

### API Endpoint para Dashboard

```typescript
// src/app/api/leads/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getLeads, getMetrics, StoredLead } from '@/lib/storage';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  
  const action = searchParams.get('action') || 'list';
  
  try {
    if (action === 'metrics') {
      const metrics = await getMetrics();
      return NextResponse.json({ success: true, data: metrics });
    }
    
    // Lista de leads
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');
    const status = searchParams.get('status') as StoredLead['status'] | undefined;
    const tag = searchParams.get('tag') || undefined;
    
    const result = await getLeads({ limit, offset, status, tag });
    
    return NextResponse.json({
      success: true,
      data: result.leads,
      pagination: {
        total: result.total,
        limit,
        offset,
        hasMore: offset + limit < result.total
      }
    });
    
  } catch (error) {
    console.error('[API/LEADS] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

### Componente Dashboard (React)

```typescript
// src/app/dashboard/page.tsx

'use client';

import { useEffect, useState } from 'react';

interface Lead {
  email: string;
  nombre: string;
  tag: string;
  status: 'new' | 'subscribed' | 'purchased';
  createdAt: string;
}

interface Metrics {
  total: number;
  byStatus: { new: number; subscribed: number; purchased: number };
  byTag: Record<string, number>;
  today: number;
  thisWeek: number;
}

export default function Dashboard() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<{ status?: string; tag?: string }>({});

  useEffect(() => {
    fetchData();
  }, [filter]);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch metrics
      const metricsRes = await fetch('/api/leads?action=metrics');
      const metricsData = await metricsRes.json();
      if (metricsData.success) setMetrics(metricsData.data);

      // Fetch leads
      const params = new URLSearchParams();
      if (filter.status) params.set('status', filter.status);
      if (filter.tag) params.set('tag', filter.tag);
      
      const leadsRes = await fetch(`/api/leads?${params}`);
      const leadsData = await leadsRes.json();
      if (leadsData.success) setLeads(leadsData.data);
    } catch (error) {
      console.error('Error fetching data:', error);
    }
    setLoading(false);
  };

  const statusColors = {
    new: 'bg-blue-100 text-blue-800',
    subscribed: 'bg-yellow-100 text-yellow-800',
    purchased: 'bg-green-100 text-green-800'
  };

  const statusLabels = {
    new: 'Nuevo',
    subscribed: 'Suscrito',
    purchased: 'Comprador'
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            Lead Automation Dashboard
          </h1>
          <p className="text-gray-600 mt-1">
            Monitoreo de leads y conversiones
          </p>
        </div>

        {/* Métricas */}
        {metrics && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div className="bg-white rounded-lg shadow p-6">
              <p className="text-sm text-gray-500">Total Leads</p>
              <p className="text-3xl font-bold text-gray-900">{metrics.total}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <p className="text-sm text-gray-500">Hoy</p>
              <p className="text-3xl font-bold text-blue-600">{metrics.today}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <p className="text-sm text-gray-500">Esta Semana</p>
              <p className="text-3xl font-bold text-blue-600">{metrics.thisWeek}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-6">
              <p className="text-sm text-gray-500">Compradores</p>
              <p className="text-3xl font-bold text-green-600">
                {metrics.byStatus.purchased}
              </p>
              <p className="text-sm text-gray-400">
                {metrics.total > 0 
                  ? `${((metrics.byStatus.purchased / metrics.total) * 100).toFixed(1)}%`
                  : '0%'
                } conversión
              </p>
            </div>
          </div>
        )}

        {/* Filtros */}
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <div className="flex flex-wrap gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Estado</label>
              <select
                className="border rounded px-3 py-2"
                value={filter.status || ''}
                onChange={(e) => setFilter({ ...filter, status: e.target.value || undefined })}
              >
                <option value="">Todos</option>
                <option value="new">Nuevos</option>
                <option value="subscribed">Suscritos</option>
                <option value="purchased">Compradores</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Tag</label>
              <select
                className="border rounded px-3 py-2"
                value={filter.tag || ''}
                onChange={(e) => setFilter({ ...filter, tag: e.target.value || undefined })}
              >
                <option value="">Todos</option>
                <option value="general">General</option>
                <option value="reel-fitness">Reel Fitness</option>
                <option value="reel-nutricion">Reel Nutrición</option>
                <option value="story-promo">Story Promo</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                onClick={fetchData}
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
              >
                Actualizar
              </button>
            </div>
          </div>
        </div>

        {/* Tabla de Leads */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Nombre
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Email
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Tag
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Estado
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Fecha
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-4 text-center text-gray-500">
                    Cargando...
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-4 text-center text-gray-500">
                    No hay leads
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <tr key={lead.email} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{lead.nombre}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                      {lead.email}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="px-2 py-1 bg-gray-100 rounded text-sm">
                        {lead.tag}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 py-1 rounded text-sm ${statusColors[lead.status]}`}>
                        {statusLabels[lead.status]}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-500 text-sm">
                      {new Date(lead.createdAt).toLocaleDateString('es-AR', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
```

---

## Criterios de Aceptación

- [ ] `/dashboard` muestra métricas (total, hoy, semana, compradores)
- [ ] Dashboard muestra lista de leads con paginación
- [ ] Filtro por estado funciona
- [ ] Filtro por tag funciona
- [ ] Botón actualizar recarga datos
- [ ] Estados muestran colores diferenciados
- [ ] Formato de fecha legible
- [ ] API `/api/leads` retorna leads correctamente
- [ ] API `/api/leads?action=metrics` retorna métricas

---

## Tests

```typescript
// tests/dashboard.test.ts

import { GET } from '@/app/api/leads/route';
import { NextRequest } from 'next/server';

describe('Leads API', () => {
  
  test('GET retorna lista de leads', async () => {
    const req = new NextRequest('http://localhost/api/leads');
    const res = await GET(req);
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
  });
  
  test('GET con action=metrics retorna métricas', async () => {
    const req = new NextRequest('http://localhost/api/leads?action=metrics');
    const res = await GET(req);
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.total).toBeDefined();
    expect(data.data.byStatus).toBeDefined();
  });
  
  test('GET con filtro status funciona', async () => {
    const req = new NextRequest('http://localhost/api/leads?status=purchased');
    const res = await GET(req);
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
  
  test('GET con filtro tag funciona', async () => {
    const req = new NextRequest('http://localhost/api/leads?tag=reel-fitness');
    const res = await GET(req);
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
```

---

## Ralph Loop One-Shot

```
1. ✅ Leer esta épica completa
2. Instalar Vercel KV: npm install @vercel/kv
3. Crear archivo src/lib/storage.ts
4. Crear archivo src/app/api/leads/route.ts
5. Crear archivo src/app/dashboard/page.tsx
6. Crear archivo tests/dashboard.test.ts
7. Integrar storage en EPIC-01 (saveLead) y EPIC-03 (updateLeadStatus)
8. Ejecutar: npm test -- dashboard
9. Si FAIL → fix y volver a 8
10. Si PASS → EPIC-04 DONE ✅
```

---

## Integración con otras Épicas

### Modificar EPIC-01 (después de agregar a Brevo):

```typescript
// En src/app/api/webhook/sheet/route.ts, agregar:
import { saveLead } from '@/lib/storage';

// Después de addContactToBrevo():
await saveLead({
  email: payload.mail,
  nombre: payload.nombre,
  tag: payload.tag || 'general',
  idContacto: payload.idContacto,
  status: 'subscribed',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  brevoContactId: brevoResult.id.toString()
});
```

### Modificar EPIC-03 (después de marcar compra):

```typescript
// En src/app/api/webhook/woocommerce/route.ts, agregar:
import { updateLeadStatus } from '@/lib/storage';

// Después de markAsPurchased():
await updateLeadStatus(buyerEmail, 'purchased', {
  orderId: order.id.toString(),
  purchasedAt: new Date().toISOString()
});
```

---

## Configuración Vercel KV

1. En Vercel Dashboard > Project > Storage
2. Create Database > KV
3. Las variables se agregan automáticamente:
   - `KV_URL`
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
   - `KV_REST_API_READ_ONLY_TOKEN`
