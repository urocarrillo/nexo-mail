/**
 * Tests de la lógica pura de la secuencia post-Typeform:
 *   - computeSequenceDates / computeStockM1 (cadencia anclada al calendario ART)
 *   - m1VariantForAge / parseArgDate / tierDePantalla
 *   - computeElegibles (exclusiones del enrolamiento)
 *   - estadoPausaSecuencia (skip por Estado del CRM)
 *   - buildSecuenciaMail (fallback de nombre + links ?m=sqN)
 */
import {
  computeSequenceDates,
  computeSequenceDatesFromM1,
  computeStockM1,
  computeStockSequenceDates,
  m1VariantForAge,
  parseArgDate,
  tierDePantalla,
  estadoPausaSecuencia,
  isSecuenciaExcluido,
  computeElegibles,
  buildSecuenciaMail,
  buildRecuperoMail,
  buildMailTierC,
  computeTierCCandidates,
  tieneMailCEnviado,
  fechaArgDDMM,
  type StockRow,
  type TierCRow,
} from '@/lib/secuencia-post-typeform';

// Día de la semana en hora ART (UTC-3): 0 = domingo … 6 = sábado.
function artDow(d: Date): number {
  return new Date(d.getTime() - 3 * 60 * 60 * 1000).getUTCDay();
}

// Primer instante (a las 13:00 UTC = 10:00 ART) cuyo día ART sea `targetDow`.
function instantWithArtDow(targetDow: number): Date {
  let d = new Date('2026-07-01T13:00:00Z');
  for (let i = 0; i < 7; i++) {
    if (artDow(d) === targetDow) return d;
    d = new Date(d.getTime() + 86400000);
  }
  throw new Error('no encontrado');
}

const DOW = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

describe('computeSequenceDates — cadencia y orden estricto', () => {
  // Cubre lead que entra viernes, sábado, domingo y lunes.
  const entradas: Array<[string, number]> = [
    ['viernes', DOW.FRI],
    ['sábado', DOW.SAT],
    ['domingo', DOW.SUN],
    ['lunes', DOW.MON],
  ];

  it.each(entradas)('lead que entra %s: M1<M2<…<M8 estrictos y días distintos', (_label, dow) => {
    const enrolledAt = instantWithArtDow(dow);
    const dates = computeSequenceDates(enrolledAt);

    expect(dates).toHaveLength(8);

    // Estrictamente creciente → ningún mail el mismo día que otro.
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i].getTime()).toBeLessThan(dates[i + 1].getTime());
      // separación mínima de 1 día
      expect(dates[i + 1].getTime() - dates[i].getTime()).toBeGreaterThanOrEqual(86400000);
    }
  });

  it.each(entradas)('lead que entra %s: anclas de calendario correctas', (_label, dow) => {
    const dates = computeSequenceDates(instantWithArtDow(dow));
    const [M1, M2, M3, M4, M5, M6, M7, M8] = dates;

    expect(artDow(M1)).not.toBe(DOW.SUN); // M1 nunca domingo
    expect(artDow(M2)).toBe(DOW.SUN); // primer domingo
    expect(artDow(M3)).toBe(DOW.TUE); // M2 + 2
    expect(artDow(M4)).toBe(DOW.FRI); // M3 + 3
    expect(artDow(M5)).toBe(DOW.MON); // M4 + 3
    expect(artDow(M6)).toBe(DOW.SUN); // segundo domingo
    expect(artDow(M7)).toBe(DOW.TUE); // martes siguiente a M6
    expect(artDow(M8)).toBe(DOW.FRI); // viernes siguiente a M7

    // M1 estrictamente antes de M2 (regla explícita del spec).
    expect(M1.getTime()).toBeLessThan(M2.getTime());
  });

  it('M1 = enrolledAt + 2 días; si cae domingo corre a lunes', () => {
    // Un viernes → +2 = domingo → debe correr a lunes.
    const fri = instantWithArtDow(DOW.FRI);
    const [M1] = computeSequenceDates(fri);
    expect(artDow(M1)).toBe(DOW.MON);
  });

  it('computeSequenceDatesFromM1 respeta el M1 dado', () => {
    const m1 = new Date('2026-07-10T12:00:00Z'); // viernes ART
    const dates = computeSequenceDatesFromM1(m1);
    expect(artDow(dates[0])).toBe(DOW.FRI);
    expect(artDow(dates[1])).toBe(DOW.SUN);
  });
});

