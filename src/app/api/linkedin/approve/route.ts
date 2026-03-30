import { NextRequest, NextResponse } from 'next/server';

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || '';
const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

// Best posting days: Tuesday (2), Wednesday (3), Thursday (4)
// Best time: 9:00 AM Argentina (12:00 UTC)
const OPTIMAL_DAYS = [2, 3, 4]; // Tue, Wed, Thu
const OPTIMAL_HOUR_UTC = 12; // 9:00 AM Argentina = 12:00 UTC

function getNextOptimalSlot(): string {
  const now = new Date();
  const candidate = new Date(now);

  // Start checking from tomorrow
  candidate.setUTCDate(candidate.getUTCDate() + 1);
  candidate.setUTCHours(OPTIMAL_HOUR_UTC, 0, 0, 0);

  // Find the next Tue/Wed/Thu
  for (let i = 0; i < 7; i++) {
    const day = candidate.getUTCDay();
    if (OPTIMAL_DAYS.includes(day)) {
      return candidate.toISOString().replace('Z', '').split('.')[0];
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }

  // Fallback: next Tuesday
  candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate.toISOString().replace('Z', '').split('.')[0];
}

function buildSuccessPage(scheduledFor: string): string {
  const date = new Date(scheduledFor + 'Z');
  const formatted = date.toLocaleDateString('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires',
  });

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Post aprobado</title></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif; display:flex; justify-content:center; align-items:center; min-height:100vh;">
<div style="background:#ffffff; border-radius:12px; padding:40px; max-width:500px; text-align:center; box-shadow:0 2px 12px rgba(0,0,0,0.1);">
  <div style="width:64px; height:64px; background:#0077B5; border-radius:50%; margin:0 auto 20px; display:flex; align-items:center; justify-content:center;">
    <span style="color:#ffffff; font-size:32px;">&#10003;</span>
  </div>
  <h1 style="margin:0 0 12px; font-size:24px; color:#152735;">Post aprobado</h1>
  <p style="margin:0 0 24px; font-size:16px; color:#666666; line-height:1.5;">
    Tu post de LinkedIn se publicara el<br>
    <strong style="color:#0077B5;">${formatted}</strong>
  </p>
  <p style="margin:0; font-size:13px; color:#999999;">Podes cerrar esta ventana.</p>
</div>
</body>
</html>`;
}

function buildErrorPage(error: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Error</title></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif; display:flex; justify-content:center; align-items:center; min-height:100vh;">
<div style="background:#ffffff; border-radius:12px; padding:40px; max-width:500px; text-align:center; box-shadow:0 2px 12px rgba(0,0,0,0.1);">
  <div style="width:64px; height:64px; background:#E67E22; border-radius:50%; margin:0 auto 20px; display:flex; align-items:center; justify-content:center;">
    <span style="color:#ffffff; font-size:32px;">!</span>
  </div>
  <h1 style="margin:0 0 12px; font-size:24px; color:#152735;">Error</h1>
  <p style="margin:0; font-size:16px; color:#666666;">${error}</p>
</div>
</body>
</html>`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const postId = searchParams.get('postId');
  const token = searchParams.get('token');

  // Validate
  if (!token || token !== process.env.API_SECRET_KEY) {
    return new NextResponse(buildErrorPage('Token invalido o expirado.'), {
      status: 401,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (!postId) {
    return new NextResponse(buildErrorPage('Falta el ID del post.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (!ZERNIO_API_KEY) {
    return new NextResponse(buildErrorPage('ZERNIO_API_KEY no configurada.'), {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  try {
    const scheduledFor = getNextOptimalSlot();

    // Schedule the draft post via Zernio PUT
    const res = await fetch(`${ZERNIO_BASE_URL}/posts/${postId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scheduledFor,
        timezone: 'America/Argentina/Mendoza',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Zernio schedule error: ${res.status} ${text}`);
      return new NextResponse(
        buildErrorPage(`No se pudo programar el post (${res.status}). Puede que ya haya sido aprobado anteriormente.`),
        { status: 502, headers: { 'Content-Type': 'text/html' } }
      );
    }

    console.log(`LinkedIn post approved and scheduled: ${postId} → ${scheduledFor}`);

    return new NextResponse(buildSuccessPage(scheduledFor), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn approve error:', msg);
    return new NextResponse(
      buildErrorPage(`Error interno: ${msg}`),
      { status: 500, headers: { 'Content-Type': 'text/html' } }
    );
  }
}
