/**
 * Cálculo del tier del test del programa DE (reemplaza la fórmula del Apps
 * Script del Sheet CRM, muerto por timeout el 15/07/2026).
 *
 * Entrada: las respuestas crudas del Sheet ("Cohorte 2 — Calificación").
 * Salida: Score / Forzador / Pantalla / Variante, tal como los escribía el
 * script viejo. Función pura, sin IO.
 *
 * Comparaciones por prefijo (tras trim), con las tildes exactas del Sheet.
 */

export interface RespuestasTier {
  edad: string;
  ereccion: string;
  salud: string;
  pareja: string;
  consumo: string;
  compromiso: string;
  inversion: string; // puede venir vacía
}

export interface TierResult {
  score: number;
  forzador: string; // '' | 'P2c' | 'P3c' | 'P6c'
  pantalla: string; // 'A' | 'B-CONTACTO' | 'B-AUTO' | 'C'
  variante: string;
}

export type TierEnvio = 'A' | 'B' | 'C';

const clean = (v: string | undefined | null): string => (v || '').trim();
const empieza = (v: string, prefijo: string): boolean => v.startsWith(prefijo);

/**
 * Prefijos conocidos de las respuestas cerradas. Pareja y consumo tienen rama
 * "cualquier otro" en la fórmula, así que no se validan. Si el Typeform cambia
 * el texto de una opción (tilde perdida, reformulación) la respuesta deja de
 * matchear y en vez de puntuar 0 en silencio (o perder un forzador médico) el
 * tier NO se calcula: el vigilante lo cuenta como sin_tier y avisa.
 */
const PREFIJOS_CONOCIDOS: Partial<Record<keyof RespuestasTier, string[]>> = {
  edad: ['18', '50'],
  ereccion: ['Sí', 'A veces', 'No'],
  salud: ['No tengo', 'Tengo enfermedad', 'Tengo varias'],
  compromiso: ['Sí', 'Voy', 'No tengo'],
  inversion: ['Sí', 'Me importa', 'Tengo otras'],
};

/**
 * Devuelve el nombre del primer campo con una respuesta no vacía que no
 * matchea ningún prefijo conocido, o null si todo es reconocible.
 */
export function respuestaDesconocida(r: RespuestasTier): keyof RespuestasTier | null {
  for (const campo of Object.keys(PREFIJOS_CONOCIDOS) as Array<keyof RespuestasTier>) {
    const v = clean(r[campo]);
    if (!v) continue;
    const prefijos = PREFIJOS_CONOCIDOS[campo] || [];
    if (!prefijos.some((p) => empieza(v, p))) return campo;
  }
  return null;
}

/**
 * true si están las respuestas necesarias. Typeform SALTA las preguntas
 * siguientes cuando una respuesta obliga a C (P2c en erección, P3c en salud),
 * así que esas filas llegan "incompletas" a propósito: se aceptan igual.
 * La inversión puede faltar siempre.
 */
export function respuestasCompletas(r: RespuestasTier): boolean {
  if (!clean(r.edad) || !clean(r.ereccion)) return false;
  if (empieza(clean(r.ereccion), 'No')) return true; // P2c → pantalla C, sin más preguntas
  if (!clean(r.salud)) return false;
  if (empieza(clean(r.salud), 'Tengo varias')) return true; // P3c → pantalla C
  return Boolean(clean(r.pareja) && clean(r.consumo) && clean(r.compromiso));
}

/**
 * Devuelve null si falta cualquiera de las 6 respuestas puntuables
 * (la inversión puede faltar) o si alguna respuesta cerrada no es reconocible
 * (ver respuestaDesconocida).
 */
