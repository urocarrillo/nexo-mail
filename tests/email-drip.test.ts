/**
 * Tests del motor drip para las tareas T9 (recupero de carrito) y el gating
 * temporal de la secuencia (que el cambio de cron a corridas cada 2 h NO adelanta
 * los envíos). Se mockean las dependencias de IO (KV, clientes, brevo, crm-sheet)
 * y el fetch de Brevo; la lógica de email-drip se ejerce de verdad.
 */

// ── Mock de @vercel/kv: store en memoria con accesores para inspección ──
jest.mock('@vercel/kv', () => {
  const hashes = new Map<string, Map<string, string>>();
  const store = new Map<string, unknown>();
  const kv = {
    async hgetall(key: string) {
      const h = hashes.get(key);
      if (!h || h.size === 0) return null;
      return Object.fromEntries(h);
    },
    async hset(key: string, obj: Record<string, string>) {
      let h = hashes.get(key);
      if (!h) {
        h = new Map();
        hashes.set(key, h);
      }
      for (const [k, v] of Object.entries(obj)) h.set(k, v);
      return Object.keys(obj).length;
    },
    async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
  };
  return {
    kv,
    __hashes: hashes,
    __store: store,
    __reset: () => {
      hashes.clear();
      store.clear();
    },
  };
});

jest.mock('@/lib/clientes', () => ({
  esCliente: jest.fn(async () => false),
  getClientes: jest.fn(async () => new Map()),
}));

jest.mock('@/lib/brevo', () => ({
  isEmailBlacklisted: jest.fn(async () => false),
}));

jest.mock('@/lib/crm-sheet', () => ({
  readCrmSheet: jest.fn(async () => ({ rows: [] })),
  writeSecuenciaMarks: jest.fn(async () => {}),
}));

import {
  enqueueRecupero,
  cancelDripForEmail,
  processDripQueue,
  RECUPERO_TAG,
} from '@/lib/email-drip';
import { esCliente, getClientes } from '@/lib/clientes';
import { isEmailBlacklisted } from '@/lib/brevo';
import { readCrmSheet, writeSecuenciaMarks } from '@/lib/crm-sheet';

const kvMock = jest.requireMock('@vercel/kv') as {
  __hashes: Map<string, Map<string, string>>;
  __store: Map<string, unknown>;
  __reset: () => void;
};

const QUEUE = 'drip:queue';

const mockedEsCliente = esCliente as jest.MockedFunction<typeof esCliente>;
const mockedGetClientes = getClientes as jest.MockedFunction<typeof getClientes>;
const mockedIsBlacklisted = isEmailBlacklisted as jest.MockedFunction<typeof isEmailBlacklisted>;
const mockedReadCrm = readCrmSheet as jest.MockedFunction<typeof readCrmSheet>;
const mockedWriteSecuencia = writeSecuenciaMarks as jest.MockedFunction<typeof writeSecuenciaMarks>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function queueEntries(): Record<string, unknown>[] {
  const h = kvMock.__hashes.get(QUEUE);
  if (!h) return [];
  return [...h.values()].map((j) => JSON.parse(j));
}

