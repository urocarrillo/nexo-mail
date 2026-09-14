/**
 * Tests del embudo post-consulta (cola KV + cron + webhook Calendly).
 * Se mockean @vercel/kv (store en memoria), las alertas y `fetch` (WooCommerce
 * + Brevo simulados en memoria, registrando cada llamada).
 */
import { NextRequest } from 'next/server';

jest.mock('@vercel/kv', () => {
  const store = new Map<string, unknown>();
  const hashes = new Map<string, Map<string, unknown>>();
  const kv = {
    set: jest.fn(async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    hset: jest.fn(async (key: string, fields: Record<string, unknown>) => {
      const h = hashes.get(key) || new Map<string, unknown>();
      for (const [f, v] of Object.entries(fields)) h.set(f, v);
      hashes.set(key, h);
      return Object.keys(fields).length;
    }),
    hdel: jest.fn(async (key: string, field: string) => (hashes.get(key)?.delete(field) ? 1 : 0)),
    hgetall: jest.fn(async (key: string) => {
      const h = hashes.get(key);
      if (!h || h.size === 0) return null;
      return Object.fromEntries(h.entries());
    }),
  };
  return {
    kv,
    __store: store,
    __hashes: hashes,
    __reset: () => {
      store.clear();
      hashes.clear();
    },
  };
});

jest.mock('@/lib/alertas', () => ({
  enviarAlerta: jest.fn(async () => true),
}));

import { GET as cronGET } from '@/app/api/cron/postconsulta/route';
import { POST as webhookPOST } from '@/app/api/webhook/calendly/route';
import { enviarAlerta } from '@/lib/alertas';
import {
  DONE_PREFIX,
  PENDING_KEY,
  debeProcesarse,
  esHoyEnArgentina,
  listarPendientes,
  nombreDesdeDescripcion,
  parseWcGmt,
} from '@/lib/postconsulta';

const kvMock = jest.requireMock('@vercel/kv') as {
  __store: Map<string, unknown>;
  __hashes: Map<string, Map<string, unknown>>;
  __reset: () => void;
};
const mockedAlerta = enviarAlerta as jest.MockedFunction<typeof enviarAlerta>;

const SECRET = 'test-cron-secret';

// ── WooCommerce + Brevo en memoria ─────────────────────────────────

interface FakeCoupon {
  id: number;
  code: string;
  amount: string;
  discount_type: string;
  date_expires: string | null;
  date_expires_gmt: string | null;
  usage_count: number;
  usage_limit: number | null;
  product_ids: number[];
  description: string;
  meta_data: { key: string; value: string }[];
}

let coupons: FakeCoupon[] = [];
let nextCouponId = 100;
let brevoCalls: Record<string, unknown>[] = [];
let brevoFail: string | null = null;
let wcFail = false;
let brevoDeleted: string[] = [];

function wcGmt(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

function addCoupon(p: {
  code: string;
  email: string;
  name: string;
  expiresAt: Date;
  eventUri?: string;
  messageId?: string;
  source?: string;
  used?: number;
}): FakeCoupon {
  const c: FakeCoupon = {
    id: nextCouponId++,
    code: p.code.toLowerCase(),
    amount: '30.00',
    discount_type: 'percent',
    date_expires: wcGmt(new Date(p.expiresAt.getTime() - 3 * 3600e3)),
    date_expires_gmt: wcGmt(p.expiresAt),
    usage_count: p.used || 0,
    usage_limit: 1,
    product_ids: [3740],
    description: `Post-consulta ${p.name} (${p.email}) — 2026-09-07`,
    meta_data: [
      { key: '_patient_email', value: p.email },
      { key: '_source', value: p.source || 'calendly-post-consultation' },
      ...(p.eventUri ? [{ key: '_event_uri', value: p.eventUri }] : []),
      ...(p.messageId ? [{ key: '_brevo_message_id', value: p.messageId }] : []),
    ],
  };
  coupons.push(c);
  return c;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method || 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : null;

  if (url.startsWith('https://urologia.ar/wp-json/wc/v3/coupons')) {
    if (wcFail) return Promise.resolve(json({ message: 'boom' }, 500));
    const u = new URL(url);
    const idMatch = u.pathname.match(/\/coupons\/(\d+)$/);
    if (method === 'GET') {
      const search = (u.searchParams.get('search') || '').toLowerCase();
      const page = parseInt(u.searchParams.get('page') || '1', 10);
      if (page > 1) return Promise.resolve(json([]));
      const found = coupons.filter(
        c => c.code.includes(search) || c.description.toLowerCase().includes(search)
      );
      return Promise.resolve(json(found));
    }
    if (method === 'POST') {
      const c: FakeCoupon = {
        id: nextCouponId++,
        code: String(body.code).toLowerCase(),
        amount: body.amount,
        discount_type: body.discount_type,
        date_expires: body.date_expires,
        date_expires_gmt: wcGmt(new Date(body.date_expires)),
        usage_count: 0,
        usage_limit: body.usage_limit,
        product_ids: body.product_ids,
        description: body.description,
        meta_data: body.meta_data,
      };
      coupons.push(c);
      return Promise.resolve(json(c, 201));
    }
    if (method === 'PUT' && idMatch) {
      const c = coupons.find(x => x.id === parseInt(idMatch[1], 10));
      if (!c) return Promise.resolve(json({ message: 'not found' }, 404));
      for (const m of body.meta_data || []) {
        const existing = c.meta_data.find(x => x.key === m.key);
        if (existing) existing.value = m.value;
        else c.meta_data.push(m);
      }
      return Promise.resolve(json(c));
    }
    if (method === 'DELETE' && idMatch) {
      const before = coupons.length;
      coupons = coupons.filter(x => x.id !== parseInt(idMatch[1], 10));
      return Promise.resolve(json({ deleted: before !== coupons.length }));
    }
  }

  if (url === 'https://api.brevo.com/v3/smtp/email' && method === 'POST') {
    brevoCalls.push(body);
    if (brevoFail) return Promise.resolve(json({ code: 'invalid_parameter', message: brevoFail }, 400));
    return Promise.resolve(json({ messageId: `<msg-${brevoCalls.length}@test>` }, 201));
  }
  if (url.startsWith('https://api.brevo.com/v3/smtp/email/') && method === 'DELETE') {
    brevoDeleted.push(decodeURIComponent(url.split('/smtp/email/')[1]));
    return Promise.resolve(new Response(null, { status: 204 }));
  }

  return Promise.resolve(json({ message: `unexpected ${method} ${url}` }, 500));
}

// ── Helpers ─────────────────────────────────────────────────────────

const NOW = new Date('2026-09-14T13:00:00.000Z'); // 10:00 Argentina, lunes 14/09

function cronReq(query = ''): NextRequest {
  return new NextRequest(`https://nexo-mail.vercel.app/api/cron/postconsulta${query}`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

function webhookReq(payload: unknown): NextRequest {
  return new NextRequest('https://nexo-mail.vercel.app/api/webhook/calendly', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function bookingPayload(p: {
  email: string;
  name: string;
  endTime: string;
  eventUri: string;
  event?: string;
  typeName?: string;
}) {
  return {
    event: p.event || 'invitee.created',
    payload: {
      event: p.eventUri,
      name: p.name,
      email: p.email,
      scheduled_event: {
        uri: p.eventUri,
        name: p.typeName || 'Atención Prioritaria',
        start_time: new Date(new Date(p.endTime).getTime() - 40 * 60e3).toISOString(),
        end_time: p.endTime,
      },
      event_type: { name: p.typeName || 'Atención Prioritaria' },
    },
  };
}

async function enqueue(r: { eventUri: string; email: string; name: string; endTime: string; attempts?: number }) {
  const { kv } = jest.requireMock('@vercel/kv') as { kv: { hset: (k: string, f: Record<string, unknown>) => Promise<number> } };
  await kv.hset(PENDING_KEY, {
    [r.eventUri]: JSON.stringify({ ...r, createdAt: NOW.toISOString(), attempts: r.attempts || 0 }),
  });
}

const EV = (id: string) => `https://api.calendly.com/scheduled_events/${id}`;

beforeEach(() => {
  kvMock.__reset();
  coupons = [];
  nextCouponId = 100;
  brevoCalls = [];
  brevoFail = null;
  wcFail = false;
  brevoDeleted = [];
  mockedAlerta.mockClear();
  process.env.CRON_SECRET = SECRET;
  process.env.BREVO_API_KEY = 'test-brevo';
  process.env.CALENDLY_EMAIL_TEMPLATE_ID = '158';
  process.env.WP_USER = 'u';
  process.env.WP_APP_PASSWORD = 'p';
  global.fetch = jest.fn(fakeFetch) as unknown as typeof fetch;
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Fechas ──────────────────────────────────────────────────────────

describe('fechas', () => {
  it('esHoyEnArgentina compara el día calendario de Argentina (UTC-3)', () => {
    // 01:30 UTC del 15/09 = 22:30 ART del 14/09 → mismo día que NOW
    expect(esHoyEnArgentina(new Date('2026-09-15T01:30:00Z'), NOW)).toBe(true);
    // 03:30 UTC del 15/09 = 00:30 ART del 15/09 → otro día
    expect(esHoyEnArgentina(new Date('2026-09-15T03:30:00Z'), NOW)).toBe(false);
  });

  it('debeProcesarse: hoy o pasado sí, mañana no', () => {
    expect(debeProcesarse(new Date('2026-09-14T15:40:00Z'), NOW)).toBe(true); // hoy, más tarde
    expect(debeProcesarse(new Date('2026-09-10T15:40:00Z'), NOW)).toBe(true); // pasado
    expect(debeProcesarse(new Date('2026-09-16T15:40:00Z'), NOW)).toBe(false); // pasado mañana
    expect(debeProcesarse(new Date('invalid'), NOW)).toBe(false);
  });

  it('parseWcGmt agrega la Z que WooCommerce omite', () => {
    expect(parseWcGmt('2026-09-15T15:40:00')?.toISOString()).toBe('2026-09-15T15:40:00.000Z');
    expect(parseWcGmt('2026-09-15T15:40:00Z')?.toISOString()).toBe('2026-09-15T15:40:00.000Z');
    expect(parseWcGmt(null)).toBeNull();
  });

  it('nombreDesdeDescripcion extrae el nombre del cupón', () => {
    expect(nombreDesdeDescripcion('Post-consulta Ivan Ponce Curto (x@y.com) — 2026-09-07')).toBe('Ivan Ponce Curto');
    expect(nombreDesdeDescripcion('otra cosa')).toBeNull();
  });
});

// ── Cron ────────────────────────────────────────────────────────────

describe('cron postconsulta', () => {
  it('rechaza sin secret', async () => {
    const res = await cronGET(new NextRequest('https://nexo-mail.vercel.app/api/cron/postconsulta'));
    expect(res.status).toBe(401);
  });

  it('reserva de mañana: queda en cola, sin cupón ni mail', async () => {
    await enqueue({ eventUri: EV('manana'), email: 'a@x.com', name: 'Ana', endTime: '2026-09-16T15:40:00Z' });
    const res = await cronGET(cronReq());
    const body = await res.json();
    expect(body.debidas).toBe(0);
    expect(body.proximas).toHaveLength(1);
    expect(coupons).toHaveLength(0);
    expect(brevoCalls).toHaveLength(0);
    expect(await listarPendientes()).toHaveLength(1);
  });

  it('reserva de hoy: crea cupón (vence 24 h después del envío), programa Brevo al fin del turno, guarda messageId y desencola', async () => {
    await enqueue({ eventUri: EV('hoy'), email: 'ivan@x.com', name: 'Ivan Ponce', endTime: '2026-09-14T15:40:00Z' });
    const res = await cronGET(cronReq());
    const body = await res.json();
    expect(body.reservas.resumen).toEqual({ programado: 1 });

    expect(coupons).toHaveLength(1);
    const c = coupons[0];
    expect(c.code).toMatch(/^pac-[a-z2-9]{6}$/);
    expect(c.date_expires).toBe('2026-09-15T15:40:00Z'); // sin milisegundos: WooCommerce respeta la Z
    expect(c.meta_data.find(m => m.key === '_event_uri')?.value).toBe(EV('hoy'));
    expect(c.meta_data.find(m => m.key === '_brevo_message_id')?.value).toBe('<msg-1@test>');

    expect(brevoCalls).toHaveLength(1);
    expect(brevoCalls[0]).toMatchObject({
      templateId: 158,
      to: [{ email: 'ivan@x.com', name: 'Ivan Ponce' }],
      params: { NOMBRE: 'Ivan', COUPON_CODE: c.code.toUpperCase() },
      scheduledAt: '2026-09-14T15:40:00.000Z',
    });

    expect(await listarPendientes()).toHaveLength(0);
    expect(kvMock.__store.get(`${DONE_PREFIX}${EV('hoy')}`)).toBe(NOW.toISOString());
    expect(mockedAlerta).not.toHaveBeenCalled();
  });

  it('turno ya pasado (corridas perdidas): mail inmediato sin scheduledAt y cupón válido 24 h desde ahora', async () => {
    await enqueue({ eventUri: EV('pasado'), email: 'p@x.com', name: 'Pedro', endTime: '2026-09-13T15:40:00Z' });
    const res = await cronGET(cronReq());
    expect((await res.json()).reservas.resumen).toEqual({ programado: 1 });
    expect(brevoCalls[0]).not.toHaveProperty('scheduledAt');
    expect(new Date(coupons[0].date_expires as string).toISOString()).toBe('2026-09-15T13:00:00.000Z');
  });

  it('reutiliza un cupón existente del mismo turno en vez de crear otro', async () => {
    addCoupon({ code: 'PAC-AAAAAA', email: 'r@x.com', name: 'Raul', expiresAt: new Date('2026-09-15T15:40:00Z'), eventUri: EV('reusa') });
    await enqueue({ eventUri: EV('reusa'), email: 'r@x.com', name: 'Raul', endTime: '2026-09-14T15:40:00Z' });
    const res = await cronGET(cronReq());
    const body = await res.json();
    expect(body.reservas.detalle[0]).toMatchObject({ estado: 'programado', couponCode: 'PAC-AAAAAA', couponCreado: false });
    expect(coupons).toHaveLength(1);
    expect(brevoCalls).toHaveLength(1);
    expect(brevoCalls[0]).toMatchObject({ params: { COUPON_CODE: 'PAC-AAAAAA' } });
  });

  it('cupón del turno con messageId ya guardado: no manda nada y desencola', async () => {
    addCoupon({ code: 'PAC-BBBBBB', email: 'o@x.com', name: 'Osvaldo', expiresAt: new Date('2026-09-15T18:40:00Z'), eventUri: EV('ya'), messageId: '<old@test>' });
    await enqueue({ eventUri: EV('ya'), email: 'o@x.com', name: 'Osvaldo', endTime: '2026-09-14T18:40:00Z' });
    const res = await cronGET(cronReq());
    expect((await res.json()).reservas.resumen).toEqual({ 'ya-procesada': 1 });
    expect(brevoCalls).toHaveLength(0);
    expect(await listarPendientes()).toHaveLength(0);
  });

  it('si Brevo falla: cupón queda, reserva sigue en cola con attempts+1, guardia liberada y alerta', async () => {
    brevoFail = 'boom';
    await enqueue({ eventUri: EV('falla'), email: 'f@x.com', name: 'Fede', endTime: '2026-09-14T15:40:00Z' });
    const res = await cronGET(cronReq());
    expect((await res.json()).reservas.resumen).toEqual({ error: 1 });
    expect(coupons).toHaveLength(1);
    const pend = await listarPendientes();
    expect(pend).toHaveLength(1);
    expect(pend[0].attempts).toBe(1);
    expect(pend[0].lastError).toContain('boom');
    expect(kvMock.__store.has(`${DONE_PREFIX}${EV('falla')}`)).toBe(false);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);

    // Segunda corrida con Brevo sano: reutiliza el cupón, programa y desencola
    brevoFail = null;
    const res2 = await cronGET(cronReq());
    expect((await res2.json()).reservas.resumen).toEqual({ programado: 1 });
    expect(coupons).toHaveLength(1);
    expect(await listarPendientes()).toHaveLength(0);
  });

  it('cupón huérfano (creado por el webhook viejo, sin messageId) cuyo día llegó: programa el mail, sin cupón nuevo', async () => {
    addCoupon({ code: 'PAC-KBMBXC', email: 'h@x.com', name: 'Ivan Ponce Curto', expiresAt: new Date('2026-09-15T15:40:00Z'), eventUri: EV('huerfano') });
    const res = await cronGET(cronReq());
    const body = await res.json();
    expect(body.huerfanos.resumen).toEqual({ programado: 1 });
    expect(coupons).toHaveLength(1);
    expect(coupons[0].meta_data.find(m => m.key === '_brevo_message_id')?.value).toBe('<msg-1@test>');
    expect(brevoCalls[0]).toMatchObject({
      to: [{ email: 'h@x.com', name: 'Ivan Ponce Curto' }],
      params: { NOMBRE: 'Ivan', COUPON_CODE: 'PAC-KBMBXC' },
      scheduledAt: '2026-09-14T15:40:00.000Z',
    });
  });

  it('cupón huérfano de otro día, usado, vencido o de otra fuente: se ignora', async () => {
    addCoupon({ code: 'PAC-FUTURO', email: 'a@x.com', name: 'A', expiresAt: new Date('2026-09-17T15:40:00Z'), eventUri: EV('f') });
    addCoupon({ code: 'PAC-USADO0', email: 'b@x.com', name: 'B', expiresAt: new Date('2026-09-15T15:40:00Z'), eventUri: EV('u'), used: 1 });
    addCoupon({ code: 'PAC-VENCID', email: 'c@x.com', name: 'C', expiresAt: new Date('2026-09-14T12:00:00Z'), eventUri: EV('v') });
    addCoupon({ code: 'PAC-MANUAL', email: 'd@x.com', name: 'D', expiresAt: new Date('2026-09-15T15:40:00Z'), source: 'manual' });
    const res = await cronGET(cronReq());
    expect((await res.json()).huerfanos.resumen).toEqual({});
    expect(brevoCalls).toHaveLength(0);
  });

  it('dry=1: informa qué haría sin crear, enviar ni tocar la cola', async () => {
    await enqueue({ eventUri: EV('dry'), email: 'd@x.com', name: 'Dani', endTime: '2026-09-14T15:40:00Z' });
    addCoupon({ code: 'PAC-HUERFA', email: 'h@x.com', name: 'H', expiresAt: new Date('2026-09-15T15:40:00Z'), eventUri: EV('h') });
    const res = await cronGET(cronReq('?dry=1'));
    const body = await res.json();
    expect(body.reservas.resumen).toEqual({ dry: 1 });
    expect(body.reservas.detalle[0]).toMatchObject({ couponCreado: true, sendAt: '2026-09-14T15:40:00.000Z' });
    expect(body.huerfanos.resumen).toEqual({ dry: 1 });
    expect(coupons).toHaveLength(1);
    expect(brevoCalls).toHaveLength(0);
    expect(await listarPendientes()).toHaveLength(1);
  });

  it('si WooCommerce falla: la reserva queda en cola y hay alerta; la red de seguridad no tumba la corrida', async () => {
    wcFail = true;
    await enqueue({ eventUri: EV('wc'), email: 'w@x.com', name: 'W', endTime: '2026-09-14T15:40:00Z' });
    const res = await cronGET(cronReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reservas.resumen).toEqual({ error: 1 });
    expect(body.huerfanos.error).toContain('HTTP 500');
    expect(await listarPendientes()).toHaveLength(1);
    expect(mockedAlerta).toHaveBeenCalled();
  });
});

// ── Webhook Calendly ────────────────────────────────────────────────

describe('webhook calendly', () => {
  it('reserva con días de anticipación: solo encola (sin cupón ni mail)', async () => {
    const res = await webhookPOST(webhookReq(bookingPayload({ email: 'l@x.com', name: 'Lucas', endTime: '2026-09-23T04:40:00Z', eventUri: EV('lejos') })));
    const body = await res.json();
    expect(body).toMatchObject({ success: true, queued: true, sendAt: '2026-09-23T04:40:00.000Z' });
    expect(coupons).toHaveLength(0);
    expect(brevoCalls).toHaveLength(0);
    const pend = await listarPendientes();
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ eventUri: EV('lejos'), email: 'l@x.com', name: 'Lucas' });
  });

  it('reserva para hoy: encola y procesa en el acto', async () => {
    const res = await webhookPOST(webhookReq(bookingPayload({ email: 'o@x.com', name: 'Osvaldo', endTime: '2026-09-14T18:40:00Z', eventUri: EV('hoy') })));
    const body = await res.json();
    expect(body).toMatchObject({ success: true, estado: 'programado', sendAt: '2026-09-14T18:40:00.000Z' });
    expect(coupons).toHaveLength(1);
    expect(brevoCalls[0]).toMatchObject({ scheduledAt: '2026-09-14T18:40:00.000Z' });
    expect(await listarPendientes()).toHaveLength(0);
  });

  it('ignora otros tipos de evento', async () => {
    const res = await webhookPOST(webhookReq(bookingPayload({ email: 'x@x.com', name: 'X', endTime: '2026-09-20T15:40:00Z', eventUri: EV('otro'), typeName: 'Sesión 1-1' })));
    expect((await res.json()).skipped).toBe(true);
    expect(await listarPendientes()).toHaveLength(0);
  });

  it('cancelación: saca de la cola, borra solo el cupón de ese turno y revoca el mail programado', async () => {
    await enqueue({ eventUri: EV('cancel'), email: 'c@x.com', name: 'Carla', endTime: '2026-09-20T15:40:00Z' });
    addCoupon({ code: 'PAC-CANCEL', email: 'c@x.com', name: 'Carla', expiresAt: new Date('2026-09-21T15:40:00Z'), eventUri: EV('cancel'), messageId: '<sched@test>' });
    addCoupon({ code: 'PAC-OTRO00', email: 'c@x.com', name: 'Carla', expiresAt: new Date('2026-09-25T15:40:00Z'), eventUri: EV('otro-turno') });

    const res = await webhookPOST(webhookReq(bookingPayload({ event: 'invitee.canceled', email: 'c@x.com', name: 'Carla', endTime: '2026-09-20T15:40:00Z', eventUri: EV('cancel') })));
    const body = await res.json();
    expect(body).toMatchObject({ success: true, dequeued: true, emailCanceled: true, couponsDeleted: ['pac-cancel'] });
    expect(brevoDeleted).toEqual(['<sched@test>']);
    expect(coupons.map(c => c.code)).toEqual(['pac-otro00']);
    expect(await listarPendientes()).toHaveLength(0);
  });
});
