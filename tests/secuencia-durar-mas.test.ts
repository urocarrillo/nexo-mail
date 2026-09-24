/**
 * Tests de la lógica pura de la secuencia "Durar más" (curso EP):
 *   - computeDurarMasDates (offsets +2/+4/+7/+10/+12/+21 anclados al día ART,
 *     entregados en la corrida del cron de las 10:00 ART)
 *   - buildDurarMasMail / mailEntrega (interpolación de nombre + steps inválidos)
 */
import {
  computeDurarMasDates,
  buildDurarMasMail,
  mailEntrega,
  saludo,
  DURARMAS_OFFSETS_DIAS,
  DURARMAS_SENDER_ENTREGA,
  DURARMAS_SENDER_SECUENCIA,
  COPY_ENTREGA,
} from '@/lib/secuencia-durar-mas';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('computeDurarMasDates — cadencia +2/+4/+7/+10/+12/+21 en calendario ART', () => {
  it('devuelve 6 fechas con los offsets exactos desde el día ART del alta', () => {
    // 22/07/2026 15:30 ART (= 18:30 UTC) → día base ART = 22/07.
    const enrolledAt = new Date('2026-07-22T18:30:00Z');
    const dates = computeDurarMasDates(enrolledAt);

    expect(dates).toHaveLength(6);
    expect(DURARMAS_OFFSETS_DIAS).toEqual([2, 4, 7, 10, 12, 21]);

    // Cada "día ART" se representa a las 12:00 UTC de esa fecha (convención del
    // motor drip: el cron de las 13:00 UTC = 10:00 ART lo entrega ese mismo día).
    const base = Date.UTC(2026, 6, 22, 12, 0, 0, 0);
    dates.forEach((d, i) => {
      expect(d.getTime()).toBe(base + DURARMAS_OFFSETS_DIAS[i] * DAY_MS);
    });
  });

  it('las 6 fechas quedan a las 12:00 UTC → la corrida de las 10:00 ART las entrega', () => {
    const dates = computeDurarMasDates(new Date('2026-07-22T18:30:00Z'));
    for (const d of dates) {
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
      // 12:00 UTC ≤ 13:00 UTC (cron) → sale en la corrida de las 10:00 ART del día.
    }
  });

  it('ancla al día ART aunque el instante UTC ya sea el día siguiente', () => {
    // 21/07/2026 23:30 ART = 22/07 02:30 UTC → día base ART = 21/07.
    const enrolledAt = new Date('2026-07-22T02:30:00Z');
    const dates = computeDurarMasDates(enrolledAt);
    // dm1 = 21/07 + 2 días = 23/07 ART.
    expect(dates[0].getTime()).toBe(Date.UTC(2026, 6, 23, 12, 0, 0, 0));
    // dm5 = 21/07 + 12 días = 02/08 ART.
    expect(dates[4].getTime()).toBe(Date.UTC(2026, 7, 2, 12, 0, 0, 0));
    // dm6 = 21/07 + 21 días = 11/08 ART.
    expect(dates[5].getTime()).toBe(Date.UTC(2026, 7, 11, 12, 0, 0, 0));
  });

  it('fechas estrictamente crecientes (ningún mail el mismo día que otro)', () => {
    const dates = computeDurarMasDates(new Date('2026-07-22T18:30:00Z'));
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i + 1].getTime() - dates[i].getTime()).toBeGreaterThanOrEqual(DAY_MS);
    }
  });
});

describe('buildDurarMasMail — interpolación de nombre y steps', () => {
  it('interpola el primer nombre en el saludo', () => {
    const m = buildDurarMasMail(1, 'Juan');
    expect(m.text.startsWith('Hola Juan,')).toBe(true);
  });

  it('sin nombre (o nombre vacío) → "Hola,"', () => {
    expect(buildDurarMasMail(1).text.startsWith('Hola,')).toBe(true);
    expect(buildDurarMasMail(1, '').text.startsWith('Hola,')).toBe(true);
    expect(buildDurarMasMail(1, '   ').text.startsWith('Hola,')).toBe(true);
  });

  it('cada paso usa su copy con el link de atribución ?mseq=dmN', () => {
    const subjects = new Set<string>();
    for (let step = 1; step <= 6; step++) {
      const m = buildDurarMasMail(step, 'Juan');
      expect(m.subject.length).toBeGreaterThan(5);
      expect(m.subject).not.toContain('PLACEHOLDER');
      expect(m.text).toContain(`https://urologia.ar/controla-tu-eyaculacion?mseq=dm${step}`);
      subjects.add(m.subject);
    }
    expect(subjects.size).toBe(6);
  });

  it('steps inválidos lanzan', () => {
    expect(() => buildDurarMasMail(0)).toThrow();
    expect(() => buildDurarMasMail(7)).toThrow();
    expect(() => buildDurarMasMail(-1, 'Juan')).toThrow();
  });

  it('mailEntrega usa COPY_ENTREGA e interpola el nombre', () => {
    const m = mailEntrega('Pedro');
    expect(m.subject).toBe(COPY_ENTREGA.subject);
    expect(m.text.startsWith('Hola Pedro,')).toBe(true);
    expect(m.text).toContain(COPY_ENTREGA.body);
    expect(mailEntrega().text.startsWith('Hola,')).toBe(true);
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