describe('computeStockM1 — próximo día hábil', () => {
  it('jueves → viernes', () => {
    const m1 = computeStockM1(instantWithArtDow(DOW.THU));
    expect(artDow(m1)).toBe(DOW.FRI);
  });
  it('viernes → mismo viernes', () => {
    const run = instantWithArtDow(DOW.FRI);
    const m1 = computeStockM1(run);
    expect(artDow(m1)).toBe(DOW.FRI);
    // misma fecha ART que el run
    const runArt = new Date(run.getTime() - 3 * 3600e3);
    expect(m1.getUTCDate()).toBe(runArt.getUTCDate());
  });
  it('sábado → lunes', () => {
    expect(artDow(computeStockM1(instantWithArtDow(DOW.SAT)))).toBe(DOW.MON);
  });
  it('domingo → lunes', () => {
    expect(artDow(computeStockM1(instantWithArtDow(DOW.SUN)))).toBe(DOW.MON);
  });
  it('lunes → martes', () => {
    expect(artDow(computeStockM1(instantWithArtDow(DOW.MON)))).toBe(DOW.TUE);
  });

  it('computeStockSequenceDates ancla M2..M8 desde el M1 del stock', () => {
    const dates = computeStockSequenceDates(instantWithArtDow(DOW.THU));
    expect(artDow(dates[0])).toBe(DOW.FRI); // M1
    expect(artDow(dates[1])).toBe(DOW.SUN); // M2
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i].getTime()).toBeLessThan(dates[i + 1].getTime());
    }
  });
});

describe('m1VariantForAge', () => {
  const now = new Date('2026-07-10T12:00:00Z');
  it('≤7 días → A', () => {
    expect(m1VariantForAge(new Date('2026-07-05T12:00:00Z'), now)).toBe('A');
    expect(m1VariantForAge(now, now)).toBe('A');
  });
  it('8+ días → B', () => {
    expect(m1VariantForAge(new Date('2026-06-30T12:00:00Z'), now)).toBe('B');
  });
  it('fecha nula/inválida → B', () => {
    expect(m1VariantForAge(null, now)).toBe('B');
  });
});

describe('parseArgDate', () => {
  it('dd/mm/yyyy con hora', () => {
    const d = parseArgDate('02/07/2026 14:30:00');
    expect(d).not.toBeNull();
    expect(d!.getUTCMonth()).toBe(6); // julio (0-based)
    expect(new Date(d!.getTime() - 3 * 3600e3).getUTCDate()).toBe(2);
  });
  it('dd/mm/yyyy sin hora', () => {
    const d = parseArgDate('15/03/2026');
    expect(d!.getUTCMonth()).toBe(2);
  });
  it('ISO', () => {
    const d = parseArgDate('2026-07-02T10:00:00Z');
    expect(d!.getUTCFullYear()).toBe(2026);
  });
  it('vacío o basura → null', () => {
    expect(parseArgDate('')).toBeNull();
    expect(parseArgDate('   ')).toBeNull();
    expect(parseArgDate('no-es-fecha')).toBeNull();
  });
});

describe('tierDePantalla', () => {
  it('extrae la letra de tier', () => {
    expect(tierDePantalla('A')).toBe('A');
    expect(tierDePantalla('Pantalla A')).toBe('A');
    expect(tierDePantalla('B')).toBe('B');
    expect(tierDePantalla('C - descartado')).toBe('C');
    expect(tierDePantalla('')).toBe('');
    expect(tierDePantalla('sin letra')).toBe('');
  });
});

describe('estadoPausaSecuencia', () => {
  it('pausa si el Estado indica conversación humana', () => {
    expect(estadoPausaSecuencia('Respondido')).toBe(true);
    expect(estadoPausaSecuencia('En conversación')).toBe(true);
    expect(estadoPausaSecuencia('en conversacion')).toBe(true);
    expect(estadoPausaSecuencia('Contactado por mail')).toBe(true);
    expect(estadoPausaSecuencia('COMPRÓ')).toBe(true);
    expect(estadoPausaSecuencia('compro')).toBe(true);
  });
  it('no pausa si está vacío o es un estado neutro', () => {
    expect(estadoPausaSecuencia('')).toBe(false);
    expect(estadoPausaSecuencia(undefined)).toBe(false);
    expect(estadoPausaSecuencia('Nuevo')).toBe(false);
  });
});

