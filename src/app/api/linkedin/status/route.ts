import { NextRequest, NextResponse } from 'next/server';
import { getAccountHealth, listPosts } from '@/lib/linkedin';

function validateApiKey(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key');
  return apiKey === process.env.API_SECRET_KEY;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Validate API key
  if (!validateApiKey(request)) {
    return NextResponse.json(
      { success: false, error: 'Invalid or missing API key' },
      { status: 401 }
    );
  }

  // Check Zernio API key is configured
  if (!process.env.ZERNIO_API_KEY) {
    return NextResponse.json(
      { success: false, error: 'ZERNIO_API_KEY not configured' },
      { status: 500 }
    );
  }

  try {
    // Fetch health and posts in parallel
    const [healthResult, postsResult] = await Promise.all([
      getAccountHealth(),
      listPosts(),
    ]);

    // Count posts this week and this month
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let postsThisWeek = 0;
    let postsThisMonth = 0;

    if (postsResult.success && postsResult.data) {
      for (const post of postsResult.data) {
        const postDate = new Date(post.createdAt);
        if (postDate >= startOfWeek) postsThisWeek++;
        if (postDate >= startOfMonth) postsThisMonth++;
      }
    }

    return NextResponse.json({
      success: true,
      connection: healthResult.success ? healthResult.data : { status: 'unknown', error: healthResult.error },
      stats: {
        postsThisWeek,
        postsThisMonth,
        totalPosts: postsResult.data?.length || 0,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn status route error:', msg);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
