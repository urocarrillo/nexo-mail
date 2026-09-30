/**
 * Tests de la lógica pura de la secuencia "Durar más" v3 (curso EP, 30/09/2026):
 *   - computeDurarMasDates (offsets +1/+4 anclados al día ART, entregados en la
 *     corrida del cron de las 10:00 ART)
 *   - buildDurarMasMail / mailEntrega (copy v3, links de atribución, steps inválidos)
 *   - estadoCortaDurarMas (regla "quien responde el 0 o el 1 no recibe el 2")
 */
import {
  computeDurarMasDates,
  buildDurarMasMail,
  mailEntrega,
  saludo,
  estadoCortaDurarMas,
  DURARMAS_OFFSETS_DIAS,
  DURARMAS_STEPS,
  DURARMAS_SEQ_VERSION,
  DURARMAS_SENDER_ENTREGA,
  DURARMAS_SENDER_SECUENCIA,
  COPY_ENTREGA,
} from '@/lib/secuencia-durar-mas';

const DAY_MS = 24 * 60 * 60 * 1000;
const LANDING = 'https://urologia.ar/controla-tu-eyaculacion';

describe('computeDurarMasDates — cadencia +1/+4 en calendario ART', () => {
  it('devuelve 2 fechas con los offsets exactos desde el día ART del alta', () => {
    // 22/07/2026 15:30 ART (= 18:30 UTC) → día base ART = 22/07.
    const dates = computeDurarMasDates(new Date('2026-07-22T18:30:00Z'));
    expect(dates).toHaveLength(2);
    expect(DURARMAS_OFFSETS_DIAS).toEqual([1, 4]);
    expect(DURARMAS_STEPS).toBe(2);
    expect(DURARMAS_SEQ_VERSION).toBe(3);
    const base = Date.UTC(2026, 6, 22, 12, 0, 0, 0);
    dates.forEach((d, i) => expect(d.getTime()).toBe(base + DURARMAS_OFFSETS_DIAS[i] * DAY_MS));
  });

  it('las fechas quedan a las 12:00 UTC → la corrida de las 10:00 ART las entrega', () => {
    for (const d of computeDurarMasDates(new Date('2026-07-22T18:30:00Z'))) {
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(0);
    }
  });

  it('ancla al día ART aunque el instante UTC ya sea el día siguiente', () => {
    // 21/07/2026 23:30 ART = 22/07 02:30 UTC → día base ART = 21/07.
    const dates = computeDurarMasDates(new Date('2026-07-22T02:30:00Z'));
    expect(dates[0].getTime()).toBe(Date.UTC(2026, 6, 22, 12, 0, 0, 0)); // ep1 = 22/07
    expect(dates[1].getTime()).toBe(Date.UTC(2026, 6, 25, 12, 0, 0, 0)); // ep2 = 25/07
  });
});

describe('buildDurarMasMail — copy v3', () => {
  it('interpola el primer nombre en el saludo, o "Hola," sin nombre', () => {
    expect(buildDurarMasMail(1, 'Juan').text.startsWith('Hola Juan,')).toBe(true);
    expect(buildDurarMasMail(1).text.startsWith('Hola,')).toBe(true);
    expect(buildDurarMasMail(2, '   ').text.startsWith('Hola,')).toBe(true);
  });

  it('ep0 lleva el link ?mseq=ep0, ep1 va sin link, ep2 lleva ?mseq=ep2', () => {
    expect(mailEntrega('Juan').text).toContain(`${LANDING}?mseq=ep0`);
    expect(buildDurarMasMail(1, 'Juan').text).not.toContain('http');
    expect(buildDurarMasMail(2, 'Juan').text).toContain(`${LANDING}?mseq=ep2`);
  });

  it('asuntos aprobados (30/09/2026)', () => {
    expect(COPY_ENTREGA.subject).toBe('acá está lo que pediste');
    expect(buildDurarMasMail(1).subject).toBe('¿la pudiste ver?');
    expect(buildDurarMasMail(2).subject).toBe('¿qué te gustaría saber antes de entrar?');
  });

  it('sin precios, sin "Dr.", firma "Mauro"', () => {
    for (const m of [mailEntrega('Ana'), buildDurarMasMail(1, 'Ana'), buildDurarMasMail(2, 'Ana')]) {
      expect(m.text).not.toMatch(/\$|USD|Dr\./);
      expect(m.text.trimEnd().endsWith('Mauro')).toBe(true);
    }
  });

  it('steps inválidos lanzan (la v2 tenía hasta 6)', () => {
    expect(() => buildDurarMasMail(0)).toThrow();
    expect(() => buildDurarMasMail(3)).toThrow();
    expect(() => buildDurarMasMail(6, 'Juan')).toThrow();
  });

  it('saludo recorta espacios', () => {
    expect(saludo('  Ana  ')).toBe('Hola Ana,');
    expect(saludo()).toBe('Hola,');
  });

  it('senders correctos: todo desde mauro@', () => {
    expect(DURARMAS_SENDER_ENTREGA).toEqual({ name: 'Mauro', email: 'mauro@urologia.ar' });
    expect(DURARMAS_SENDER_SECUENCIA).toEqual({ name: 'Mauro Carrillo', email: 'mauro@urologia.ar' });
  });
});

describe('estadoCortaDurarMas — quien responde el 0 o el 1 no recibe el 2', () => {
  it('sin Estado → sigue la secuencia', () => {
    expect(estadoCortaDurarMas('')).toBe(false);
    expect(estadoCortaDurarMas(undefined)).toBe(false);
    expect(estadoCortaDurarMas(null)).toBe(false);
    expect(estadoCortaDurarMas('   ')).toBe(false);
  });

  it('acuse trivial ("Recibido — gracias") → sigue', () => {
    expect(estadoCortaDurarMas('Recibido — gracias 30/09')).toBe(false);
    expect(estadoCortaDurarMas('recibido')).toBe(false);
  });

  it('respuesta gestionada, compra, cierre o contacto → corta', () => {
    expect(estadoCortaDurarMas('Respondido — Candidato con dudas')).toBe(true);
    expect(estadoCortaDurarMas('Respondido — Objeción precio')).toBe(true);
    expect(estadoCortaDurarMas('COMPRÓ')).toBe(true);
    expect(estadoCortaDurarMas('Cerrado')).toBe(true);
    expect(estadoCortaDurarMas('Contactado — pedido cancelado (rescate)')).toBe(true);
  });
});
