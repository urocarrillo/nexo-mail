/**
 * Tests del endpoint /api/form/test-programa (test propio del programa DE).
 * Se mockean KV, la auth de Google, dispatchPostTest y las alertas; Sheets y
 * Brevo se simulan con un fetch en memoria que registra cada llamada.
 */
import { NextRequest } from 'next/server';

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
    incr: jest.fn(),
    expire: jest.fn(async () => 1),
  };
  const incrImpl = async (key: string) => {
    const n = (typeof store.get(key) === 'number' ? (store.get(key) as number) : 0) + 1;
    store.set(key, n);
    return n;
  };
  kv.incr.mockImplementation(incrImpl);
  return { kv, __store: store, __reset: () => store.clear(), __incrImpl: incrImpl };
});

jest.mock('@/lib/google-auth', () => ({
  getGoogleAccessToken: jest.fn(async () => 'test-token'),
}));

jest.mock('@/lib/postest', () => ({
  SENT_KEY_PREFIX: 'postest-sent:',
  SENT_TTL_S: 60 * 60 * 24 * 60,
  esErrorAmbiguo: jest.requireActual('@/lib/postest').esErrorAmbiguo,
  dispatchPostTest: jest.fn(),
}));

jest.mock('@/lib/alertas', () => ({
  enviarAlerta: jest.fn(async () => true),
}));

import { POST } from '@/app/api/form/test-programa/route';
import { kv } from '@vercel/kv';
import { dispatchPostTest } from '@/lib/postest';
import { enviarAlerta } from '@/lib/alertas';
import { CRM_TAB, colLetter } from '@/lib/crm-sheet';
import {
  CONTACTO_TEXTOS,
  OPCIONES,
  cleanName,
  cleanVerbatim,
  emailCanonico,
  formatSubmittedAt,
  parseSubmittedAt,
  resetNewColumnsCache,
  resolverColumnas,
  validateContacto,
  validateFinal,
  validatePartial,
  filaDesdeUpdatedRange,
  generarToken,
} from '@/lib/test-programa';

const kvMock = jest.requireMock('@vercel/kv') as {
  __store: Map<string, unknown>;
  __reset: () => void;
  __incrImpl: (key: string) => Promise<number>;
};
const mockedDispatch = dispatchPostTest as jest.MockedFunction<typeof dispatchPostTest>;
const mockedAlerta = enviarAlerta as jest.MockedFunction<typeof enviarAlerta>;

// ── Sheet en memoria (headers en orden distinto al "esperado") ─────

const H = {
  submitted: 'Submitted At',
  email: '¿Cuál es tu mejor email para contactarte?',
  nombre: '¿Cómo te llamás?',
  token: 'Token',
  edad: '¿En qué rango de edad estás?',
  ereccion: '¿Tu erección funciona bien cuando estás solo (autoestimulación) o tenés erecciones espontáneas (noche/mañana)?',
  salud: 'En cuanto a tu salud general, ¿con cuál te identificás más?',
  pareja: '¿Cómo es tu situación de pareja hoy?',
  consumo: '¿Cuánto consumís de redes sociales y/o pornografía al día? Si tuviste un periodo problemático reciente (últimos 6 meses), respondé por ese periodo.',
  compromiso: '¿Te comprometés a dedicar 15-30 minutos diarios a las prácticas del programa durante al menos 8 semanas para lograr una transformación real y sostenida?',
  inversion: 'En este momento de tu vida, ¿estás dispuesto a invertir en tu salud y calidad de vida íntima?',
  contacto: 'Por lo que me contás, el programa puede funcionar bien para vos. Pero antes de comprar conviene que conversemos para asegurarnos. ¿Cómo te contacto?',
  telWa: 'Dejame tu número completo con código de país',
  telAr: 'Dejame tu número de teléfono (Argentina) — código de área + número, sin 15',
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  utmContent: 'utm_content',
  scoreTf: 'score',
  score: 'Score',
  forzador: 'Forzador',
  pantalla: 'Pantalla',
  variante: 'Variante',
  estado: 'Estado seguimiento',
  mail: 'Mail enviado',
  cliente: 'Cliente',
  secuencia: 'Secuencia',
  pais: 'País',
  verbatim: 'Verbatim',
};

/** Orden deliberadamente distinto al del Typeform: la fila debe alinearse por nombre. */
const BASE_HEADERS = [
  H.submitted, H.email, H.nombre, H.token, H.edad, H.ereccion, H.salud, H.pareja, H.consumo,
  H.compromiso, H.inversion, H.contacto, H.telWa, H.telAr, H.utmSource, H.utmMedium, H.utmCampaign,
  H.utmContent, H.scoreTf, H.score, H.forzador, H.pantalla, H.variante, H.estado, H.mail,
  H.cliente, H.secuencia,
];