describe('computeElegibles — exclusiones del enrolamiento', () => {
  const now = new Date('2026-07-10T12:00:00Z');
  const esCliente = (email: string) => email === 'cliente@x.com';

  function row(p: Partial<StockRow>): StockRow {
    return {
      email: p.email ?? 'lead@x.com',
      pantalla: p.pantalla ?? 'A',
      estado: p.estado ?? '',
      fecha: p.fecha ?? '05/07/2026',
      nombre: p.nombre ?? 'Juan',
    };
  }

  it('lead válido de Pantalla A entra como elegible', () => {
    const res = computeElegibles([row({ email: 'ok@x.com' })], { esCliente, now });
    expect(res.elegibles).toHaveLength(1);
    expect(res.elegibles[0].email).toBe('ok@x.com');
  });

  it('descarta duplicados (segunda fila del mismo email)', () => {
    const res = computeElegibles(
      [row({ email: 'dup@x.com' }), row({ email: 'dup@x.com' })],
      { esCliente, now }
    );
    expect(res.elegibles).toHaveLength(1);
    expect(res.descartes.duplicado).toBe(1);
  });

  it('descarta Pantalla ≠ A', () => {
    const res = computeElegibles([row({ email: 'b@x.com', pantalla: 'B' })], { esCliente, now });
    expect(res.elegibles).toHaveLength(0);
    expect(res.descartes['no-pantalla-a']).toBe(1);
  });

  it('descarta Estado no vacío', () => {
    const res = computeElegibles(
      [row({ email: 'e@x.com', estado: 'Respondido' })],
      { esCliente, now }
    );
    expect(res.elegibles).toHaveLength(0);
    expect(res.descartes['estado-no-vacio']).toBe(1);
  });

  it('descarta emails de la exclusión 1-a-1', () => {
    const excluido = 'pruebatester7@gmail.com';
    expect(isSecuenciaExcluido(excluido)).toBe(true);
    const res = computeElegibles([row({ email: excluido })], { esCliente, now });
    expect(res.elegibles).toHaveLength(0);
    expect(res.descartes['excluido-1a1']).toBe(1);
  });

  it('descarta clientes', () => {
    const res = computeElegibles([row({ email: 'cliente@x.com' })], { esCliente, now });
    expect(res.elegibles).toHaveLength(0);
    expect(res.descartes.cliente).toBe(1);
  });

  it('asigna variante A (test reciente) vs B (test viejo)', () => {
    const res = computeElegibles(
      [
        row({ email: 'reciente@x.com', fecha: '08/07/2026' }),
        row({ email: 'viejo@x.com', fecha: '01/06/2026' }),
        row({ email: 'sinfecha@x.com', fecha: '' }),
      ],
      { esCliente, now }
    );
    const byEmail = Object.fromEntries(res.elegibles.map((e) => [e.email, e.variant]));
    expect(byEmail['reciente@x.com']).toBe('A');
    expect(byEmail['viejo@x.com']).toBe('B');
    expect(byEmail['sinfecha@x.com']).toBe('B'); // fecha desconocida → B
  });
});

describe('buildSecuenciaMail', () => {
  it('usa el nombre si está, y "Hola," si no', () => {
    expect(buildSecuenciaMail(0, 'Mauro').text.startsWith('Hola Mauro,')).toBe(true);
    expect(buildSecuenciaMail(0, '').text.startsWith('Hola,')).toBe(true);
  });

  it('M0/M3/M5/M6/M7/M8 llevan su link ?m=sqN', () => {
    expect(buildSecuenciaMail(0, 'x').text).toContain('/?m=sq0');
    expect(buildSecuenciaMail(3, 'x').text).toContain('/?m=sq3');
    expect(buildSecuenciaMail(5, 'x').text).toContain('/?m=sq5');
    expect(buildSecuenciaMail(6, 'x').text).toContain('/?m=sq6');
    expect(buildSecuenciaMail(7, 'x').text).toContain('/?m=sq7');
    expect(buildSecuenciaMail(8, 'x').text).toContain('/?m=sq8');
  });

  it('M1 tiene variantes A y B distintas', () => {
    const a = buildSecuenciaMail(1, 'x', 'A').text;
    const b = buildSecuenciaMail(1, 'x', 'B').text;
    expect(a).not.toBe(b);
    expect(a).toContain('Hace unos días');
    expect(b).toContain('Hace un tiempo');
  });

  it('M8 incluye la puerta del Calendly', () => {
    expect(buildSecuenciaMail(8, 'x').text).toContain('calendly.com/urologocarrillo');
  });

  it('M2 no tiene CTA/link (mail de reconocimiento)', () => {
    expect(buildSecuenciaMail(2, 'x').text).not.toContain('urologia.ar/recuperatuereccion');
  });

  it('paso inválido lanza error', () => {
    expect(() => buildSecuenciaMail(9, 'x')).toThrow();
  });
});

