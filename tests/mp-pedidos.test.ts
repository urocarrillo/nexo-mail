/**
 * Tests de la lib mp-pedidos (reconciliación Mercado Pago ↔ WooCommerce).
 * Se mockean KV (en memoria), el fetch (router por URL) y plainToHtml; la
 * lógica de resolverPedido / completarPedido / edad se ejerce de verdad.
 */

jest.mock('@vercel/kv', () => {
  const store = new Map<string, unknown>();
  const kv = {
    set: jest.fn(async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    incr: jest.fn(async (key: string) => {
      const n = ((store.get(key) as number) || 0) + 1;
      store.set(key, n);
      return n;
    }),
    expire: jest.fn(async () => 1),
  };
  return { kv, __store: store, __reset: () => store.clear() };
});

jest.mock('@/lib/email-drip', () => ({
  plainToHtml: (text: string) => `<p>${text}</p>`,
}));

import {
  type WcOrder,
  type MpPayment,
  resolverPedido,
  edadMinutos,
  elegirPedido,
  orderIdDeReferencia,
  pagoPorId,
  enviarBienvenida,
  cerrarCasoAccesoPorPedido,
  nuevoCaso,
  guardarCaso,
  vincularCasoPedido,
  getCaso,
  destinatariosAviso,
} from '@/lib/mp-pedidos';

const kvMock = jest.requireMock('@vercel/kv') as { __store: Map<string, unknown>; __reset: () => void };

// ── fetch router ────────────────────────────────────────────────────
interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}
const calls: Call[] = [];
let mpPagosPorId: Record<string, MpPayment | null> = {};
let mpSearch: MpPayment[] = [];
let putStatus = 200;

function jsonRes(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const fetchMock = jest.fn(async (input: string, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method || 'GET').toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  calls.push({ url, method, body });

  let m = /api\.mercadopago\.com\/v1\/payments\/(\d+)$/.exec(url);
  if (m) {
    const p = mpPagosPorId[m[1]];
    return p ? jsonRes(200, p) : jsonRes(404, { message: 'not found' });
  }
  if (url.includes('api.mercadopago.com/v1/payments/search')) return jsonRes(200, { results: mpSearch });

  m = /wc\/v3\/orders\/(\d+)$/.exec(url);
  if (m && method === 'PUT') return jsonRes(putStatus, { id: Number(m[1]), status: 'completed', ...(body || {}) });
  if (/wc\/v3\/orders\/\d+\/notes$/.test(url) && method === 'POST') return jsonRes(201, { id: 1 });
  if (url.includes('api.brevo.com/v3/smtp/email')) return jsonRes(201, { messageId: 'msg-1' });
  return jsonRes(500, { error: `sin ruta mock para ${method} ${url}` });
});
global.fetch = fetchMock as unknown as typeof fetch;

function pago(partial: Partial<MpPayment>): MpPayment {
  return { id: 100, status: 'approved', external_reference: 'Curso-5578', date_approved: '2026-09-13T23:32:00Z', ...partial };
}

function order(partial: Partial<WcOrder> = {}): WcOrder {
  return {
    id: 5578,
    status: 'pending',
    order_key: 'wc_order_abc123',
    date_created: '2026-09-13T20:31:00',
    date_created_gmt: '2026-09-13T23:31:00',
    payment_method: 'woo-mercado-pago-basic',
    total: '115.00',
    currency: 'USD',
    billing: { first_name: 'Felipe', last_name: 'Romero', email: 'felipe@example.com' },
    line_items: [{ product_id: 3208, name: 'Curso: Controlá tu eyaculación' }],
    meta_data: [],
    ...partial,
  };
}

const puts = () => calls.filter((c) => c.method === 'PUT');
const brevo = () => calls.filter((c) => c.url.includes('brevo.com'));

beforeEach(() => {
  kvMock.__reset();
  calls.length = 0;
  mpPagosPorId = {};
  mpSearch = [];
  putStatus = 200;
  fetchMock.mockClear();
  process.env.MP_ACCESS_TOKEN = 'test-mp-token';
  delete process.env.APPROVAL_EMAIL;
});

describe('edadMinutos (TZ)', () => {
  it('usa date_created_gmt: pedido creado hace 5 min → 5, no 185', () => {
    const ahora = Date.UTC(2026, 8, 13, 23, 36, 0); // 23:36Z
    const o = order({ date_created: '2026-09-13T20:31:00', date_created_gmt: '2026-09-13T23:31:00' });
    expect(Math.round(edadMinutos(o, ahora))).toBe(5);
  });

  it('cae a date_created si falta date_created_gmt', () => {
    const ahora = Date.UTC(2026, 8, 13, 20, 41, 0);
    const o = order({ date_created: '2026-09-13T20:31:00Z', date_created_gmt: undefined });
    expect(Math.round(edadMinutos(o, ahora))).toBe(10);
  });
});