const sheet = { headers: [] as string[], rows: [] as Array<Array<string | number>> };
const col = (name: string) => sheet.headers.indexOf(name);
const A1 = (name: string, row: number) => `${CRM_TAB}!${colLetter(col(name))}${row}`;

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let appendStatus = 200;
/** Contactos que Brevo "conoce" (GET /v3/contacts/{email} → 200 con estos atributos). */
let brevoExistentes: Record<string, Record<string, unknown>> = {};
/** true → el PUT de headers responde OK pero la fila 1 no cambia (Sheets "lento"). */
let headersNoPersisten = false;
/** true → el append escribe la fila pero la respuesta "se pierde" (timeout). */
let appendEscribeYFalla = false;

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function jsonRes(data: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function setCell(a1: string, value: string | number) {
  const m = a1.split('!')[1].match(/^([A-Z]+)(\d+)$/)!;
  const c = colIndex(m[1]);
  const r = parseInt(m[2], 10);
  if (r === 1) {
    while (sheet.headers.length <= c) sheet.headers.push('');
    sheet.headers[c] = String(value);
    return;
  }
  const row = sheet.rows[r - 2];
  if (!row) throw new Error(`fila ${r} no existe`);
  while (row.length <= c) row.push('');
  row[c] = value;
}

const baseFetch = async (input: string, init?: RequestInit) => {
  const url = decodeURIComponent(String(input));
  const method = init?.method || 'GET';
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ method, url, body });

  if (url.includes('api.brevo.com/v3/contacts/') && method === 'GET') {
    const email = url.split('/v3/contacts/')[1];
    const attrs = brevoExistentes[email];
    if (!attrs) return jsonRes({ code: 'document_not_found' }, 404);
    return jsonRes({ email, attributes: attrs });
  }
  if (!url.includes('sheets.googleapis.com')) return jsonRes({}, 201);

  if (method === 'GET' && url.includes('/values/')) {
    const a1 = url.split('/values/')[1].split('?')[0].split('!')[1];
    if (a1 === '1:1') return jsonRes({ values: [sheet.headers] });
    const m = a1.match(/^([A-Z]+)2:([A-Z]+)$/);
    if (m) {
      const c = colIndex(m[1]);
      return jsonRes({ values: sheet.rows.map((row) => (row[c] !== undefined && row[c] !== '' ? [String(row[c])] : [])) });
    }
    return jsonRes({ error: `range no soportado: ${a1}` }, 400);
  }
  if (method === 'GET' && url.includes('values:batchGet')) {
    const ranges = url.split('?')[1].split('&').map((p) => p.replace('ranges=', ''));
    const valueRanges = ranges.map((r) => {
      const m = r.split('!')[1].match(/^([A-Z]+)2:([A-Z]+)$/)!;
      const c = colIndex(m[1]);
      return { values: sheet.rows.map((row) => (row[c] !== undefined && row[c] !== '' ? [String(row[c])] : [])) };
    });
    return jsonRes({ valueRanges });
  }
  if (method === 'POST' && url.includes(':append')) {
    if (appendStatus !== 200) return jsonRes({ error: 'boom' }, appendStatus);
    const row = (body.values as Array<Array<string | number>>)[0];
    sheet.rows.push([...row]);
    if (appendEscribeYFalla) {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    const n = sheet.rows.length + 1;
    return jsonRes({ updates: { updatedRange: `'${CRM_TAB}'!A${n}:${colLetter(row.length - 1)}${n}` } });
  }
  if (method === 'PUT') {
    const range = body.range as string;
    if (headersNoPersisten && /!([A-Z]+)1$/.test(range)) return jsonRes({});
    setCell(range, (body.values as Array<Array<string | number>>)[0][0]);
    return jsonRes({});
  }
  if (method === 'POST' && url.endsWith('values:batchUpdate')) {
    for (const d of body.data as Array<{ range: string; values: Array<Array<string | number>> }>) {
      setCell(d.range, d.values[0][0]);
    }
    return jsonRes({});
  }
  return jsonRes({ error: `no soportado: ${method} ${url}` }, 400);
};
const fetchMock = jest.fn(baseFetch);
global.fetch = fetchMock as unknown as typeof fetch;

// ── Helpers de request ─────────────────────────────────────────────

let ipSeq = 0;
function req(body: unknown, opts: { origin?: string | null; ip?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': opts.ip || `10.0.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`,
    ...(opts.headers || {}),
  };
  if (opts.origin !== null) headers.origin = opts.origin || 'https://urologia.ar';
  return new NextRequest('http://localhost/api/form/test-programa', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const ALL_A = { p1: 'a', p2: 'a', p3: 'a', p4: 'a', p5: 'a', p6: 'a', p7: 'a' };
function finalBody(extra: Record<string, unknown> = {}) {
  return {
    step: 'final',
    name: 'Juan Pérez',
    email: 'Juan@Example.com',
    pais: 'AR',
    src: 'tiktok',
    verbatim: 'Me pasa con mi pareja',
    _hp: '',
    ...ALL_A,
    ...extra,
  };
}

const appends = () => calls.filter((c) => c.url.includes(':append'));
const puts = () => calls.filter((c) => c.method === 'PUT');
const batchUpdates = () => calls.filter((c) => c.url.endsWith('values:batchUpdate'));
const brevoContacts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('api.brevo.com/v3/contacts'));
const brevoGets = () => calls.filter((c) => c.method === 'GET' && c.url.includes('api.brevo.com/v3/contacts/'));
const sheetCalls = () => calls.filter((c) => c.url.includes('sheets.googleapis.com'));
/** Celdas escritas vía batchUpdate: {rangoA1: valor}. */
function celdasBatch(): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const b of batchUpdates()) {
    for (const d of b.body.data as Array<{ range: string; values: Array<Array<string | number>> }>) {
      out[d.range] = d.values[0][0];
    }
  }
  return out;
}
const SENT = (email: string) => `postest-sent:${email}`;

const NOW = new Date('2026-09-04T18:07:09.000Z');

beforeEach(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'],
  });
  kvMock.__reset();
  resetNewColumnsCache();
  jest.clearAllMocks();
  fetchMock.mockImplementation(baseFetch);
  calls = [];
  appendStatus = 200;
  brevoExistentes = {};
  headersNoPersisten = false;
  appendEscribeYFalla = false;
  sheet.headers = [...BASE_HEADERS, H.pais, H.verbatim];
  sheet.rows = [];
  process.env.BREVO_API_KEY = 'test-api-key';
  process.env.API_SECRET_KEY = 'test-secret-key';
  mockedDispatch.mockResolvedValue({ success: true, tier: 'A', pantalla: 'A', messageId: 'mid-1', enrolled: true });
  mockedAlerta.mockResolvedValue(true);
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Lógica pura ────────────────────────────────────────────────────