describe('buildRecuperoMail (T9)', () => {
  it('usa el nombre si está, y "Hola," si no', () => {
    expect(buildRecuperoMail('Juan').text.startsWith('Hola Juan,')).toBe(true);
    expect(buildRecuperoMail('').text.startsWith('Hola,')).toBe(true);
  });
  it('asunto exacto y link de carrito con ?m=rec1', () => {
    const m = buildRecuperoMail('Juan');
    expect(m.subject).toBe('se trabó tu inscripción');
    expect(m.text).toContain('https://urologia.ar/carrito/?add-to-cart=3740&m=rec1');
  });
  it('mantiene la PD de MercadoPago/cuotas', () => {
    expect(buildRecuperoMail('x').text).toContain('MercadoPago y tenés cuotas');
  });
});

describe('buildMailTierC (T12)', () => {
  it('usa el nombre si está, y "Hola," si no', () => {
    expect(buildMailTierC('Juan').text.startsWith('Hola Juan,')).toBe(true);
    expect(buildMailTierC('').text.startsWith('Hola,')).toBe(true);
  });
  it('asunto exacto y link de Calendly', () => {
    const m = buildMailTierC('Juan');
    expect(m.subject).toBe('sobre tu test');
    expect(m.text).toContain('https://calendly.com/urologocarrillo');
  });
  it('no ofrece el programa (deriva a consulta)', () => {
    expect(buildMailTierC('x').text).not.toContain('urologia.ar/recuperatuereccion');
  });
});

describe('fechaArgDDMM', () => {
  it('dd/mm en hora ART (UTC-3)', () => {
    // 03/07 01:00 UTC = 02/07 22:00 ART → dd/mm = 02/07
    expect(fechaArgDDMM(new Date('2026-07-03T01:00:00Z'))).toBe('02/07');
    // 03/07 15:00 UTC = 03/07 12:00 ART → 03/07
    expect(fechaArgDDMM(new Date('2026-07-03T15:00:00Z'))).toBe('03/07');
  });
});

describe('tieneMailCEnviado', () => {
  it('detecta la marca del Sheet (tolera espacios/case)', () => {
    expect(tieneMailCEnviado('Mail C enviado 02/07')).toBe(true);
    expect(tieneMailCEnviado('mail c enviado')).toBe(true);
    expect(tieneMailCEnviado('MailC enviado')).toBe(true);
    expect(tieneMailCEnviado('')).toBe(false);
    expect(tieneMailCEnviado('sq3 enviado 08/07')).toBe(false);
  });
});

describe('computeTierCCandidates (T12 backfill)', () => {
  const esCliente = (email: string) => email === 'cliente@x.com';

  function row(p: Partial<TierCRow>): TierCRow {
    return {
      email: p.email ?? 'c@x.com',
      pantalla: p.pantalla ?? 'C',
      estado: p.estado ?? '',
      secuencia: p.secuencia ?? '',
      nombre: p.nombre ?? 'Juan',
      rowIndex: p.rowIndex ?? 2,
    };
  }

  it('fila tier C limpia → candidato', () => {
    const res = computeTierCCandidates([row({ email: 'ok@x.com', rowIndex: 5 })], { esCliente });
    expect(res.candidatos).toHaveLength(1);
    expect(res.candidatos[0]).toEqual({ email: 'ok@x.com', nombre: 'Juan', rowIndex: 5 });
    expect(res.tierCTotal).toBe(1);
  });

  it('ignora filas que no son tier C (no cuentan como descarte)', () => {
    const res = computeTierCCandidates(
      [row({ email: 'a@x.com', pantalla: 'A' }), row({ email: 'b@x.com', pantalla: 'B' })],
      { esCliente }
    );
    expect(res.candidatos).toHaveLength(0);
    expect(res.tierCTotal).toBe(0);
  });

  it('descarta duplicados de tier C', () => {
    const res = computeTierCCandidates(
      [row({ email: 'dup@x.com' }), row({ email: 'dup@x.com' })],
      { esCliente }
    );
    expect(res.candidatos).toHaveLength(1);
    expect(res.descartes.duplicado).toBe(1);
  });

  it('descarta filas que ya tienen "Mail C enviado"', () => {
    const res = computeTierCCandidates(
      [row({ email: 'ya@x.com', secuencia: 'Mail C enviado 01/07' })],
      { esCliente }
    );
    expect(res.candidatos).toHaveLength(0);
    expect(res.descartes['ya-enviado']).toBe(1);
  });

  it('descarta filas con Estado no vacío', () => {
    const res = computeTierCCandidates(
      [row({ email: 'e@x.com', estado: 'Respondido' })],
      { esCliente }
    );
    expect(res.candidatos).toHaveLength(0);
    expect(res.descartes['estado-no-vacio']).toBe(1);
  });

  it('descarta compradores', () => {
    const res = computeTierCCandidates([row({ email: 'cliente@x.com' })], { esCliente });
    expect(res.candidatos).toHaveLength(0);
    expect(res.descartes.cliente).toBe(1);
  });
});
