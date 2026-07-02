/**
 * Backfill one-shot del filtro "¿ya es cliente?" (PRD-filtro-cliente / T8).
 *
 * Construye el mapa completo desde WooCommerce y:
 *   1. Marca la columna `Cliente` en el Sheet CRM (Cohorte 2 — Calificación).
 *   2. Setea HAS_PURCHASED / PRODUCTOS / FECHA_COMPRA en Brevo para los pagadores.
 *   3. Crea la lista "Compradores Programa 3740" y carga a los compradores del 3740.
 *
 * Protegido con API_SECRET_KEY (query ?token= o header x-api-key).
 * DRY RUN por default: ?dry=1 (o sin param) reporta sin escribir; ?dry=0 ejecuta.
 *
 *   GET /api/admin/backfill-clientes?token=XXX          → dry run (reporte)
 *   GET /api/admin/backfill-clientes?token=XXX&dry=0    → ejecución real
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getClientes,
  clienteCellText,
  productosText,
  type EstadoCliente,
  type ClienteInfo,
} from '@/lib/clientes';
import { readCrmSheet, writeClienteColumn, colLetter, ensureTab, RECON_TAB } from '@/lib/crm-sheet';
import {
  importBuyers,
  createOrGetList,
  addContactsToList,
} from '@/lib/brevo';

const PROGRAMA_LIST_NAME = 'Compradores Programa 3740';

function authorized(request: NextRequest): boolean {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-api-key');
  return Boolean(process.env.API_SECRET_KEY) && token === process.env.API_SECRET_KEY;
}

function isPagador(estado: EstadoCliente): boolean {
  return estado === 'cliente-programa' || estado === 'cliente-otro';
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const dry = new URL(request.url).searchParams.get('dry') !== '0'; // default true

  try {
    // ── 1. Mapa desde WooCommerce (sin cache) ───────────────────────
    const wooMap = await getClientes({ force: true });

    const byEstado: Record<EstadoCliente, number> = {
      'cliente-programa': 0,
      'cliente-otro': 0,
      'carrito-caido': 0,
      refund: 0,
      lead: 0,
    };
    for (const info of wooMap.values()) byEstado[info.estado]++;

    // ── 2. Sheet CRM ────────────────────────────────────────────────
    const snap = await readCrmSheet();
    const sheetUpdates: Array<{ rowIndex: number; text: string }> = [];
    for (const row of snap.rows) {
      if (!row.email) continue;
      const info = wooMap.get(row.email);
      if (!info) continue;
      const text = clienteCellText(info);
      if (row.cliente.trim() !== text) {
        sheetUpdates.push({ rowIndex: row.rowIndex, text });
      }
    }

    if (!dry && (sheetUpdates.length > 0 || !snap.clienteColExists)) {
      await writeClienteColumn(snap, sheetUpdates);
    }

    // El tab de Reconciliación se crea acá (en el run real) para que el cron
    // reconciliador tenga dónde loguear. Ver PRD-filtro-cliente punto 5.
    let reconTabCreado = false;
    if (!dry) {
      await ensureTab(RECON_TAB);
      reconTabCreado = true;
    }

    // ── 3. Brevo: atributos de pagadores ────────────────────────────
    const pagadores: Array<{ email: string; info: ClienteInfo }> = [];
    for (const [email, info] of wooMap) {
      if (isPagador(info.estado)) pagadores.push({ email, info });
    }
    const brevoBuyers = pagadores.map(({ email, info }) => ({
      email,
      attributes: {
        HAS_PURCHASED: true,
        PRODUCTOS: productosText(info),
        FECHA_COMPRA: info.fechaUltimaCompra ? info.fechaUltimaCompra.slice(0, 10) : '',
      } as Record<string, unknown>,
    }));

    let brevoImport: { success: boolean; error?: string } = { success: true };
    if (!dry) {
      brevoImport = await importBuyers(brevoBuyers, []);
    }

    // ── 4. Lista Compradores Programa 3740 ──────────────────────────
    const programaEmails = pagadores
      .filter(({ info }) => info.estado === 'cliente-programa')
      .map(({ email }) => email);

    let listResult: {
      listId?: number;
      created?: boolean;
      wouldCreate?: boolean;
      added?: number;
      error?: string;
    } = {};

    if (dry) {
      listResult = { wouldCreate: true, added: programaEmails.length };
    } else {
      const created = await createOrGetList(PROGRAMA_LIST_NAME);
      if (!created.success || !created.listId) {
        listResult = { error: created.error };
      } else {
        const add = await addContactsToList(created.listId, programaEmails);
        listResult = {
          listId: created.listId,
          created: created.created,
          added: add.added,
          error: add.success ? undefined : add.error,
        };
      }
    }

    // ── Reporte ─────────────────────────────────────────────────────
    return NextResponse.json({
      success: true,
      dry,
      woo: {
        totalClientes: wooMap.size,
        byEstado,
      },
      sheet: {
        tab: 'Cohorte 2 — Calificación',
        rowsLeidas: snap.rows.length,
        clienteColumna: colLetter(snap.clienteCol),
        clienteColumnaExistia: snap.clienteColExists,
        filasAMarcar: sheetUpdates.length,
        aplicado: !dry,
        reconTabCreado,
        ejemplos: sheetUpdates.slice(0, 5),
      },
      brevo: {
        pagadores: brevoBuyers.length,
        importAplicado: !dry,
        importOk: brevoImport.success,
        importError: brevoImport.error,
      },
      listaProgramaDE: {
        nombre: PROGRAMA_LIST_NAME,
        miembros3740: programaEmails.length,
        ...listResult,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('backfill-clientes error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
