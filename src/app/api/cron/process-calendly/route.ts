import { NextRequest, NextResponse } from 'next/server';
import { processScheduledConsultationEmails } from '@/app/api/webhook/calendly/route';

export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Verify Vercel cron secret
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await processScheduledConsultationEmails();

    console.log(
      `Calendly cron: processed=${result.processed}, sent=${result.sent}, failed=${result.failed}, remaining=${result.remaining}`
    );

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Calendly cron error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