describe('lib test-programa', () => {
  it('formatSubmittedAt: d/M/yyyy H:mm:ss en UTC sin ceros a la izquierda', () => {
    expect(formatSubmittedAt(new Date('2026-09-04T18:07:09Z'))).toBe('4/9/2026 18:07:09');
    expect(formatSubmittedAt(new Date('2026-12-25T03:05:00Z'))).toBe('25/12/2026 3:05:00');
    // ida y vuelta
    expect(parseSubmittedAt('4/9/2026 18:07:09')?.toISOString()).toBe('2026-09-04T18:07:09.000Z');
  });

  it('generarToken: form- + 12 hex', () => {
    expect(generarToken()).toMatch(/^form-[0-9a-f]{12}$/);
    expect(generarToken()).not.toBe(generarToken());
  });

  it('filaDesdeUpdatedRange', () => {
    expect(filaDesdeUpdatedRange(`'${CRM_TAB}'!A57:AC57`)).toBe(57);
    expect(filaDesdeUpdatedRange(`${CRM_TAB}!B9`)).toBe(9);
    expect(filaDesdeUpdatedRange(undefined)).toBeNull();
  });

  it('validatePartial normaliza email/pais/src', () => {
    const r = validatePartial({ name: '  Juan   Pérez ', email: ' Juan@Example.COM ', pais: 'ar', src: 'TikTok!#' });
    expect(r).toEqual({ ok: true, data: { name: 'Juan Pérez', email: 'juan@example.com', pais: 'AR', src: 'tiktok' } });
    expect(validatePartial({ name: 'x', email: 'no-es-mail', pais: 'AR' }).ok).toBe(false);
    expect(validatePartial({ name: 'x', email: 'a@b.co', pais: 'ARG' }).ok).toBe(false);
    expect(validatePartial({ name: 'x'.repeat(81), email: 'a@b.co', pais: 'AR' }).ok).toBe(false);
    const sinSrc = validatePartial({ name: 'x', email: 'a@b.co', pais: 'XX' });
    expect(sinSrc.ok && sinSrc.data.src).toBe('web');
  });

  it('validateFinal: letras válidas, verbatim ≤ 300 sin saltos múltiples', () => {
    const r = validateFinal({ ...finalBody(), verbatim: 'a\n\n\nb   c ' + 'x'.repeat(400) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.verbatim.length).toBeLessThanOrEqual(300);
      expect(r.data.verbatim.startsWith('a\nb c')).toBe(true);
      expect(r.data.p1).toBe('a');
    }
    expect(validateFinal(finalBody({ p3: 'd' })).ok).toBe(false);
    expect(validateFinal(finalBody({ p1: 'c' })).ok).toBe(false); // p1 solo a|b
    expect(validateFinal(finalBody({ p7: '' })).ok).toBe(false);
  });

  it('cleanName/cleanVerbatim neutralizan prefijos de fórmula (= + - @)', () => {
    expect(cleanName('=HYPERLINK("https://evil";"Juan")')).toBe('HYPERLINK("https://evil";"Juan")');
    expect(cleanName('  +Juan')).toBe('Juan');
    expect(cleanName('@Juan')).toBe('Juan');
    expect(cleanName('Juan-Pablo')).toBe('Juan-Pablo');
    expect(cleanVerbatim('=IMPORTXML("x")\nme pasa')).toBe('IMPORTXML("x")\nme pasa');
    expect(cleanVerbatim('-  - me pasa con mi pareja')).toBe('me pasa con mi pareja');
    const r = validateFinal(finalBody({ name: '=cmd|calc', verbatim: '@evil' }));
    expect(r.ok && r.data.name).toBe('cmd|calc');
    expect(r.ok && r.data.verbatim).toBe('evil');
    // el teléfono conserva el + inicial
    const t = validateContacto({ email: 'a@b.co', contacto: 'wa', telefono: '+54 9 261 1234567' });
    expect(t.ok && t.data.telefono).toBe('+54 9 261 1234567');
  });

  it('emailCanonico: sin +sufijo; gmail sin puntos y googlemail → gmail', () => {
    expect(emailCanonico('Juan+1@Example.com')).toBe('juan@example.com');
    expect(emailCanonico('j.u.an+spam@gmail.com')).toBe('juan@gmail.com');
    expect(emailCanonico('ju.an@googlemail.com')).toBe('juan@gmail.com');
    expect(emailCanonico('ju.an@example.com')).toBe('ju.an@example.com');
  });

  it('resolverColumnas: utm_medium/campaign/content y P8/P14/P15 son opcionales; P14 acepta el header del PRD', () => {
    const sinOpc = BASE_HEADERS.filter((h) => ![H.utmMedium, H.utmCampaign, H.utmContent, H.contacto, H.telWa, H.telAr].includes(h));
    const r = resolverColumnas(sinOpc);
    expect(r.missing).toEqual([]);
    expect(r.cols.utmMedium).toBe(-1);
    expect(r.cols.contacto).toBe(-1);
    const alt = resolverColumnas(BASE_HEADERS.map((h) => (h === H.telWa ? 'Dejame tu WhatsApp — número completo con código de país' : h)));
    expect(alt.missing).toEqual([]);
    expect(alt.cols.telefonoWa).toBe(BASE_HEADERS.indexOf(H.telWa));
    expect(resolverColumnas(BASE_HEADERS.filter((h) => h !== H.token)).missing).toEqual(['Token']);
  });

  it('validateContacto: canal y teléfono', () => {
    expect(validateContacto({ email: 'a@b.co', contacto: 'meet' })).toEqual({
      ok: true,
      data: { email: 'a@b.co', contacto: 'meet', telefono: '' },
    });
    const wa = validateContacto({ email: 'a@b.co', contacto: 'wa', telefono: '+54 (9) 261-123-4567' });
    expect(wa).toEqual({ ok: true, data: { email: 'a@b.co', contacto: 'wa', telefono: '+54 9 2611234567' } });
    expect(validateContacto({ email: 'a@b.co', contacto: 'wa', telefono: '123' }).ok).toBe(false);
    expect(validateContacto({ email: 'a@b.co', contacto: 'tel', telefono: 'abc123456' }).ok).toBe(false);
    expect(validateContacto({ email: 'a@b.co', contacto: 'sms', telefono: '2611234567' }).ok).toBe(false);
    // token opcional: solo si tiene forma 'form-' + 12 hex
    const tk = validateContacto({ email: 'a@b.co', contacto: 'meet', token: 'form-abcdef012345' });
    expect(tk.ok && tk.data.token).toBe('form-abcdef012345');
    const tkMal = validateContacto({ email: 'a@b.co', contacto: 'meet', token: 'otro' });
    expect(tkMal.ok && tkMal.data.token).toBeUndefined();
  });
});

// ── Seguridad / validación del endpoint ────────────────────────────