beforeEach(() => {
  kvMock.__reset();
  jest.clearAllMocks();
  mockedEsCliente.mockResolvedValue(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedGetClientes.mockResolvedValue(new Map() as any);
  mockedIsBlacklisted.mockResolvedValue(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedReadCrm.mockResolvedValue({ rows: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedWriteSecuencia.mockResolvedValue(undefined as any);
  fetchMock.mockResolvedValue({
    status: 201,
    json: async () => ({ messageId: 'test-msg-id' }),
    text: async () => '',
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('enqueueRecupero (T9)', () => {
  it('encola un mail de recupero kind=recupero con sendAt = +2 h', async () => {
    const r = await enqueueRecupero({ email: 'Lead@X.com', name: 'Juan', orderId: '999' });
    expect(r.enqueued).toBe(true);

    const entries = queueEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0] as Record<string, string>;
    expect(e.kind).toBe('recupero');
    expect(e.tag).toBe(RECUPERO_TAG);
    expect(e.email).toBe('lead@x.com'); // normalizado
    expect(e.status).toBe('pending');
    expect(e.subject).toBe('se trabó tu inscripción');

    const delta = new Date(e.sendAt).getTime() - new Date(e.createdAt).getTime();
    expect(delta).toBe(2 * 60 * 60 * 1000);

    // Dedupe key reclamada.
    expect(kvMock.__store.has('recupero-dedupe:lead@x.com')).toBe(true);
  });

  it('dedupe: máximo 1 recupero por email cada 30 días', async () => {
    const r1 = await enqueueRecupero({ email: 'a@x.com', orderId: '1' });
    expect(r1.enqueued).toBe(true);

    const r2 = await enqueueRecupero({ email: 'a@x.com', orderId: '2' });
    expect(r2.enqueued).toBe(false);
    expect(r2.reason).toBe('dedupe');

    // Sólo un mail en la cola.
    expect(queueEntries()).toHaveLength(1);
  });

  it('skip si ya es cliente (pudo pagar con otra orden) — no encola ni reclama dedupe', async () => {
    mockedEsCliente.mockResolvedValue(true);
    const r = await enqueueRecupero({ email: 'buyer@x.com', orderId: '5' });
    expect(r.enqueued).toBe(false);
    expect(r.reason).toBe('cliente');
    expect(queueEntries()).toHaveLength(0);
    // No reclama la clave de dedupe (para no bloquear un recupero futuro legítimo).
    expect(kvMock.__store.has('recupero-dedupe:buyer@x.com')).toBe(false);
  });
});

describe('cancelDripForEmail cancela también los recupero pendientes (T9 regla d)', () => {
  it('marca cancelled el recupero al comprar', async () => {
    await enqueueRecupero({ email: 'x@x.com', name: 'Ana', orderId: '1' });
    const { cancelled } = await cancelDripForEmail('X@X.com');
    expect(cancelled).toBe(1);

    const e = queueEntries()[0] as Record<string, string>;
    expect(e.status).toBe('cancelled');
    expect(e.cancelReason).toBe('compra');
  });
});

describe('processDripQueue — el cron cada 2 h NO adelanta la secuencia', () => {
  // Un mail de secuencia con sendAt=12:00 UTC NO debe salir en la corrida de las
  // 11:00 UTC; sí en la de las 13:00 UTC. El gating es por sendAt, independiente
  // de la frecuencia del cron.
  function seedSecuenciaM1() {
    const entry = {
      id: 'sq_test_1',
      email: 'lead@x.com',
      name: 'Juan',
      tag: 'secuencia-post-typeform',
      stepIndex: 1,
      templateId: 0,
      subject: '¿lo pudiste ver?',
      sendAt: '2026-07-10T12:00:00.000Z',
      status: 'pending',
      createdAt: '2026-07-08T12:00:00.000Z',
      kind: 'secuencia',
      seqStep: 1,
      mailVariant: 'A',
    };
    kvMock.__hashes.set(QUEUE, new Map([['sq_test_1', JSON.stringify(entry)]]));
  }

  it('no envía a las 11:00 UTC (sendAt en el futuro) y sí a las 13:00 UTC', async () => {
    seedSecuenciaM1();

    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T11:00:00Z'));
    let res = await processDripQueue();
    expect(res.sent).toBe(0);
    expect(res.remaining).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((queueEntries()[0] as Record<string, string>).status).toBe('pending');

    jest.setSystemTime(new Date('2026-07-10T13:00:00Z'));
    res = await processDripQueue();
    expect(res.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((queueEntries()[0] as Record<string, string>).status).toBe('sent');
  });
});

describe('processDripQueue — envío de recupero re-chequea antes de mandar', () => {
  function seedRecupero(email: string) {
    const entry = {
      id: 'rec_1',
      email,
      name: 'Ana',
      tag: RECUPERO_TAG,
      stepIndex: 0,
      templateId: 0,
      subject: 'se trabó tu inscripción',
      sendAt: '2026-07-10T10:00:00.000Z',
      status: 'pending',
      createdAt: '2026-07-10T08:00:00.000Z',
      kind: 'recupero',
    };
    kvMock.__hashes.set(QUEUE, new Map([['rec_1', JSON.stringify(entry)]]));
  }

  it('cancela (no envía) si para entonces ya es cliente', async () => {
    seedRecupero('buyer@x.com');
    mockedEsCliente.mockResolvedValue(true);

    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T13:00:00Z'));
    const res = await processDripQueue();

    expect(res.sent).toBe(0);
    expect(res.cancelled).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((queueEntries()[0] as Record<string, string>).cancelReason).toBe('cliente');
  });

  it('cancela (no envía) si está blacklisted', async () => {
    seedRecupero('bl@x.com');
    mockedIsBlacklisted.mockResolvedValue(true);

    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T13:00:00Z'));
    const res = await processDripQueue();

    expect(res.sent).toBe(0);
    expect(res.cancelled).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((queueEntries()[0] as Record<string, string>).cancelReason).toBe('blacklist');
  });

  it('envía si sigue siendo lead y no está blacklisted', async () => {
    seedRecupero('lead2@x.com');

    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T13:00:00Z'));
    const res = await processDripQueue();

    expect(res.sent).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((queueEntries()[0] as Record<string, string>).status).toBe('sent');
  });
});
