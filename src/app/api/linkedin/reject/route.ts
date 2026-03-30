import { NextRequest, NextResponse } from 'next/server';

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || '';
const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const postId = searchParams.get('postId');
  const token = searchParams.get('token');

  if (!token || token !== process.env.API_SECRET_KEY) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (!postId) {
    return new NextResponse('Missing postId', { status: 400 });
  }

  try {
    await fetch(`${ZERNIO_BASE_URL}/posts/${postId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` },
    });

    return new NextResponse(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Rechazado</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;">
<div style="background:#fff;border-radius:12px;padding:40px;max-width:500px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.1);">
  <div style="width:64px;height:64px;background:#e0e0e0;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;">
    <span style="color:#666;font-size:28px;">&#10005;</span>
  </div>
  <h1 style="margin:0 0 12px;font-size:24px;color:#152735;">Post rechazado</h1>
  <p style="margin:0;font-size:14px;color:#999;">El draft fue eliminado. Podes cerrar esta ventana.</p>
</div></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new NextResponse(`Error: ${msg}`, { status: 500 });
  }
}
