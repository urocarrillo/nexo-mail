/**
 * Enrolamiento del rescate tier A (R2..R4) en el motor drip.
 *
 * Contexto: el R1 ("tu test quedó sin respuesta") se manda a mano con un script
 * local que escribe 'rescate dd/mm' en la columna "Mail enviado" del Sheet CRM.
 * Este endpoint lee el Sheet, arma los candidatos y encola R2 (+3), R3 (+6) y
 * R4 (+10) a las 10:00 ART (domingo → lunes) con kind 'rescate-a'.
 *
 * Candidatos = filas con "Mail enviado" que empieza con 'rescate ' Y Pantalla A
 * Y "Estado seguimiento" vacío Y "Cliente" vacío, email válido, dedupe por email
 * normalizado, sin los ya enrolados en rescate-a, sin secuencia post-Typeform
 * pendiente ni clientes (WooCommerce). La variante (A-Cuotas / A-Limpia / …)
 * sale de la columna "Variante" y define la PD del R3. La blacklist NO se
 * filtra acá (cara en bulk): el motor la re-chequea antes de CADA envío.
 *
 * Fechas: la base de cada candidato es la fecha real de su celda
 * ('rescate dd/mm', año de ?r1=); si no parsea, ?r1=. Para que el cap diario
 * del motor no apile cientos de R2 el mismo día, los candidatos se reparten en
 * lotes de `lote` (default 150): el lote k arranca k días después, y cada
 * persona conserva su +3/+6/+10.
 *
 * Protegido con API_SECRET_KEY (query ?token= o header x-api-key).
 * DRY RUN por default. El run real exige dry=0 Y confirm=enrolar, toma un lock
 * KV (no corre dos veces solapado) y rechaza (400) si algún R2 ya está vencido,
 * salvo force=1.
 *
 *   GET /api/admin/enroll-rescate?token=XXX                         → dry run
 *   GET /api/admin/enroll-rescate?token=XXX&dry=0&confirm=enrolar   → enrola
 *   Params opcionales: r1=2026-09-04 (fecha del R1) · max=1000 · lote=150 · force=1
 */
import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';

export const maxDuration = 60;

import { getClientes, normalizeEmail } from '@/lib/clientes';
import { readCrmSheet, colLetter, CRM_SHEET_ID, CRM_TAB } from '@/lib/crm-sheet';
import { getGoogleAccessToken } from '@/lib/google-auth';
import {
  enrollRescateBulk,
  getRescateEnrollmentSets,
  type RescateEnrollParams,
} from '@/lib/email-drip';
import {
  addDays,
  artDayOf,
  computeRescateCandidatos,
  computeRescateDates,
  parseR1Date,
  type RescateRow,
} from '@/lib/secuencia-rescate-a';

const DEFAULT_R1 = '2026-09-04';
const DEFAULT_MAX = 1000;
const DEFAULT_LOTE = 150;

const LOCK_KEY = 'lock:enroll-rescate';
const LOCK_TTL_S = 120; // > maxDuration 60

const HEADER_MAIL_ENVIADO = 'Mail enviado';
const HEADER_VARIANTE = 'Variante';

function cleanHeader(h: string | undefined): string {
  return (h || '').replace(/\u00a0/g, ' ').trim().toLowerCase();
}

function findHeader(headers: string[], name: string): number {
  const target = name.toLowerCase();
  return headers.findIndex((h) => cleanHeader(h) === target);
}

/**
 * Lee UN rango de columnas contiguas del tab CRM (filas 2..fin) en una sola
 * llamada. readCrmSheet no expone "Mail enviado" ni "Variante"; se leen junto
 * con la columna de email para verificar fila a fila que el Sheet no cambió
 * entre las dos lecturas (una fila borrada u ordenada a mano desalinearía la
 * celda 'rescate dd/mm' con otro email). Índice i ↔ rowIndex i+2.
 */
