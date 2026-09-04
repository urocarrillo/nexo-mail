/**
 * Tests de la secuencia de rescate tier A (R2..R4):
 *   - buildRescateMail (textos, links ?mseq=raN, PD de R3 por variante)
 *   - computeRescateDates (+3/+6/+10 a las 13:00 UTC, domingo → lunes)
 *   - enrollRescate (3 entries kind 'rescate-a', step 2..4, sendAt)
 *   - processDripQueue (envía R2 vencido, orden estricto + gap mínimo, domingo,
 *     reintento de failed, duplicados, fail-closed, blacklist, Estado, lock)
 *   - cancelDripForEmail cancela también rescate-a
 *   - endpoint /api/admin/enroll-rescate (dry por default, filtros, ya enrolados,
 *     en secuencia, lock, R2 vencido, lectura alineada, lotes)
 * IO mockeada: KV en memoria, clientes, brevo, crm-sheet, google-auth y fetch.
 */
import { NextRequest } from 'next/server';

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

jest.mock('@/lib/clientes', () => {
  const actual = jest.requireActual('@/lib/clientes');
  return {
    ...actual,
    esCliente: jest.fn(async () => false),
    getClientes: jest.fn(async () => new Map()),
  };
});

jest.mock('@/lib/brevo', () => ({
  isEmailBlacklisted: jest.fn(async () => false),
}));

jest.mock('@/lib/crm-sheet', () => {
  const actual = jest.requireActual('@/lib/crm-sheet');
  return {
    CRM_TAB: actual.CRM_TAB,
    CRM_SHEET_ID: actual.CRM_SHEET_ID,
    colLetter: actual.colLetter,
    readCrmSheet: jest.fn(async () => ({ headers: [], rows: [] })),
    writeSecuenciaMarks: jest.fn(async () => {}),
  };
});

jest.mock('@/lib/google-auth', () => ({
  getGoogleAccessToken: jest.fn(async () => 'test-token'),
}));

import {
  buildRescateMail,
  computeRescateDates,
  computeRescateCandidatos,
  parseR1Date,
  parseRescateCellDate,
  tieneRescateR1,
  esDomingoART,
  diasArtEntre,
  RESCATE_KIND,
  RESCATE_TAG,
  type RescateRow,
} from '@/lib/secuencia-rescate-a';
import {
  enrollRescate,
  enrollRescateBulk,
  getEnrolledRescateEmails,
  getRescateEnrollmentSets,
  cancelDripForEmail,
  processDripQueue,
} from '@/lib/email-drip';
import { esCliente, getClientes } from '@/lib/clientes';
import { isEmailBlacklisted } from '@/lib/brevo';
import { readCrmSheet, writeSecuenciaMarks, colLetter } from '@/lib/crm-sheet';
import { GET } from '@/app/api/admin/enroll-rescate/route';

const kvMock = jest.requireMock('@vercel/kv') as {
  __hashes: Map<string, Map<string, string>>;
  __store: Map<string, unknown>;
  __reset: () => void;
};

const QUEUE = 'drip:queue';
const DAY_MS = 24 * 60 * 60 * 1000;

const mockedEsCliente = esCliente as jest.MockedFunction<typeof esCliente>;
const mockedGetClientes = getClientes as jest.MockedFunction<typeof getClientes>;
const mockedIsBlacklisted = isEmailBlacklisted as jest.MockedFunction<typeof isEmailBlacklisted>;
const mockedReadCrm = readCrmSheet as jest.MockedFunction<typeof readCrmSheet>;
const mockedWriteSecuencia = writeSecuenciaMarks as jest.MockedFunction<typeof writeSecuenciaMarks>;

// ── fetch mock: Sheets (lectura de columnas) + Brevo (envío) ──
// sheetCols: letra de columna → valores de las filas 2..fin
let sheetCols: Record<string, string[]> = {};
function colIndex(letter: string): number {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
const defaultFetchImpl = async (input: string | URL | Request, _init?: RequestInit): Promise<FakeResponse> => {
  void _init;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('sheets.googleapis.com')) {
    // Rango de columnas contiguas X2:Y (filas 2..fin) armado desde sheetCols.
    const range = decodeURIComponent(url.split('/values/')[1] || '');
    const m = range.match(/!([A-Z]+)2:([A-Z]+)$/);
    const from = m ? colIndex(m[1]) : 0;
    const to = m ? colIndex(m[2]) : -1;
    const letters: string[] = [];
    for (let c = from; c <= to; c++) letters.push(colLetter(c));
    const nRows = Math.max(0, ...letters.map((l) => (sheetCols[l] || []).length));
    const values: string[][] = [];
    for (let i = 0; i < nRows; i++) values.push(letters.map((l) => (sheetCols[l] || [])[i] || ''));
    return { ok: true, status: 200, json: async () => ({ values }), text: async () => '' };
  }
  return { ok: true, status: 201, json: async () => ({ messageId: 'test-msg-id' }), text: async () => '' };
};
const fetchMock = jest.fn(defaultFetchImpl);
global.fetch = fetchMock as unknown as typeof fetch;

function queueEntries(): Record<string, unknown>[] {
  const h = kvMock.__hashes.get(QUEUE);
  if (!h) return [];
  return [...h.values()].map((j) => JSON.parse(j));
}

function brevoCalls(): Array<{ url: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('api.brevo.com'))
    .map((c) => ({
      url: String(c[0]),
      body: JSON.parse(((c[1] as RequestInit | undefined)?.body as string) || '{}'),
    }));
}

function seedRescate(
  email: string,
  step: number,
  sendAt: string,
  status: string = 'pending',
  variante: string = 'A-Limpia',
  extra: Record<string, unknown> = {}
): string {
  const id = (extra.id as string) || `ra_test_${email}_${step}`;
  const entry = {
    id,
    email,
    name: 'Juan',
    tag: RESCATE_TAG,
    stepIndex: step,
    templateId: 0,
    subject: buildRescateMail(step as 2 | 3 | 4, 'Juan', variante).subject,
    sendAt,
    status,
    createdAt: '2026-09-04T18:00:00.000Z',
    kind: RESCATE_KIND,
    seqStep: step,
    rescateVariante: variante,
    ...extra,
  };
  let h = kvMock.__hashes.get(QUEUE);
  if (!h) {
    h = new Map();
    kvMock.__hashes.set(QUEUE, h);
  }
  h.set(id, JSON.stringify(entry));
  return id;
}

