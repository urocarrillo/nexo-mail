/**
 * Generación de borradores de follow-up con el tono de Mauro.
 * Sin frases prohibidas (sin "Dr.", sin "sin spam", sin invitar a responder).
 */

export interface BorradorInput {
  nombre: string;          // Primer nombre del participante
  tipo: 'd7' | 'd30';
  diasDesdeSesion: number;
  fechaSesionFmt?: string; // ej. "el jueves pasado" o "hace 9 días"
  notas?: string;          // Notas internas (no se usan en el cuerpo, solo contexto)
}

export interface Borrador {
  subject: string;
  body: string;
}

function firstName(full: string): string {
  return (full || '').trim().split(/\s+/)[0] || '';
}

export function generarBorrador(input: BorradorInput): Borrador {
  const nombre = firstName(input.nombre);

  if (input.tipo === 'd7') {
    return generarD7(nombre, input.diasDesdeSesion);
  }
  return generarD30(nombre, input.diasDesdeSesion);
}

function generarD7(nombre: string, dias: number): Borrador {
  const refTiempo = dias <= 8 ? 'pasaron unos días desde nuestra sesión'
                  : dias <= 14 ? 'pasó algo más de una semana desde nuestra sesión'
                  : 'pasaron un par de semanas desde nuestra sesión';
  return {
    subject: `¿Cómo seguís, ${nombre}?`,
    body: `Hola ${nombre},

Quería saber cómo estás. ${refTiempo} 1 a 1 y me quedé pensando en algunas cosas que charlamos.

No es un mail de seguimiento estándar — me importa de verdad cómo te está yendo con las herramientas. ¿Pudiste probar algo? ¿Te trabó algo concreto?

Si querés conversarlo, agendamos otra sesión cuando vos quieras.

Un abrazo,

Mauro
Urólogo Mauro Carrillo
urologia.ar`,
  };
}

function generarD30(nombre: string, _dias: number): Borrador {
  return {
    subject: `Pasó un mes — ¿cómo estás, ${nombre}?`,
    body: `Hola ${nombre},

Pasó un mes desde nuestra sesión y te escribo para ver cómo seguiste.

Después de un mes ya hay tiempo de haber probado las herramientas en distintas situaciones. A veces aparecen avances, a veces aparecen preguntas nuevas. Si tenés algo para contarme o ajustar, podemos coordinar una sesión.

Un abrazo,

Mauro
Urólogo Mauro Carrillo
urologia.ar`,
  };
}
