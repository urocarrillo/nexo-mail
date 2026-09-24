/**
 * Tests de la lógica pura de la secuencia "Firme y Seguro" (curso Erección
 * con Preservativo):
 *   - computeFirmeSeguroDates (offsets +2/+4/+7/+10/+14 anclados al día ART,
 *     entregados en la corrida del cron de las 10:00 ART)
 *   - buildFirmeSeguroMail / mailEntrega (interpolación de nombre + steps inválidos)
 */
import {
  computeFirmeSeguroDates,
  buildFirmeSeguroMail,
  mailEntrega,
  saludo,
  FIRMESEGURO_OFFSETS_DIAS,
  FIRMESEGURO_SENDER_ENTREGA,
  FIRMESEGURO_SENDER_SECUENCIA,
  COPY_ENTREGA,
} from '@/lib/secuencia-firme-seguro';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('computeFirmeSeguroDates — cadencia +2/+4/+7/+10/+14 en calendario ART', () => {
  it('devuelve 5 fechas con los offsets exactos desde el día ART del alta', () => {
    // 23/07/2026 15:30 ART (= 18:30 UTC) → día base ART = 23/07.
    const enrolledAt = new Date('2026-07-23T18:30:00Z');
    const dates = computeFirmeSeguroDates(enrolledAt);

    expect(dates).toHaveLength(5);
    expect(FIRMESEGURO_OFFSETS_DIAS).toEqual([2, 4, 7, 10, 14]);

    // Cada "día ART" se representa a las 12:00 UTC de esa fecha (convención del
    // motor drip: el cron de las 13:00 UTC = 10:00 ART lo entrega ese mismo día).
    const base = Date.UTC(2026, 6, 23, 12, 0, 0, 0);
    dates.forEach((d, i) => {
      expect(d.getTime()).toBe(base + FIRMESEGURO_OFFSETS_DIAS[i] * DAY_MS);
    });
  });

  it('las 5 fechas quedan a las 12:00 UTC → la corrida de las 10:00 ART las entrega', () => {
    const dates = computeFirmeSeguroDates(new Date('2026-07-23T18:30:00Z'));
    for (const d of dates) {
      expect(d.getUTCHours()).toBe(12);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
    }
  });

  it('ancla al día ART aunque el instante UTC ya sea el día siguiente', () => {
    // 22/07/2026 23:30 ART = 23/07 02:30 UTC → día base ART = 22/07.
    const enrolledAt = new Date('2026-07-23T02:30:00Z');
    const dates = computeFirmeSeguroDates(enrolledAt);
    // fs1 = 22/07 + 2 días = 24/07 ART.
    expect(dates[0].getTime()).toBe(Date.UTC(2026, 6, 24, 12, 0, 0, 0));
    // fs5 = 22/07 + 14 días = 05/08 ART.
    expect(dates[4].getTime()).toBe(Date.UTC(2026, 7, 5, 12, 0, 0, 0));
  });

  it('fechas estrictamente crecientes (ningún mail el mismo día que otro)', () => {
    const dates = computeFirmeSeguroDates(new Date('2026-07-23T18:30:00Z'));
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i + 1].getTime() - dates[i].getTime()).toBeGreaterThanOrEqual(DAY_MS);
    }
  });
});

describe('buildFirmeSeguroMail — interpolación de nombre y steps', () => {
  it('interpola el primer nombre en el saludo', () => {
    const m = buildFirmeSeguroMail(1, 'Juan');
    expect(m.text.startsWith('Hola Juan,')).toBe(true);
  });

  it('sin nombre (o nombre vacío) → "Hola,"', () => {
    expect(buildFirmeSeguroMail(1).text.startsWith('Hola,')).toBe(true);
    expect(buildFirmeSeguroMail(1, '').text.startsWith('Hola,')).toBe(true);
    expect(buildFirmeSeguroMail(1, '   ').text.startsWith('Hola,')).toBe(true);
  });

  it('cada paso usa su copy con el link de atribución ?mseq=fsN', () => {
    const subjects = new Set<string>();
    for (let step = 1; step <= 5; step++) {
      const m = buildFirmeSeguroMail(step, 'Juan');
      expect(m.subject.length).toBeGreaterThan(5);
      expect(m.subject).not.toContain('PLACEHOLDER');
      expect(m.text).toContain(`https://urologia.ar/seguridad-en-la-intimidad?mseq=fs${step}`);
      subjects.add(m.subject);
    }
    expect(subjects.size).toBe(5);
  });

  it('steps inválidos lanzan', () => {
    expect(() => buildFirmeSeguroMail(0)).toThrow();
    expect(() => buildFirmeSeguroMail(6)).toThrow();
    expect(() => buildFirmeSeguroMail(-1, 'Juan')).toThrow();
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

  it('senders correctos: entrega desde mauro@, secuencia desde info@', () => {
    expect(FIRMESEGURO_SENDER_ENTREGA).toEqual({ name: 'Mauro', email: 'mauro@urologia.ar' });
    expect(FIRMESEGURO_SENDER_SECUENCIA).toEqual({
      name: 'Urólogo Mauro Carrillo',
      email: 'info@urologia.ar',
    });
  });
});