beforeEach(() => {
  kvMock.__reset();
  jest.clearAllMocks();
  fetchMock.mockImplementation(defaultFetchImpl);
  sheetCols = {};
  process.env.API_SECRET_KEY = 'test-secret-key';
  mockedEsCliente.mockResolvedValue(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedGetClientes.mockResolvedValue(new Map() as any);
  mockedIsBlacklisted.mockResolvedValue(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedReadCrm.mockResolvedValue({ headers: [], rows: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedWriteSecuencia.mockResolvedValue(undefined as any);
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Textos ─────────────────────────────────────────────────────────

describe('buildRescateMail — textos R2/R3/R4', () => {
  it('saludo con nombre y "Hola," sin nombre', () => {
    expect(buildRescateMail(2, 'Juan', 'A-Limpia').text.startsWith('Hola Juan,')).toBe(true);
    expect(buildRescateMail(2, '', 'A-Limpia').text.startsWith('Hola,')).toBe(true);
    expect(buildRescateMail(3, '  ', 'A-Limpia').text.startsWith('Hola,')).toBe(true);
  });

  it('R2 "una palabra": sin link, con las 4 palabras y firma Mauro', () => {
    const m = buildRescateMail(2, 'Juan', 'A-Limpia');
    expect(m.subject).toBe('una palabra');
    expect(m.text).not.toContain('http');
    expect(m.text).toContain('precio — dudas — momento — otra');
    expect(m.text).toContain('Te respondo yo, puntualmente sobre lo tuyo.');
    expect(m.text.trimEnd().endsWith('Abrazo,\nMauro')).toBe(true);
  });

  it('R3 "cómo es por dentro": link ?mseq=ra3 y PD A-Cuotas', () => {
    const m = buildRescateMail(3, 'Juan', 'A-Cuotas');
    expect(m.subject).toBe('cómo es por dentro');
    expect(m.text).toContain('https://urologia.ar/recuperatuereccion/?mseq=ra3');
    expect(m.text).toContain('nadie te corre y el acceso queda para vos');
    expect(m.text).toContain(
      'PD: sé que la inversión pesa. Desde Argentina pagás en pesos con Mercado Pago y en cuotas sin interés. Desde otros países, con PayPal.'
    );
    expect(m.text).not.toContain('PD: desde Argentina pagás en pesos por Mercado Pago y tenés cuotas.');
  });

  it('R3 PD por defecto para A-Limpia, A-Nurture y variante vacía', () => {
    for (const v of ['A-Limpia', 'A-Nurture', '', 'otra']) {
      const t = buildRescateMail(3, 'Juan', v).text;
      expect(t).toContain('PD: desde Argentina pagás en pesos por Mercado Pago y tenés cuotas.');
      expect(t).not.toContain('sé que la inversión pesa');
    }
  });

  it('R3 PD A-Cuotas tolera mayúsculas/espacios', () => {
    expect(buildRescateMail(3, 'x', ' a-cuotas ').text).toContain('sé que la inversión pesa');
  });

  it('R4 "lo que sigue es tuyo": link ?mseq=ra4 + Calendly', () => {
    const m = buildRescateMail(4, 'Juan', 'A-Cuotas');
    expect(m.subject).toBe('lo que sigue es tuyo');
    expect(m.text).toContain('https://urologia.ar/recuperatuereccion/?mseq=ra4');
    expect(m.text).toContain('https://calendly.com/urologocarrillo');
    expect(m.text).not.toContain('PD:');
  });

  it('paso inválido lanza error', () => {
    expect(() => buildRescateMail(1 as unknown as 2, 'x', '')).toThrow();
    expect(() => buildRescateMail(5 as unknown as 4, 'x', '')).toThrow();
  });
});

// ─── Fechas ─────────────────────────────────────────────────────────

describe('computeRescateDates — +3/+6/+10 a las 13:00 UTC, domingo → lunes', () => {
  it('R1 viernes 04/09/2026 → R2 lun 07/09, R3 jue 10/09, R4 lun 14/09', () => {
    const dates = computeRescateDates(new Date('2026-09-04T13:00:00Z'));
    expect(dates).toHaveLength(3);
    expect(dates[0].toISOString()).toBe('2026-09-07T13:00:00.000Z');
    expect(dates[1].toISOString()).toBe('2026-09-10T13:00:00.000Z');
    expect(dates[2].toISOString()).toBe('2026-09-14T13:00:00.000Z');
    for (const d of dates) {
      expect(d.getUTCHours()).toBe(13);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCDay()).not.toBe(0);
    }
  });

  it('si cae domingo corre a lunes (R1 jueves 03/09 → R2 y R4 caerían domingo)', () => {
    const dates = computeRescateDates(new Date('2026-09-03T13:00:00Z'));
    // +3 = dom 06/09 → lun 07/09
    expect(dates[0].toISOString()).toBe('2026-09-07T13:00:00.000Z');
    // +6 = mié 09/09
    expect(dates[1].toISOString()).toBe('2026-09-09T13:00:00.000Z');
    // +10 = dom 13/09 → lun 14/09
    expect(dates[2].toISOString()).toBe('2026-09-14T13:00:00.000Z');
  });

  it('ancla al día ART del R1 aunque el instante UTC sea el día siguiente', () => {
    // 04/09 23:30 ART = 05/09 02:30 UTC → día base ART = 04/09.
    const dates = computeRescateDates(new Date('2026-09-05T02:30:00Z'));
    expect(dates[0].toISOString()).toBe('2026-09-07T13:00:00.000Z');
  });

  it('sin domingos, los offsets son exactos', () => {
    const r1 = new Date('2026-09-04T13:00:00Z');
    const dates = computeRescateDates(r1);
    expect(dates[0].getTime() - r1.getTime()).toBe(3 * DAY_MS);
    expect(dates[1].getTime() - r1.getTime()).toBe(6 * DAY_MS);
    expect(dates[2].getTime() - r1.getTime()).toBe(10 * DAY_MS);
  });

  it('parseRescateCellDate lee la fecha real de la celda (año de r1)', () => {
    expect(parseRescateCellDate('rescate 04/09', 2026)!.toISOString()).toBe('2026-09-04T13:00:00.000Z');
    expect(parseRescateCellDate('Rescate 5/9 ', 2026)!.toISOString()).toBe('2026-09-05T13:00:00.000Z');
    expect(parseRescateCellDate('rescate 04/09/2025', 2026)!.toISOString()).toBe('2025-09-04T13:00:00.000Z');
    expect(parseRescateCellDate('rescate', 2026)).toBeNull();
    expect(parseRescateCellDate('rescate 31/02', 2026)).toBeNull();
    expect(parseRescateCellDate('04/09/2026', 2026)).toBeNull();
  });

  it('esDomingoART y diasArtEntre usan el calendario de Argentina', () => {
    expect(esDomingoART(new Date('2026-09-06T13:00:00Z'))).toBe(true); // dom 10:00 ART
    expect(esDomingoART(new Date('2026-09-07T01:00:00Z'))).toBe(true); // dom 22:00 ART
    expect(esDomingoART(new Date('2026-09-07T13:00:00Z'))).toBe(false);
    expect(diasArtEntre(new Date('2026-09-07T13:00:00Z'), new Date('2026-09-07T20:00:00Z'))).toBe(0);
    expect(diasArtEntre(new Date('2026-09-07T13:00:00Z'), new Date('2026-09-08T13:00:00Z'))).toBe(1);
    expect(diasArtEntre(new Date('2026-09-07T13:00:00Z'), new Date('2026-09-10T13:00:00Z'))).toBe(3);
  });

  it('parseR1Date acepta YYYY-MM-DD y dd/mm/yyyy; rechaza basura', () => {
    expect(parseR1Date('2026-09-04')!.toISOString()).toBe('2026-09-04T13:00:00.000Z');
    expect(parseR1Date('04/09/2026')!.toISOString()).toBe('2026-09-04T13:00:00.000Z');
    expect(parseR1Date('')).toBeNull();
    expect(parseR1Date('ayer')).toBeNull();
    expect(parseR1Date('2026-13-01')).toBeNull();
  });
});

// ─── Enrolamiento ───────────────────────────────────────────────────

describe('enrollRescate', () => {
  const dates = computeRescateDates(new Date('2026-09-04T13:00:00Z'));

  it('encola 3 entries kind rescate-a, step 2..4, sendAt = dates[i]', async () => {
    const r = await enrollRescate({ email: 'Lead@X.com', name: 'Juan', variante: 'A-Cuotas', dates });
    expect(r.scheduled).toBe(3);

    const entries = queueEntries().sort(
      (a, b) => (a.seqStep as number) - (b.seqStep as number)
    ) as Array<Record<string, string | number>>;
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.seqStep)).toEqual([2, 3, 4]);
    expect(entries.map((e) => e.sendAt)).toEqual(dates.map((d) => d.toISOString()));
    for (const e of entries) {
      expect(e.kind).toBe('rescate-a');
      expect(e.tag).toBe(RESCATE_TAG);
      expect(e.email).toBe('lead@x.com');
      expect(e.status).toBe('pending');
      expect(e.templateId).toBe(0);
      expect(e.rescateVariante).toBe('A-Cuotas');
    }
    expect(entries[0].subject).toBe('una palabra');
    expect(entries[1].subject).toBe('cómo es por dentro');
    expect(entries[2].subject).toBe('lo que sigue es tuyo');
  });

  it('bad-dates si no llegan 3 fechas', async () => {
    const r = await enrollRescate({ email: 'a@x.com', variante: '', dates: dates.slice(0, 2) });
    expect(r.scheduled).toBe(0);
    expect(r.skipped).toBe('bad-dates');
    expect(queueEntries()).toHaveLength(0);
  });

  it('dedupe con alreadyEnrolled (y lo actualiza)', async () => {
    const already = new Set<string>();
    const r1 = await enrollRescate({ email: 'a@x.com', variante: '', dates, alreadyEnrolled: already });
    expect(r1.scheduled).toBe(3);
    expect(already.has('a@x.com')).toBe(true);
    const r2 = await enrollRescate({ email: 'A@x.com', variante: '', dates, alreadyEnrolled: already });
    expect(r2.skipped).toBe('already-enrolled');
    expect(queueEntries()).toHaveLength(3);
  });

  it('getEnrolledRescateEmails devuelve los emails con entries rescate-a (cualquier status)', async () => {
    await enrollRescate({ email: 'a@x.com', variante: '', dates });
    seedRescate('viejo@x.com', 2, '2026-08-01T13:00:00.000Z', 'sent');
    const set = await getEnrolledRescateEmails();
    expect(set.has('a@x.com')).toBe(true);
    expect(set.has('viejo@x.com')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('getRescateEnrollmentSets: rescate (cualquier status) + secuencia pendiente en una lectura', async () => {
    seedRescate('ra@x.com', 2, '2026-09-07T13:00:00.000Z', 'cancelled');
    const h = kvMock.__hashes.get(QUEUE)!;
    h.set('sq_1', JSON.stringify({ id: 'sq_1', email: 'Seq@x.com', kind: 'secuencia', status: 'pending', sendAt: '2026-09-10T13:00:00.000Z' }));
    h.set('sq_2', JSON.stringify({ id: 'sq_2', email: 'done@x.com', kind: 'secuencia', status: 'sent', sendAt: '2026-08-10T13:00:00.000Z' }));
    const sets = await getRescateEnrollmentSets();
    expect([...sets.rescate]).toEqual(['ra@x.com']);
    expect([...sets.secuencia]).toEqual(['seq@x.com']);
  });

  it('enrollRescateBulk: un hset por chunk, dedupe y rowIndex en la entry', async () => {
    const kv = jest.requireMock('@vercel/kv').kv as { hset: (k: string, o: Record<string, string>) => Promise<number> };
    const spy = jest.spyOn(kv, 'hset');
    const already = new Set<string>(['ya@x.com']);
    const r = await enrollRescateBulk(
      [
        { email: 'a@x.com', name: 'Ana', variante: 'A-Cuotas', dates, rowIndex: 12 },
        { email: 'b@x.com', variante: '', dates, rowIndex: 13 },
        { email: 'A@x.com', variante: '', dates, rowIndex: 14 }, // dup dentro del lote
        { email: 'ya@x.com', variante: '', dates, rowIndex: 15 },
        { email: 'c@x.com', variante: '', dates, rowIndex: 16 },
        { email: 'bad@x.com', variante: '', dates: dates.slice(0, 1), rowIndex: 17 },
      ],
      already,
      2
    );
    expect(r).toEqual({ enrolados: 3, yaEnrolados: 2, badDates: 1 });
    expect(spy).toHaveBeenCalledTimes(2); // chunks: [a,b] y [c]
    expect(Object.keys(spy.mock.calls[0][1])).toHaveLength(6);
    expect(queueEntries()).toHaveLength(9);
    const deA = queueEntries().filter((e) => e.email === 'a@x.com');
    expect(deA.every((e) => e.rescateRowIndex === 12 && e.rescateVariante === 'A-Cuotas')).toBe(true);
    expect(already.has('c@x.com')).toBe(true);
    spy.mockRestore();
  });
});

// ─── Motor drip ─────────────────────────────────────────────────────

describe('processDripQueue — rescate-a', () => {
  it('envía R2 vencido desde mauro@, marca sent y registra "ra2 enviado dd/mm" en el Sheet', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z', 'pending', 'A-Cuotas');
    seedRescate('lead@x.com', 3, '2026-09-10T13:00:00.000Z');
    seedRescate('lead@x.com', 4, '2026-09-14T13:00:00.000Z');
    mockedReadCrm.mockResolvedValue({
      headers: [],
      rows: [{ rowIndex: 7, email: 'lead@x.com', cliente: '', estado: '', pantalla: 'A', fecha: '', nombre: 'Juan', secuencia: '' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    const res = await processDripQueue();

    expect(res.sent).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.remaining).toBe(2); // R3 y R4 siguen pendientes (no vencidos)

    const calls = brevoCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.subject).toBe('una palabra');
    expect((calls[0].body.sender as { email: string }).email).toBe('mauro@urologia.ar');
    expect((calls[0].body.to as Array<{ email: string }>)[0].email).toBe('lead@x.com');
    expect(String(calls[0].body.textContent)).toContain('Hola Juan,');
    expect(String(calls[0].body.textContent)).toContain('date de baja'); // pie de baja
    expect((calls[0].body.headers as Record<string, string>)['List-Unsubscribe']).toBeDefined();

    const byStep = Object.fromEntries(queueEntries().map((e) => [e.seqStep as number, e]));
    expect((byStep[2] as Record<string, string>).status).toBe('sent');
    expect((byStep[3] as Record<string, string>).status).toBe('pending');
    expect((byStep[4] as Record<string, string>).status).toBe('pending');

    expect(mockedWriteSecuencia).toHaveBeenCalledTimes(1);
    expect(mockedWriteSecuencia.mock.calls[0][1]).toEqual([{ rowIndex: 7, text: 'ra2 enviado 07/09' }]);
  });

  it('R3 vencido con PD correcta según variante A-Cuotas', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z', 'sent', 'A-Cuotas');
    seedRescate('lead@x.com', 3, '2026-09-10T13:00:00.000Z', 'pending', 'A-Cuotas');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(1);
    const text = String(brevoCalls()[0].body.textContent);
    expect(text).toContain('?mseq=ra3');
    expect(text).toContain('sé que la inversión pesa');
  });

  it('NO envía R3 si R2 no está sent (R2 pending no vencido → R3 queda pending, deferred)', async () => {
    // R2 con sendAt corrido a mano al futuro: R3 vencido no puede adelantarse.
    seedRescate('lead@x.com', 2, '2026-09-12T13:00:00.000Z');
    seedRescate('lead@x.com', 3, '2026-09-10T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T13:00:30Z'));
    const res = await processDripQueue();

    expect(res.sent).toBe(0);
    expect(res.deferred).toBe(1);
    expect(res.remaining).toBe(2);
    expect(brevoCalls()).toHaveLength(0);
    const byStep = Object.fromEntries(queueEntries().map((e) => [e.seqStep as number, e]));
    expect((byStep[3] as Record<string, string>).status).toBe('pending');
  });

  it('R2 y R3 vencidos en la misma corrida: sale R2 y R3 se difiere (nunca dos pasos el mismo día)', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z');
    seedRescate('lead@x.com', 3, '2026-09-10T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(1);
    expect(res.deferred).toBe(1);
    expect(brevoCalls().map((c) => c.body.subject)).toEqual(['una palabra']);
    const byStep = Object.fromEntries(queueEntries().map((e) => [e.seqStep as number, e]));
    expect((byStep[2] as Record<string, string>).status).toBe('sent');
    expect((byStep[3] as Record<string, string>).status).toBe('pending');
  });

  it('gap mínimo: R3 no sale al día siguiente del R2; sí a los 2 días', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z', 'sent', 'A-Limpia', { sentAt: '2026-09-10T13:00:05.000Z' });
    seedRescate('lead@x.com', 3, '2026-09-10T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T13:00:30Z'));
    let res = await processDripQueue();
    expect(res.sent).toBe(0);
    expect(res.deferred).toBe(1);

    jest.setSystemTime(new Date('2026-09-12T13:00:30Z'));
    res = await processDripQueue();
    expect(res.sent).toBe(1);
    expect(brevoCalls()[0].body.subject).toBe('cómo es por dentro');
  });

  it('domingo ART: no sale nada, todo diferido a mañana', async () => {
    seedRescate('a@x.com', 2, '2026-09-05T13:00:00.000Z');
    seedRescate('b@x.com', 2, '2026-09-05T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-06T13:00:30Z')); // domingo
    const res = await processDripQueue();
    expect(res.sent).toBe(0);
    expect(res.deferred).toBe(2);
    expect(res.remaining).toBe(2);
    expect(brevoCalls()).toHaveLength(0);
    expect(mockedReadCrm).not.toHaveBeenCalled();
  });

  it('R2 failed (1 intento) se reintenta en la corrida siguiente; R3 espera', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z', 'failed', 'A-Limpia', { attempts: 1, error: 'Brevo send 503' });
    seedRescate('lead@x.com', 3, '2026-09-10T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(1);
    expect(res.deferred).toBe(1);
    expect(brevoCalls().map((c) => c.body.subject)).toEqual(['una palabra']);
    const byStep = Object.fromEntries(queueEntries().map((e) => [e.seqStep as number, e]));
    expect((byStep[2] as Record<string, unknown>).status).toBe('sent');
    expect((byStep[2] as Record<string, unknown>).attempts).toBe(2);
    expect((byStep[2] as Record<string, unknown>).error).toBeUndefined();
    expect((byStep[3] as Record<string, unknown>).status).toBe('pending');
  });

  it('R2 failed con intentos agotados no se reintenta y R3 se cancela (previo-fallido)', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z', 'failed', 'A-Limpia', { attempts: 2 });
    seedRescate('lead@x.com', 3, '2026-09-10T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(0);
    expect(res.cancelled).toBe(1);
    expect(brevoCalls()).toHaveLength(0);
    const byStep = Object.fromEntries(queueEntries().map((e) => [e.seqStep as number, e]));
    expect((byStep[2] as Record<string, unknown>).status).toBe('failed');
    expect((byStep[3] as Record<string, unknown>).cancelReason).toBe('previo-fallido');
  });

  it('envío que falla dos veces queda failed con attempts=2 y no se vuelve a intentar', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z');
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.brevo.com')) {
        return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' };
      }
      return { ok: true, status: 200, json: async () => ({ values: [] }), text: async () => '' };
    });
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    let res = await processDripQueue();
    expect(res.failed).toBe(1);
    expect((queueEntries()[0] as Record<string, unknown>).attempts).toBe(1);
    jest.setSystemTime(new Date('2026-09-08T13:00:30Z'));
    res = await processDripQueue();
    expect(res.failed).toBe(1);
    expect((queueEntries()[0] as Record<string, unknown>).attempts).toBe(2);
    jest.setSystemTime(new Date('2026-09-09T13:00:30Z'));
    res = await processDripQueue();
    expect(res.processed).toBe(0); // agotado: no se vuelve a intentar
    expect((queueEntries()[0] as Record<string, unknown>).status).toBe('failed');
  });

  it('duplicado (doble enrolamiento): sale un solo R2, el otro se cancela', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z', 'pending', 'A-Limpia', { id: 'ra_dup_1' });
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z', 'pending', 'A-Limpia', { id: 'ra_dup_2' });
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(1);
    expect(res.cancelled).toBe(1);
    expect(brevoCalls()).toHaveLength(1);
    expect(queueEntries().map((e) => e.status).sort()).toEqual(['cancelled', 'sent']);
    expect(queueEntries().find((e) => e.status === 'cancelled')!.cancelReason).toBe('duplicado');
  });

  it('fail-closed: si el Sheet CRM no se puede leer, no sale nada (diferido)', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z');
    mockedReadCrm.mockRejectedValue(new Error('sheets 500'));
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(0);
    expect(res.deferred).toBe(1);
    expect(brevoCalls()).toHaveLength(0);
    expect((queueEntries()[0] as Record<string, string>).status).toBe('pending');
  });

  it('fail-closed: si el mapa de clientes falla, no sale nada (diferido)', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z');
    mockedGetClientes.mockRejectedValue(new Error('woo down'));
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(0);
    expect(res.deferred).toBe(1);
    expect(brevoCalls()).toHaveLength(0);
  });

  it('usa la fila del rescate (rescateRowIndex) para el Estado y la marca, no otra fila del email', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z', 'pending', 'A-Limpia', { rescateRowIndex: 9 });
    mockedReadCrm.mockResolvedValue({
      headers: [],
      rows: [
        { rowIndex: 4, email: 'lead@x.com', cliente: '', estado: 'no respondió', pantalla: 'A', fecha: '', nombre: 'Juan', secuencia: '' },
        { rowIndex: 9, email: 'lead@x.com', cliente: '', estado: '', pantalla: 'A', fecha: '', nombre: 'Juan', secuencia: '' },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(1);
    expect(mockedWriteSecuencia.mock.calls[0][1]).toEqual([{ rowIndex: 9, text: 'ra2 enviado 07/09' }]);
  });

  it('lock: si hay otra corrida en curso no procesa nada; al terminar libera el lock', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    kvMock.__store.set('lock:send-emails', 'otra');
    let res = await processDripQueue();
    expect(res.skipped).toBe('locked');
    expect(brevoCalls()).toHaveLength(0);

    kvMock.__store.delete('lock:send-emails');
    res = await processDripQueue();
    expect(res.sent).toBe(1);
    expect(kvMock.__store.has('lock:send-emails')).toBe(false);
  });

  it('varios emails en paralelo: cada uno recibe su R2 y las marcas van al Sheet', async () => {
    for (let i = 0; i < 12; i++) seedRescate(`p${i}@x.com`, 2, '2026-09-07T13:00:00.000Z');
    mockedReadCrm.mockResolvedValue({
      headers: [],
      rows: Array.from({ length: 12 }, (_, i) => ({
        rowIndex: i + 2, email: `p${i}@x.com`, cliente: '', estado: '', pantalla: 'A', fecha: '', nombre: '', secuencia: '',
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(12);
    const tos = brevoCalls().map((c) => (c.body.to as Array<{ email: string }>)[0].email).sort();
    expect(tos).toEqual(Array.from({ length: 12 }, (_, i) => `p${i}@x.com`).sort());
    expect(queueEntries().every((e) => e.status === 'sent')).toBe(true);
    const marks = mockedWriteSecuencia.mock.calls.flatMap((c) => c[1]);
    expect(marks).toHaveLength(12);
  });

  it('R3 se cancela (previo-cancelado) si R2 fue cancelado', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z', 'cancelled');
    seedRescate('lead@x.com', 3, '2026-09-10T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(0);
    expect(res.cancelled).toBe(1);
    const byStep = Object.fromEntries(queueEntries().map((e) => [e.seqStep as number, e]));
    expect((byStep[3] as Record<string, string>).cancelReason).toBe('previo-cancelado');
  });

  it('no envía a blacklisted (cancela con razón blacklist)', async () => {
    seedRescate('bl@x.com', 2, '2026-09-07T13:00:00.000Z');
    mockedIsBlacklisted.mockResolvedValue(true);
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    const res = await processDripQueue();

    expect(res.sent).toBe(0);
    expect(res.cancelled).toBe(1);
    expect(brevoCalls()).toHaveLength(0);
    expect((queueEntries()[0] as Record<string, string>).cancelReason).toBe('blacklist');
    expect(mockedWriteSecuencia).not.toHaveBeenCalled();
  });

  it('respeta Estado seguimiento no vacío (cancela con estado-crm, aunque no sea keyword)', async () => {
    seedRescate('est@x.com', 2, '2026-09-07T13:00:00.000Z');
    mockedReadCrm.mockResolvedValue({
      headers: [],
      rows: [{ rowIndex: 3, email: 'est@x.com', cliente: '', estado: 'Nuevo', pantalla: 'A', fecha: '', nombre: 'Juan', secuencia: '' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    const res = await processDripQueue();

    expect(res.sent).toBe(0);
    expect(res.cancelled).toBe(1);
    expect(brevoCalls()).toHaveLength(0);
    expect((queueEntries()[0] as Record<string, string>).cancelReason).toBe('estado-crm');
  });

  it('cancela si para entonces ya es cliente', async () => {
    seedRescate('buyer@x.com', 2, '2026-09-07T13:00:00.000Z');
    mockedEsCliente.mockResolvedValue(true);
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T13:00:30Z'));
    const res = await processDripQueue();
    expect(res.sent).toBe(0);
    expect(res.cancelled).toBe(1);
    expect((queueEntries()[0] as Record<string, string>).cancelReason).toBe('cliente');
  });

  it('no adelanta: a las 12:59 UTC del día no sale, a las 13:00 sí', async () => {
    seedRescate('lead@x.com', 2, '2026-09-07T13:00:00.000Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T12:59:00Z'));
    let res = await processDripQueue();
    expect(res.sent).toBe(0);
    expect(res.remaining).toBe(1);
    jest.setSystemTime(new Date('2026-09-07T13:00:00Z'));
    res = await processDripQueue();
    expect(res.sent).toBe(1);
  });

  it('cancelDripForEmail cancela los rescate-a pendientes (compra)', async () => {
    const dates = computeRescateDates(new Date('2026-09-04T13:00:00Z'));
    await enrollRescate({ email: 'x@x.com', name: 'Ana', variante: 'A-Limpia', dates });
    const { cancelled } = await cancelDripForEmail('X@X.com');
    expect(cancelled).toBe(3);
    for (const e of queueEntries()) {
      expect(e.status).toBe('cancelled');
      expect(e.cancelReason).toBe('compra');
    }
  });
});

// ─── Candidatos (puro) ──────────────────────────────────────────────

describe('computeRescateCandidatos', () => {
  const esCliente = (email: string) => email === 'cliente@x.com';
  function row(p: Partial<RescateRow>): RescateRow {
    return {
      email: p.email ?? 'lead@x.com',
      nombre: p.nombre ?? 'Juan',
      pantalla: p.pantalla ?? 'A',
      estado: p.estado ?? '',
      cliente: p.cliente ?? '',
      mailEnviado: p.mailEnviado ?? 'rescate 04/09',
      variante: p.variante ?? 'A-Limpia',
      rowIndex: p.rowIndex ?? 2,
    };
  }

  it('tieneRescateR1 detecta el prefijo', () => {
    expect(tieneRescateR1('rescate 04/09')).toBe(true);
    expect(tieneRescateR1('  Rescate 04/09 ')).toBe(true);
    expect(tieneRescateR1('04/09/2026')).toBe(false);
    expect(tieneRescateR1('')).toBe(false);
    expect(tieneRescateR1('rescate')).toBe(false);
  });

  it('aplica todos los filtros y cuenta descartes', () => {
    const res = computeRescateCandidatos(
      [
        row({ email: 'ok@x.com', variante: 'A-Cuotas', rowIndex: 2 }),
        row({ email: 'sinres@x.com', mailEnviado: '04/09/2026', rowIndex: 3 }),
        row({ email: 'no-es-mail', rowIndex: 4 }),
        row({ email: 'OK@x.com', rowIndex: 5 }), // duplicado
        row({ email: 'b@x.com', pantalla: 'B', rowIndex: 6 }),
        row({ email: 'est@x.com', estado: 'Respondido', rowIndex: 7 }),
        row({ email: 'cli@x.com', cliente: 'programa 01/09/2026', rowIndex: 8 }),
        row({ email: 'pruebatester7@gmail.com', rowIndex: 9 }), // exclusión 1-a-1
        row({ email: 'cliente@x.com', rowIndex: 10 }),
        row({ email: 'ya@x.com', rowIndex: 11 }),
        row({ email: 'seq@x.com', rowIndex: 12 }),
      ],
      {
        esCliente,
        yaEnrolados: new Set(['ya@x.com']),
        enSecuencia: new Set(['seq@x.com']),
        max: 1000,
        anioR1: 2026,
      }
    );
    expect(res.candidatos).toEqual([
      { email: 'ok@x.com', nombre: 'Juan', variante: 'A-Cuotas', rowIndex: 2, r1Celda: new Date('2026-09-04T13:00:00Z') },
    ]);
    expect(res.descartes).toEqual({
      'sin-rescate': 1,
      'email-invalido': 1,
      duplicado: 1,
      'no-pantalla-a': 1,
      'estado-no-vacio': 1,
      'cliente-col': 1,
      'excluido-1a1': 1,
      cliente: 1,
      'ya-enrolado': 1,
      'en-secuencia': 1,
      max: 0,
    });
    expect(res.totalRows).toBe(11);
    expect(res.conRescate).toBe(10);
  });

  it('r1Celda null si la celda no trae fecha parseable', () => {
    const res = computeRescateCandidatos([row({ email: 'a@x.com', mailEnviado: 'rescate hoy' })], {
      esCliente,
      yaEnrolados: new Set(),
      max: 10,
      anioR1: 2026,
    });
    expect(res.candidatos[0].r1Celda).toBeNull();
  });

  it('max corta la lista', () => {
    const res = computeRescateCandidatos(
      [row({ email: 'a@x.com' }), row({ email: 'b@x.com' }), row({ email: 'c@x.com' })],
      { esCliente, yaEnrolados: new Set(), max: 2 }
    );
    expect(res.candidatos.map((c) => c.email)).toEqual(['a@x.com', 'b@x.com']);
    expect(res.descartes.max).toBe(1);
  });
});

// ─── Endpoint ───────────────────────────────────────────────────────

describe('GET /api/admin/enroll-rescate', () => {
  const NCOLS = 33;
  const HEADER_AT: Record<number, string> = {
    0: '¿Cómo te llamás?',
    1: '¿Cuál es tu mejor email para contactarte?',
    20: 'Submitted At',
    24: 'Pantalla',
    25: 'Variante',
    26: 'Estado seguimiento',
    30: 'Mail enviado',
    31: 'Cliente',
    32: 'Secuencia',
  };
  const headers = Array.from({ length: NCOLS }, (_, i) => HEADER_AT[i] || `col${i}`);

  interface R {
    email: string;
    nombre?: string;
    pantalla?: string;
    variante?: string;
    estado?: string;
    cliente?: string;
    mail?: string;
  }

  function setupSheet(rows: R[], opts: { omitVariante?: boolean } = {}) {
    const hs = opts.omitVariante ? headers.map((h) => (h === 'Variante' ? 'otra' : h)) : headers;
    mockedReadCrm.mockResolvedValue({
      headers: hs,
      emailCol: 1,
      rows: rows.map((r, i) => ({
        rowIndex: i + 2,
        email: r.email.trim().toLowerCase(),
        cliente: r.cliente ?? '',
        estado: r.estado ?? '',
        pantalla: r.pantalla ?? 'A',
        fecha: '',
        nombre: r.nombre ?? 'Juan',
        secuencia: '',
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    sheetCols = {
      [colLetter(1)]: rows.map((r) => r.email),
      [colLetter(30)]: rows.map((r) => r.mail ?? 'rescate 04/09'),
      [colLetter(25)]: rows.map((r) => r.variante ?? 'A-Limpia'),
    };
  }

  function req(qs: string, headersInit?: Record<string, string>): NextRequest {
    return new NextRequest(`http://localhost/api/admin/enroll-rescate${qs}`, { headers: headersInit });
  }

  const REAL = '?token=test-secret-key&dry=0&confirm=enrolar';

  beforeEach(() => {
    // "Hoy" fijo: el run real rechaza R2 vencidos, y R1 default es 04/09/2026.
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T18:00:00Z'));
  });

  it('500 si falta API_SECRET_KEY', async () => {
    delete process.env.API_SECRET_KEY;
    const res = await GET(req('?token=test-secret-key'));
    expect(res.status).toBe(500);
  });

  it('401 sin token o con token incorrecto; acepta x-api-key', async () => {
    setupSheet([]);
    expect((await GET(req(''))).status).toBe(401);
    expect((await GET(req('?token=malo'))).status).toBe(401);
    const ok = await GET(req('', { 'x-api-key': 'test-secret-key' }));
    expect(ok.status).toBe(200);
  });

  it('dry por default: reporta candidatos, fechas y muestra enmascarada, sin escrituras', async () => {
    setupSheet([
      { email: 'juanperez@x.com', variante: 'A-Cuotas' },
      { email: 'pedro@x.com', variante: 'A-Limpia' },
    ]);
    const res = await GET(req('?token=test-secret-key'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.dry).toBe(true);
    expect(body.candidatos.total).toBe(2);
    expect(body.candidatos.porVariante).toEqual({ 'A-Cuotas': 1, 'A-Limpia': 1 });
    expect(body.fechas).toEqual({
      r1: '2026-09-04T13:00:00.000Z',
      r2: '2026-09-07T13:00:00.000Z',
      r3: '2026-09-10T13:00:00.000Z',
      r4: '2026-09-14T13:00:00.000Z',
    });
    expect(body.muestra).toHaveLength(2);
    expect(body.muestra[0].email).toBe('ju***@x.com');
    expect(body.muestra[0].variante).toBe('A-Cuotas');
    expect(body.enrolamiento).toEqual({ aplicado: false, enrolados: 0, yaEnrolados: 0 });

    // Sin escrituras: cola vacía, nada a Brevo, nada al Sheet.
    expect(queueEntries()).toHaveLength(0);
    expect(brevoCalls()).toHaveLength(0);
    expect(mockedWriteSecuencia).not.toHaveBeenCalled();
  });

  it('dry=0 sin confirm=enrolar sigue siendo dry', async () => {
    setupSheet([{ email: 'a@x.com' }]);
    const body = await (await GET(req('?token=test-secret-key&dry=0'))).json();
    expect(body.dry).toBe(true);
    expect(queueEntries()).toHaveLength(0);
  });

  it('filtra filas sin "rescate " en Mail enviado y las otras exclusiones', async () => {
    setupSheet([
      { email: 'ok@x.com' },
      { email: 'viejo@x.com', mail: '04/09/2026' },
      { email: 'vacio@x.com', mail: '' },
      { email: 'b@x.com', pantalla: 'B' },
      { email: 'est@x.com', estado: 'Respondido' },
      { email: 'cli@x.com', cliente: 'programa 01/09/2026' },
      { email: 'ok@x.com' }, // duplicado
    ]);
    const body = await (await GET(req('?token=test-secret-key'))).json();
    expect(body.candidatos.total).toBe(1);
    expect(body.sheet.totalRows).toBe(7);
    expect(body.sheet.conRescate).toBe(5);
    expect(body.descartes['sin-rescate']).toBe(2);
    expect(body.descartes['no-pantalla-a']).toBe(1);
    expect(body.descartes['estado-no-vacio']).toBe(1);
    expect(body.descartes['cliente-col']).toBe(1);
    expect(body.descartes.duplicado).toBe(1);
  });

  it('excluye clientes de WooCommerce (getClientes)', async () => {
    setupSheet([{ email: 'ok@x.com' }, { email: 'comprador@x.com' }]);
    mockedGetClientes.mockResolvedValue(
      new Map([
        ['comprador@x.com', { estado: 'cliente-programa', productos: [3740], fechaUltimaCompra: null }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ]) as any
    );
    const body = await (await GET(req('?token=test-secret-key'))).json();
    expect(body.candidatos.total).toBe(1);
    expect(body.descartes.cliente).toBe(1);
  });

  it('excluye emails ya enrolados en rescate-a', async () => {
    setupSheet([{ email: 'nuevo@x.com' }, { email: 'ya@x.com' }]);
    seedRescate('ya@x.com', 2, '2026-09-07T13:00:00.000Z');
    const body = await (await GET(req('?token=test-secret-key'))).json();
    expect(body.candidatos.total).toBe(1);
    expect(body.descartes['ya-enrolado']).toBe(1);
    expect(body.enrolamiento.yaEnrolados).toBe(1);
  });

  it('excluye emails con secuencia post-Typeform pendiente (en-secuencia)', async () => {
    setupSheet([{ email: 'nuevo@x.com' }, { email: 'seq@x.com' }]);
    kvMock.__hashes.set(QUEUE, new Map([
      ['sq_1', JSON.stringify({ id: 'sq_1', email: 'seq@x.com', kind: 'secuencia', status: 'pending', sendAt: '2026-09-10T13:00:00.000Z' })],
    ]));
    const body = await (await GET(req('?token=test-secret-key'))).json();
    expect(body.candidatos.total).toBe(1);
    expect(body.descartes['en-secuencia']).toBe(1);
  });

  it('409 si el Sheet cambió entre lecturas (email desalineado)', async () => {
    setupSheet([{ email: 'a@x.com' }, { email: 'b@x.com' }]);
    sheetCols[colLetter(1)] = ['b@x.com', 'a@x.com']; // segunda lectura ordenada distinto
    const res = await GET(req('?token=test-secret-key'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('cambió durante la lectura');
  });

  it('usa la fecha real de la celda (rescate dd/mm) por fila y reporta fechasR1', async () => {
    setupSheet([
      { email: 'a@x.com', mail: 'rescate 04/09' },
      { email: 'b@x.com', mail: 'rescate 05/09' },
      { email: 'c@x.com', mail: 'rescate xx' },
    ]);
    const body = await (await GET(req('?token=test-secret-key'))).json();
    expect(body.fechasR1).toEqual({ '04/09/2026': 2, '05/09/2026': 1 });
    expect(body.warnings).toEqual([expect.stringContaining('1 candidatos sin fecha parseable')]);
    expect(body.muestra.map((m: { r2: string }) => m.r2)).toEqual([
      '2026-09-07T13:00:00.000Z',
      '2026-09-08T13:00:00.000Z',
      '2026-09-07T13:00:00.000Z',
    ]);
  });

  it('lote reparte los R2 en días sucesivos (cada uno conserva +3/+6/+10)', async () => {
    setupSheet([{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }]);
    const body = await (await GET(req('?token=test-secret-key&lote=2'))).json();
    expect(body.lote).toBe(2);
    expect(body.lotes).toEqual([
      { base: '2026-09-04T13:00:00.000Z', n: 2, r2: '2026-09-07T13:00:00.000Z', r3: '2026-09-10T13:00:00.000Z', r4: '2026-09-14T13:00:00.000Z' },
      { base: '2026-09-05T13:00:00.000Z', n: 1, r2: '2026-09-08T13:00:00.000Z', r3: '2026-09-11T13:00:00.000Z', r4: '2026-09-15T13:00:00.000Z' },
    ]);

    const real = await (await GET(req(`${REAL}&lote=2`))).json();
    expect(real.enrolamiento.enrolados).toBe(3);
    const deC = queueEntries().filter((e) => e.email === 'c@x.com').map((e) => e.sendAt).sort();
    expect(deC).toEqual(['2026-09-08T13:00:00.000Z', '2026-09-11T13:00:00.000Z', '2026-09-15T13:00:00.000Z']);
  });

  it('run real rechaza (400) si algún R2 ya está vencido; con force=1 enrola y avisa', async () => {
    setupSheet([{ email: 'a@x.com', mail: 'rescate 20/08' }]);
    const res = await GET(req(REAL));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('R2 ya vencido');
    expect(queueEntries()).toHaveLength(0);

    const dryBody = await (await GET(req('?token=test-secret-key'))).json();
    expect(dryBody.success).toBe(true);
    expect(dryBody.warnings).toEqual([expect.stringContaining('R2 ya vencido')]);

    const forced = await (await GET(req(`${REAL}&force=1`))).json();
    expect(forced.success).toBe(true);
    expect(forced.enrolamiento.enrolados).toBe(1);
    expect(queueEntries()).toHaveLength(3);
  });

  it('run real con lock tomado → 409 sin escrituras; el dry no usa lock', async () => {
    setupSheet([{ email: 'a@x.com' }]);
    kvMock.__store.set('lock:enroll-rescate', 'otro');
    const res = await GET(req(REAL));
    expect(res.status).toBe(409);
    expect(queueEntries()).toHaveLength(0);
    const dry = await GET(req('?token=test-secret-key'));
    expect(dry.status).toBe(200);
  });

  it('run real libera el lock al terminar', async () => {
    setupSheet([{ email: 'a@x.com' }]);
    const body = await (await GET(req(REAL))).json();
    expect(body.enrolamiento.enrolados).toBe(1);
    expect(kvMock.__store.has('lock:enroll-rescate')).toBe(false);
  });

  it('run real (dry=0&confirm=enrolar): encola 3 mails por candidato con la variante y la fila', async () => {
    setupSheet([
      { email: 'a@x.com', nombre: 'Ana', variante: 'A-Cuotas' },
      { email: 'b@x.com', nombre: '', variante: 'A-Limpia' },
      { email: 'ya@x.com' },
    ]);
    seedRescate('ya@x.com', 2, '2026-09-07T13:00:00.000Z');

    const body = await (await GET(req(REAL))).json();
    expect(body.dry).toBe(false);
    expect(body.enrolamiento).toEqual({ aplicado: true, enrolados: 2, yaEnrolados: 1 });
    expect(body.descartes['ya-enrolado']).toBe(1);

    const entries = queueEntries().filter((e) => e.id !== 'ra_test_ya@x.com_2');
    expect(entries).toHaveLength(6);
    const deA = entries.filter((e) => e.email === 'a@x.com') as Array<Record<string, unknown>>;
    expect(deA.map((e) => e.seqStep).sort()).toEqual([2, 3, 4]);
    expect(deA.every((e) => e.rescateVariante === 'A-Cuotas' && e.name === 'Ana' && e.rescateRowIndex === 2)).toBe(true);
    expect(deA.map((e) => e.sendAt).sort()).toEqual([
      '2026-09-07T13:00:00.000Z',
      '2026-09-10T13:00:00.000Z',
      '2026-09-14T13:00:00.000Z',
    ]);
    const deB = entries.filter((e) => e.email === 'b@x.com') as Array<Record<string, unknown>>;
    expect(deB.every((e) => e.rescateVariante === 'A-Limpia' && e.name === undefined)).toBe(true);
    // No manda nada por Brevo (sólo encola).
    expect(brevoCalls()).toHaveLength(0);
  });

  it('r1 y max por query; r1 inválida → 400', async () => {
    setupSheet([{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }]);
    const body = await (await GET(req('?token=test-secret-key&r1=2026-09-03&max=2'))).json();
    expect(body.fechas.r2).toBe('2026-09-07T13:00:00.000Z'); // dom 06/09 → lun
    expect(body.fechas.r3).toBe('2026-09-09T13:00:00.000Z');
    expect(body.fechas.r4).toBe('2026-09-14T13:00:00.000Z'); // dom 13/09 → lun
    expect(body.candidatos.total).toBe(2);
    expect(body.descartes.max).toBe(1);

    const bad = await GET(req('?token=test-secret-key&r1=ayer'));
    expect(bad.status).toBe(400);
  });

  it('sin columna Variante: warning y variante vacía (PD por defecto)', async () => {
    setupSheet([{ email: 'a@x.com' }], { omitVariante: true });
    const body = await (await GET(req('?token=test-secret-key'))).json();
    expect(body.warnings).toHaveLength(1);
    expect(body.sheet.varianteCol).toBeNull();
    expect(body.muestra[0].variante).toBe('');
  });

  it('500 si falta la columna Mail enviado', async () => {
    mockedReadCrm.mockResolvedValue({
      headers: headers.map((h) => (h === 'Mail enviado' ? 'otra' : h)),
      rows: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await GET(req('?token=test-secret-key'));
    expect(res.status).toBe(500);
  });
});
