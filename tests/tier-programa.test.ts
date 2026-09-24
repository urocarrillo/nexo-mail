/**
 * Casos de validación del cálculo de tier del test del programa DE
 * (réplica de la fórmula del Apps Script del Sheet CRM).
 */
import { calcularTier, ereccionSoloOk, factorTierB, respuestaDesconocida, tierParaEnvio } from '@/lib/tier-programa';

type Caso = [string, string, string, string, string, string, string];

function tier(c: Caso) {
  const [edad, ereccion, salud, pareja, consumo, compromiso, inversion] = c;
  return calcularTier({ edad, ereccion, salud, pareja, consumo, compromiso, inversion });
}

describe('calcularTier', () => {
  it('110 → A / A-Limpia', () => {
    const r = tier([
      '18 - 49 años',
      'Sí, casi siempre',
      'No tengo enfermedades',
      'No tengo pareja estable',
      'Más de 1 hora',
      'Sí, me comprometo',
      'Sí, es prioridad',
    ]);
    expect(r).toEqual({ score: 110, forzador: '', pantalla: 'A', variante: 'A-Limpia' });
  });

  it('80 → A / A-Cuotas (inversión "Me importa")', () => {
    const r = tier([
      '18 - 49 años',
      'A veces sí, a veces no',
      'No tengo enfermedades',
      'Tengo pareja estable y la relación es buena',
      'Ocasional o no consumo',
      'Sí, me comprometo',
      'Me importa pero estoy ajustado',
    ]);
    expect(r).toEqual({ score: 80, forzador: '', pantalla: 'A', variante: 'A-Cuotas' });
  });

  it('90 → A / A-Limpia (50+)', () => {
    const r = tier([
      '50 años o más',
      'Sí, casi siempre',
      'No tengo enfermedades',
      'Tengo pareja estable y la relación es buena',
      'Diariamente pero poco',
      'Sí, me comprometo',
      'Sí, es prioridad',
    ]);
    expect(r).toEqual({ score: 90, forzador: '', pantalla: 'A', variante: 'A-Limpia' });
  });

  it('70 → B-CONTACTO (compromiso Sí + inversión Sí)', () => {
    const r = tier([
      '50 años o más',
      'A veces sí',
      'No tengo enfermedades',
      'Tengo pareja estable y la relación es buena',
      'Diariamente pero poco',
      'Sí, me comprometo',
      'Sí, es prioridad',
    ]);
    expect(r).toEqual({ score: 70, forzador: '', pantalla: 'B-CONTACTO', variante: 'B-CONTACTO' });
  });

  it('65 → B-AUTO (inversión "Me importa")', () => {
    const r = tier([
      '18 - 49 años',
      'A veces sí',
      'Tengo enfermedad/es de base',
      'Tengo pareja estable y la relación es buena',
      'Más de 1 hora',
      'Sí, me comprometo',
      'Me importa pero',
    ]);
    expect(r).toEqual({ score: 65, forzador: '', pantalla: 'B-AUTO', variante: 'B-AUTO' });
  });

  it('60 → B-AUTO (compromiso "Voy")', () => {
    const r = tier([
      '18 - 49 años',
      'A veces sí',
      'No tengo enfermedades',
      'No tengo pareja estable',
      'Ocasional',
      'Voy a intentarlo',
      'Sí, es prioridad',
    ]);
    expect(r).toEqual({ score: 60, forzador: '', pantalla: 'B-AUTO', variante: 'B-AUTO' });
  });

  it('-5 → C / C-ScoreBajo', () => {
    const r = tier([
      '50 años o más',
      'A veces sí',
      'Tengo enfermedad/es',
      'Tengo pareja estable pero hay problemas',
      'Ocasional',
      'Voy a intentarlo',
      'Tengo otras prioridades',
    ]);
    expect(r).toEqual({ score: -5, forzador: '', pantalla: 'C', variante: 'C-ScoreBajo' });
  });

  it('erección "No" → forzador P2c', () => {
    const r = tier([
      '18 - 49 años',
      'No, casi nunca',
      'No tengo enfermedades',
      'No tengo pareja estable',
      'Más de 1 hora',
      'Sí, me comprometo',
      'Sí, es prioridad',
    ]);
    expect(r).toMatchObject({ forzador: 'P2c', pantalla: 'C', variante: 'C-P2c' });
    expect(r!.score).toBe(75); // suma de lo que sí puntuó
  });

  it('salud "Tengo varias" → forzador P3c', () => {
    const r = tier([
      '18 - 49 años',
      'Sí, casi siempre',
      'Tengo varias de esas condiciones',
      'No tengo pareja estable',
      'Más de 1 hora',
      'Sí, me comprometo',
      'Sí, es prioridad',
    ]);
    expect(r).toMatchObject({ forzador: 'P3c', pantalla: 'C', variante: 'C-P3c' });
  });

  it('compromiso "No tengo" → forzador P6c', () => {
    const r = tier([
      '18 - 49 años',
      'Sí, casi siempre',
      'No tengo enfermedades',
      'No tengo pareja estable',
      'Más de 1 hora',
      'No tengo esa disponibilidad',
      'Sí, es prioridad',
    ]);
    expect(r).toMatchObject({ forzador: 'P6c', pantalla: 'C', variante: 'C-P6c' });
  });

  it('varios forzadores → gana el primero en orden P2c, P3c, P6c', () => {
    const r = tier([
      '18 - 49 años',
      'No, casi nunca',
      'Tengo varias de esas condiciones',
      'No tengo pareja estable',
      'Más de 1 hora',
      'No tengo esa disponibilidad',
      '',
    ]);
    expect(r).toMatchObject({ forzador: 'P2c', variante: 'C-P2c' });
  });

  it('edad vacía → null', () => {
    const r = tier([
      '',
      'Sí, casi siempre',
      'No tengo enfermedades',
      'No tengo pareja estable',
      'Más de 1 hora',
      'Sí, me comprometo',
      'Sí, es prioridad',
    ]);
    expect(r).toBeNull();
  });

  it('inversión vacía no bloquea (A-Limpia por defecto)', () => {
    const r = tier([
      '18 - 49 años',
      'Sí, casi siempre',
      'No tengo enfermedades',
      'No tengo pareja estable',
      'Más de 1 hora',
      'Sí, me comprometo',
      '',
    ]);
    expect(r).toEqual({ score: 110, forzador: '', pantalla: 'A', variante: 'A-Limpia' });
  });

  it('tolera espacios alrededor de las respuestas', () => {
    const r = tier([
      '  18 - 49 años ',
      ' Sí, casi siempre',
      'No tengo enfermedades ',
      ' No tengo pareja estable',
      'Más de 1 hora ',
      ' Sí, me comprometo ',
      ' Sí, es prioridad',
    ]);
    expect(r?.score).toBe(110);
  });
});

