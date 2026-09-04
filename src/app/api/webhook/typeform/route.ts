import { NextRequest, NextResponse } from 'next/server';
import { dispatchPostTest, parsePayload } from '@/lib/postest';

/**
 * Webhook post-test del programa DE. Wrapper fino: auth x-api-key + parse +
 * dispatchPostTest (la lógica vive en src/lib/postest.ts, compartida con el
 * cron postest-vigilante).
 */

function validateApiKey(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key');
  return Boolean(apiKey) && apiKey === process.env.API_SECRET_KEY;
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    success: true,
    message: 'Typeform webhook endpoint active. POST with x-api-key header to dispatch post-test email.',
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!validateApiKey(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = parsePayload(raw);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }

  const result = await dispatchPostTest(parsed.payload);
  // Mismos códigos que antes: 200 en éxito/skip (tier C incluido), 502 si falló Brevo.
  return NextResponse.json(result, { status: result.success ? 200 : 502 });
}
