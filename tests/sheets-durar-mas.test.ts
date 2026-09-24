/**
 * Tests del rastro de duplicado en el Sheet de leads "Durar más"
 * (logLeadDurarMas: lead que re-envía el formulario → nota "pidió de nuevo"
 * en la columna H de su fila). Se mockean google-auth y el fetch de la API
 * de Sheets; la lógica de sheets-durar-mas se ejerce de verdad.
 */
jest.mock('@/lib/google-auth', () => ({
  getGoogleAccessToken: jest.fn(async () => 'test-token'),
}));

import { logLeadDurarMas } from '@/lib/sheets-durar-mas';

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

/**
 * Mock de la API de Sheets por URL:
 *   - lectura C:C → columna de emails (header + filas)
 *   - lectura HN  → contenido actual de Notas de esa fila
 *   - batchUpdate / append → ok vacío
 */
function mockSheetsApi(opts: { emails: string[]; notaActual?: string; failUpdate?: boolean }) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const decoded = decodeURIComponent(String(url));
    if (decoded.includes('Leads!C:C')) {
      return {
        ok: true,
        json: async () => ({ values: [['Email'], ...opts.emails.map((e) => [e])] }),
      };
    }
    if (/Leads!H\d+/.test(decoded) && init?.method !== 'POST') {
      return {
        ok: true,
        json: async () => (opts.notaActual ? { values: [[opts.notaActual]] } : {}),
      };
    }
    if (decoded.includes(':batchUpdate')) {
      if (opts.failUpdate) {
        return { ok: false, status: 500, text: async () => 'boom' };
      }
      return { ok: true, json: async () => ({}) };
    }
    if (decoded.includes(':append')) {
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`fetch inesperado: ${decoded}`);
  });
}

/** Calls a batchUpdate → bodies parseados. */
function batchUpdateBodies(): Array<{ data: Array<{ range: string; values: string[][] }> }> {
  return fetchMock.mock.calls
    .filter(([url]) => decodeURIComponent(String(url)).includes(':batchUpdate'))
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('logLeadDurarMas — duplicado deja rastro en Notas (col H)', () => {
  it('sin nota previa: escribe "pidió de nuevo dd/mm/yyyy hh:mm" en la fila del email', async () => {
    // Header en fila 1 + lead@x.com en fila 3.
    mockSheetsApi({ emails: ['otro@x.com', 'lead@x.com'] });

    const r = await logLeadDurarMas({ nombre: 'Juan', email: 'Lead@X.com', fuente: 'ig' });
    expect(r).toEqual({ ok: true, duplicate: true });

    const bodies = batchUpdateBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].data).toHaveLength(1);
    expect(bodies[0].data[0].range).toBe('Leads!H3');
    expect(bodies[0].data[0].values[0][0]).toMatch(
      /^pidió de nuevo \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/
    );

    // No agrega fila nueva.
    const appendCalls = fetchMock.mock.calls.filter(([url]) =>
      decodeURIComponent(String(url)).includes(':append')
    );
    expect(appendCalls).toHaveLength(0);
  });

  it('con nota previa: concatena con " · " (mismo patrón que la col Secuencia)', async () => {
    mockSheetsApi({ emails: ['lead@x.com'], notaActual: 'vino de tiktok' });

    const r = await logLeadDurarMas({ nombre: '', email: 'lead@x.com', fuente: 'ig' });
    expect(r).toEqual({ ok: true, duplicate: true });

    const bodies = batchUpdateBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].data[0].range).toBe('Leads!H2');
    expect(bodies[0].data[0].values[0][0]).toMatch(
      /^vino de tiktok · pidió de nuevo \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/
    );
  });

  it('si el update de la nota falla, devuelve igual {ok:true, duplicate:true}', async () => {
    mockSheetsApi({ emails: ['lead@x.com'], failUpdate: true });

    const r = await logLeadDurarMas({ nombre: '', email: 'lead@x.com', fuente: 'ig' });
    expect(r).toEqual({ ok: true, duplicate: true });
  });

  it('email nuevo: appendea la fila y no toca Notas', async () => {
    mockSheetsApi({ emails: ['otro@x.com'] });

    const r = await logLeadDurarMas({ nombre: 'Juan', email: 'nuevo@x.com', fuente: 'ig' });
    expect(r).toEqual({ ok: true });

    expect(batchUpdateBodies()).toHaveLength(0);
    const appendCalls = fetchMock.mock.calls.filter(([url]) =>
      decodeURIComponent(String(url)).includes(':append')
    );
    expect(appendCalls).toHaveLength(1);
  });
});
