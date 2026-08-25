// Preferencias derivadas de las RESPUESTAS del test, no solo de su puntuación.
// El test completo se guarda en el dispositivo (profile.answers): aquí lo
// traducimos a decisiones concretas sobre QUÉ comprar y qué evitar, con una
// explicación legible de qué respuesta ha provocado cada regla.
// Puro y determinista: mismas respuestas → mismas preferencias.

// Cada respuesta Likert (0..4) se normaliza a 0..1. Sin respuesta → 0.5 (neutro).
function ans(answers, id) {
  const v = answers?.[id];
  if (v == null || Number.isNaN(Number(v))) return 0.5;
  return Math.max(0, Math.min(4, Number(v))) / 4;
}

export const TILTS = {
  defensivo: { id: 'defensivo', name: 'Defensivo', volCap: 0.20 },
  equilibrado: { id: 'equilibrado', name: 'Equilibrado', volCap: 0.32 },
  crecimiento: { id: 'crecimiento', name: 'Crecimiento', volCap: 0.50 },
};

export function derivePreferences(answers) {
  const q = id => ans(answers, id);

  // Rasgos compuestos (0..1)
  const anxiety = (q('q4') + q('q1')) / 2;          // ansiedad diaria + venta en pánico
  const safety = (q('q5') + (1 - q('q2'))) / 2;     // preferencia por lo seguro
  const knowledge = (q('q11') + q('q6')) / 2;       // entiende ETFs + ha invertido antes
  const contrarian = (q('q9') + q('q12')) / 2;      // aguanta o compra en las caídas
  const cushion = (q('q8') + q('q7')) / 2;          // fondo de emergencia + ingresos estables
  const shortNeed = q('q10');                       // necesita el dinero en 3 años
  const longHorizon = q('q3');

  const horizon = shortNeed > 0.5 ? 'corto' : longHorizon > 0.5 ? 'largo' : 'medio';

  // Sesgo de cartera: cuánto puede tirar hacia crecimiento sin traicionar el test
  const tiltScore =
    (1 - anxiety) * 0.30 + (1 - safety) * 0.30 + contrarian * 0.20 + cushion * 0.10 +
    (horizon === 'largo' ? 0.10 : horizon === 'corto' ? -0.10 : 0);
  const tilt = tiltScore < 0.40 ? 'defensivo' : tiltScore < 0.65 ? 'equilibrado' : 'crecimiento';

  const notes = [];
  const excludeClasses = [];

  // --- Exclusiones duras: activos que no encajan con lo que respondiste ---
  if (horizon === 'corto') {
    excludeClasses.push('crypto');
    notes.push({ from: 'q10', text: 'Dijiste que necesitarás este dinero en los próximos 3 años: descartamos cripto y priorizamos activos poco volátiles.' });
  } else if (knowledge < 0.5) {
    excludeClasses.push('crypto');
    notes.push({ from: 'q11', text: 'Por tus respuestas sobre experiencia y conocimiento de ETFs, dejamos fuera la cripto hasta que te sientas cómodo con lo básico.' });
  } else if (anxiety > 0.75) {
    excludeClasses.push('crypto');
    notes.push({ from: 'q4', text: 'Marcaste que seguir tus inversiones a diario te genera ansiedad: la cripto queda fuera por su volatilidad.' });
  }

  // --- Preferencias blandas: ordenan y puntúan las opciones, no las prohíben ---
  let volCap = TILTS[tilt].volCap;
  if (horizon === 'corto') volCap = Math.min(volCap, 0.18);
  if (anxiety > 0.7) {
    volCap = Math.min(volCap, 0.22);
    notes.push({ from: 'q1', text: `Tiendes a vender en las caídas, así que limitamos la volatilidad de lo que te proponemos al ${Math.round(volCap * 100)}% anualizado.` });
  }

  const preferDiversified = knowledge < 0.6 || anxiety > 0.6;
  if (preferDiversified) {
    notes.push({ from: 'q11', text: 'Priorizamos ETFs indexados sobre acciones sueltas: diversifican por ti y exigen menos seguimiento.' });
  }

  // Menos colchón o ingresos inestables → posiciones más pequeñas
  const maxPosFactor = cushion < 0.4 ? 0.7 : anxiety > 0.7 ? 0.8 : 1;
  if (cushion < 0.4) {
    notes.push({ from: 'q8', text: 'Sin un fondo de emergencia sólido reducimos el tamaño de cada posición: primero el colchón, después la bolsa.' });
  }

  if (contrarian > 0.6) {
    notes.push({ from: 'q9', text: 'Aguantaste (o compraste) en las caídas anteriores: en desplomes profundos te propondremos promediar en vez de vender.' });
  }

  return {
    anxiety, safety, knowledge, contrarian, cushion, horizon,
    tilt, tiltScore,
    volCap,
    preferDiversified,
    excludeClasses,
    minPositions: preferDiversified ? 4 : 3,
    maxPosFactor,
    allowContrarianDCA: contrarian > 0.6,
    notes,
  };
}

// Preferencias neutras: para usuarios sin test guardado (no debería ocurrir,
// el test es obligatorio, pero el motor no debe romperse por ello).
export function neutralPreferences() {
  return derivePreferences({});
}

// ¿Este activo está permitido por las respuestas del test?
export function allowsAsset(preferences, asset) {
  if (!preferences || !asset) return true;
  return !preferences.excludeClasses.includes(asset.assetClass);
}