describe('resolverPedido', () => {
  it('approved sin mediación → completa (PUT completed + transaction_id + nota)', async () => {
    mpSearch = [pago({ id: 100 })];
    const r = await resolverPedido(order(), { origen: 'test' });

    expect(r.accion).toBe('completado');
    expect(r.pago?.id).toBe(100);
    expect(r.order.status).toBe('completed');
    expect(r.order.transaction_id).toBe('100');
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toEqual({ status: 'completed', transaction_id: '100' });
    const nota = calls.find((c) => c.url.endsWith('/orders/5578/notes'));
    expect(nota?.body?.note).toContain('pago Mercado Pago 100');
    expect(nota?.body?.note).toContain('(test)');
  });

  it('approved + in_mediation → en_mediacion, no toca el pedido', async () => {
    mpSearch = [pago({ id: 101, status: 'in_mediation' }), pago({ id: 100, status: 'approved' })];
    const r = await resolverPedido(order(), { origen: 'test' });

    expect(r.accion).toBe('en_mediacion');
    expect(r.pago?.id).toBe(101);
    expect(puts()).toHaveLength(0);
  });

  it('charged_back cuenta como mediación', async () => {
    mpSearch = [pago({ id: 100 }), pago({ id: 102, status: 'charged_back' })];
    const r = await resolverPedido(order(), { origen: 'test' });
    expect(r.accion).toBe('en_mediacion');
    expect(puts()).toHaveLength(0);
  });

  it('on-hold con pago approved → completa', async () => {
    mpSearch = [pago({ id: 100 })];
    const r = await resolverPedido(order({ status: 'on-hold' }), { origen: 'test' });
    expect(r.accion).toBe('completado');
    expect(puts()).toHaveLength(1);
  });

  it('pending sin pago → sin_pago, sin PUT', async () => {
    mpSearch = [];
    const r = await resolverPedido(order(), { origen: 'test' });
    expect(r.accion).toBe('sin_pago');
    expect(r.pagos).toEqual([]);
    expect(puts()).toHaveLength(0);
  });

  it('pago in_process → pago_pendiente', async () => {
    mpSearch = [pago({ id: 103, status: 'in_process' })];
    const r = await resolverPedido(order(), { origen: 'test' });
    expect(r.accion).toBe('pago_pendiente');
    expect(r.pago?.id).toBe(103);
    expect(puts()).toHaveLength(0);
  });

  it('sólo pagos rejected → pago_rechazado', async () => {
    mpSearch = [pago({ id: 104, status: 'rejected' })];
    const r = await resolverPedido(order(), { origen: 'test' });
    expect(r.accion).toBe('pago_rechazado');
    expect(puts()).toHaveLength(0);
  });

  it('completed/processing → ya_completado sin consultar MP', async () => {
    const r1 = await resolverPedido(order({ status: 'completed' }), { origen: 'test' });
    const r2 = await resolverPedido(order({ status: 'processing' }), { origen: 'test' });
    expect(r1.accion).toBe('ya_completado');
    expect(r2.accion).toBe('ya_completado');
    expect(calls).toHaveLength(0);
  });

  it('cancelled con pago approved → revisar_manual, sin PUT', async () => {
    mpSearch = [pago({ id: 100 })];
    const r = await resolverPedido(order({ status: 'cancelled' }), { origen: 'test' });
    expect(r.accion).toBe('revisar_manual');
    expect(r.motivo).toContain('cancelled');
    expect(puts()).toHaveLength(0);
  });

  it('gateway no MP → revisar_manual sin consultar MP', async () => {
    const r = await resolverPedido(order({ payment_method: 'ppcp-gateway', payment_method_title: 'PayPal' }), { origen: 'test' });
    expect(r.accion).toBe('revisar_manual');
    expect(r.motivo).toContain('PayPal');
    expect(calls).toHaveLength(0);
  });

  it('dry: reporta completado pero no hace PUT', async () => {
    mpSearch = [pago({ id: 100 })];
    const r = await resolverPedido(order(), { dry: true, origen: 'test' });
    expect(r.accion).toBe('completado');
    expect(r.order.status).toBe('pending');
    expect(puts()).toHaveLength(0);
  });

  it('busca por meta _Mercado_Pago_Payment_IDs antes que por external_reference', async () => {
    mpPagosPorId = { '200': pago({ id: 200 }) };
    const r = await resolverPedido(
      order({ meta_data: [{ key: '_Mercado_Pago_Payment_IDs', value: '200' }] }),
      { origen: 'test' }
    );
    expect(r.accion).toBe('completado');
    expect(r.pago?.id).toBe(200);
    expect(calls.some((c) => c.url.includes('/payments/search'))).toBe(false);
  });

  it('pagos precargados (payment_id verificado) saltean la búsqueda', async () => {
    const r = await resolverPedido(order(), { origen: 'test', pagos: [pago({ id: 300 })] });
    expect(r.accion).toBe('completado');
    expect(calls.some((c) => c.url.includes('mercadopago.com'))).toBe(false);
  });

  it('PUT fallido lanza (el caller avisa y reintenta en la próxima corrida)', async () => {
    mpSearch = [pago({ id: 100 })];
    putStatus = 500;
    await expect(resolverPedido(order(), { origen: 'test' })).rejects.toThrow('PUT /orders/5578');
  });
});

