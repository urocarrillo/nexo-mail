/**
 * Envío de test de la secuencia post-Typeform.
 *
 * Manda AHORA los 9 mails (M0, M1A, M1B, M2..M8) al email del query, con los
 * asuntos prefijados "[TEST sqN] ". Es lo ÚNICO que envía mails de esta tarea,
 * y sólo al email pasado en ?to=. Sirve para revisar el copy en el inbox antes
 * de enrolar a nadie.
 *
 * Protegido con API_SECRET_KEY (query ?token= o header x-api-key).
 *
 *   GET /api/admin/test-secuencia?token=XXX&to=urologia.carrillo@gmail.com
 *   GET /api/admin/test-secuencia?token=XXX&to=...&name=Mauro   (nombre opcional)
 */
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

import { sendPlainSecuencia } from '@/lib/email-drip';
import { buildSecuenciaMail, type MailVariant } from '@/lib/secuencia-post-typeform';

function authorized(request: NextRequest): boolean {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-api-key');
  return Boolean(process.env.API_SECRET_KEY) && token === process.env.API_SECRET_KEY;
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Orden de la muestra: M0, M1A, M1B, M2..M8.
const SPECS: Array<{ label: string; step: number; variant: MailVariant }> = [
  { label: 'sq0', step: 0, variant: 'A' },
  { label: 'sq1A', step: 1, variant: 'A' },
  { label: 'sq1B', step: 1, variant: 'B' },
  { label: 'sq2', step: 2, variant: 'A' },
  { label: 'sq3', step: 3, variant: 'A' },
  { label: 'sq4', step: 4, variant: 'A' },
  { label: 'sq5', step: 5, variant: 'A' },
  { label: 'sq6', step: 6, variant: 'A' },
  { label: 'sq7', step: 7, variant: 'A' },
  { label: 'sq8', step: 8, variant: 'A' },
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
    const m = buildSecuenciaMail(s.step, name, s.variant);
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
