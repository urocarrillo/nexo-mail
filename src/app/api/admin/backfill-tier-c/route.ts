/**
 * Backfill tier C → Calendly (T12).
 *
 * Los tier C (pantalla C del Typeform, red flags médicos) no recibían nada.
 * Este endpoint manda el mail de derivación a Calendly a los tier C históricos
 * SIN "Mail C enviado" en la columna Secuencia, excluyendo compradores,
 * blacklisted y filas con Estado (seguimiento) no vacío. Marca cada envío en la
 * columna Secuencia.
 *
 * Protegido con API_SECRET_KEY (query ?token= o header x-api-key).
 * DRY RUN por default: reporta conteo + muestra sin enviar.
 * Candado doble para el run real: ?dry=0 Y ?confirm=enviar (mismo patrón que
 * enroll-stock). La blacklist se chequea antes de CADA envío (no en el dry).
 *
 *   GET /api/admin/backfill-tier-c?token=XXX                       → dry run
 *   GET /api/admin/backfill-tier-c?token=XXX&dry=0&confirm=enviar  → envía de verdad
 */
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

import { getClientes, normalizeEmail } from '@/lib/clientes';
import { readCrmSheet, writeSecuenciaMarks } from '@/lib/crm-sheet';
import { isEmailBlacklisted } from '@/lib/brevo';
import { sendPlainSecuencia } from '@/lib/email-drip';
import {
  buildMailTierC,
  computeTierCCandidates,
  fechaArgDDMM,
  type TierCRow,
} from '@/lib/secuencia-post-typeform';

// Tope de envíos por corrida (protege el timeout de 60 s). El resto queda para
// una corrida siguiente. Los tier C acumulados son ~56, así que no debería
// activarse, pero es una red de seguridad ante crecimiento.
const MAX_SENDS_PER_RUN = 200;

function authorized(request: NextRequest): boolean {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-api-key');
  return Boolean(process.env.API_SECRET_KEY) && token === process.env.API_SECRET_KEY;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const sp = new URL(request.url).searchParams;
  // Candado doble: el run real exige dry=0 Y confirm=enviar.
  const dry = sp.get('dry') !== '0' || sp.get('confirm') !== 'enviar';
  if (sp.get('dry') === '0' && sp.get('confirm') !== 'enviar') {
    console.warn('backfill-tier-c: dry=0 sin confirm=enviar → se ejecuta como dry-run');
  }
  const now = new Date();

  try {
    const snap = await readCrmSheet();
    const clientesMap = await getClientes();

    const esClienteSync = (email: string): boolean => {
      const info = clientesMap.get(normalizeEmail(email));
      return info?.estado === 'cliente-programa' || info?.estado === 'cliente-otro';
    };

    const rows: TierCRow[] = snap.rows.map((r) => ({
      email: r.email,
      pantalla: r.pantalla,
      estado: r.estado,
      secuencia: r.secuencia,
      nombre: r.nombre,
      rowIndex: r.rowIndex,
    }));

    const { candidatos, descartes, tierCTotal } = computeTierCCandidates(rows, {
      esCliente: esClienteSync,
    });

    if (dry) {
      return NextResponse.json({
        success: true,
        dry: true,
        sheet: { tab: 'Cohorte 2 — Calificación', tierCTotal },
        candidatos: candidatos.length,
        descartes,
        nota: 'La blacklist se chequea antes de cada envío (no en el dry). El run real puede enviar menos.',
        muestra: candidatos.slice(0, 10),
        timestamp: now.toISOString(),
      });
    }

    // ── Run real: blacklist por email + envío + marca en el Sheet ──
    const marks: Array<{ rowIndex: number; text: string }> = [];
    let enviados = 0;
    let blacklisted = 0;
    let fallidos = 0;
    let procesados = 0;
    let diferidos = 0;

    for (const c of candidatos) {
      if (procesados >= MAX_SENDS_PER_RUN) {
        diferidos++;
        continue;
      }
      procesados++;

      if (await isEmailBlacklisted(c.email)) {
        blacklisted++;
        continue;
      }

      const mail = buildMailTierC(c.nombre);
      const r = await sendPlainSecuencia(c.email, c.nombre || undefined, mail.subject, mail.text);
      if (r.success) {
        enviados++;
        marks.push({ rowIndex: c.rowIndex, text: `Mail C enviado ${fechaArgDDMM(now)}` });
      } else {
        fallidos++;
        console.error(`backfill-tier-c: envío falló → ${c.email}: ${r.error}`);
      }
    }

    if (marks.length > 0) {
      try {
        await writeSecuenciaMarks(snap, marks);
      } catch (err) {
        console.error('backfill-tier-c: no se pudo marcar el Sheet (non-blocking):', err);
      }
    }

    return NextResponse.json({
      success: true,
      dry: false,
      sheet: { tab: 'Cohorte 2 — Calificación', tierCTotal },
      candidatos: candidatos.length,
      descartes,
      resultado: { enviados, blacklisted, fallidos, diferidos, marcados: marks.length },
      timestamp: now.toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('backfill-tier-c error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