describe('seguridad', () => {
  it('payload inválido → 400 JSON {ok:false,error}', async () => {
    const res = await POST(req(finalBody({ p3: 'd' })));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
    expect(sheetCalls()).toHaveLength(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('JSON roto → 400; step desconocido → 400', async () => {
    expect((await POST(req('{no json'))).status).toBe(400);
    expect((await POST(req({ step: 'otro', _hp: '' }))).status).toBe(400);
  });

  it('honeypot con valor → 200 {ok:true} sin efectos', async () => {
    const res = await POST(req(finalBody({ _hp: 'http://spam' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('origin no permitido → 403; sin origin → 403; x-api-key saltea el chequeo', async () => {
    expect((await POST(req({ step: 'partial' }, { origin: 'https://evil.com' }))).status).toBe(403);
    expect((await POST(req({ step: 'partial' }, { origin: null }))).status).toBe(403);
    const res = await POST(
      req(
        { step: 'partial', name: 'Ana', email: 'ana@x.com', pais: 'MX', src: 'web', _hp: '' },
        { origin: null, headers: { 'x-api-key': 'test-secret-key' } }
      )
    );
    expect(res.status).toBe(200);
    for (const o of ['https://link.urologia.ar', 'https://www.urologia.ar', 'https://nexo-mail.vercel.app']) {
      const r = await POST(req({ step: 'partial', name: 'Ana', email: 'ana@x.com', pais: 'MX', _hp: '' }, { origin: o }));
      expect(r.status).toBe(200);
      expect(r.headers.get('Access-Control-Allow-Origin')).toBe(o);
    }
  });

  it('body > 8 KB → 413', async () => {
    const res = await POST(req(finalBody({ verbatim: 'x'.repeat(9000) })));
    expect(res.status).toBe(413);
  });

  it('rate limit: 10 por minuto por IP, contador en KV (compartido entre instancias) con expire 60 s', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < 10; i++) {
      const r = await POST(req({ step: 'partial', name: 'A', email: `a${i}@x.com`, pais: 'AR', _hp: '' }, { ip }));
      expect(r.status).toBe(200);
    }
    const r = await POST(req({ step: 'partial', name: 'A', email: 'a@x.com', pais: 'AR', _hp: '' }, { ip }));
    expect(r.status).toBe(429);
    expect(kvMock.__store.get(`rl:ip:${ip}`)).toBe(11);
    expect(kv.expire).toHaveBeenCalledWith(`rl:ip:${ip}`, 60);
    expect((kv.expire as jest.Mock).mock.calls.filter(([k]) => k === `rl:ip:${ip}`)).toHaveLength(1);
  });

  it('rate limit: si KV falla cae al contador en memoria', async () => {
    (kv.incr as jest.Mock).mockRejectedValue(new Error('KV down'));
    const ip = '203.0.113.8';
    for (let i = 0; i < 10; i++) {
      const r = await POST(req({ step: 'partial', name: 'A', email: `b${i}@x.com`, pais: 'AR', _hp: '' }, { ip }));
      expect(r.status).toBe(200);
    }
    expect((await POST(req({ step: 'partial', name: 'A', email: 'b@x.com', pais: 'AR', _hp: '' }, { ip }))).status).toBe(429);
    (kv.incr as jest.Mock).mockImplementation(kvMock.__incrImpl);
  });

  it('x-api-key incorrecta (misma longitud) → 403', async () => {
    const r = await POST(
      req({ step: 'partial', name: 'Ana', email: 'ana@x.com', pais: 'MX', _hp: '' }, { origin: null, headers: { 'x-api-key': 'test-secret-kez' } })
    );
    expect(r.status).toBe(403);
  });
});

// ── partial ────────────────────────────────────────────────────────

describe("step 'partial'", () => {
  it('upsert Brevo lista #33 con NOMBRE/PAIS/LEAD_SOURCE; ni Sheet ni mail', async () => {
    const res = await POST(req({ step: 'partial', name: 'Juan Pérez', email: 'Juan@Example.com', pais: 'AR', src: 'tiktok', _hp: '' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(brevoGets()).toHaveLength(1);
    expect(brevoGets()[0].url).toContain('/v3/contacts/juan@example.com');
    const b = brevoContacts();
    expect(b).toHaveLength(1);
    expect(b[0].body).toEqual({
      email: 'juan@example.com',
      attributes: { NOMBRE: 'Juan', PAIS: 'AR', LEAD_SOURCE: 'test-tiktok' },
      listIds: [33],
      updateEnabled: true,
    });
    expect(sheetCalls()).toHaveLength(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('smtp/email'))).toBe(false);
  });

  it('contacto existente en Brevo: no pisa NOMBRE ni LEAD_SOURCE/PAIS que ya tenía; agrega solo lo que falta', async () => {
    brevoExistentes['cliente@x.com'] = { NOMBRE: 'Carlos', LEAD_SOURCE: 'programa-tiktok', PAIS: '' };
    const res = await POST(req({ step: 'partial', name: 'idiota', email: 'cliente@x.com', pais: 'AR', src: 'web', _hp: '' }));
    expect(res.status).toBe(200);
    const b = brevoContacts();
    expect(b).toHaveLength(1);
    expect(b[0].body).toEqual({ email: 'cliente@x.com', attributes: { PAIS: 'AR' }, listIds: [33], updateEnabled: true });

    brevoExistentes['otro@x.com'] = { NOMBRE: 'Otro' };
    await POST(req({ step: 'partial', name: 'X', email: 'otro@x.com', pais: 'MX', src: 'web', _hp: '' }));
    expect(brevoContacts()[1].body).toEqual({
      email: 'otro@x.com',
      attributes: { PAIS: 'MX', LEAD_SOURCE: 'test-web' },
      listIds: [33],
      updateEnabled: true,
    });
  });

  it('GET de Brevo falla → upsert conservador (sin NOMBRE; LEAD_SOURCE solo con src explícito)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes('api.brevo.com/v3/contacts/') && (!init?.method || init.method === 'GET')) throw new Error('fetch failed');
      return baseFetch(input, init);
    });
    await POST(req({ step: 'partial', name: 'Juan', email: 'j@x.com', pais: 'AR', src: 'web', _hp: '' }));
    expect(brevoContacts()[0].body).toEqual({ email: 'j@x.com', attributes: { PAIS: 'AR' }, listIds: [33], updateEnabled: true });
    await POST(req({ step: 'partial', name: 'Juan', email: 'k@x.com', pais: 'AR', src: 'tiktok', _hp: '' }));
    expect(brevoContacts()[1].body.attributes).toEqual({ PAIS: 'AR', LEAD_SOURCE: 'test-tiktok' });
  });

  it('Brevo caído → 200 igual (best-effort)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes('api.brevo.com')) throw new Error('fetch failed');
      return baseFetch(input, init);
    });
    const res = await POST(req({ step: 'partial', name: 'Juan', email: 'j@x.com', pais: 'AR', _hp: '' }));
    expect(res.status).toBe(200);
  });

  it('partial inválido → 400', async () => {
    const res = await POST(req({ step: 'partial', name: 'Juan', email: 'j@x.com', pais: 'Argentina', _hp: '' }));
    expect(res.status).toBe(400);
    expect(brevoContacts()).toHaveLength(0);
  });
});

// ── final ──────────────────────────────────────────────────────────

describe("step 'final'", () => {
  it('A-Limpia: fila alineada a headers con textos exactos, Submitted At UTC, dispatch con pais y marca "form " en la fila', async () => {
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, pantalla: 'A', variante: 'A-Limpia', token: expect.stringMatching(/^form-[0-9a-f]{12}$/) });

    // Fila appendeada (RAW + INSERT_ROWS)
    const ap = appends();
    expect(ap).toHaveLength(1);
    expect(ap[0].url).toContain('valueInputOption=RAW');
    expect(ap[0].url).toContain('insertDataOption=INSERT_ROWS');
    const row = (ap[0].body.values as Array<Array<string | number>>)[0];

    expect(row[col(H.nombre)]).toBe('Juan Pérez');
    expect(row[col(H.email)]).toBe('juan@example.com');
    expect(row[col(H.edad)]).toBe('18 - 49 años');
    expect(row[col(H.ereccion)]).toBe('Sí, casi siempre');
    expect(row[col(H.salud)]).toBe('No tengo enfermedades crónicas importantes, o tengo solo 1 condición controlada');
    expect(row[col(H.pareja)]).toBe('No tengo pareja estable (soltero, encuentros casuales u ocasionales)');
    expect(row[col(H.consumo)]).toBe('Más de 1 hora diaria o más de lo que me gustaría');
    expect(row[col(H.compromiso)]).toBe('Sí, me comprometo');
    expect(row[col(H.inversion)]).toBe('Sí, es prioridad y estoy dispuesto a invertir en mejorar de una vez por todas');
    expect(row[col(H.submitted)]).toBe('4/9/2026 18:07:09');
    expect(row[col(H.token)]).toBe(json.token);
    expect(row[col(H.score)]).toBe(110);
    expect(row[col(H.forzador)]).toBe('');
    expect(row[col(H.pantalla)]).toBe('A');
    expect(row[col(H.variante)]).toBe('A-Limpia');
    expect(row[col(H.pais)]).toBe('AR');
    expect(row[col(H.verbatim)]).toBe('Me pasa con mi pareja');
    expect(row[col(H.utmSource)]).toBe('test-tiktok');
    // celdas que no corresponden quedan vacías
    expect(row[col(H.contacto)]).toBe('');
    expect(row[col(H.mail)]).toBe('');
    expect(row[col(H.estado)]).toBe('');

    // Dispatch con pais y tier A
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'juan@example.com',
        name: 'Juan Pérez',
        pantalla: 'A',
        variante: 'A-Limpia',
        score: 110,
        tier: 'A',
        pais: 'AR',
        respuestas: expect.objectContaining({ ereccion: expect.any(String) }),
      }),
      { deferMarks: true }
    );

    // Marca "form dd/mm/yyyy HH:MM" en la fila del updatedRange (fila 2), un solo batchUpdate RAW
    const bu = batchUpdates();
    expect(bu).toHaveLength(1);
    expect(bu[0].body.valueInputOption).toBe('RAW');
    expect(celdasBatch()).toEqual({ [A1(H.mail, 2)]: 'form 04/09/2026 15:07' });
    expect(puts()).toHaveLength(0);
    expect(sheet.rows[0][col(H.mail)]).toBe('form 04/09/2026 15:07');

    // Orden: primero Sheet (append), después mail
    const idxAppend = calls.findIndex((c) => c.url.includes(':append'));
    expect(idxAppend).toBeGreaterThanOrEqual(0);
    expect(mockedDispatch.mock.invocationCallOrder[0]).toBeGreaterThan(fetchMock.mock.invocationCallOrder[idxAppend]);
    expect(mockedAlerta).not.toHaveBeenCalled();

    // Guardia postest-sent: 'inflight' (nx, 5 min) ANTES del append; fecha larga después del envío
    const sentSets = (kv.set as jest.Mock).mock.calls.filter(([k]) => k === SENT('juan@example.com'));
    expect(sentSets[0][1]).toBe('inflight');
    expect(sentSets[0][2]).toEqual({ nx: true, ex: 300 });
    expect(sentSets[0]).toBeDefined();
    const idxSent = (kv.set as jest.Mock).mock.invocationCallOrder[(kv.set as jest.Mock).mock.calls.indexOf(sentSets[0])];
    expect(idxSent).toBeLessThan(fetchMock.mock.invocationCallOrder[idxAppend]);
    expect(kvMock.__store.get(SENT('juan@example.com'))).toBe(NOW.toISOString());
    expect(sentSets[sentSets.length - 1][2]).toEqual({ ex: 60 * 60 * 24 * 60 });

    // Tope diario por email: contador del día (hora Argentina)
    expect(kvMock.__store.get('rl:email:juan@example.com:2026-09-04')).toBe(1);
  });

  it('B-CONTACTO (score 70): textos b/a mapeados y tier B', async () => {
    mockedDispatch.mockResolvedValue({ success: true, tier: 'B', pantalla: 'B-CONTACTO', messageId: 'm' });
    const res = await POST(req(finalBody({ p1: 'b', p2: 'b', p3: 'a', p4: 'b', p5: 'b', p6: 'a', p7: 'a' })));
    expect(await res.json()).toEqual(expect.objectContaining({ ok: true, pantalla: 'B-CONTACTO', variante: 'B-CONTACTO' }));
    const row = (appends()[0].body.values as Array<Array<string | number>>)[0];
    expect(row[col(H.edad)]).toBe('50 años o más');
    expect(row[col(H.ereccion)]).toBe(OPCIONES.p2.b);
    expect(row[col(H.pareja)]).toBe(OPCIONES.p4.b);
    expect(row[col(H.consumo)]).toBe(OPCIONES.p5.b);
    expect(row[col(H.score)]).toBe(70);
    expect(row[col(H.pantalla)]).toBe('B-CONTACTO');
    expect(mockedDispatch.mock.calls[0][0]).toEqual(expect.objectContaining({ tier: 'B', pantalla: 'B-CONTACTO', score: 70 }));
  });

  it('C-P2c: forzador, tier C, marcas diferidas (Secuencia) escritas en la fila', async () => {
    mockedDispatch.mockResolvedValue({
      success: true,
      tier: 'C',
      pantalla: 'C',
      sent: true,
      pendingMarks: [{ col: 'secuencia', text: 'Mail C enviado 04/09' }],
    });
    const res = await POST(req(finalBody({ p2: 'c' })));
    expect(await res.json()).toEqual(expect.objectContaining({ ok: true, pantalla: 'C', variante: 'C-P2c' }));
    const row = (appends()[0].body.values as Array<Array<string | number>>)[0];
    expect(row[col(H.ereccion)]).toBe('No, casi nunca');
    expect(row[col(H.forzador)]).toBe('P2c');
    expect(row[col(H.pantalla)]).toBe('C');
    expect(row[col(H.variante)]).toBe('C-P2c');
    expect(mockedDispatch.mock.calls[0][0]).toEqual(expect.objectContaining({ tier: 'C', pantalla: 'C', variante: 'C-P2c' }));
    expect(sheet.rows[0][col(H.mail)]).toMatch(/^form \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(sheet.rows[0][col(H.secuencia)]).toBe('Mail C enviado 04/09');
    // ambas marcas en un solo request
    expect(batchUpdates()).toHaveLength(1);
  });

  it('idempotencia KV: segundo POST del mismo email devuelve lo guardado sin repetir append ni dispatch', async () => {
    const r1 = await (await POST(req(finalBody()))).json();
    const r2 = await (await POST(req(finalBody({ p2: 'c' })))).json(); // aunque cambie, gana lo guardado
    expect(r2).toEqual(r1);
    expect(appends()).toHaveLength(1);
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(batchUpdates()).toHaveLength(1);
    expect(kvMock.__store.get('testfinal:juan@example.com')).toEqual(
      expect.objectContaining({ status: 'done', pantalla: 'A', variante: 'A-Limpia', token: r1.token })
    );
    // gmail: +sufijo y puntos no cuentan como otra persona
    const g1 = await (await POST(req(finalBody({ email: 'ju.an@gmail.com' })))).json();
    const g2 = await (await POST(req(finalBody({ email: 'juan+otro@gmail.com', p2: 'c' })))).json();
    expect(g2).toEqual(g1);
    expect(appends()).toHaveLength(2);
    expect(kvMock.__store.has('testfinal:juan@gmail.com')).toBe(true);
  });

  it('inflight vigente (otro request procesando) → 409 sin repetir', async () => {
    kvMock.__store.set('testfinal:juan@example.com', { status: 'inflight', ts: Date.now() - 5000 });
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(409);
    expect(appends()).toHaveLength(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('inflight vencido (función muerta antes del append) → reprocesa con el mismo token', async () => {
    kvMock.__store.set('testfinal:juan@example.com', { status: 'inflight', ts: Date.now() - 120_000, t0: Date.now() - 120_000, token: 'form-0123456789ab' });
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe('form-0123456789ab');
    expect(appends()).toHaveLength(1);
    expect(sheet.rows[0][col(H.token)]).toBe('form-0123456789ab');
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
  });

  it('inflight vencido con la fila ya escrita → reusa la fila (sin segundo append) y despacha una vez', async () => {
    seedRow('juan@example.com', 'form-0123456789ab', 2, 'A');
    kvMock.__store.set('testfinal:juan@example.com', { status: 'inflight', ts: Date.now() - 120_000, t0: Date.now() - 120_000, token: 'form-0123456789ab' });
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(200);
    expect(appends()).toHaveLength(0);
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0][col(H.mail)]).toBe('form 04/09/2026 15:07');
    // la fila reusada no suma al tope diario
    expect(kvMock.__store.has('rl:email:juan@example.com:2026-09-04')).toBe(false);
  });

  it('inflight vencido después de que el intento anterior YA mandó el mail → marca "form" sin volver a despachar', async () => {
    const t0 = Date.now() - 120_000;
    seedRow('juan@example.com', 'form-0123456789ab', 2, 'A');
    kvMock.__store.set('testfinal:juan@example.com', { status: 'inflight', ts: t0, t0, token: 'form-0123456789ab' });
    kvMock.__store.set(SENT('juan@example.com'), new Date(t0 + 30_000).toISOString()); // envío propio
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(200);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(appends()).toHaveLength(0);
    expect(sheet.rows[0][col(H.mail)]).toBe('form 04/09/2026 15:07');
    expect(mockedAlerta).not.toHaveBeenCalled();
  });

  it('postest-sent con fecha vieja (ya recibió el post-test por Typeform/vigilante) → fila sin mail, marca "form kv-dup"', async () => {
    kvMock.__store.set(SENT('juan@example.com'), '2026-08-20T10:00:00.000Z');
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: true, pantalla: 'A', variante: 'A-Limpia' }));
    expect(appends()).toHaveLength(1);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(sheet.rows[0][col(H.mail)]).toBe('form kv-dup 04/09/2026 15:07');
    expect(kvMock.__store.get(SENT('juan@example.com'))).toBe('2026-08-20T10:00:00.000Z');
  });

  it('postest-sent "inflight" de otro proceso (vigilante) → 409 sin append; libera testfinal para el reintento', async () => {
    kvMock.__store.set(SENT('juan@example.com'), 'inflight');
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(409);
    expect(appends()).toHaveLength(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(kvMock.__store.has('testfinal:juan@example.com')).toBe(false);
  });

  it('tope diario: a la tercera fila nueva del mismo email (canónico) en el día → 429 sin append', async () => {
    expect((await POST(req(finalBody()))).status).toBe(200);
    kvMock.__store.delete('testfinal:juan@example.com'); // pasaron los 10 min
    expect((await POST(req(finalBody({ email: 'juan+2@example.com' })))).status).toBe(200);
    expect(appends()).toHaveLength(2);
    kvMock.__store.delete('testfinal:juan@example.com');
    const res = await POST(req(finalBody({ email: 'juan+3@example.com' })));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain('Ya registramos tu test hoy');
    expect(appends()).toHaveLength(2);
    // postest-sent: es por dirección literal (juan+2 ≠ juan): el segundo sí despacha; el tope diario frena el tercero
    expect(mockedDispatch).toHaveBeenCalledTimes(2);
    expect(kvMock.__store.has('testfinal:juan@example.com')).toBe(false);
  });

  it('append fallido → 502 sin dispatch; deja la key en "retry" (mismo token) y libera postest-sent; el reintento funciona', async () => {
    appendStatus = 500;
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'No pude guardar tus respuestas. Probá de nuevo.' });
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(batchUpdates()).toHaveLength(0);
    const prev = kvMock.__store.get('testfinal:juan@example.com') as { status: string; token: string };
    expect(prev.status).toBe('retry');
    expect(prev.token).toMatch(/^form-/);
    expect(kvMock.__store.has(SENT('juan@example.com'))).toBe(false);
    expect(mockedAlerta).not.toHaveBeenCalled(); // 500 es transitorio: sin alerta

    appendStatus = 200;
    const res2 = await POST(req(finalBody()));
    expect(res2.status).toBe(200);
    expect((await res2.json()).token).toBe(prev.token);
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0][col(H.token)]).toBe(prev.token);
  });

  it('append que vence el timeout pero Google lo escribió → el reintento encuentra la fila por Token y no la duplica', async () => {
    appendEscribeYFalla = true;
    expect((await POST(req(finalBody()))).status).toBe(502);
    expect(sheet.rows).toHaveLength(1);
    expect(mockedDispatch).not.toHaveBeenCalled();

    appendEscribeYFalla = false;
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(200);
    expect(sheet.rows).toHaveLength(1);
    expect(appends()).toHaveLength(1);
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(sheet.rows[0][col(H.mail)]).toBe('form 04/09/2026 15:07');
  });

  it('append 400 (error estructural) → 502 + alerta a Mauro con throttle 1/h', async () => {
    appendStatus = 400;
    expect((await POST(req(finalBody()))).status).toBe(502);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toContain('error estructural del Sheet');
    kvMock.__store.delete('testfinal:juan@example.com');
    expect((await POST(req(finalBody()))).status).toBe(502);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
  });

  it('dispatch falla → marca "form-error" igual (el vigilante no reintenta) + alerta a Mauro, responde 200', async () => {
    mockedDispatch.mockResolvedValue({ success: false, tier: 'A', pantalla: 'A', stage: 'send', error: 'Brevo send 500: x' });
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: true, pantalla: 'A', variante: 'A-Limpia' }));
    expect(sheet.rows[0][col(H.mail)]).toBe('form-error 04/09/2026 15:07');
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toContain('falló el mail post-test');
    expect(mockedAlerta.mock.calls[0][1]).toContain('Brevo send 500: x');
    expect(mockedAlerta.mock.calls[0][1]).toContain('Reenviar a mano');
    // fallo definitivo: se libera la guardia postest-sent
    expect(kvMock.__store.has(SENT('juan@example.com'))).toBe(false);
  });

  it('envío ambiguo (timeout de Brevo en el send) → marca "form?" + alerta "verificar en Brevo" + postest-sent "ambiguo"', async () => {
    mockedDispatch.mockResolvedValue({ success: false, tier: 'A', pantalla: 'A', stage: 'send', error: 'Brevo send error: TimeoutError: The operation was aborted' });
    await POST(req(finalBody()));
    expect(sheet.rows[0][col(H.mail)]).toBe('form? 04/09/2026 15:07');
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toContain('envío ambiguo');
    expect(mockedAlerta.mock.calls[0][1]).toContain('verificar en Brevo antes de reenviar');
    expect(kvMock.__store.get(SENT('juan@example.com'))).toBe(`ambiguo ${NOW.toISOString()}`);
  });

  it('timeout en la etapa contact (sin mail) NO es ambiguo → "form-error"', async () => {
    mockedDispatch.mockResolvedValue({ success: false, tier: 'A', pantalla: 'A', stage: 'contact', error: 'Brevo contact error: timeout' });
    await POST(req(finalBody()));
    expect(sheet.rows[0][col(H.mail)]).toMatch(/^form-error /);
  });

  it('tier C con sent=false por timeout → ambiguo ("form?"); con 5xx → "form-error"', async () => {
    mockedDispatch.mockResolvedValue({ success: true, tier: 'C', pantalla: 'C', sent: false, sendError: 'TimeoutError: Brevo send (tier C) > 8000 ms' });
    await POST(req(finalBody({ p6: 'c' })));
    expect(sheet.rows[0][col(H.mail)]).toMatch(/^form\? /);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);

    mockedDispatch.mockResolvedValue({ success: true, tier: 'C', pantalla: 'C', sent: false, sendError: 'Brevo send 500: x' });
    await POST(req(finalBody({ p6: 'c', email: 'otro@x.com' })));
    expect(sheet.rows[1][col(H.mail)]).toMatch(/^form-error /);
  });

  it('cliente-programa (skipped) → marca "form " sin alerta y deja la huella postest-sent', async () => {
    mockedDispatch.mockResolvedValue({ success: true, skipped: true, reason: 'cliente-programa', tier: 'A', pantalla: 'A' });
    await POST(req(finalBody()));
    expect(sheet.rows[0][col(H.mail)]).toMatch(/^form \d/);
    expect(mockedAlerta).not.toHaveBeenCalled();
    expect(kvMock.__store.get(SENT('juan@example.com'))).toBe(NOW.toISOString());
  });

  it('País/Verbatim ausentes → se crean en la primera columna libre (una sola vez) y la fila los incluye', async () => {
    sheet.headers = [...BASE_HEADERS, '', ''];
    const n = BASE_HEADERS.length;

    await POST(req(finalBody()));
    const headerPuts = puts().filter((p) => p.url.includes(`${colLetter(n)}1`) || p.url.includes(`${colLetter(n + 1)}1`));
    expect(headerPuts).toHaveLength(2);
    expect(sheet.headers[n]).toBe('País');
    expect(sheet.headers[n + 1]).toBe('Verbatim');
    expect(sheet.rows[0][n]).toBe('AR');
    expect(sheet.rows[0][n + 1]).toBe('Me pasa con mi pareja');

    // Segundo test (otro email): ya existen → no se vuelven a crear
    await POST(req(finalBody({ email: 'otro@x.com' })));
    expect(puts().filter((p) => /[A-Z]+1\?/.test(p.url))).toHaveLength(2);
    expect(sheet.rows[1][n]).toBe('AR');
  });

  it('columna requerida faltante → 502 sin dispatch + alerta estructural (1/h)', async () => {
    sheet.headers = BASE_HEADERS.filter((h) => h !== H.token);
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(502);
    expect(appends()).toHaveLength(0);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][1]).toContain('Token');
    expect(kvMock.__store.get('testfinal:juan@example.com')).toEqual(expect.objectContaining({ status: 'retry' }));
    // throttle: la segunda no avisa de nuevo
    await POST(req(finalBody({ email: 'otro@x.com' })));
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
  });

  it('utm_medium/campaign/content y P8/P14/P15 ausentes NO bloquean el final', async () => {
    sheet.headers = [...BASE_HEADERS.filter((h) => ![H.utmMedium, H.utmCampaign, H.utmContent, H.contacto, H.telWa, H.telAr].includes(h)), H.pais, H.verbatim];
    const res = await POST(req(finalBody()));
    expect(res.status).toBe(200);
    expect(appends()).toHaveLength(1);
    expect(sheet.rows[0][col(H.pais)]).toBe('AR');
    expect(sheet.rows[0][col(H.mail)]).toMatch(/^form /);
  });

  it('cache de País/Verbatim: header escrito pero todavía no visible → el segundo final usa los índices cacheados sin repetir el PUT; a los 11 min se vuelve a resolver', async () => {
    sheet.headers = [...BASE_HEADERS, '', ''];
    const n = BASE_HEADERS.length;
    headersNoPersisten = true;

    await POST(req(finalBody()));
    const headerPuts = () => puts().filter((p) => /[A-Z]+1\?/.test(p.url));
    expect(headerPuts()).toHaveLength(2);
    expect(sheet.headers[n]).toBe(''); // "no visible" todavía
    expect(sheet.rows[0][n]).toBe('AR');
    expect(sheet.rows[0][n + 1]).toBe('Me pasa con mi pareja');

    await POST(req(finalBody({ email: 'otro@x.com' })));
    expect(headerPuts()).toHaveLength(2); // sin PUT nuevo: índices del cache
    expect(sheet.rows[1][n]).toBe('AR');
    expect(sheet.rows[1][n + 1]).toBe('Me pasa con mi pareja');

    jest.setSystemTime(new Date(NOW.getTime() + 11 * 60_000));
    await POST(req(finalBody({ email: 'tercero@x.com' })));
    expect(headerPuts()).toHaveLength(4); // cache vencido: vuelve a crear
    expect(sheet.rows[2][n]).toBe('AR');
  });
});

