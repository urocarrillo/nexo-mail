/**
 * Envío de test de la secuencia post-test (v6, 24/09/2026).
 *
 * Manda AHORA los 7 mails de la secuencia corta al email del query, con los
 * asuntos prefijados "[TEST …] ": A0 (solitario sí / a veces), A1, A4, B0
 * (factor físico / vínculo) y B3. Es lo ÚNICO que envía mails de esta tarea,
 * y sólo al email pasado en ?to=. Sirve para revisar el copy en el inbox.
 *
 * Protegido con API_SECRET_KEY (query ?token= o header x-api-key).
 *
 *   GET /api/admin/test-secuencia?token=XXX&to=urologia.carrillo@gmail.com
 *   GET /api/admin/test-secuencia?token=XXX&to=...&name=Mauro   (nombre opcional)
 */
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

import { sendPlainSecuencia } from '@/lib/email-drip';
import {
  buildMailA0,
  buildMailA4,
  buildMailB0,
  buildMailPudisteVer,
  type SecuenciaMail,
} from '@/lib/secuencia-post-typeform';

function authorized(request: NextRequest): boolean {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-api-key');
  return Boolean(process.env.API_SECRET_KEY) && token === process.env.API_SECRET_KEY;
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Orden de la muestra: tier A (día 0, 1, 4) y tier B (día 0, 3).
const SPECS: Array<{ label: string; build: (name: string) => SecuenciaMail }> = [
  { label: 'A0 solitario-sí', build: (n) => buildMailA0(n, { soloOk: true }) },
  { label: 'A0 solitario-a-veces', build: (n) => buildMailA0(n, { soloOk: false }) },
  { label: 'A1 día 1', build: (n) => buildMailPudisteVer(n, 'A') },
  { label: 'A4 día 4', build: (n) => buildMailA4(n) },
  { label: 'B0 físico', build: (n) => buildMailB0(n, 'fisico') },
  { label: 'B0 vínculo', build: (n) => buildMailB0(n, 'vinculo') },
  { label: 'B3 día 3', build: (n) => buildMailPudisteVer(n, 'B') },
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const to = (url.searchParams.get('to') || '').trim().toLowerCase();
  const name = (url.searchParams.get('name') || '').trim();

  if (!validEmail(to)) {
    return NextResponse.json(
      { success: false, error: 'Falta ?to= con un email válido' },
      { status: 400 }
    );
  }

  const results: Array<{ label: string; ok: boolean; messageId?: string; error?: string }> = [];
  for (const s of SPECS) {
    const m = s.build(name);
    const subject = `[TEST ${s.label}] ${m.subject}`;
    const r = await sendPlainSecuencia(to, name || undefined, subject, m.text);
    results.push({ label: s.label, ok: r.success, messageId: r.messageId, error: r.error });
  }

  return NextResponse.json({
    success: true,
    to,
    enviados: results.filter((r) => r.ok).length,
    total: results.length,
    results,
    timestamp: new Date().toISOString(),
  });
}
