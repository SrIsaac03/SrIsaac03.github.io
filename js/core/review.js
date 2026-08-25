// Etapa 6 del motor: REVISIÓN DE CARTERA. Analiza la tendencia de cada activo
// que el usuario YA tiene y dicta un veredicto explicable: vender, reducir,
// mantener o reforzar.
//
// Principio: nunca se vende por haber perdido dinero, sino porque la tendencia
// del activo se ha roto o porque la posición se ha desequilibrado respecto al
// perfil. Vender por miedo a la pérdida es exactamente lo que el test detecta
// como sesgo (q1), no lo que el motor debe amplificar.
// Puro y determinista: mismas entradas → mismas salidas.

import { DEFAULT_PARAMS } from './engine.js';

export const VERDICTS = {
  vender:   { id: 'vender',   label: 'Vender',    tone: 'critical' },
  reducir:  { id: 'reducir',  label: 'Reducir',   tone: 'warning' },
  mantener: { id: 'mantener', label: 'Mantener',  tone: 'neutral' },
  reforzar: { id: 'reforzar', label: 'Reforzar',  tone: 'good' },
  sin_datos:{ id: 'sin_datos',label: 'Sin datos', tone: 'muted' },
};

const SEVERITY = { sin_datos: -1, reforzar: 0, mantener: 0, reducir: 2, vender: 3 };

// Índice de salud 0-100 del activo, para el medidor visual. Es un resumen
// continuo y monótono de los mismos factores que dictan el veredicto: sirve
// para comparar posiciones de un vistazo, no para decidir por sí solo.
export function healthScore(state, params = DEFAULT_PARAMS) {
  if (!state || state.rsi == null || state.vol == null) return null;
  const { regime, rsi, vol, drawdown, momentum } = state;
  let health = 50;
  health += regime === 'alcista' ? 22 : regime === 'bajista' ? -28 : 0;
  if (momentum != null) health += Math.max(-18, Math.min(18, momentum * 90));
  if (drawdown != null) health += Math.max(-22, Math.min(0, drawdown * 80));
  health += vol > params.volExtreme ? -12 : vol > params.volHigh ? -6 : 4;
  if (regime === 'alcista' && rsi > params.rsiOverbought) health -= 4;
  return Math.round(Math.max(0, Math.min(100, health)));
}

const pct = x => (x == null ? '—' : (x * 100).toFixed(1) + '%');
const round1 = x => Math.round(x * 10) / 10;

// Tope de peso (% del capital) admisible para una posición. Un ETF indexado ya
// diversifica por dentro, así que no se le aplica el límite de una acción suelta.
export function capForAsset(asset, category, preferences) {
  const base = category.maxPosPct * (preferences?.maxPosFactor ?? 1);
  return asset?.core ? Math.min(100, base * 3) : base;
}

// position: snapshot de holdings.js · state: SeriesAnalyzer.stateAt(i) del activo
export function reviewHolding({ position, asset, state, capPct, preferences, params = DEFAULT_PARAMS }) {
  const reasons = [];
  const info = [];

  if (!state || state.rsi == null) {
    return {
      assetId: position.assetId,
      verdict: 'sin_datos', urgency: 0,
      health: null,
      targetPct: round1(position.capitalPct),
      reasons: ['No hay histórico suficiente de este activo para evaluar su tendencia.'],
    };
  }

  let verdict = 'mantener';
  let urgency = 0;
  let targetPct = round1(position.capitalPct);

  const escalate = (v, u, target, reason) => {
    reasons.push(reason);
    if (SEVERITY[v] > SEVERITY[verdict]) { verdict = v; urgency = u; targetPct = round1(target); }
  };

  const { regime, momentum: mom, vol, drawdown: dd, rsi } = state;
  const deepValue = dd != null && dd < params.ddDeep && rsi < params.rsiOversold;

  // --- 1. Ruptura de tendencia: el criterio de venta principal ---
  if (regime === 'bajista') {
    if (deepValue && preferences?.allowContrarianDCA) {
      info.push(`Tendencia bajista, pero la caída es profunda (${pct(dd)}) y el RSI ${rsi.toFixed(0)} marca sobreventa. En el test dijiste que ves las caídas fuertes como oportunidad: mantener y, si acaso, promediar poco a poco.`);
      urgency = Math.max(urgency, 1);
    } else if (mom != null && mom < 0) {
      escalate('vender', 3, 0,
        `Ruptura de tendencia: el precio está por debajo de su media de ${params.smaLong} sesiones y el momentum a 12 meses es negativo (${pct(mom)}).`);
    } else {
      escalate('reducir', 2, position.capitalPct / 2,
        `Tendencia bajista: el precio ha perdido su media de ${params.smaLong} sesiones. Reducir a la mitad y esperar a que la recupere.`);
    }
  }

  // --- 2. Stop de riesgo: caída profunda sin tendencia que la sostenga ---
  if (dd != null && dd < -0.25 && regime !== 'alcista' && !(deepValue && preferences?.allowContrarianDCA)) {
    escalate('reducir', 2, position.capitalPct / 2,
      `Acumula una caída del ${pct(Math.abs(dd))} desde sus máximos de 52 semanas sin haber recuperado la tendencia.`);
  }

  // --- 3. Volatilidad desproporcionada para lo que respondiste ---
  if (vol != null && vol > params.volExtreme) {
    escalate('reducir', 2, Math.min(position.capitalPct, capPct / 2),
      `Volatilidad extrema (${pct(vol)} anualizada): la posición mueve tu cartera más de lo que justifica su peso.`);
  } else if (vol != null && preferences && vol > preferences.volCap && position.capitalPct > capPct / 2) {
    escalate('reducir', 1, capPct / 2,
      `Su volatilidad (${pct(vol)}) supera el techo del ${pct(preferences.volCap)} que se deduce de tus respuestas sobre riesgo y ansiedad.`);
  }

  // --- 4. Sobreconcentración respecto a tu perfil ---
  if (position.capitalPct > capPct * 1.5) {
    escalate('reducir', 2, capPct,
      `Concentración: esta posición pesa un ${round1(position.capitalPct)}% de tu capital, muy por encima del ${round1(capPct)}% máximo de tu perfil.`);
  }

  // --- 5. Toma de beneficios (solo si además sobra peso) ---
  if (regime === 'alcista' && rsi > 78 && position.pnlPct != null && position.pnlPct > 0.30 &&
      position.capitalPct > capPct) {
    escalate('reducir', 1, capPct,
      `Llevas un ${pct(position.pnlPct)} de ganancia y el RSI ${rsi.toFixed(0)} está muy sobrecomprado: vale la pena recoger parte y volver a tu peso objetivo.`);
  }

  // --- 6. Refuerzo: solo si nada anterior ha saltado ---
  if (verdict === 'mantener' && regime === 'alcista' && mom != null && mom > 0 &&
      position.capitalPct < capPct * 0.6) {
    verdict = 'reforzar';
    targetPct = round1(capPct);
    reasons.push(`Tendencia alcista con momentum ${pct(mom)} y solo pesa un ${round1(position.capitalPct)}% de tu capital: hay margen hasta tu tope del ${round1(capPct)}%.`);
  }

  if (!reasons.length) {
    reasons.push(regime === 'alcista'
      ? `Tendencia alcista y peso dentro de tu objetivo: nada que tocar.`
      : `Tendencia en transición: señales mixtas, pero sin motivo para deshacer la posición.`);
  }

  // Informativo, nunca motor de la decisión: qué implica vender ahora.
  if (verdict === 'vender' || verdict === 'reducir') {
    if (position.pnlPct != null) {
      info.push(position.pnlPct >= 0
        ? `Vender materializaría una ganancia del ${pct(position.pnlPct)} (recuerda su tributación).`
        : `Vender materializaría una pérdida del ${pct(Math.abs(position.pnlPct))}. La decisión se basa en la tendencia, no en el precio al que compraste.`);
    }
  }

  return {
    assetId: position.assetId,
    verdict, urgency,
    health: healthScore(state, params),
    targetPct,
    reduceByPct: round1(Math.max(0, position.capitalPct - targetPct)),
    reasons, info,
    state: { regime, rsi, vol, momentum: mom, drawdown: dd },
  };
}

