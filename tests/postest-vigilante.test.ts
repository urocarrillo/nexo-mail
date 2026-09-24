/**
 * Tests del cron postest-vigilante. Se mockean KV, la auth de Google, el
 * dispatch del mail post-test y las alertas; el fetch a Sheets se simula con un
 * Sheet en memoria que registra cada escritura.
 */
import { NextRequest } from 'next/server';

// ── Mock de @vercel/kv: store en memoria con métodos espiables ──
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
    hgetall: jest.fn(async () => null),
  };
  return { kv, __store: store, __reset: () => store.clear() };
});

jest.mock('@/lib/google-auth', () => ({
  getGoogleAccessToken: jest.fn(async () => 'test-token'),
}));

jest.mock('@/lib/postest', () => {
  const actual = jest.requireActual('@/lib/postest');
  return {
    dispatchPostTest: jest.fn(),
    validateEmail: actual.validateEmail,
    esErrorAmbiguo: actual.esErrorAmbiguo,
    SENT_KEY_PREFIX: actual.SENT_KEY_PREFIX,
    SENT_TTL_S: actual.SENT_TTL_S,
  };
});

// Cargas auxiliares por corrida (mapa de clientes / enrolados): sin IO real.
jest.mock('@/lib/clientes', () => {
  const actual = jest.requireActual('@/lib/clientes');
  return { ...actual, getClientes: jest.fn(async () => new Map()) };
});
jest.mock('@/lib/email-drip', () => ({
  getEnrolledSecuenciaEmails: jest.fn(async () => new Set<string>()),
}));

jest.mock('@/lib/alertas', () => ({
  enviarAlerta: jest.fn(async () => true),
}));

import { GET } from '@/app/api/cron/postest-vigilante/route';
import { kv } from '@vercel/kv';
import { dispatchPostTest } from '@/lib/postest';
import { enviarAlerta } from '@/lib/alertas';
import { CRM_TAB } from '@/lib/crm-sheet';

const kvMock = jest.requireMock('@vercel/kv') as {
  __store: Map<string, unknown>;
  __reset: () => void;
};
const mockedDispatch = dispatchPostTest as jest.MockedFunction<typeof dispatchPostTest>;
const mockedAlerta = enviarAlerta as jest.MockedFunction<typeof enviarAlerta>;

const SECRET = 'test-cron-secret';
const NCOLS = 33;

// ── Sheet en memoria ────────────────────────────────────────────────

const HEADER_AT: Record<number, string> = {
  0: '¿Cómo te llamás?',
  1: '¿Cuál es tu mejor email para contactarte?',
  2: '¿En qué rango de edad estás?',
  3: '¿Tu erección funciona bien cuando estás con alguien?',
  4: 'En cuanto a tu salud general, ¿cuál te describe mejor?',
  5: '¿Cómo es tu situación de pareja hoy?',
  6: '¿Cuánto consumís de redes sociales por día?',
  7: '¿Te comprometés a dedicar 20 minutos por día?',
  8: 'En este momento de tu vida, ¿cómo ves la inversión?',
  20: 'Submitted At',
  22: 'Score',
  23: 'Forzador',
  24: 'Pantalla',
  25: 'Variante',
  26: 'Estado seguimiento',
  30: 'Mail enviado',
  31: 'Cliente',
  32: 'Secuencia',
};

function makeHeaders(omit: string[] = []): string[] {
  return Array.from({ length: NCOLS }, (_, i) => {
    const h = HEADER_AT[i];
    if (!h) return `col${i}`;
    return omit.includes(h) ? `otra${i}` : h;
  });
}

interface RowOpts {
  name?: string;
  email: string;
  submitted: string;
  pantalla?: string;
  variante?: string;
  score?: string;
  estado?: string;
  mail?: string;
  secuencia?: string;
  respuestas?: string[]; // 7 respuestas (edad..inversion)
}

const RESP_A = [
  '18 - 49 años',
  'Sí, casi siempre',
  'No tengo enfermedades',
  'No tengo pareja estable',
  'Más de 1 hora',
  'Sí, me comprometo',
  'Sí, es prioridad',
];

