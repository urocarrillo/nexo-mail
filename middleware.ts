import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const host = request.headers.get('host') || '';

  // Serve static link page for link.urologia.ar (TikTok)
  if (host.startsWith('link.urologia.ar')) {
    return NextResponse.rewrite(new URL('/link.html', request.url));
  }

  // Serve static link page for legendario.urologia.ar (YouTube)
  if (host.startsWith('legendario.urologia.ar')) {
    return NextResponse.rewrite(new URL('/legendario.html', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/',
};
