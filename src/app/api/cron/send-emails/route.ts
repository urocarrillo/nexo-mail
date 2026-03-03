import { NextRequest, NextResponse } from 'next/server';
import { processDripQueue } from '@/lib/email-drip';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Verify cron secret (Vercel sets this header for cron jobs)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await processDripQueue();

    console.log(
      `Cron complete: ${result.sent} sent, ${result.failed} failed, ${result.remaining} remaining`
    );

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cron error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal error' },
      { status: 500 }
    );
  }
}
