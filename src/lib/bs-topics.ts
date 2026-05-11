// Behind-the-scenes topics for weekly LinkedIn mini-interview.
// Each topic is the seed for one weekly email with 4-5 specific questions.
// Responses accumulate in Vercel KV (`bs:dossier:<id>`) and feed all future
// LinkedIn post generation as authentic context — no inventing process data.

export interface BsTopic {
  id: string;
  label: string;
  questions: string[];
}

export const BS_TOPICS: BsTopic[] = [
  {
    id: 'proceso-guion',
    label: 'Cómo escribís un guión de YouTube',
    questions: [
      '¿Qué disparó el último guión que terminaste (paciente, comentario, paper, idea propia)?',
      '¿Cuánto tiempo te llevó del concepto al guión final, y cuál fue la parte más lenta?',
      '¿Qué parte del guión (hook, bloques, café, bibliografía) te trabás más y cómo la resolvés?',
      '¿Qué cambiaste en tu forma de guionar en los últimos meses?',
      '¿Cuál es un "no" que aplicás siempre al escribir (algo que ya no hacés)?',
    ],
  },
  {
    id: 'embudo-conversion',
    label: 'Embudo: cómo capturás y convertís leads',
    questions: [
      '¿Qué fuente de leads te dio más resultados este mes y por qué creés que funcionó?',
      '¿Qué probaste recientemente que sorprendió (para bien o para mal)?',
      '¿Dónde ves la mayor fricción / leak hoy en el embudo?',
      '¿Qué cambio chico tuvo el impacto más grande recientemente?',
    ],
  },
  {
    id: 'automatizaciones',
    label: 'Stack de automatizaciones (ManyChat, Brevo, Nexo-mail)',
    questions: [
      '¿Qué automatización te ahorra más tiempo concreto cada semana?',
      '¿Cuál fue el último problema que resolviste automatizando algo?',
      '¿Qué cosa todavía hacés a mano y te molesta?',
      '¿Qué automatización fracasó y por qué decidiste sacarla?',
    ],
  },
  {
    id: 'edicion-video',
    label: 'Edición de videos y decisiones visuales',
    questions: [
      '¿Quién edita los videos actualmente y cómo es el flujo entre vos y el editor?',
      '¿Qué decisión de edición creés que más impacta retención?',
      '¿Qué cambiaste en edición en los últimos 6 meses?',
      '¿Qué probás cuando un video no rinde lo esperado?',
    ],
  },
  {
    id: 'decisiones-canal',
    label: 'Decisiones de canal: qué sí, qué no',
    questions: [
      '¿Qué tema descartaste recientemente y por qué?',
      '¿Cómo decidís el orden de los próximos videos?',
      '¿Qué señal usás para saber que un tema vale el esfuerzo?',
      '¿Algo que harías muy distinto si arrancaras el canal hoy?',
    ],
  },
  {
    id: 'monetizacion',
    label: 'De dónde vienen los ingresos hoy',
    questions: [
      '¿Cuál es la mayor fuente de ingresos hoy y cuál querés que sea en 12 meses?',
      '¿Qué experimento de monetización funcionó mejor de lo esperado?',
      '¿Qué probaste que no funcionó y qué aprendiste?',
      '¿Cómo balanceás precio bajo vs. valor percibido?',
    ],
  },
  {
    id: 'gestion-tiempo',
    label: 'Gestionar tiempo entre clínica y contenido',
    questions: [
      '¿Cómo dividís una semana típica entre clínica y creación?',
      '¿Qué energía te requiere cada actividad y cómo equilibrás?',
      '¿Qué dejaste de hacer para sostener este ritmo?',
      '¿Qué hábito chico cambió todo?',
    ],
  },
  {
    id: 'herramientas-ia',
    label: 'Cómo usás IA realmente en tu trabajo',
    questions: [
      '¿Para qué SÍ usás IA (sin filtros, con casos concretos)?',
      '¿Para qué NO la usás y por qué?',
      '¿Qué workflow con IA cambió cómo trabajás en el último tiempo?',
      '¿Dónde te decepcionó la IA?',
    ],
  },
  {
    id: 'eleccion-temas',
    label: 'De dónde sacás los temas de contenido',
    questions: [
      '¿Qué señal te dice que un tema va a funcionar?',
      '¿Cuál fue el último tema que te sorprendió por desempeño?',
      '¿Cómo decidís entre un tema viral vs. uno educativo de nicho?',
      '¿Qué tema fue gran riesgo y salió bien?',
    ],
  },
  {
    id: 'comunidad',
    label: 'Relación con la audiencia',
    questions: [
      '¿Qué pregunta te repiten más los seguidores últimamente?',
      '¿Qué te enseñaron tus seguidores en el último tiempo?',
      '¿Cómo cambia tu enfoque para audiencia general vs. profesionales (médicos, marketing salud)?',
      '¿Qué interacción con un seguidor te marcó este mes?',
    ],
  },
];

export interface BsEntry {
  topicId: string;
  date: string; // ISO
  answers: Array<{ question: string; answer: string }>;
}