function makeRow(o: RowOpts): string[] {
  const r = Array.from({ length: NCOLS }, () => '');
  r[0] = o.name || 'Juan Pérez';
  r[1] = o.email;
  const resp = o.respuestas || RESP_A;
  for (let i = 0; i < 7; i++) r[2 + i] = resp[i] || '';
  r[20] = o.submitted;
  r[22] = o.score ?? '';
  r[24] = o.pantalla ?? '';
  r[25] = o.variante ?? '';
  r[26] = o.estado ?? '';
  r[30] = o.mail ?? '';
  r[32] = o.secuencia ?? '';
  return r;
}

const sheet = { headers: makeHeaders(), rows: [] as string[][] };
interface Write {
  method: string;
  url: string;
  body: Record<string, unknown>;
}
let writes: Write[] = [];
/** Rangos GET que deben fallar (una vez cada uno) para simular errores transitorios. */
let failReadsOnce = new Set<string>();

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function jsonRes(data: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const baseFetch = async (input: string, init?: RequestInit) => {
  const url = decodeURIComponent(String(input));
  const method = init?.method || 'GET';
  if (!url.includes('sheets.googleapis.com')) return jsonRes({}, 201);

  if (method === 'GET') {
    const a1 = url.split('/values/')[1].split('?')[0].split('!')[1];
    if (failReadsOnce.has(a1)) {
      failReadsOnce.delete(a1);
      return jsonRes({ error: 'quota' }, 429);
    }
    if (a1 === '1:1') return jsonRes({ values: [sheet.headers] });
    // copia: los tests pueden mutar sheet.rows "después de la lectura"
    if (a1.startsWith('A2:')) return jsonRes({ values: sheet.rows.map((r) => [...r]) });
    const col = a1.match(/^([A-Z]+)2:([A-Z]+)$/);
    if (col) {
      const c = colIndex(col[1]);
      return jsonRes({ values: sheet.rows.map((r) => (r[c] ? [r[c]] : [])) });
    }
    const m = a1.match(/^([A-Z]+)(\d+)$/);
    if (m) {
      const row = sheet.rows[parseInt(m[2], 10) - 2] || [];
      const v = row[colIndex(m[1])] || '';
      return jsonRes({ values: v ? [[v]] : [] });
    }
    return jsonRes({ error: `range no soportado: ${a1}` }, 400);
  }

  writes.push({ method, url, body: JSON.parse(String(init?.body || '{}')) });
  return jsonRes({});
};
const fetchMock = jest.fn(baseFetch);
global.fetch = fetchMock as unknown as typeof fetch;

function req(query = '', headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
  return new NextRequest(`http://localhost/api/cron/postest-vigilante${query}`, { headers });
}

/** yyyy-mm-dd de hoy en hora Argentina (UTC-3), misma clave que usa el heartbeat. */
function artToday(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const putsMail = () => writes.filter((w) => w.method === 'PUT');
const batches = () => writes.filter((w) => w.url.endsWith('values:batchUpdate'));

beforeEach(() => {
  kvMock.__reset();
  jest.clearAllMocks();
  fetchMock.mockImplementation(baseFetch); // los tests que lo envuelven no deben contaminar a los demás
  writes = [];
  failReadsOnce = new Set();
  sheet.headers = makeHeaders();
  sheet.rows = [];
  // Heartbeat ya enviado hoy (el test de heartbeat lo borra a propósito)
  kvMock.__store.set(`vigilante:heartbeat:${artToday()}`, 'x');
  process.env.CRON_SECRET = SECRET;
  process.env.APPROVAL_EMAIL = 'alertas@test.local';
  process.env.BREVO_API_KEY = 'test-api-key';
  process.env.POSTEST_CUTOFF = '2026-08-01T00:00:00.000Z';
  mockedDispatch.mockResolvedValue({ success: true, tier: 'A', pantalla: 'A', messageId: 'mid-1' });
  mockedAlerta.mockResolvedValue(true);
});

describe('auth', () => {
  it('sin CRON_SECRET → 500 (nunca público)', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin credencial → 401', async () => {
    const res = await GET(req('', {}));
    expect(res.status).toBe(401);
  });

  it('acepta ?token=', async () => {
    const res = await GET(req(`?token=${SECRET}&dry=1`, {}));
    expect(res.status).toBe(200);
  });

  it('sin APPROVAL_EMAIL → 500 (alertas no configuradas), sin leer el Sheet', async () => {
    delete process.env.APPROVAL_EMAIL;
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('alertas no configuradas');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('error de KV al tomar el lock → alerta + 500', async () => {
    (kv.set as jest.Mock).mockRejectedValueOnce(new Error('KV down'));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toBe('VIGILANTE: KV no disponible');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('columnas', () => {
  it('columna faltante → 500, alerta y cero envíos', async () => {
    sheet.headers = makeHeaders(['Mail enviado']);
    sheet.rows = [makeRow({ email: 'a@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];

    const res = await GET(req());
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.ok).toBe(false);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toBe('VIGILANTE: columna faltante');
    expect(mockedAlerta.mock.calls[0][1]).toContain('Mail enviado');

    // Segunda corrida dentro de la hora: mismo 500 pero sin repetir el mail
    const res2 = await GET(req());
    expect(res2.status).toBe(500);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
  });

  it('columnas opcionales Cliente/Secuencia ausentes → sigue funcionando (camino legacy)', async () => {
    sheet.headers = makeHeaders(['Cliente', 'Secuencia']);
    sheet.rows = [makeRow({ email: 'ok@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    const data = await (await GET(req())).json();
    expect(data.sent.A).toBe(1);
    expect(mockedDispatch.mock.calls[0][1]).toEqual(expect.objectContaining({ deferMarks: false }));
  });
});

describe('candidatos', () => {
  it('fila anterior al cutoff → no se envía', async () => {
    sheet.rows = [makeRow({ email: 'viejo@x.com', submitted: '15/7/2026 10:00:00', pantalla: 'A' })];

    const res = await GET(req());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.candidates).toBe(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(putsMail()).toHaveLength(0);
  });

  it('fila con Estado seguimiento → skipped.estado', async () => {
    sheet.rows = [
      makeRow({ email: 'seg@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A', estado: 'CONTACTADO' }),
    ];
    const data = await (await GET(req())).json();
    expect(data.candidates).toBe(0);
    expect(data.skipped.estado).toBe(1);
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('duplicado por email (otra fila ya marcada) → no se envía y se marca dup', async () => {
    sheet.rows = [
      makeRow({ email: 'Dup@X.com', submitted: '5/8/2026 10:00:00', pantalla: 'A', mail: 'auto 05/08/2026 10:05' }),
      makeRow({ email: 'dup@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' }),
    ];

    const data = await (await GET(req())).json();

    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(data.skipped.dup).toBe(1);
    expect(data.sent).toEqual({ A: 0, B: 0, C: 0 });
    // marca "dup dd/mm/yyyy" en la fila 3 (AE = columna 'Mail enviado')
    const b = batches();
    expect(b).toHaveLength(1);
    const d = b[0].body.data as Array<{ range: string; values: string[][] }>;
    expect(d[0].range).toBe(`${CRM_TAB}!AE3`);
    expect(d[0].values[0][0]).toMatch(/^dup \d{2}\/\d{2}\/\d{4}$/);
  });

  it('mismo email dos veces en la corrida → 1 envío + 1 dup', async () => {
    sheet.rows = [
      makeRow({ email: 'dos@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' }),
      makeRow({ email: 'dos@x.com', submitted: '11/8/2026 10:00:00', pantalla: 'A' }),
    ];
    const data = await (await GET(req())).json();
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(data.sent.A).toBe(1);
    expect(data.skipped.dup).toBe(1);
  });

  it('tier C con "Mail C enviado" en Secuencia (backfill) → dup, no se reenvía', async () => {
    sheet.rows = [
      makeRow({ email: 'c@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'C', secuencia: 'Mail C enviado 10/08' }),
    ];
    const data = await (await GET(req())).json();
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(data.skipped.dup).toBe(1);
    const d = batches()[0].body.data as Array<{ range: string; values: string[][] }>;
    expect(d[0].range).toBe(`${CRM_TAB}!AE2`);
    expect(d[0].values[0][0]).toMatch(/^dup /);
  });

  it('marca dup NO se escribe si la fila ya no contiene ese email', async () => {
    sheet.rows = [
      makeRow({ email: 'dup@x.com', submitted: '5/8/2026 10:00:00', pantalla: 'A', mail: 'manual' }),
      makeRow({ email: 'dup@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' }),
    ];
    // La fila 3 cambia de email después de la lectura inicial
    fetchMock.mockImplementation(async (input, init) => {
      const r = await baseFetch(input, init);
      if (String(input).includes('A2%3A')) sheet.rows[1][1] = 'otro@x.com';
      return r;
    });

    const data = await (await GET(req())).json();
    expect(data.skipped.dup).toBe(1);
    expect(batches()).toHaveLength(0);
    expect(data.alerts.some((a: string) => a.includes('NO escrita'))).toBe(true);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
  });

  it('fecha m/d/yyyy ("9/15/2026") → sin_fecha, no candidato ni futuro', async () => {
    sheet.rows = [makeRow({ email: 'us@x.com', submitted: '9/15/2026 10:00:00', pantalla: 'A' })];
    const data = await (await GET(req('?dry=1'))).json();
    expect(data.skipped.sin_fecha).toBe(1);
    expect(data.skipped.futuro).toBe(0);
    expect(data.candidates).toBe(0);
    expect(data.alerts.some((a: string) => a.includes('formato de fecha'))).toBe(true);
  });

  it('fecha futura → skipped.futuro y aviso', async () => {
    sheet.rows = [makeRow({ email: 'fut@x.com', submitted: '1/1/2099 10:00:00', pantalla: 'A' })];
    const data = await (await GET(req())).json();
    expect(data.skipped.futuro).toBe(1);
    expect(data.candidates).toBe(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][1]).toContain('en el futuro');
  });

  it('Pantalla no reconocida → pantalla_invalida, sin envío', async () => {
    sheet.rows = [makeRow({ email: 'raro@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'D' })];
    const data = await (await GET(req())).json();
    expect(data.skipped.pantalla_invalida).toBe(1);
    expect(mockedDispatch).not.toHaveBeenCalled();
  });
});

describe('envío', () => {
  it('envío exitoso → dispatch con el payload y marca "auto " en la fila correcta', async () => {
    sheet.rows = [
      makeRow({ email: 'otro@x.com', submitted: '12/8/2026 09:00:00', pantalla: 'B-AUTO', variante: 'B-AUTO', score: '60', mail: 'auto 12/08/2026 09:15' }),
      makeRow({ name: 'Pedro Gómez', email: 'Nuevo@X.com', submitted: '10/8/2026 11:29:08', pantalla: 'A', variante: 'A-Limpia', score: '110' }),
    ];

    const res = await GET(req());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'nuevo@x.com',
        name: 'Pedro Gómez',
        pantalla: 'A',
        variante: 'A-Limpia',
        score: 110,
        tier: 'A',
        respuestas: expect.objectContaining({ ereccion: expect.any(String) }),
      }),
      // cargas auxiliares una vez por corrida + marcas diferidas a la fila conocida
      { clientes: expect.any(Map), alreadyEnrolled: expect.any(Set), deferMarks: true }
    );

    const puts = putsMail();
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain(`${CRM_TAB}!AE3`);
    expect(puts[0].url).toContain('valueInputOption=RAW');
    expect((puts[0].body.values as string[][])[0][0]).toMatch(/^auto \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);

    expect(data.sent).toEqual({ A: 1, B: 0, C: 0 });
    expect(data.failed).toBe(0);
    expect(kvMock.__store.has('postest-sent:nuevo@x.com')).toBe(true);
    // lock liberado
    expect(kvMock.__store.has('lock:postest-vigilante')).toBe(false);
  });

  it('procesa las más antiguas primero y respeta ?max', async () => {
    sheet.rows = [
      makeRow({ email: 'c@x.com', submitted: '12/8/2026 10:00:00', pantalla: 'A' }),
      makeRow({ email: 'a@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' }),
      makeRow({ email: 'b@x.com', submitted: '11/8/2026 10:00:00', pantalla: 'C' }),
    ];
    mockedDispatch.mockImplementation(async (p) => ({ success: true, tier: p.tier, pantalla: p.pantalla, sent: true }));

    const data = await (await GET(req('?max=2'))).json();

    expect(mockedDispatch.mock.calls.map((c) => c[0].email)).toEqual(['a@x.com', 'b@x.com']);
    expect(data.sent).toEqual({ A: 1, B: 0, C: 1 });
    expect(data.remaining).toBe(1);
    // quedó pendiente → una alerta de resumen
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toContain('1 pendientes');
  });

  it('envío fallido → kv.del de la key, failed=1, sin marca', async () => {
    sheet.rows = [makeRow({ email: 'falla@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    mockedDispatch.mockResolvedValue({ success: false, tier: 'A', pantalla: 'A', stage: 'send', error: 'Brevo 500' });

    const data = await (await GET(req())).json();

    expect(data.failed).toBe(1);
    expect(data.sent.A).toBe(0);
    expect(kv.del).toHaveBeenCalledWith('postest-sent:falla@x.com');
    expect(kvMock.__store.has('postest-sent:falla@x.com')).toBe(false);
    expect(putsMail()).toHaveLength(0);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toContain('1 fallidos');
  });

  it('la guardia KV se setea en dos fases: inflight antes, ISO después', async () => {
    sheet.rows = [makeRow({ email: 'fases@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    await GET(req());
    const mine = (kv.set as jest.Mock).mock.calls.filter(([k]) => k === 'postest-sent:fases@x.com');
    expect(mine).toHaveLength(2);
    expect(mine[0][1]).toBe('inflight');
    expect(mine[0][2]).toEqual({ nx: true, ex: 300 });
    expect(mine[1][2]).toEqual({ ex: 60 * 60 * 24 * 60 });
    expect(kvMock.__store.get('postest-sent:fases@x.com')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('envío ambiguo (timeout de Brevo) → NO kv.del, marca "auto?" y alerta', async () => {
    sheet.rows = [makeRow({ email: 'amb@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    mockedDispatch.mockResolvedValue({
      success: false,
      tier: 'A',
      pantalla: 'A',
      stage: 'send',
      error: 'Brevo send error: TimeoutError: The operation was aborted due to timeout',
    });

    const data = await (await GET(req())).json();

    expect(data.failed).toBe(0);
    expect(data.ambiguous).toBe(1);
    expect(data.sent.A).toBe(0);
    expect(kv.del).not.toHaveBeenCalledWith('postest-sent:amb@x.com');
    expect(kvMock.__store.get('postest-sent:amb@x.com')).toMatch(/^ambiguo /);
    const puts = putsMail();
    expect(puts).toHaveLength(1);
    expect((puts[0].body.values as string[][])[0][0]).toMatch(/^auto\? \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][1]).toContain('envío ambiguo');
  });

  it('timeout en etapa contacto (sin mail) → sí se reintenta (kv.del)', async () => {
    sheet.rows = [makeRow({ email: 'ct@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    mockedDispatch.mockResolvedValue({
      success: false,
      tier: 'A',
      pantalla: 'A',
      stage: 'contact',
      error: 'Brevo contact error: TimeoutError',
    });
    const data = await (await GET(req())).json();
    expect(data.failed).toBe(1);
    expect(data.ambiguous).toBe(0);
    expect(kv.del).toHaveBeenCalledWith('postest-sent:ct@x.com');
  });

  it('tier C con timeout ambiguo → "auto?" y sin reintento', async () => {
    sheet.rows = [makeRow({ email: 'camb@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'C' })];
    mockedDispatch.mockResolvedValue({
      success: true,
      tier: 'C',
      pantalla: 'C',
      sent: false,
      sendError: 'TimeoutError: Brevo send (tier C) > 8000 ms',
    });
    const data = await (await GET(req())).json();
    expect(data.ambiguous).toBe(1);
    expect(data.failed).toBe(0);
    expect(kv.del).not.toHaveBeenCalledWith('postest-sent:camb@x.com');
    expect((putsMail()[0].body.values as string[][])[0][0]).toMatch(/^auto\? /);
  });

  it('fallo al marcar "auto" tras envío OK → alerta igual (alerts.length > 0)', async () => {
    sheet.rows = [makeRow({ email: 'nomarca@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') return jsonRes({ error: 'boom' }, 500);
      return baseFetch(input, init);
    });

    const data = await (await GET(req())).json();
    expect(data.sent.A).toBe(1);
    expect(data.failed).toBe(0);
    expect(data.alerts.some((a: string) => a.includes('no se pudo marcar fila 2'))).toBe(true);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toContain('1 aviso');
    // la key larga quedó: la próxima corrida no reenvía
    expect(kvMock.__store.get('postest-sent:nomarca@x.com')).toMatch(/^\d{4}-/);
  });

  it('PUT con 429 → reintenta una vez y marca', async () => {
    sheet.rows = [makeRow({ email: 'cuota@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    let puts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PUT' && puts++ === 0) return jsonRes({ error: 'quota' }, 429);
      return baseFetch(input, init);
    });
    const data = await (await GET(req())).json();
    expect(data.sent.A).toBe(1);
    expect(putsMail()).toHaveLength(1);
    expect(data.alerts).toHaveLength(0);
  });

  it('marcas pendientes de dispatch (Secuencia) se escriben en la fila verificada', async () => {
    sheet.rows = [makeRow({ email: 'c@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'C' })];
    mockedDispatch.mockResolvedValue({
      success: true,
      tier: 'C',
      pantalla: 'C',
      sent: true,
      pendingMarks: [{ col: 'secuencia', text: 'Mail C enviado 10/08' }],
    });
    const data = await (await GET(req())).json();
    expect(data.sent.C).toBe(1);
    expect(mockedDispatch.mock.calls[0][1]).toEqual(expect.objectContaining({ deferMarks: true }));
    const puts = putsMail();
    expect(puts).toHaveLength(2);
    expect(puts[0].url).toContain(`${CRM_TAB}!AE2`);
    expect(puts[1].url).toContain(`${CRM_TAB}!AG2`);
    expect((puts[1].body.values as string[][])[0][0]).toBe('Mail C enviado 10/08');
  });

  it('tier C con sent=false cuenta como fallo (no se marca)', async () => {
    sheet.rows = [makeRow({ email: 'c@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'C' })];
    mockedDispatch.mockResolvedValue({ success: true, tier: 'C', pantalla: 'C', sent: false, sendError: 'x' });

    const data = await (await GET(req())).json();
    expect(data.failed).toBe(1);
    expect(putsMail()).toHaveLength(0);
  });

  it('cliente-programa → skipped.cliente y se marca la fila igual', async () => {
    sheet.rows = [makeRow({ email: 'alumno@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    mockedDispatch.mockResolvedValue({ success: true, skipped: true, reason: 'cliente-programa', tier: 'A', pantalla: 'A' });

    const data = await (await GET(req())).json();
    expect(data.skipped.cliente).toBe(1);
    expect(data.sent.A).toBe(0);
    expect(putsMail()).toHaveLength(1);
  });

  it('key KV ya existente (enviado) → kv-dup, sin envío, con alerta', async () => {
    sheet.rows = [makeRow({ email: 'ya@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    kvMock.__store.set('postest-sent:ya@x.com', '2026-08-10T13:00:00.000Z');

    const data = await (await GET(req())).json();
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(data.skipped.kvdup).toBe(1);
    const d = batches()[0].body.data as Array<{ values: string[][] }>;
    expect(d[0].values[0][0]).toMatch(/^kv-dup /);
    // kv-dup siempre es anomalía: avisa
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][1]).toContain('kv-dup fila 2');
  });

  it('key KV "inflight" (corrida anterior murió) → se salta SIN marcar, se reintenta luego', async () => {
    sheet.rows = [makeRow({ email: 'inf@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    kvMock.__store.set('postest-sent:inf@x.com', 'inflight');

    const data = await (await GET(req())).json();
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(data.skipped.kvdup).toBe(1);
    expect(batches()).toHaveLength(0);
    expect(putsMail()).toHaveLength(0);
    expect(mockedAlerta.mock.calls[0][1]).toContain('inflight fila 2');
  });

  it('error transitorio al releer la celda → NO es "fila movida": reintenta, marca y avisa', async () => {
    sheet.rows = [makeRow({ email: 'tr@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' })];
    failReadsOnce.add('B2');

    const data = await (await GET(req())).json();
    expect(data.ok).toBe(true);
    expect(data.sent.A).toBe(1);
    expect(putsMail()).toHaveLength(1);
    expect(mockedAlerta.mock.calls.map((c) => c[0])).not.toContain('VIGILANTE: fila movida');
    // 429 → reintento OK → sin aviso de verificación
    expect(data.alerts).toHaveLength(0);
  });

  it('fila movida (email releído no coincide) → alerta, corta sin marcar y no escribe marcas dup', async () => {
    sheet.rows = [
      makeRow({ email: 'ya@x.com', submitted: '9/8/2026 10:00:00', pantalla: 'A', mail: 'manual' }),
      makeRow({ email: 'ya@x.com', submitted: '9/8/2026 11:00:00', pantalla: 'A' }),
      makeRow({ email: 'uno@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A' }),
      makeRow({ email: 'dos@x.com', submitted: '11/8/2026 10:00:00', pantalla: 'A' }),
    ];
    mockedDispatch.mockImplementation(async (p) => {
      // simulamos que alguien insertó una fila arriba mientras se enviaba
      sheet.rows[2][1] = 'intruso@x.com';
      return { success: true, tier: p.tier, pantalla: p.pantalla };
    });

    const res = await GET(req());
    const data = await res.json();

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(putsMail()).toHaveLength(0);
    expect(data.ok).toBe(false);
    expect(data.remaining).toBe(1);
    expect(data.skipped.dup).toBe(1);
    expect(batches()).toHaveLength(0); // la marca dup NO se escribe con índices sospechosos
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toBe('VIGILANTE: fila movida');
  });

  it('lock tomado → skipped locked, sin leer el Sheet', async () => {
    kvMock.__store.set('lock:postest-vigilante', 'x');
    const data = await (await GET(req())).json();
    expect(data.skipped).toBe('locked');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tiers', () => {
  it('Pantalla vacía con respuestas → calcula y escribe Score..Variante en una batchUpdate, y envía', async () => {
    sheet.rows = [makeRow({ email: 'sintier@x.com', submitted: '10/8/2026 10:00:00' })];

    const data = await (await GET(req())).json();

    expect(data.tiered).toBe(1);
    const b = batches();
    expect(b.length).toBeGreaterThanOrEqual(1);
    expect(b[0].body.valueInputOption).toBe('RAW');
    const d = b[0].body.data as Array<{ range: string; values: unknown[][] }>;
    expect(d).toHaveLength(1);
    expect(d[0].range).toBe(`${CRM_TAB}!W2:Z2`);
    expect(d[0].values[0]).toEqual([110, '', 'A', 'A-Limpia']);

    expect(mockedDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'sintier@x.com', pantalla: 'A', variante: 'A-Limpia', score: 110, tier: 'A' }),
      expect.anything()
    );
    expect(data.sent.A).toBe(1);
  });

  it('respuestas incompletas → no calcula ni envía', async () => {
    sheet.rows = [
      makeRow({ email: 'inc@x.com', submitted: '10/8/2026 10:00:00', respuestas: ['', ...RESP_A.slice(1)] }),
    ];
    const data = await (await GET(req())).json();
    expect(data.tiered).toBe(0);
    expect(data.skipped.sin_tier).toBe(0);
    expect(data.candidates).toBe(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('respuesta no reconocible (opción del Typeform cambiada) → sin_tier, sin envío y alerta', async () => {
    const resp = [...RESP_A];
    resp[1] = 'Si, casi siempre'; // sin tilde
    sheet.rows = [makeRow({ email: 'des@x.com', submitted: '10/8/2026 10:00:00', respuestas: resp })];

    const data = await (await GET(req())).json();
    expect(data.tiered).toBe(0);
    expect(data.skipped.sin_tier).toBe(1);
    expect(batches()).toHaveLength(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][1]).toContain('ereccion = "Si, casi siempre"');

    // Misma anomalía en la corrida siguiente: no repite el mail (throttle 1 h)
    await GET(req());
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
  });

  it('filas movidas entre la lectura y la escritura de tiers → 500, alerta, sin escrituras ni envíos', async () => {
    sheet.rows = [
      makeRow({ email: 'a@x.com', submitted: '10/8/2026 10:00:00' }),
      makeRow({ email: 'b@x.com', submitted: '11/8/2026 10:00:00' }),
    ];
    fetchMock.mockImplementation(async (input, init) => {
      const r = await baseFetch(input, init);
      // tras la lectura completa alguien ordena el Sheet
      if (String(input).includes('A2%3A')) sheet.rows.reverse();
      return r;
    });

    const res = await GET(req());
    const data = await res.json();
    expect(res.status).toBe(500);
    expect(writes).toHaveLength(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toBe('VIGILANTE: filas movidas');
    expect(data.alerts[0]).toContain('filas movidas antes de escribir tiers: 2');
  });
});

describe('dry=1', () => {
  it('cero escrituras, cero envíos, cero KV; reporta conteos y muestra enmascarada', async () => {
    sheet.rows = [
      makeRow({ email: 'sintier@x.com', submitted: '10/8/2026 10:00:00' }),
      makeRow({ email: 'listo@x.com', submitted: '11/8/2026 10:00:00', pantalla: 'B-CONTACTO' }),
      makeRow({ email: 'viejo@x.com', submitted: '1/7/2026 10:00:00', pantalla: 'A' }),
    ];

    const res = await GET(req('?dry=1'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.dry).toBe(true);
    expect(data.rows).toBe(3);
    expect(data.tiered).toBe(1);
    expect(data.candidates).toBe(2);
    expect(data.sample).toHaveLength(2);
    expect(data.sample[0].email).toBe('si***@x.com');
    expect(data.sample.map((s: { row: number }) => s.row)).toEqual([2, 3]);

    expect(writes).toHaveLength(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(kv.set).not.toHaveBeenCalled();
    expect(mockedAlerta).not.toHaveBeenCalled();
  });
});

describe('heartbeat', () => {
  it('primera corrida del día → mail VIGILANTE OK; la segunda no repite', async () => {
    sheet.rows = [makeRow({ email: 'ok@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A', mail: 'manual' })];
    kvMock.__store.delete(`vigilante:heartbeat:${artToday()}`);

    await GET(req());
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toMatch(/^VIGILANTE OK \d{4}-\d{2}-\d{2} · SIN TESTS 48H$/);

    await GET(req());
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
  });

  it('si el mail del heartbeat falla, se libera la key para reintentar', async () => {
    kvMock.__store.delete(`vigilante:heartbeat:${artToday()}`);
    mockedAlerta.mockResolvedValueOnce(false);

    const data = await (await GET(req())).json();
    expect(data.alert_sent).toBe(false);
    expect(kvMock.__store.has(`vigilante:heartbeat:${artToday()}`)).toBe(false);

    await GET(req());
    expect(mockedAlerta).toHaveBeenCalledTimes(2);
    expect(kvMock.__store.has(`vigilante:heartbeat:${artToday()}`)).toBe(true);
  });

  it('cuenta "auto?" (ambiguos) como enviados del día', async () => {
    const hoy = artToday().split('-').reverse().join('/');
    sheet.rows = [
      makeRow({ email: 'a@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'A', mail: `auto ${hoy} 10:00` }),
      makeRow({ email: 'b@x.com', submitted: '10/8/2026 10:00:00', pantalla: 'C', mail: `auto? ${hoy} 10:05` }),
    ];
    kvMock.__store.delete(`vigilante:heartbeat:${artToday()}`);
    await GET(req());
    expect(mockedAlerta.mock.calls[0][1]).toContain('Enviados en 24 h: A=1 B=0 C=1');
  });
});
