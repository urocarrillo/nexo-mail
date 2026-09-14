/**
 * /api/unsubscribe — la baja tiene que cortar el drip aunque el lead nunca haya
 * sido contacto de Brevo (leads del test propio / Typeform entran por Sheet + KV).
 * Caso real 13/09/2026: PUT → 404 se daba por ok y el lead seguía recibiendo.
 */
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/unsubscribe/route';

const EMAIL = 'lead.test@example.com';
const token = (email: string) =>
  createHmac('sha256', process.env.API_SECRET_KEY as string)
    .update(email.toLowerCase().trim())
    .digest('hex')
    .slice(0, 32);

const url = (email: string, t: string) =>
  `https://nexo-mail.vercel.app/api/unsubscribe?e=${encodeURIComponent(email)}&t=${t}`;

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const resp = (status: number) => ({ status, ok: status < 400, json: async () => ({}) });

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('POST /api/unsubscribe', () => {
  it('contacto existente: un solo PUT con emailBlacklisted=true → 200', async () => {
    fetchMock.mockResolvedValueOnce(resp(204));
    const res = await POST(new NextRequest(url(EMAIL, token(EMAIL)), { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Listo. No te escribo más.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [u, init] = fetchMock.mock.calls[0];
    expect(u).toBe(`https://api.brevo.com/v3/contacts/${encodeURIComponent(EMAIL)}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ emailBlacklisted: true });
  });

  it('contacto inexistente (404): lo crea blacklisteado con POST /contacts → 200', async () => {
    fetchMock.mockResolvedValueOnce(resp(404)).mockResolvedValueOnce(resp(201));
    const res = await POST(new NextRequest(url(EMAIL, token(EMAIL)), { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [u, init] = fetchMock.mock.calls[1];
    expect(u).toBe('https://api.brevo.com/v3/contacts');
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe(process.env.BREVO_API_KEY);
    expect(JSON.parse(init.body)).toEqual({
      email: EMAIL,
      emailBlacklisted: true,
      updateEnabled: true,
    });
  });

  it('normaliza el email (mayúsculas/espacios) en PUT y POST', async () => {
    const raw = '  Lead.Test@Example.com ';
    fetchMock.mockResolvedValueOnce(resp(404)).mockResolvedValueOnce(resp(201));
    const res = await POST(new NextRequest(url(raw, token(raw)), { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.brevo.com/v3/contacts/${encodeURIComponent(EMAIL)}`
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).email).toBe(EMAIL);
  });

  it('404 + carrera (POST devuelve 204 porque ya existía) → 200', async () => {
    fetchMock.mockResolvedValueOnce(resp(404)).mockResolvedValueOnce(resp(204));
    const res = await POST(new NextRequest(url(EMAIL, token(EMAIL)), { method: 'POST' }));
    expect(res.status).toBe(200);
  });

  it('404 y el alta falla (400) → 500 con mensaje de contacto manual', async () => {
    fetchMock.mockResolvedValueOnce(resp(404)).mockResolvedValueOnce(resp(400));
    const res = await POST(new NextRequest(url(EMAIL, token(EMAIL)), { method: 'POST' }));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('escribime a mauro@urologia.ar');
  });

  it('PUT falla con otro código (500) → 500, sin intentar el alta', async () => {
    fetchMock.mockResolvedValueOnce(resp(500));
    const res = await POST(new NextRequest(url(EMAIL, token(EMAIL)), { method: 'POST' }));
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('firma inválida → 400 y no toca Brevo', async () => {
    const res = await POST(new NextRequest(url(EMAIL, 'x'.repeat(32)), { method: 'POST' }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/unsubscribe', () => {
  it('solo muestra la confirmación, nunca ejecuta la baja (escáneres de mail)', async () => {
    const res = await GET(new NextRequest(url(EMAIL, token(EMAIL))));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('method="post"');
    expect(html).toContain('Sí, darme de baja');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('firma inválida → 400', async () => {
    const res = await GET(new NextRequest(url(EMAIL, 'x'.repeat(32))));
    expect(res.status).toBe(400);
  });
});
