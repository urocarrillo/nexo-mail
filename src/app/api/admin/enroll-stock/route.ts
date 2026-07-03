/**
 * Enrolamiento del stock en la secuencia post-Typeform (Pantalla A).
 *
 * Lee el Sheet CRM completo, calcula elegibles (Pantalla A, email único, NO
 * cliente, NO en la exclusión 1-a-1, Estado vacío), los divide en variante M1A
 * (test ≤7 días) / M1B (8+ días) y los encola con M1 = próximo día hábil 10:00
 * ART. El resto de la cadencia (M2..M8) se ancla al calendario desde M1.
 *
 * La blacklist NO se filtra acá (cara en bulk): se re-chequea antes de CADA
 * envío en el motor drip, así que ningún blacklisted llega a recibir un mail.
 *
 * Protegido con API_SECRET_KEY (query ?token= o header x-api-key).
 * DRY RUN por default (?dry=1 o sin param): reporta conteos + muestra, no escribe.
 * ?dry=0 → encola de verdad.
 *
 *   GET /api/admin/enroll-stock?token=XXX          → dry run (reporte)
 *   GET /api/admin/enroll-stock?token=XXX&dry=0    → enrola de verdad
 */
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

import { getClientes, normalizeEmail } from '@/lib/clientes';
import { readCrmSheet } from '@/lib/crm-sheet';
import { enrollSecuencia, getEnrolledSecuenciaEmails } from '@/lib/email-drip';
import {
  computeElegibles,
  computeStockSequenceDates,
  computeStockM1,
  type StockRow,
} from '@/lib/secuencia-post-typeform';

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
  // Candado doble: el run real exige dry=0 Y confirm=enrolar (evita enrolamientos accidentales).
  const dry = sp.get('dry') !== '0' || sp.get('confirm') !== 'enrolar';
  if (sp.get('dry') === '0' && sp.get('confirm') !== 'enrolar') {
    console.warn('enroll-stock: dry=0 sin confirm=enrolar → se ejecuta como dry-run');
  }
  const now = new Date();

  try {
    const snap = await readCrmSheet();
    const clientesMap = await getClientes();

    const esClienteSync = (email: string): boolean => {
      const info = clientesMap.get(normalizeEmail(email));
      return info?.estado === 'cliente-programa' || info?.estado === 'cliente-otro';
    };

    const rows: StockRow[] = snap.rows.map((r) => ({
      email: r.email,
      pantalla: r.pantalla,
      estado: r.estado,
      fecha: r.fecha,
      nombre: r.nombre,
    }));

    const { elegibles, descartes, totalRows, uniques } = computeElegibles(rows, {
      esCliente: esClienteSync,
      now,
    });

    const countA = elegibles.filter((e) => e.variant === 'A').length;
    const countB = elegibles.filter((e) => e.variant === 'B').length;

    const m1 = computeStockM1(now);
    const dates = computeStockSequenceDates(now);
    const cadencia = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'].map((m, i) => ({
      mail: m,
      fecha: dates[i].toISOString(),
    }));

    let enrolados = 0;
    let yaEnrolados = 0;
    if (!dry) {
      const already = await getEnrolledSecuenciaEmails();
      for (const el of elegibles) {
        const r = await enrollSecuencia({
          email: el.email,
          name: el.nombre || undefined,
          variant: el.variant,
          dates,
          alreadyEnrolled: already,
        });
        if (r.scheduled > 0) enrolados++;
        else if (r.skipped === 'already-enrolled') yaEnrolados++;
      }
    }

    return NextResponse.json({
      success: true,
      dry,
      sheet: {
        tab: 'Cohorte 2 — Calificación',
        totalRows,
        emailsUnicos: uniques,
        pantallaColDetectada: snap.pantallaCol >= 0,
        fechaColIndex: snap.fechaCol,
      },
      elegibles: {
        total: elegibles.length,
        m1A: countA,
        m1B: countB,
      },
      descartes,
      cadencia: {
        m1: m1.toISOString(),
        pasos: cadencia,
      },
      enrolamiento: {
        aplicado: !dry,
        enrolados,
        yaEnrolados,
      },
      muestra: elegibles.slice(0, 10),
      timestamp: now.toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('enroll-stock error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