describe('respuestas no reconocibles (cambio de texto en el Typeform)', () => {
  const base: Caso = [
    '18 - 49 años',
    'Sí, casi siempre',
    'No tengo enfermedades',
    'No tengo pareja estable',
    'Más de 1 hora',
    'Sí, me comprometo',
    'Sí, es prioridad',
  ];
  const con = (i: number, v: string): Caso => {
    const c = [...base] as Caso;
    c[i] = v;
    return c;
  };

  it('erección sin tilde ("Si") → null, no 0 puntos en silencio', () => {
    expect(tier(con(1, 'Si, casi siempre'))).toBeNull();
  });

  it('salud reformulada → null (no se pierde un forzador médico)', () => {
    expect(tier(con(2, 'Varias condiciones'))).toBeNull();
  });

  it('compromiso sin tilde → null (no baja a B-AUTO en silencio)', () => {
    expect(tier(con(5, 'Si, me comprometo'))).toBeNull();
  });

  it('inversión desconocida no vacía → null; vacía → A-Limpia', () => {
    expect(tier(con(6, 'Si, es prioridad'))).toBeNull();
    expect(tier(con(6, ''))?.variante).toBe('A-Limpia');
  });

  it('edad fuera de los dos rangos → null', () => {
    expect(tier(con(0, 'Menos de 18'))).toBeNull();
  });

  it('pareja y consumo aceptan cualquier texto (tienen rama "otro")', () => {
    expect(tier(con(3, 'Es complicado'))?.score).toBe(85); // -15 en vez de +10
    expect(tier(con(4, 'Nada'))?.score).toBe(100); // +5 en vez de +15
  });

  it('respuestaDesconocida nombra el campo', () => {
    const [edad, ereccion, salud, pareja, consumo, compromiso, inversion] = con(1, 'Si, casi siempre');
    expect(respuestaDesconocida({ edad, ereccion, salud, pareja, consumo, compromiso, inversion })).toBe('ereccion');
    const ok = base;
    expect(
      respuestaDesconocida({
        edad: ok[0],
        ereccion: ok[1],
        salud: ok[2],
        pareja: ok[3],
        consumo: ok[4],
        compromiso: ok[5],
        inversion: ok[6],
      })
    ).toBeNull();
  });
});

