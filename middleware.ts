import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const host = request.headers.get('host') || '';

  // Serve static link page for link.urologia.ar
  if (host.startsWith('link.urologia.ar')) {
    return NextResponse.rewrite(new URL('/link.html', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/',
};
