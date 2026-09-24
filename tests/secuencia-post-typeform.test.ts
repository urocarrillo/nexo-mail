/**
 * Tests de la lógica pura de la secuencia post-test (v6, 24/09/2026):
 *   - computeSequenceDates (A: día 1 y 4 · B: día 3, anclados al calendario ART)
 *   - m1VariantForAge / parseArgDate / tierDePantalla
 *   - computeElegibles (exclusiones del enrolamiento)
 *   - estadoPausaSecuencia (skip por Estado del CRM)
 *   - builders de los mails (copy aprobado, sin cuotas, sin Calendly, sin edad)
 */
import {
  computeSequenceDates,
  SECUENCIA_DIAS,
  buildMailA0,
  buildMailA4,
  buildMailB0,
  buildMailPudisteVer,
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

describe('computeSequenceDates — secuencia corta (v6)', () => {
  const entradas: Array<[string, number]> = [
    ['viernes', DOW.FRI],
    ['sábado', DOW.SAT],
    ['domingo', DOW.SUN],
    ['lunes', DOW.MON],
  ];

  it.each(entradas)('tier A que entra %s: día 1 y día 4 a las 12:00 UTC', (_label, dow) => {
    const testAt = instantWithArtDow(dow);
    const dates = computeSequenceDates(testAt, 'A');
    expect(dates).toHaveLength(2);
    expect(SECUENCIA_DIAS.A).toEqual([1, 4]);
    const base = Date.UTC(testAt.getUTCFullYear(), testAt.getUTCMonth(), testAt.getUTCDate(), 12);
    expect(dates[0].getTime()).toBe(base + 1 * 86400000);
    expect(dates[1].getTime()).toBe(base + 4 * 86400000);
    expect(dates[0].getUTCHours()).toBe(12);
  });

  it('tier B: un solo paso al día 3', () => {
    const testAt = new Date('2026-09-24T20:30:00Z'); // 17:30 ART del 24/09
    const dates = computeSequenceDates(testAt, 'B');
    expect(dates).toHaveLength(1);
    expect(dates[0].toISOString()).toBe('2026-09-27T12:00:00.000Z');
  });

  it('un test a las 23:30 ART (02:30 UTC del día siguiente) ancla al día ART del test', () => {
    const testAt = new Date('2026-09-25T02:30:00Z'); // 23:30 ART del 24/09
    const [d1] = computeSequenceDates(testAt, 'A');
    expect(d1.toISOString()).toBe('2026-09-25T12:00:00.000Z');
  });

  it('por defecto usa el track A', () => {
    expect(computeSequenceDates(new Date('2026-09-24T15:00:00Z'))).toHaveLength(2);
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

describe('builders de la secuencia v6', () => {
  const PROHIBIDO = [/cuota/i, /calendly/i, /a los 18/i, /con calma/i, /\bdudas\b/i, /\bpero\b/i, /Dr\./];

  function sinProhibidos(text: string) {
    for (const re of PROHIBIDO) expect(text).not.toMatch(re);
  }

  it('usa el nombre si está, y "Hola," si no', () => {
    expect(buildMailA0('Mauro').text.startsWith('Hola Mauro,')).toBe(true);
    expect(buildMailA0('').text.startsWith('Hola,')).toBe(true);
    expect(buildSecuenciaMail(1, '', 'B').text.startsWith('Hola,')).toBe(true);
  });

  it('A0: asunto, frase de perfil según solitario, link sq0 y pedido de "recibido"', () => {
    const si = buildMailA0('x', { soloOk: true });
    const aveces = buildMailA0('x', { soloOk: false });
    expect(si.subject).toBe('tu resultado del test');
    expect(si.text).toContain('el cuerpo funciona, y la cabeza se acelera y desconecta');
    expect(aveces.text).not.toContain('el cuerpo funciona');
    expect(aveces.text).toContain('la cabeza se acelera y desconecta');
    expect(si.text).toContain('/?mseq=sq0');
    expect(si.text).toContain('"recibido"');
    expect(buildMailA0('x').text).not.toContain('el cuerpo funciona'); // sin dato → se omite
    sinProhibidos(si.text);
  });

  it('día 1 (A) y día 3 (B) comparten asunto y difieren en el pedido', () => {
    const a = buildMailPudisteVer('x', 'A');
    const b = buildMailPudisteVer('x', 'B');
    expect(a.subject).toBe('¿la pudiste ver?');
    expect(b.subject).toBe('¿la pudiste ver?');
    expect(a.text).toContain('qué te gustaría saber antes de arrancar');
    expect(b.text).toContain('contame en dos líneas cómo es lo tuyo');
    expect(a.text).not.toContain('urologia.ar'); // sin link: pide respuesta
    sinProhibidos(a.text);
    sinProhibidos(b.text);
  });

  it('A4: asunto gatillo, plan semana a semana, link sq2 y "lo conversamos"', () => {
    const m = buildMailA4('x');
    expect(m.subject).toBe('¿hace cuánto que estás con esto?');
    expect(m.text).toContain('semana a semana');
    expect(m.text).toContain('/?mseq=sq2');
    expect(m.text).toContain('lo conversamos');
    sinProhibidos(m.text);
  });

  it('B0: frase según factor (físico / vínculo / sin dato) y link sqb0', () => {
    const f = buildMailB0('x', 'fisico');
    const v = buildMailB0('x', 'vinculo');
    const n = buildMailB0('x', null);
    expect(f.subject).toBe('sobre tu resultado');
    expect(f.text).toContain('parte física para revisar');
    expect(v.text).toContain('lo que pasa en la pareja');
    expect(n.text).not.toContain('parte física');
    expect(n.text).not.toContain('en la pareja');
    expect(n.text).toContain('/?mseq=sqb0');
    expect(n.text).toContain('contame en dos líneas cómo es lo tuyo');
    sinProhibidos(f.text);
    sinProhibidos(v.text);
  });

  it('buildSecuenciaMail: track A pasos 1-2, track B paso 1, otros lanzan', () => {
    expect(buildSecuenciaMail(1, 'x', 'A').subject).toBe('¿la pudiste ver?');
    expect(buildSecuenciaMail(2, 'x', 'A').subject).toBe('¿hace cuánto que estás con esto?');
    expect(buildSecuenciaMail(1, 'x', 'B').text).toContain('dos líneas');
    expect(buildSecuenciaMail(0, 'x', 'A').subject).toBe('tu resultado del test');
    expect(buildSecuenciaMail(0, 'x', 'B').subject).toBe('sobre tu resultado');
    expect(() => buildSecuenciaMail(3, 'x', 'A')).toThrow();
    expect(() => buildSecuenciaMail(2, 'x', 'B')).toThrow();
    expect(() => buildSecuenciaMail(9, 'x')).toThrow();
  });
});

describe('buildRecuperoMail (T9)', () => {
  it('usa el nombre si está, y "Hola," si no', () => {
    expect(buildRecuperoMail('Juan').text.startsWith('Hola Juan,')).toBe(true);
    expect(buildRecuperoMail('').text.startsWith('Hola,')).toBe(true);
  });
  it('R1: asunto, link por defecto al carrito con ?mseq=rec1 y PD de Mercado Pago', () => {
    const m = buildRecuperoMail('Juan');
    expect(m.subject).toBe('todavía estás a tiempo');
    expect(m.text).toContain('https://urologia.ar/carrito/?add-to-cart=3740&mseq=rec1');
    expect(m.text).toContain('pagás en pesos por Mercado Pago, con cuotas');
    expect(m.text).toContain('el programa Controla tu Mente, Recupera tu Erección');
  });
  it('R2: asunto propio, usa el link y el nombre del curso que le pasan (limpio)', () => {
    const m = buildRecuperoMail('Ana', { paso: 2, curso: 'Controla tu mente,  Recupera tu erección\u200b', link: 'https://urologia.ar/finalizar-compra/order-pay/5/?pay_for_order=true&key=k&mseq=rec2' });
    expect(m.subject).toBe('hoy es un gran día para empezar');
    expect(m.text).toContain('order-pay/5/');
    expect(m.text).toContain('empezar Controla tu mente, Recupera tu erección.');
    expect(m.text).not.toContain('\u200b');
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
