/**
 * Cron reconciliador diario (PRD-filtro-cliente / T8, componente 4).
 *
 * Mira las órdenes de WooCommerce de las últimas 48 h y compara el estado de
 * cliente (fuente de verdad) contra lo registrado en el Sheet CRM y en Brevo.
 * Corrige el drift de webhooks perdidos / órdenes manuales / refunds.
 *
 * SEGURIDAD: DRY por default. No escribe a producción salvo acción explícita:
 *   - env RECONCILIAR_APPLY=true   → aplica correcciones + loguea a la hoja
 *   - query ?apply=1               → idem, para pruebas puntuales
 * En modo dry sólo devuelve el diff en el JSON (sin tocar Sheet/Brevo).
 *
 * Auth: CRON_SECRET (header Authorization: Bearer …), igual que los otros crons.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getClientes,
  fetchWooOrders,
  normalizeEmail,
  buildReconciliationDiff,
  clienteCellText,
  productosText,
  TEST_EMAILS,
  type ClientesMap,
  type DiffEntry,
} from '@/lib/clientes';
import {
  getSheetMarcas,
  readCrmSheet,
  writeClienteColumn,
  appendReconciliacion,
} from '@/lib/crm-sheet';
import { getBrevoPurchasedSet, importBuyers } from '@/lib/brevo';

const HORAS_VENTANA = 48;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apply =
    process.env.RECONCILIAR_APPLY === 'true' ||
    new URL(request.url).searchParams.get('apply') === '1';

  try {
    // Fuente de verdad: mapa completo (cacheado 1 h). La clasificación necesita
    // TODAS las órdenes de cada email, no sólo las de la ventana.
    const wooMap = await getClientes();

    // Emails con actividad en las últimas 48 h → set a reconciliar.
    const desde = new Date(Date.now() - HORAS_VENTANA * 60 * 60 * 1000).toISOString();
    const recientes = await fetchWooOrders(desde);
    const emailsRecientes = new Set<string>();
    for (const o of recientes) {
      const e = normalizeEmail(o.email);
      if (e && !TEST_EMAILS.has(e)) emailsRecientes.add(e);
    }

    // Submapa restringido a los emails recientes.
    const subMap: ClientesMap = new Map();
    for (const email of emailsRecientes) {
      const info = wooMap.get(email);
      if (info) subMap.set(email, info);
    }

    const sheetMarcas = await getSheetMarcas();
    const brevoComprados = await getBrevoPurchasedSet();

    const diffs = buildReconciliationDiff({
      wooMap: subMap,
      sheetMarcas,
      brevoComprados,
    });

    const corregidas = { sheet: 0, brevo: 0, logueadas: 0 };

    if (apply && diffs.length > 0) {
      // 1. Correcciones al Sheet CRM (falta-en-sheet / texto-distinto).
      const sheetDiffs = diffs.filter(
        (d) => d.tipo === 'falta-en-sheet' || d.tipo === 'texto-sheet-distinto'
      );
      if (sheetDiffs.length > 0) {
        const snap = await readCrmSheet();
        const updates: Array<{ rowIndex: number; text: string }> = [];
        for (const d of sheetDiffs) {
          const row = snap.rows.find((r) => r.email === d.email);
          const info = subMap.get(d.email);
          if (row && info) updates.push({ rowIndex: row.rowIndex, text: clienteCellText(info) });
        }
        if (updates.length > 0) {
          await writeClienteColumn(snap, updates);
          corregidas.sheet = updates.length;
        }
      }

      // 2. Correcciones a Brevo (falta-en-brevo).
      const brevoDiffs = diffs.filter((d) => d.tipo === 'falta-en-brevo');
      if (brevoDiffs.length > 0) {
        const buyers = brevoDiffs
          .map((d) => {
            const info = subMap.get(d.email);
            if (!info) return null;
            return {
              email: d.email,
              attributes: {
                HAS_PURCHASED: true,
                PRODUCTOS: productosText(info),
                FECHA_COMPRA: info.fechaUltimaCompra ? info.fechaUltimaCompra.slice(0, 10) : '',
              } as Record<string, unknown>,
            };
          })
          .filter((b): b is { email: string; attributes: Record<string, unknown> } => b !== null);
        const res = await importBuyers(buyers, []);
        if (res.success) corregidas.brevo = buyers.length;
      }

      // 3. Log a la hoja "Reconciliación".
      const now = new Date().toISOString();
      const rows = diffs.map((d: DiffEntry) => [now, d.email, d.tipo, d.estado, `${d.actual} → ${d.esperado}`]);
      await appendReconciliacion(rows);
      corregidas.logueadas = rows.length;
    }

    console.log(
      `Reconciliar clientes: ${emailsRecientes.size} emails recientes, ${diffs.length} diffs, apply=${apply}`
    );

    return NextResponse.json({
      success: true,
      apply,
      ventanaHoras: HORAS_VENTANA,
      emailsRecientes: emailsRecientes.size,
      diffs: diffs.length,
      porTipo: {
        'falta-en-sheet': diffs.filter((d) => d.tipo === 'falta-en-sheet').length,
        'falta-en-brevo': diffs.filter((d) => d.tipo === 'falta-en-brevo').length,
        'texto-sheet-distinto': diffs.filter((d) => d.tipo === 'texto-sheet-distinto').length,
      },
      corregidas,
      ejemplos: diffs.slice(0, 10),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('reconciliar-clientes cron error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
