// Test psicométrico de perfilado de riesgo (único método de perfilado del sistema).
// 12 ítems tipo Likert (0-4). risk_score = 0..100. Categorías con bandas de renta variable.

export const QUESTIONS = [
  { id: 'q1', text: 'Si mi cartera cayera un 20% en un mes, vendería para evitar más pérdidas.', reverse: true },
  { id: 'q2', text: 'Estoy dispuesto a aceptar pérdidas temporales importantes a cambio de mayor rentabilidad a largo plazo.' },
  { id: 'q3', text: 'Mi horizonte de inversión es superior a 10 años.' },
  { id: 'q4', text: 'Comprobar el valor de mis inversiones a diario me genera ansiedad.', reverse: true },
  { id: 'q5', text: 'Prefiero una rentabilidad segura del 3% antes que una probable del 8% con riesgo de pérdida.', reverse: true },
  { id: 'q6', text: 'He invertido antes en renta variable (acciones, ETFs, fondos de bolsa).' },
  { id: 'q7', text: 'Mis ingresos mensuales son estables y predecibles.' },
  { id: 'q8', text: 'Dispongo de un fondo de emergencia de al menos 6 meses de gastos.' },
  { id: 'q9', text: 'Si un activo que tengo cae un 30%, lo vería como oportunidad de comprar más.' },
  { id: 'q10', text: 'Necesitaré disponer de este dinero en los próximos 3 años.', reverse: true },
  { id: 'q11', text: 'Entiendo cómo funcionan los ETFs, la diversificación y el interés compuesto.' },
  { id: 'q12', text: 'En 2020 (COVID) o 2022, mantuve o aumenté mis inversiones durante las caídas.' },
];

export const LIKERT = ['Totalmente en desacuerdo', 'En desacuerdo', 'Neutral', 'De acuerdo', 'Totalmente de acuerdo'];

export const CATEGORIES = [
  { id: 'conservador', name: 'Conservador', min: 0, max: 34, equityRange: [15, 35], maxPosPct: 5 },
  { id: 'moderado', name: 'Moderado', min: 35, max: 54, equityRange: [35, 55], maxPosPct: 8 },
  { id: 'dinamico', name: 'Dinámico', min: 55, max: 74, equityRange: [55, 75], maxPosPct: 12 },
  { id: 'agresivo', name: 'Agresivo', min: 75, max: 100, equityRange: [75, 95], maxPosPct: 15 },
];

// answers: { q1: 0..4, ... } → { score, category }
export function scoreTest(answers) {
  let total = 0, n = 0;
  for (const q of QUESTIONS) {
    let v = answers[q.id];
    if (v == null) continue;
    v = Math.max(0, Math.min(4, v));
    if (q.reverse) v = 4 - v;
    total += v; n++;
  }
  if (n < QUESTIONS.length) throw new Error(`Test incompleto: ${n}/${QUESTIONS.length} respuestas`);
  const score = Math.round((total / (QUESTIONS.length * 4)) * 100);
  const category = CATEGORIES.find(c => score >= c.min && score <= c.max) || CATEGORIES[0];
  return { score, category };
}

// Bandas de capital/ingresos (privacidad: nunca pedimos el importe exacto).
export const CAPITAL_BANDS = [
  { id: 'c1', label: '< 1.000 €', mid: 500 },
  { id: 'c2', label: '1.000 – 5.000 €', mid: 3000 },
  { id: 'c3', label: '5.000 – 20.000 €', mid: 12500 },
  { id: 'c4', label: '20.000 – 50.000 €', mid: 35000 },
  { id: 'c5', label: '50.000 – 150.000 €', mid: 100000 },
  { id: 'c6', label: '> 150.000 €', mid: 200000 },
];

export const INCOME_BANDS = [
  { id: 'i1', label: '< 1.200 €/mes', mid: 1000 },
  { id: 'i2', label: '1.200 – 2.000 €/mes', mid: 1600 },
  { id: 'i3', label: '2.000 – 3.500 €/mes', mid: 2750 },
  { id: 'i4', label: '3.500 – 6.000 €/mes', mid: 4750 },
  { id: 'i5', label: '> 6.000 €/mes', mid: 7500 },
];
