/**
 * Tests unitarios del filtro "¿ya es cliente?" (PRD-filtro-cliente / T8).
 * Sólo lógica pura: normalización, clasificación de estados y armado del diff.
 */
import {
  normalizeEmail,
  classifyOrders,
  buildClientesMap,
  clienteCellText,
  productosText,
  buildReconciliationDiff,
  PROGRAMA_DE_PRODUCT_ID,
  type WcOrderLite,
  type ClienteInfo,
  type ClientesMap,
} from '@/lib/clientes';

function order(partial: Partial<WcOrderLite>): WcOrderLite {
  return {
    id: partial.id ?? 1,
    status: partial.status ?? 'completed',
    email: partial.email ?? 'test@example.com',
    productIds: partial.productIds ?? [PROGRAMA_DE_PRODUCT_ID],
    dateCreated: partial.dateCreated ?? '2026-06-29T10:00:00',
  };
}

describe('normalizeEmail', () => {
  it('baja a minúsculas y hace trim', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
  it('tolera vacío/undefined', () => {
    expect(normalizeEmail('')).toBe('');
    expect(normalizeEmail(undefined as unknown as string)).toBe('');
  });
});

describe('classifyOrders', () => {
  it('compra paga del 3740 → cliente-programa', () => {
    const info = classifyOrders([order({ status: 'completed', productIds: [3740] })]);
    expect(info.estado).toBe('cliente-programa');
    expect(info.productos).toContain(3740);
    expect(info.fechaUltimaCompra).toBe('2026-06-29T10:00:00');
  });

  it('processing también cuenta como pago', () => {
    const info = classifyOrders([order({ status: 'processing', productIds: [3740] })]);
    expect(info.estado).toBe('cliente-programa');
  });

  it('compra paga de otro producto → cliente-otro', () => {
    const info = classifyOrders([order({ status: 'completed', productIds: [3208] })]);
    expect(info.estado).toBe('cliente-otro');
    expect(info.productos).toEqual([3208]);
  });

  it('orden refunded → refund', () => {
    const info = classifyOrders([order({ status: 'refunded', productIds: [3740] })]);
    expect(info.estado).toBe('refund');
  });

  it('sólo órdenes cancelled/pending del 3740 → carrito-caido', () => {
    const info = classifyOrders([
      order({ status: 'cancelled', productIds: [3740] }),
      order({ status: 'pending', productIds: [3740] }),
    ]);
    expect(info.estado).toBe('carrito-caido');
    expect(info.productos).toEqual([3740]);
  });

  it('órdenes no pagas de otro producto (sin 3740) → lead', () => {
    const info = classifyOrders([order({ status: 'pending', productIds: [3208] })]);
    expect(info.estado).toBe('lead');
  });

  it('paga posterior a un cancelled manda (caso nahuel.auge)', () => {
    const info = classifyOrders([
      order({ id: 1, status: 'cancelled', productIds: [3740], dateCreated: '2026-06-01T10:00:00' }),
      order({ id: 2, status: 'completed', productIds: [3740], dateCreated: '2026-06-10T10:00:00' }),
    ]);
    expect(info.estado).toBe('cliente-programa');
    expect(info.fechaUltimaCompra).toBe('2026-06-10T10:00:00');
  });

  it('paga de otro producto gana sobre un refund del programa', () => {
    const info = classifyOrders([
      order({ id: 1, status: 'refunded', productIds: [3740] }),
      order({ id: 2, status: 'completed', productIds: [3208] }),
    ]);
    expect(info.estado).toBe('cliente-otro');
  });

  it('toma la fecha más reciente entre varias pagas', () => {
    const info = classifyOrders([
      order({ id: 1, status: 'completed', productIds: [1043], dateCreated: '2025-01-01T00:00:00' }),
      order({ id: 2, status: 'completed', productIds: [3208], dateCreated: '2025-09-23T00:00:00' }),
    ]);
    expect(info.estado).toBe('cliente-otro');
    expect(info.productos).toEqual([1043, 3208]);
    expect(info.fechaUltimaCompra).toBe('2025-09-23T00:00:00');
  });
});

describe('buildClientesMap', () => {
  it('agrupa por email normalizado', () => {
    const map = buildClientesMap([
      order({ email: 'A@B.com', status: 'cancelled', productIds: [3740], dateCreated: '2026-06-01T00:00:00' }),
      order({ email: 'a@b.com', status: 'completed', productIds: [3740], dateCreated: '2026-06-05T00:00:00' }),
    ]);
    expect(map.size).toBe(1);
    expect(map.get('a@b.com')?.estado).toBe('cliente-programa');
  });

  it('excluye los emails de test', () => {
    const map = buildClientesMap([
      order({ email: 'urologia.ar@gmail.com', status: 'completed' }),
      order({ email: 'pruebatester7@gmail.com', status: 'completed' }),
      order({ email: 'urologia.carrillo@gmail.com', status: 'completed' }),
    ]);
    expect(map.size).toBe(0);
  });

  it('no guarda entradas lead', () => {
    const map = buildClientesMap([order({ email: 'x@y.com', status: 'pending', productIds: [3208] })]);
    expect(map.size).toBe(0);
  });
});

describe('clienteCellText / productosText', () => {
  it('cliente-programa → "programa DD/MM/YYYY"', () => {
    const info: ClienteInfo = { estado: 'cliente-programa', productos: [3740], fechaUltimaCompra: '2026-06-29T10:00:00' };
    expect(clienteCellText(info)).toBe('programa 29/6/2026');
  });

  it('cliente-otro con label conocido', () => {
    const info: ClienteInfo = { estado: 'cliente-otro', productos: [3208], fechaUltimaCompra: '2025-09-23T00:00:00' };
    expect(clienteCellText(info)).toBe('curso-ep 23/9/2025');
  });

  it('productosText mapea ids a labels', () => {
    const info: ClienteInfo = { estado: 'cliente-otro', productos: [3740, 3208], fechaUltimaCompra: null };
    expect(productosText(info)).toBe('programa, curso-ep');
  });

  it('producto desconocido cae a "producto-<id>"', () => {
    const info: ClienteInfo = { estado: 'cliente-otro', productos: [9999], fechaUltimaCompra: '2026-01-01T00:00:00' };
    expect(clienteCellText(info)).toBe('producto-9999 1/1/2026');
  });
});

describe('buildReconciliationDiff', () => {
  function mapOf(entries: Array<[string, ClienteInfo]>): ClientesMap {
    return new Map(entries);
  }

  it('detecta falta-en-sheet y falta-en-brevo', () => {
    const wooMap = mapOf([
      ['nuevo@x.com', { estado: 'cliente-programa', productos: [3740], fechaUltimaCompra: '2026-06-29T00:00:00' }],
    ]);
    const diffs = buildReconciliationDiff({
      wooMap,
      sheetMarcas: new Map(), // vacío → falta-en-sheet
      brevoComprados: new Set(), // vacío → falta-en-brevo
    });
    const tipos = diffs.map((d) => d.tipo).sort();
    expect(tipos).toEqual(['falta-en-brevo', 'falta-en-sheet']);
  });

  it('sin diffs cuando todo está registrado', () => {
    const info: ClienteInfo = { estado: 'cliente-programa', productos: [3740], fechaUltimaCompra: '2026-06-29T00:00:00' };
    const wooMap = mapOf([['ok@x.com', info]]);
    const diffs = buildReconciliationDiff({
      wooMap,
      sheetMarcas: new Map([['ok@x.com', clienteCellText(info)]]),
      brevoComprados: new Set(['ok@x.com']),
    });
    expect(diffs).toHaveLength(0);
  });

  it('marca texto-sheet-distinto cuando la marca no coincide', () => {
    const info: ClienteInfo = { estado: 'cliente-programa', productos: [3740], fechaUltimaCompra: '2026-06-29T00:00:00' };
    const wooMap = mapOf([['ok@x.com', info]]);
    const diffs = buildReconciliationDiff({
      wooMap,
      sheetMarcas: new Map([['ok@x.com', 'algo viejo']]),
      brevoComprados: new Set(['ok@x.com']),
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].tipo).toBe('texto-sheet-distinto');
    expect(diffs[0].esperado).toBe(clienteCellText(info));
  });

  it('carrito-caido no exige HAS_PURCHASED en Brevo', () => {
    const info: ClienteInfo = { estado: 'carrito-caido', productos: [3740], fechaUltimaCompra: '2026-06-29T00:00:00' };
    const wooMap = mapOf([['carrito@x.com', info]]);
    const diffs = buildReconciliationDiff({
      wooMap,
      sheetMarcas: new Map([['carrito@x.com', clienteCellText(info)]]),
      brevoComprados: new Set(), // vacío, pero no debería exigir Brevo para carrito
    });
    expect(diffs.filter((d) => d.tipo === 'falta-en-brevo')).toHaveLength(0);
  });
});
