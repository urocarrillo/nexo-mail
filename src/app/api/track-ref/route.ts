import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';

// GET /api/track-ref?email=X&ref=Y — Tracking pixel (called from checkout page JS)
// Stores email→ref association in KV for 30 days
// No auth required — called as an image pixel from the frontend
export async function GET(request: NextRequest): Promise<NextResponse> {
  const email = request.nextUrl.searchParams.get('email')?.toLowerCase().trim();
  const ref = request.nextUrl.searchParams.get('ref')?.toLowerCase().trim();

  if (email && ref) {
    try {
      // Store with 30 day TTL
      await kv.set(`affiliate-ref:${email}`, ref, { ex: 30 * 24 * 60 * 60 });
      console.log(`Tracked affiliate ref: ${email} → ${ref}`);
    } catch (error) {
      console.error('KV track-ref error:', error);
    }
  }

  // Return 1x1 transparent pixel
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );

  return new NextResponse(pixel, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