export function calcularTier(r: RespuestasTier): TierResult | null {
  const edad = clean(r.edad);
  const ereccion = clean(r.ereccion);
  const salud = clean(r.salud);
  const pareja = clean(r.pareja);
  const consumo = clean(r.consumo);
  const compromiso = clean(r.compromiso);
  const inversion = clean(r.inversion);

  if (!respuestasCompletas(r)) return null;
  if (respuestaDesconocida(r)) return null;

  let score = 0;
  const forzadores: string[] = [];

  // Edad
  if (empieza(edad, '18')) score += 15;

  // Erección
  if (empieza(ereccion, 'Sí')) score += 35;
  else if (empieza(ereccion, 'A veces')) score += 15;
  else if (empieza(ereccion, 'No')) forzadores.push('P2c');

  // Salud
  if (empieza(salud, 'Tengo varias')) forzadores.push('P3c');
  else if (empieza(salud, 'No tengo')) score += 15;
  else if (empieza(salud, 'Tengo enfermedad')) score -= 10;

  // Pareja
  if (empieza(pareja, 'No tengo') || empieza(pareja, 'Tengo pareja estable y')) score += 10;
  else score -= 15;

  // Consumo de redes
  if (empieza(consumo, 'Más de')) score += 15;
  else if (empieza(consumo, 'Diariamente')) score += 10;
  else score += 5;

  // Compromiso
  if (empieza(compromiso, 'Sí')) score += 20;
  else if (empieza(compromiso, 'No tengo')) forzadores.push('P6c');
  // 'Voy...' → 0

  // Forzador: el primero en orden P2c, P3c, P6c (el orden de push ya lo respeta)
  if (forzadores.length > 0) {
    const forzador = forzadores[0];
    return { score, forzador, pantalla: 'C', variante: `C-${forzador}` };
  }

  if (score >= 80) {
    let variante = 'A-Limpia';
    if (empieza(inversion, 'Me importa')) variante = 'A-Cuotas';
    else if (empieza(inversion, 'Tengo otras')) variante = 'A-Nurture';
    return { score, forzador: '', pantalla: 'A', variante };
  }

  if (score >= 40) {
    const contacto = empieza(compromiso, 'Sí') && empieza(inversion, 'Sí');
    const pantalla = contacto ? 'B-CONTACTO' : 'B-AUTO';
    return { score, forzador: '', pantalla, variante: pantalla };
  }

  return { score, forzador: '', pantalla: 'C', variante: 'C-ScoreBajo' };
}

/** Letra de tier que consume dispatchPostTest, o null si la pantalla no es válida. */
export function tierParaEnvio(pantalla: string | undefined | null): TierEnvio | null {
  const p = clean(pantalla);
  if (p === 'A') return 'A';
  if (p === 'B-CONTACTO' || p === 'B-AUTO') return 'B';
  if (p === 'C') return 'C';
  return null;
}

// ─── Datos para los mails post-test (mismos prefijos que el scoring) ──

export interface RespuestasMail {
  edad?: string;
  ereccion?: string;
  salud?: string;
  pareja?: string;
}

/** true si el lead respondió que en solitario la erección funciona ("Sí…"). */
export function ereccionSoloOk(r: RespuestasMail | undefined | null): boolean {
  return empieza(clean(r?.ereccion), 'Sí');
}

export type FactorB = 'fisico' | 'vinculo';

/**
 * Factor dominante que hace B a un lead, para la frase del mail B (24/09/2026):
 *   'fisico'  → erección "A veces" en solitario, enfermedad o 50+ (se revisa en la consulta)
 *   'vinculo' → pareja con conflicto / sin estabilidad, sin factor físico
 *   null      → sin datos o sin factor reconocible (mail B sin frase extra)
 */
export function factorTierB(r: RespuestasMail | undefined | null): FactorB | null {
  if (!r) return null;
  const edad = clean(r.edad);
  const ereccion = clean(r.ereccion);
  const salud = clean(r.salud);
  const pareja = clean(r.pareja);
  const fisico =
    empieza(ereccion, 'A veces') || empieza(salud, 'Tengo enfermedad') || (edad !== '' && !empieza(edad, '18'));
  if (fisico) return 'fisico';
  const parejaOk = pareja === '' || empieza(pareja, 'No tengo') || empieza(pareja, 'Tengo pareja estable y');
  return parejaOk ? null : 'vinculo';
}
