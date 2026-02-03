import { NextRequest, NextResponse } from 'next/server';
import { getLeads, getMetrics } from '@/lib/storage';
import { LeadStatus, LeadTag } from '@/lib/types';

function validateApiKey(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key');
  return apiKey === process.env.API_SECRET_KEY;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Validate API key
  if (!validateApiKey(request)) {
    return NextResponse.json(
      { success: false, message: 'Unauthorized', error: 'Invalid or missing API key' },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const includeMetrics = searchParams.get('metrics') === 'true';
  const status = searchParams.get('status') as LeadStatus | null;
  const tag = searchParams.get('tag') as LeadTag | null;
  const limit = parseInt(searchParams.get('limit') || '100', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  try {
    const leads = await getLeads({
      status: status || undefined,
      tag: tag || undefined,
      limit,
      offset,
    });

    const response: Record<string, unknown> = {
      success: true,
      leads,
      count: leads.length,
    };

    if (includeMetrics) {
      response.metrics = await getMetrics();
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Leads API error:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
