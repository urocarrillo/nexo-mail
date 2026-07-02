/**
 * Tests de los helpers puros del Sheet CRM (columnas). No tocan Google Sheets.
 */
import {
  colLetter,
  findEmailColumn,
  findClienteColumn,
  findEstadoColumn,
  firstFreeColumnAfter,
} from '@/lib/crm-sheet';

describe('colLetter', () => {
  it('mapea índices 0-based a letras de columna', () => {
    expect(colLetter(0)).toBe('A');
    expect(colLetter(25)).toBe('Z');
    expect(colLetter(26)).toBe('AA');
    expect(colLetter(30)).toBe('AE');
    expect(colLetter(31)).toBe('AF');
  });
});

describe('detección de columnas', () => {
  const headers = [
    'Marca temporal', // 0
    'Nombre',         // 1
    'Correo',         // 2
    'Teléfono',       // 3
    'Estado seguimiento', // 4
  ];

  it('encuentra la columna de email', () => {
    expect(findEmailColumn(headers)).toBe(2);
    expect(findEmailColumn(['x', 'Email', 'y'])).toBe(1);
  });

  it('encuentra la columna Estado seguimiento', () => {
    expect(findEstadoColumn(headers)).toBe(4);
  });

  it('Cliente no existe todavía → -1', () => {
    expect(findClienteColumn(headers)).toBe(-1);
  });

  it('reconoce Cliente si ya existe (case-insensitive)', () => {
    expect(findClienteColumn([...headers, 'cliente'])).toBe(5);
  });
});

describe('firstFreeColumnAfter', () => {
  it('devuelve AF (31) cuando las columnas llegan hasta AE (0..30)', () => {
    const headers = Array.from({ length: 31 }, (_, i) => `col${i}`); // 0..30 = A..AE
    expect(firstFreeColumnAfter(headers, 31)).toBe(31);
    expect(colLetter(firstFreeColumnAfter(headers, 31))).toBe('AF');
  });

  it('salta columnas ya ocupadas después de AF', () => {
    const headers = Array.from({ length: 33 }, (_, i) => `col${i}`); // 0..32 = A..AG
    expect(firstFreeColumnAfter(headers, 31)).toBe(33); // primera vacía
  });
});