// ── contacto ───────────────────────────────────────────────────────

function seedRow(email: string, token: string, minutosAtras: number, pantalla = 'B-CONTACTO'): Array<string | number> {
  const row = Array.from({ length: sheet.headers.length }, () => '') as Array<string | number>;
  row[col(H.nombre)] = 'Pedro Gómez';
  row[col(H.email)] = email;
  row[col(H.token)] = token;
  row[col(H.submitted)] = formatSubmittedAt(new Date(NOW.getTime() - minutosAtras * 60_000));
  row[col(H.pantalla)] = pantalla;
  sheet.rows.push(row);
  return row;
}

describe("step 'contacto'", () => {
  it('wa → texto P8 y teléfono en P14 de la fila form- más reciente + alerta', async () => {
    seedRow('pedro@x.com', 'form-aaaaaaaaaaaa', 90); // vieja pero dentro de 2 h
    seedRow('pedro@x.com', 'form-bbbbbbbbbbbb', 3); // la más reciente → fila 3
    seedRow('pedro@x.com', 'typeform-viejo', 1); // Typeform: no cuenta

    const res = await POST(req({ step: 'contacto', email: 'Pedro@x.com', contacto: 'wa', telefono: '+54 9 261 555 1234', _hp: '' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const bu = calls.filter((c) => c.url.endsWith('values:batchUpdate'));
    expect(bu).toHaveLength(1);
    expect(bu[0].body.valueInputOption).toBe('RAW');
    const data = bu[0].body.data as Array<{ range: string; values: string[][] }>;
    expect(data).toEqual([
      { range: A1(H.contacto, 3), values: [[CONTACTO_TEXTOS.wa]] },
      { range: A1(H.telWa, 3), values: [['+54 9 261 555 1234']] },
    ]);
    expect(sheet.rows[1][col(H.contacto)]).toBe('WhatsApp (mensajes o llamada de WA)');
    expect(sheet.rows[1][col(H.telWa)]).toBe('+54 9 261 555 1234');
    expect(sheet.rows[1][col(H.telAr)]).toBe('');
    expect(sheet.rows[0][col(H.contacto)]).toBe('');

    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toBe('Lead B-CONTACTO pidió WhatsApp');
    expect(mockedAlerta.mock.calls[0][1]).toContain('Pedro Gómez');
    expect(mockedAlerta.mock.calls[0][1]).toContain('pedro@x.com');
    expect(mockedAlerta.mock.calls[0][1]).toContain('+54 9 261 555 1234');
    expect(mockedAlerta.mock.calls[0][1]).toContain('docs.google.com/spreadsheets/d/');
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('tel → teléfono en P15 + alerta de llamada', async () => {
    seedRow('pedro@x.com', 'form-cccccccccccc', 2);
    const res = await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'tel', telefono: '261 5551234', _hp: '' }));
    expect(res.status).toBe(200);
    expect(sheet.rows[0][col(H.contacto)]).toBe('Llamada telefónica (solo Argentina)');
    expect(sheet.rows[0][col(H.telAr)]).toBe('261 5551234');
    expect(sheet.rows[0][col(H.telWa)]).toBe('');
    expect(mockedAlerta.mock.calls[0][0]).toBe('Lead B-CONTACTO pidió llamada telefónica');
  });

  it('meet → solo P8, sin alerta', async () => {
    seedRow('pedro@x.com', 'form-dddddddddddd', 2);
    const res = await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'meet', _hp: '' }));
    expect(res.status).toBe(200);
    expect(sheet.rows[0][col(H.contacto)]).toBe('Meet (Mejor opción — agenda automática)');
    expect(mockedAlerta).not.toHaveBeenCalled();
  });

  it('sin fila form- en las últimas 2 h → 404', async () => {
    seedRow('pedro@x.com', 'form-eeeeeeeeeeee', 150);
    const res = await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'meet', _hp: '' }));
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
    expect(calls.filter((c) => c.url.endsWith('values:batchUpdate'))).toHaveLength(0);
  });

  it('contacto wa sin teléfono válido → 400', async () => {
    const res = await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'wa', telefono: '12', _hp: '' }));
    expect(res.status).toBe(400);
    expect(sheetCalls()).toHaveLength(0);
  });

  it('fila reciente que no es B-CONTACTO → 400 sin escribir ni avisar', async () => {
    seedRow('pedro@x.com', 'form-ffffffffffff', 2, 'A');
    const res = await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'wa', telefono: '+54 9 261 555 1234', _hp: '' }));
    expect(res.status).toBe(400);
    expect(batchUpdates()).toHaveLength(0);
    expect(mockedAlerta).not.toHaveBeenCalled();
    expect(sheet.rows[0][col(H.telWa)]).toBe('');
  });

  it('reintento del front (mismo canal) → 200 sin reescribir ni segunda alerta; otro canal sin token → 409', async () => {
    seedRow('pedro@x.com', 'form-abcdefabcdef', 2);
    const body = { step: 'contacto', email: 'pedro@x.com', contacto: 'wa', telefono: '+54 9 261 555 1234', _hp: '' };
    expect((await POST(req(body))).status).toBe(200);
    expect((await POST(req(body))).status).toBe(200);
    expect(batchUpdates()).toHaveLength(1);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);

    // con P8 ya cargado, un tercero (sin token) no puede pisar el teléfono
    const res = await POST(req({ ...body, telefono: '+1 555 000 0000' }));
    expect(res.status).toBe(200);
    expect(sheet.rows[0][col(H.telWa)]).toBe('+54 9 261 555 1234');
    const otro = await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'meet', _hp: '' }));
    expect(otro.status).toBe(409);
    expect(sheet.rows[0][col(H.contacto)]).toBe(CONTACTO_TEXTOS.wa);
  });

  it('con el token del final se puede corregir la elección', async () => {
    seedRow('pedro@x.com', 'form-abcdefabcdef', 2);
    await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'wa', telefono: '+54 9 261 555 1234', _hp: '' }));
    const mal = await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'meet', token: 'form-000000000000', _hp: '' }));
    expect(mal.status).toBe(409);
    const ok = await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'meet', token: 'form-abcdefabcdef', _hp: '' }));
    expect(ok.status).toBe(200);
    expect(sheet.rows[0][col(H.contacto)]).toBe(CONTACTO_TEXTOS.meet);
  });

  it('alerta de contacto deduplicada por fila (KV 1 h) aunque cambie el canal con token', async () => {
    seedRow('pedro@x.com', 'form-abcdefabcdef', 2);
    await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'wa', telefono: '+54 9 261 555 1234', _hp: '' }));
    await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'tel', telefono: '261 5551234', token: 'form-abcdefabcdef', _hp: '' }));
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(kvMock.__store.has('testcontacto:pedro@x.com:2')).toBe(true);
  });

  it('columnas P8/P14/P15 faltantes → 502 + alerta estructural (solo en este step)', async () => {
    sheet.headers = [...BASE_HEADERS.filter((h) => h !== H.telAr), H.pais, H.verbatim];
    seedRow('pedro@x.com', 'form-abcdefabcdef', 2);
    const res = await POST(req({ step: 'contacto', email: 'pedro@x.com', contacto: 'meet', _hp: '' }));
    expect(res.status).toBe(502);
    expect(mockedAlerta).toHaveBeenCalledTimes(1);
    expect(mockedAlerta.mock.calls[0][0]).toContain('contacto');
  });
});