describe('tierParaEnvio', () => {
  it('mapea pantallas a la letra de tier', () => {
    expect(tierParaEnvio('A')).toBe('A');
    expect(tierParaEnvio('B-CONTACTO')).toBe('B');
    expect(tierParaEnvio('B-AUTO')).toBe('B');
    expect(tierParaEnvio('C')).toBe('C');
    expect(tierParaEnvio(' C ')).toBe('C');
  });

  it('cualquier otra cosa → null', () => {
    expect(tierParaEnvio('')).toBeNull();
    expect(tierParaEnvio('B')).toBeNull();
    expect(tierParaEnvio('C-P2c')).toBeNull();
    expect(tierParaEnvio(undefined)).toBeNull();
  });
});


describe('forzadores tempranos con preguntas salteadas por Typeform', () => {
  it('P2c con solo edad y erección → C-P2c (Typeform saltó el resto)', () => {
    const r = calcularTier({ edad: '18 - 49 años', ereccion: 'No, casi nunca', salud: '', pareja: '', consumo: '', compromiso: '', inversion: '' });
    expect(r).toMatchObject({ forzador: 'P2c', pantalla: 'C', variante: 'C-P2c' });
  });
  it('P3c con edad, erección y salud → C-P3c', () => {
    const r = calcularTier({ edad: '50 años o más', ereccion: 'A veces sí, a veces no', salud: 'Tengo varias de esas condiciones y el problema apareció cerca del diagnóstico', pareja: '', consumo: '', compromiso: '', inversion: '' });
    expect(r).toMatchObject({ forzador: 'P3c', pantalla: 'C', variante: 'C-P3c' });
  });
  it('P2c sin edad → null', () => {
    expect(calcularTier({ edad: '', ereccion: 'No, casi nunca', salud: '', pareja: '', consumo: '', compromiso: '', inversion: '' })).toBeNull();
  });
  it('sin forzador y con pareja vacía → null (sigue incompleta)', () => {
    expect(calcularTier({ edad: '18 - 49 años', ereccion: 'Sí, casi siempre', salud: 'No tengo enfermedades', pareja: '', consumo: 'Ocasional', compromiso: 'Sí, me comprometo', inversion: '' })).toBeNull();
  });
});

describe('datos para los mails post-test (v6)', () => {
  it('ereccionSoloOk: "Sí…" → true; "A veces" / vacío / undefined → false', () => {
    expect(ereccionSoloOk({ ereccion: 'Sí, casi siempre' })).toBe(true);
    expect(ereccionSoloOk({ ereccion: '  Sí' })).toBe(true);
    expect(ereccionSoloOk({ ereccion: 'A veces sí, a veces no' })).toBe(false);
    expect(ereccionSoloOk({ ereccion: '' })).toBe(false);
    expect(ereccionSoloOk(undefined)).toBe(false);
  });

  it('factorTierB: físico manda (a veces / enfermedad / 50+)', () => {
    expect(factorTierB({ edad: '18 - 49 años', ereccion: 'A veces', salud: 'No tengo enfermedades', pareja: 'Tengo pareja pero con conflictos' })).toBe('fisico');
    expect(factorTierB({ edad: '18 - 49 años', ereccion: 'Sí', salud: 'Tengo enfermedad crónica controlada', pareja: 'No tengo pareja estable' })).toBe('fisico');
    expect(factorTierB({ edad: '50 años o más', ereccion: 'Sí', salud: 'No tengo enfermedades', pareja: 'No tengo pareja estable' })).toBe('fisico');
  });

  it('factorTierB: vínculo cuando la pareja resta y no hay factor físico', () => {
    expect(factorTierB({ edad: '18 - 49 años', ereccion: 'Sí', salud: 'No tengo enfermedades', pareja: 'Tengo pareja pero con conflictos' })).toBe('vinculo');
    expect(factorTierB({ edad: '18 - 49 años', ereccion: 'Sí', salud: 'No tengo enfermedades', pareja: 'Relaciones ocasionales' })).toBe('vinculo');
  });

  it('factorTierB: sin factor reconocible o sin datos → null', () => {
    expect(factorTierB({ edad: '18 - 49 años', ereccion: 'Sí', salud: 'No tengo enfermedades', pareja: 'Tengo pareja estable y buena relación' })).toBe(null);
    expect(factorTierB({ edad: '', ereccion: '', salud: '', pareja: '' })).toBe(null);
    expect(factorTierB(undefined)).toBe(null);
  });
});
