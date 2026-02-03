import { NextResponse } from 'next/server';
import { testConnection } from '@/lib/brevo';

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    api: 'up' | 'down';
    brevo: 'up' | 'down' | 'unconfigured';
    storage: 'up' | 'down' | 'unconfigured';
  };
  version: string;
}

export async function GET(): Promise<NextResponse<HealthResponse>> {
  const timestamp = new Date().toISOString();

  // Check Brevo connection
  let brevoStatus: 'up' | 'down' | 'unconfigured' = 'unconfigured';
  if (process.env.BREVO_API_KEY) {
    const brevoTest = await testConnection();
    brevoStatus = brevoTest.success ? 'up' : 'down';
  }

  // Check storage (Vercel KV)
  let storageStatus: 'up' | 'down' | 'unconfigured' = 'unconfigured';
  if (process.env.KV_REST_API_URL) {
    try {
      const { kv } = await import('@vercel/kv');
      await kv.ping();
      storageStatus = 'up';
    } catch {
      storageStatus = 'down';
    }
  }

  // Determine overall status
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (brevoStatus === 'down' || storageStatus === 'down') {
    status = 'degraded';
  }
  if (brevoStatus === 'down' && storageStatus === 'down') {
    status = 'unhealthy';
  }

  return NextResponse.json({
    status,
    timestamp,
    services: {
      api: 'up',
      brevo: brevoStatus,
      storage: storageStatus,
    },
    version: '1.0.0',
  });
}