async function readCrmRange(fromCol: number, toCol: number): Promise<string[][]> {
  const token = await getGoogleAccessToken();
  const range = encodeURIComponent(`${CRM_TAB}!${colLetter(fromCol)}2:${colLetter(toCol)}`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${CRM_SHEET_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `CRM sheet read failed (${res.status}) [${colLetter(fromCol)}:${colLetter(toCol)}]: ${err}`
    );
  }
  const data = (await res.json()) as { values?: string[][] };
  return data.values || [];
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

function ddmmyyyy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!process.env.API_SECRET_KEY) {
    return NextResponse.json(
      { success: false, error: 'API_SECRET_KEY no configurada' },
      { status: 500 }
    );
  }
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-api-key');
  if (token !== process.env.API_SECRET_KEY) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const sp = url.searchParams;
  // Candado doble: el run real exige dry=0 Y confirm=enrolar.
  const dry = sp.get('dry') !== '0' || sp.get('confirm') !== 'enrolar';
  if (sp.get('dry') === '0' && sp.get('confirm') !== 'enrolar') {
    console.warn('enroll-rescate: dry=0 sin confirm=enrolar → se ejecuta como dry-run');
  }
  const force = sp.get('force') === '1';

  const r1 = parseR1Date(sp.get('r1') || DEFAULT_R1);
  if (!r1) {
    return NextResponse.json(
      { success: false, error: `r1 inválida: "${sp.get('r1')}" (usar YYYY-MM-DD)` },
      { status: 400 }
    );
  }
  const maxRaw = parseInt(sp.get('max') || '', 10);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_MAX;
  const loteRaw = parseInt(sp.get('lote') || '', 10);
  const lote = Number.isFinite(loteRaw) && loteRaw > 0 ? loteRaw : DEFAULT_LOTE;

  const now = new Date();

  // Lock del run real: dos invocaciones solapadas (doble click, reintento tras
  // un 504) leerían el mismo set de "ya enrolados" y encolarían todo dos veces.
  let locked = false;
  if (!dry) {
    try {
      const got = await kv.set(LOCK_KEY, now.toISOString(), { nx: true, ex: LOCK_TTL_S });
      if (got === null) {
        return NextResponse.json(
          { success: false, error: 'Otro enrolamiento en curso (lock). Reintentar en 2 minutos.' },
          { status: 409 }
        );
      }
      locked = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return NextResponse.json({ success: false, error: `KV lock error: ${msg}` }, { status: 500 });
    }
  }

  try {
    const snap = await readCrmSheet();

    const mailEnviadoCol = findHeader(snap.headers, HEADER_MAIL_ENVIADO);
    if (mailEnviadoCol < 0) {
      return NextResponse.json(
        { success: false, error: `No se encontró la columna "${HEADER_MAIL_ENVIADO}" en "${CRM_TAB}"` },
        { status: 500 }
      );
    }
    const varianteCol = findHeader(snap.headers, HEADER_VARIANTE);
    const warnings: string[] = [];
    if (varianteCol < 0) {
      warnings.push(`Sin columna "${HEADER_VARIANTE}": todos reciben la PD por defecto en R3`);
    }

    // Una sola lectura con email + Mail enviado (+ Variante) para cruzar por fila.
    const cols = [snap.emailCol, mailEnviadoCol, ...(varianteCol >= 0 ? [varianteCol] : [])];
    const fromCol = Math.min(...cols);
    const toCol = Math.max(...cols);
    const extra = await readCrmRange(fromCol, toCol);
    const cell = (i: number, col: number): string => (extra[i] && extra[i][col - fromCol]) || '';

    // Verificación de alineado: el email de la segunda lectura tiene que ser el
    // mismo que el del snapshot en cada fila; si no, el Sheet cambió entre medio.
    const desalineadas: number[] = [];
    for (const r of snap.rows) {
      const i = r.rowIndex - 2;
      const e2 = normalizeEmail(cell(i, snap.emailCol));
      if (r.email !== e2) desalineadas.push(r.rowIndex);
    }
    if (desalineadas.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `El Sheet cambió durante la lectura (${desalineadas.length} filas desalineadas, ej: ${desalineadas
            .slice(0, 5)
            .join(', ')}). Reintentar.`,
        },
        { status: 409 }
      );
    }

    const clientesMap = await getClientes();
    const esClienteSync = (email: string): boolean => {
      const info = clientesMap.get(normalizeEmail(email));
      return info?.estado === 'cliente-programa' || info?.estado === 'cliente-otro';
    };

    // Una sola lectura de la cola: ya enrolados en rescate-a + secuencia pendiente.
    const { rescate: yaEnrolados, secuencia: enSecuencia } = await getRescateEnrollmentSets();

    const rows: RescateRow[] = snap.rows.map((r) => {
      const i = r.rowIndex - 2;
      return {
        email: r.email,
        nombre: r.nombre,
        pantalla: r.pantalla,
        estado: r.estado,
        cliente: r.cliente,
        mailEnviado: cell(i, mailEnviadoCol),
        variante: varianteCol >= 0 ? cell(i, varianteCol) : '',
        rowIndex: r.rowIndex,
      };
    });

    const { candidatos, descartes, totalRows, conRescate } = computeRescateCandidatos(rows, {
      esCliente: esClienteSync,
      yaEnrolados,
      enSecuencia,
      max,
      anioR1: r1.getUTCFullYear(),
    });

    const porVariante: Record<string, number> = {};
    for (const c of candidatos) {
      const k = c.variante || '(vacía)';
      porVariante[k] = (porVariante[k] || 0) + 1;
    }

    // Fechas por candidato: base = fecha real de la celda (o ?r1=) + k días de lote.
    const fechasR1: Record<string, number> = {};
    let sinFechaCelda = 0;
    const lotes = new Map<string, { base: string; n: number; r2: string; r3: string; r4: string }>();
    const params: RescateEnrollParams[] = candidatos.map((c, i) => {
      const r1Real = c.r1Celda || r1;
      if (!c.r1Celda) sinFechaCelda++;
      const k = ddmmyyyy(r1Real);
      fechasR1[k] = (fechasR1[k] || 0) + 1;
      const base = addDays(artDayOf(r1Real), Math.floor(i / lote));
      const dates = computeRescateDates(base);
      const key = base.toISOString();
      const l = lotes.get(key);
      if (l) l.n++;
      else
        lotes.set(key, {
          base: key,
          n: 1,
          r2: dates[0].toISOString(),
          r3: dates[1].toISOString(),
          r4: dates[2].toISOString(),
        });
      return {
        email: c.email,
        name: c.nombre || undefined,
        variante: c.variante,
        dates,
        rowIndex: c.rowIndex,
      };
    });
    if (sinFechaCelda > 0) {
      warnings.push(`${sinFechaCelda} candidatos sin fecha parseable en "Mail enviado": usan r1=${ddmmyyyy(r1)}`);
    }

    // R2 ya vencido: saldría en el próximo cron (y R3 dos días después, por el
    // gap mínimo). Aviso en dry; en real, 400 salvo force=1.
    const r2Vencidos = params.filter((p) => p.dates[0].getTime() <= now.getTime()).length;
    if (r2Vencidos > 0) {
      const msg = `${r2Vencidos} candidatos con R2 ya vencido (base r1 en el pasado): saldrían en el próximo cron`;
      if (!dry && !force) {
        return NextResponse.json({ success: false, error: `${msg}. Revisar r1= o usar force=1.` }, { status: 400 });
      }
      warnings.push(msg);
    }

    const dates = computeRescateDates(r1);
    const fechas = {
      r1: r1.toISOString(),
      r2: dates[0].toISOString(),
      r3: dates[1].toISOString(),
      r4: dates[2].toISOString(),
    };

    let enrolados = 0;
    let yaEnroladosRun = 0;
    if (!dry) {
      const r = await enrollRescateBulk(params, yaEnrolados);
      enrolados = r.enrolados;
      yaEnroladosRun = r.yaEnrolados;
    }

    return NextResponse.json({
      success: true,
      dry,
      r1: fechas.r1,
      fechas,
      fechasR1,
      lote,
      lotes: [...lotes.values()],
      sheet: {
        tab: CRM_TAB,
        totalRows,
        conRescate,
        mailEnviadoCol: colLetter(mailEnviadoCol),
        varianteCol: varianteCol >= 0 ? colLetter(varianteCol) : null,
      },
      candidatos: {
        total: candidatos.length,
        porVariante,
        max,
      },
      descartes,
      enrolamiento: {
        aplicado: !dry,
        enrolados,
        yaEnrolados: dry ? descartes['ya-enrolado'] : descartes['ya-enrolado'] + yaEnroladosRun,
      },
      muestra: candidatos.slice(0, 10).map((c, i) => ({
        email: maskEmail(c.email),
        nombre: c.nombre,
        variante: c.variante,
        rowIndex: c.rowIndex,
        r2: params[i].dates[0].toISOString(),
      })),
      warnings,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('enroll-rescate error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  } finally {
    if (locked) {
      try {
        await kv.del(LOCK_KEY);
      } catch (err) {
        console.error('enroll-rescate: no se pudo liberar el lock:', err);
      }
    }
  }
}