// Revisión completa: veredicto por posición + alertas de cartera.
// ctx: { snapshot, assetOf(id), stateOf(id), category, preferences, params, targetEquityPct }
export function reviewPortfolio(ctx) {
  const { snapshot, assetOf, stateOf, category, preferences, params = DEFAULT_PARAMS, targetEquityPct } = ctx;

  const reviews = snapshot.positions.map(position => {
    const asset = assetOf(position.assetId);
    return reviewHolding({
      position, asset,
      state: stateOf(position.assetId),
      capPct: capForAsset(asset, category, preferences),
      preferences, params,
    });
  });

  const alerts = [];

  // Deriva respecto a la exposición objetivo de hoy (perfil + semáforo)
  if (targetEquityPct != null && snapshot.totalValue > 0) {
    const diff = snapshot.investedPct - targetEquityPct;
    if (diff > 10) {
      alerts.push({ level: 'warn', text: `Tienes un ${round1(snapshot.investedPct)}% de tu capital invertido y hoy tu objetivo es ${targetEquityPct}%. Sobra exposición: considera bajar ${round1(diff)} puntos, empezando por las posiciones marcadas para vender o reducir.` });
    } else if (diff < -10) {
      alerts.push({ level: 'info', text: `Estás al ${round1(snapshot.investedPct)}% de capital invertido, por debajo del ${targetEquityPct}% objetivo de hoy: tienes margen para las recomendaciones de compra.` });
    }
  }

  // Concentración por clase de activo
  for (const [cls, weight] of Object.entries(snapshot.byClass)) {
    if (weight > 60 && snapshot.positions.length > 1) {
      alerts.push({ level: 'warn', text: `El ${round1(weight)}% de tu cartera está en una sola clase de activo (${cls}). Si esa clase corrige, se lo lleva casi todo.` });
    }
  }

  // Diversificación mínima según lo que respondiste en el test
  if (preferences && snapshot.positions.length > 0 && snapshot.positions.length < preferences.minPositions) {
    alerts.push({ level: 'info', text: `Tienes ${snapshot.positions.length} ${snapshot.positions.length === 1 ? 'posición' : 'posiciones'}. Por tus respuestas sobre experiencia y tolerancia al riesgo, te conviene repartir en al menos ${preferences.minPositions}.` });
  }

  // Activos que el test desaconseja pero siguen en cartera
  if (preferences?.excludeClasses.length) {
    const held = new Set(snapshot.positions.map(p => p.assetClass));
    for (const cls of preferences.excludeClasses) {
      if (held.has(cls)) {
        alerts.push({ level: 'warn', text: `Mantienes posiciones de tipo «${cls}», que tus respuestas al test desaconsejan. No te propondremos comprar más de esta clase.` });
      }
    }
  }

  const counts = reviews.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});

  // Salud de la cartera: media de las posiciones ponderada por su valor
  let wSum = 0, hSum = 0;
  for (const r of reviews) {
    if (r.health == null) continue;
    const p = snapshot.positions.find(x => x.assetId === r.assetId);
    const w = p?.valueOrCost || 0;
    hSum += r.health * w; wSum += w;
  }
  const health = wSum > 0 ? Math.round(hSum / wSum) : null;

  return { reviews, alerts, counts, health, snapshot };
}
