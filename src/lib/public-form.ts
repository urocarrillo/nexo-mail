/**
 * Helpers compartidos por los endpoints públicos que llama el navegador desde
 * urologia.ar (CORS + rate limit por IP en KV). Mismo patrón que los forms
 * durar-mas / test-programa, sacado a un módulo para no repetirlo.
 */
import { kv } from '@vercel/kv';
import type { NextRequest } from 'next/server';

export const ALLOWED_ORIGINS = [
  'https://urologia.ar',
  'https://www.urologia.ar',
  'https://link.urologia.ar',
];

export type CorsHeaders = Record<string, string>;

export function corsHeaders(origin: string | null): CorsHeaders {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function isOriginAllowed(origin: string | null): boolean {
  return Boolean(origin && ALLOWED_ORIGINS.includes(origin));
}

export function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Rate limit por IP: contador en KV (compartido entre instancias). Si KV falla,
// cae a un Map en memoria de la instancia (se resetea en cada deploy).
const memoria = new Map<string, number[]>();

function isRateLimitedMemoria(key: string, max: number, windowS: number): boolean {
  const now = Date.now();
  const recent = (memoria.get(key) || []).filter((t) => now - t < windowS * 1000);
  recent.push(now);
  memoria.set(key, recent);
  return recent.length > max;
}

/**
 * true si la IP superó `max` requests en la ventana `windowS` (segundos) para
 * el `prefix` dado (uno por endpoint). Cada llamada cuenta como un request.
 */
export async function isRateLimited(
  prefix: string,
  ip: string,
  opts: { max: number; windowS: number }
): Promise<boolean> {
  const key = `${prefix}${ip}`;
  try {
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, opts.windowS);
    return n > opts.max;
  } catch (err) {
    console.error(`rate limit ${prefix}: kv error (cae a memoria):`, errMsg(err));
    return isRateLimitedMemoria(key, opts.max, opts.windowS);
  }
}
