/**
 * Envío de test de la secuencia "Durar más" (curso EP).
 *
 * Manda AHORA los 3 mails de la v3 (ep0 entrega + ep1 día 1 + ep2 día 4) al
 * email del query, con los asuntos prefijados "[TEST epN] ". Es lo ÚNICO que
 * envía mails de esta tarea, y sólo al email pasado en ?to=. Sirve para revisar
 * el copy en el inbox antes de enrolar a nadie. Todo sale desde mauro@.
 *
 * Protegido con API_SECRET_KEY (query ?token= o header x-api-key).
 *
 *   GET /api/admin/test-secuencia-durar-mas?token=XXX&to=urologia.carrillo@gmail.com
 *   GET /api/admin/test-secuencia-durar-mas?token=XXX&to=...&name=Mauro   (nombre opcional)
 */
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

import { sendPlainSecuencia } from '@/lib/email-drip';
import {
  buildDurarMasMail,
  mailEntrega,
  DURARMAS_SENDER_ENTREGA,
  DURARMAS_SENDER_SECUENCIA,
  type DurarMasMail,
} from '@/lib/secuencia-durar-mas';

function authorized(request: NextRequest): boolean {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-api-key');
  return Boolean(process.env.API_SECRET_KEY) && token === process.env.API_SECRET_KEY;
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

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

  // Orden de la muestra: ep0 (entrega), ep1, ep2.
  const specs: Array<{ label: string; mail: DurarMasMail; sender: { name: string; email: string } }> = [
    { label: 'ep0', mail: mailEntrega(name), sender: DURARMAS_SENDER_ENTREGA },
    ...[1, 2].map((step) => ({
      label: `ep${step}`,
      mail: buildDurarMasMail(step, name),
      sender: DURARMAS_SENDER_SECUENCIA,
    })),
  ];

  const results: Array<{ label: string; ok: boolean; messageId?: string; error?: string }> = [];
  for (const s of specs) {
    const subject = `[TEST ${s.label}] ${s.mail.subject}`;
    const r = await sendPlainSecuencia(to, name || undefined, subject, s.mail.text, s.sender);
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