describe('pagoPorId / orderIdDeReferencia', () => {
  it('404 → null; id no numérico → null sin llamar', async () => {
    expect(await pagoPorId('999')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(await pagoPorId('abc')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('external_reference "Curso-{id}" → id', () => {
    expect(orderIdDeReferencia({ external_reference: 'Curso-5578' })).toBe(5578);
    expect(orderIdDeReferencia({ external_reference: 'otra-cosa' })).toBeNull();
    expect(orderIdDeReferencia({})).toBeNull();
  });
});

describe('elegirPedido', () => {
  it('prioriza no cancelados con producto-curso, después el más reciente', () => {
    const viejoOk = order({ id: 1, status: 'completed', date_created_gmt: '2026-09-01T10:00:00' });
    const nuevoCancelado = order({ id: 2, status: 'cancelled', date_created_gmt: '2026-09-13T10:00:00' });
    const nuevoOk = order({ id: 3, status: 'pending', date_created_gmt: '2026-09-12T10:00:00' });
    expect(elegirPedido([nuevoCancelado, viejoOk, nuevoOk])?.id).toBe(3);
    expect(elegirPedido([nuevoCancelado])?.id).toBe(2);
    expect(elegirPedido([order({ line_items: [] })])).toBeNull();
    expect(elegirPedido([])).toBeNull();
  });
});

describe('enviarBienvenida', () => {
  it('manda una vez por pedido (idempotente por KV)', async () => {
    const p = { orderId: 5578, email: 'felipe@example.com', nombre: 'Felipe', cursos: ['Curso EP'] };
    expect(await enviarBienvenida(p)).toEqual({ enviado: true });
    expect(await enviarBienvenida(p)).toEqual({ enviado: false, motivo: 'ya enviada' });
    expect(brevo()).toHaveLength(1);
    const body = brevo()[0].body as { sender: { email: string }; subject: string; textContent: string };
    expect(body.sender.email).toBe('mauro@urologia.ar');
    expect(body.subject).toBe('Cómo entrar a tu curso: Curso EP');
    expect(body.textContent).toContain('https://urologia.ar/mi-cuenta');
    expect(body.textContent).toContain('felipe@example.com');
    expect(body.textContent).toContain('https://urologia.ar/no-puedo-acceder');
    expect(body.textContent).not.toContain('date de baja');
  });
});

describe('casos de acceso', () => {
  it('cerrarCasoAccesoPorPedido: mail "Listo", aviso interno y caso resuelto; no duplica', async () => {
    const caso = nuevoCaso({ nombre: 'Felipe', email_compra: 'felipe@example.com', email_pago: 'otro@example.com' });
    await guardarCaso(caso);
    await vincularCasoPedido(5578, caso.id);

    const r = await cerrarCasoAccesoPorPedido(order({ status: 'completed' }), { origen: 'test' });
    expect(r.cerrado).toBe(true);
    expect(r.casoId).toBe(caso.id);

    const mails = brevo().map((c) => c.body as { to: { email: string }[]; subject: string; sender: { email: string } });
    const alAlumno = mails.filter((m) => m.subject === 'Listo, tu curso ya está activo');
    expect(alAlumno.map((m) => m.to[0].email).sort()).toEqual(['felipe@example.com', 'otro@example.com']);
    const aviso = mails.find((m) => m.subject.startsWith('[Acceso] resuelto'));
    expect(aviso?.sender.email).toBe('info@urologia.ar');
    expect(aviso?.to.map((t) => t.email)).toEqual(['mauro@urologia.ar', 'contacto.urologocarrillo@gmail.com']);

    expect((await getCaso(caso.id))?.estado).toBe('resuelto');

    // Segunda vez: el caso ya no está abierto.
    const r2 = await cerrarCasoAccesoPorPedido(order({ status: 'completed' }), { origen: 'test' });
    expect(r2.cerrado).toBe(false);
  });

  it('sin caso vinculado no manda nada', async () => {
    const r = await cerrarCasoAccesoPorPedido(order(), { origen: 'test' });
    expect(r.cerrado).toBe(false);
    expect(brevo()).toHaveLength(0);
  });

  it('destinatariosAviso suma APPROVAL_EMAIL sin repetir', () => {
    process.env.APPROVAL_EMAIL = 'Mauro@urologia.ar';
    expect(destinatariosAviso()).toEqual(['mauro@urologia.ar', 'contacto.urologocarrillo@gmail.com']);
    process.env.APPROVAL_EMAIL = 'otro@x.com';
    expect(destinatariosAviso()).toEqual(['otro@x.com', 'mauro@urologia.ar', 'contacto.urologocarrillo@gmail.com']);
  });
});
