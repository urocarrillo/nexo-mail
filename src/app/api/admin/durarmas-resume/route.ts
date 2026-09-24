/**
 * Reanuda secuencias "Durar más" canceladas por blacklist falso.
 *
 * Contexto: los escáneres de seguridad de los clientes de correo (Outlook
 * SafeLinks, antivirus) hacían GET al link de baja y blacklisteaban leads sin
 * acción humana; el cron, al ver la blacklist, cancelaba los pasos pendientes
 * en KV. Des-blacklistear en Brevo no alcanza: este endpoint vuelve esos pasos
 * a 'pending' para que el cron los retome.
 *
 * Para cada email del body: busca sus entries kind 'durar-mas' en la cola,
 * determina el último paso enviado (máximo seqStep con status 'sent') y las
 * entries 'cancelled' con seqStep mayor las vuelve a 'pending', re-fechando
 * sendAt con la cadencia completa desde hoy (computeDurarMasDates). El orden
 * estricto dm(N-1)→dm(N) del cron hace el resto.
 *
 * OJO: NO toca la blacklist de Brevo — des-blacklistear ahí es paso previo
 * manual; si el email sigue blacklisted, el cron vuelve a cancelar.
 *
 * Protegido con API_SECRET_KEY (query ?token= o header x-api-key).
 *
 *   POST /api/admin/durarmas-resume
 *   Body: {"emails": ["a@b.com", ...]}   (máx 50)
 */
import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';

export const maxDuration = 60;

import { computeDurarMasDates } from '@/lib/secuencia-durar-mas';

const DRIP_QUEUE_KEY = 'drip:queue';
const MAX_EMAILS = 50;

// Espejo del shape de ScheduledEmail en email-drip (sólo los campos que este
// endpoint lee/escribe; el resto del JSON se preserva tal cual al re-escribir).
interface DripEntry {
  email: string;
  sendAt: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  cancelledAt?: string;
  cancelReason?: string;
  kind?: string;
  seqStep?: number;
}

function authorized(request: NextRequest): boolean {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-api-key');
  return Boolean(process.env.API_SECRET_KEY) && token === process.env.API_SECRET_KEY;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let emails: string[];
  try {
    const body = (await request.json()) as { emails?: unknown };
    if (
      !Array.isArray(body.emails) ||
      body.emails.length === 0 ||
      !body.emails.every((e) => typeof e === 'string')
    ) {
      throw new Error('body inválido');
    }
    if (body.emails.length > MAX_EMAILS) {
      return NextResponse.json(
        { success: false, error: `Máximo ${MAX_EMAILS} emails por request` },
        { status: 400 }
      );
    }
    emails = body.emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Body esperado: {"emails": ["a@b.com", ...]}' },
      { status: 400 }
    );
  }

  try {
    const now = new Date();
    // Cadencia completa re-anclada a hoy: sendAt del paso N = dates[N-1].
    const dates = computeDurarMasDates(now);

    // Una sola lectura de la cola para todo el request.
    const allRaw = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);
    const all = allRaw
      ? Object.entries(allRaw).map(([id, json]) => ({
          id,
          entry: (typeof json === 'string' ? JSON.parse(json) : json) as DripEntry,
        }))
      : [];

    const updates: Record<string, string> = {};
    const results: Array<{ email: string; resumed: number; lastSentStep: number }> = [];

    for (const email of [...new Set(emails)]) {
      const mine = all.filter(
        ({ entry }) =>
          entry.kind === 'durar-mas' && (entry.email || '').trim().toLowerCase() === email
      );

      // Último paso que salió de verdad: lo cancelado después de él se reanuda.
      const lastSentStep = mine.reduce(
        (max, { entry }) =>
          entry.status === 'sent' && (entry.seqStep || 0) > max ? entry.seqStep || 0 : max,
        0
      );

      let resumed = 0;
      for (const { id, entry } of mine) {
        const step = entry.seqStep || 0;
        if (entry.status !== 'cancelled' || step <= lastSentStep) continue;
        if (step < 1 || step > dates.length) continue;

        entry.status = 'pending';
        entry.sendAt = dates[step - 1].toISOString();
        delete entry.cancelledAt;
        delete entry.cancelReason;
        updates[id] = JSON.stringify(entry);
        resumed++;
        console.log(`Durar-mas reanudado: dm${step} → ${email} sendAt ${entry.sendAt}`);
      }

      results.push({ email, resumed, lastSentStep });
    }

    // Un solo hset con todos los pasos reanudados.
    if (Object.keys(updates).length > 0) {
      await kv.hset(DRIP_QUEUE_KEY, updates);
    }

    return NextResponse.json({
      success: true,
      totals: {
        emails: results.length,
        resumed: results.reduce((sum, r) => sum + r.resumed, 0),
      },
      results,
      cadencia: dates.map((d, i) => ({ mail: `dm${i + 1}`, fecha: d.toISOString() })),
      timestamp: now.toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('durarmas-resume error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
