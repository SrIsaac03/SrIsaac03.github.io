// Motor analítico "Copiloto de Inversión" — pipeline de 5 etapas:
//   1. MARKET STATE  → régimen e indicadores por activo/índice
//   2. ALLOCATION    → porcentajes de capital/ingresos (nunca importes fijos)
//   3. ELIGIBILITY   → filtro duro por catálogo del bróker del usuario
//   4. TIMING GATE   → ¿ahora o esperar en liquidez? (semáforo)
//   5. PERSONALIZE   → ajustes por historial de aceptados/rechazados
// Todas las funciones son puras y deterministas: mismas entradas → mismas salidas.

import { sma, rsi, rollingVolatility, drawdownFromHigh, momentum12m1, lastNonNull } from './indicators.js';
import { brokerTerms } from './brokers.js';
import { computeFeedbackAdjustments, isSuppressed } from './feedback.js';

// Parámetros del algoritmo. Los valores por defecto son los ganadores del
// backtest 1990-2010 validado en 2011-2022 (ver backtest/REPORT.md).
export const DEFAULT_PARAMS = {
  smaLong: 200,        // media larga para tendencia
  smaShort: 50,        // media corta
  rsiPeriod: 14,
  rsiOverbought: 70,   // por encima: sobrecompra → prudencia
  rsiOversold: 35,     // por debajo en tendencia bajista profunda: entrada escalonada
  volWindow: 30,
  volHigh: 0.25,       // volatilidad anualizada "alta"
  volExtreme: 0.40,    // volatilidad de pánico
  ddDeep: -0.30,       // caída profunda desde máximos (oportunidad contrarian con DCA)
  topN: 5,             // nº de activos candidatos por recomendación
  fwdHorizon: 63,      // horizonte de evaluación (~3 meses de sesiones)
};

// ---------- Etapa 1: MARKET STATE ----------

export class SeriesAnalyzer {
  constructor(values, params = DEFAULT_PARAMS) {
    this.values = values;
    this.params = params;
    this.smaL = sma(values, params.smaLong);
    this.smaS = sma(values, params.smaShort);
    this.rsi = rsi(values, params.rsiPeriod);
    this.vol = rollingVolatility(values, params.volWindow);
    this.dd = drawdownFromHigh(values, 252);
    // último índice con dato real (las series pueden traer cola de nulls si
    // su fuente de actualización falló una noche)
    this.lastValid = values.length - 1;
    while (this.lastValid > 0 && values[this.lastValid] == null) this.lastValid--;
  }

  stateAt(i) {
    const price = lastNonNull(this.values, i);
    const smaL = this.smaL[i], smaS = this.smaS[i];
    if (price == null || smaL == null || smaS == null) return null;
    const aboveLong = price > smaL;
    const shortAboveLong = smaS > smaL;
    let regime;
    if (aboveLong && shortAboveLong) regime = 'alcista';
    else if (!aboveLong && !shortAboveLong) regime = 'bajista';
    else regime = 'transicion';
    return {
      price, regime,
      rsi: this.rsi[i],
      vol: this.vol[i],
      drawdown: this.dd[i],
      momentum: momentum12m1(this.values, i),
      distSmaLong: price / smaL - 1,
    };
  }
}

// ---------- Etapa 4: TIMING GATE (semáforo) ----------
// Se define antes que la asignación porque el % invertido depende del semáforo.
// Devuelve { signal: 'green'|'amber'|'red', mode, reasons: [...] }

export function timingSignal(state, params = DEFAULT_PARAMS, timingCaution = 0) {
  if (!state || state.rsi == null || state.vol == null) return null;
  const reasons = [];
  let signal;

  if (state.regime === 'alcista') {
    signal = 'green';
    reasons.push(`Tendencia alcista: precio un ${pct(state.distSmaLong)} sobre su media de ${params.smaLong} sesiones`);
    if (state.rsi > params.rsiOverbought) {
      signal = 'amber';
      reasons.push(`RSI ${state.rsi.toFixed(0)} en sobrecompra (>${params.rsiOverbought}): mejor entrada escalonada`);
    }
    if (state.vol > params.volHigh) {
      signal = signal === 'green' ? 'amber' : signal;
      reasons.push(`Volatilidad elevada (${pct(state.vol)} anualizada)`);
    }
    if (state.vol > params.volExtreme) {
      signal = 'red';
      reasons.push(`Volatilidad extrema (${pct(state.vol)}): esperar en liquidez`);
    }
  } else if (state.regime === 'bajista') {
    signal = 'red';
    reasons.push(`Tendencia bajista: precio bajo su media de ${params.smaLong} sesiones`);
    if (state.drawdown != null && state.drawdown < params.ddDeep && state.rsi < params.rsiOversold) {
      signal = 'amber';
      reasons.push(`Caída profunda (${pct(state.drawdown)}) con RSI ${state.rsi.toFixed(0)}: se permite entrada escalonada (DCA), no de golpe`);
    }
  } else {
    signal = 'amber';
    reasons.push('Tendencia en transición: señales mixtas, entrada escalonada prudente');
    if (state.vol > params.volExtreme) {
      signal = 'red';
      reasons.push(`Volatilidad extrema (${pct(state.vol)})`);
    }
  }

  // La cautela aprendida del feedback puede degradar un verde a ámbar
  if (timingCaution >= 0.3 && signal === 'green') {
    signal = 'amber';
    reasons.push('Ajuste por tu historial: has rechazado señales por timing, aplicamos más prudencia');
  }
  const mode = signal === 'green' ? 'invertir' : signal === 'amber' ? 'escalonar' : 'esperar';
  return { signal, mode, reasons };
}

// ---------- Etapa 1b: ranking de activos (momentum ajustado por riesgo) ----------

export function rankAssets(candidates, i, adjustments) {
  const scored = [];
  for (const c of candidates) {
    // cada serie se evalúa como muy tarde en su último dato real (cripto tiene
    // su propio calendario; una acción con actualización fallida no desaparece)
    const ci = Math.min(i, c.analyzer.lastValid);
    const st = c.analyzer.stateAt(ci);
    if (!st || st.momentum == null || st.vol == null || st.vol === 0) continue;
    if (adjustments && isSuppressed(adjustments, c.asset.id)) continue;
    // momentum 12-1 dividido por volatilidad: favorece subidas sostenidas y tranquilas
    let score = st.momentum / Math.max(st.vol, 0.08);
    if (adjustments) {
      score += (adjustments.assetAdj.get(c.asset.id) || 0);
      score += (adjustments.classAdj.get(c.asset.assetClass) || 0);
    }
    scored.push({ asset: c.asset, state: st, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---------- Etapa 2: ALLOCATION (solo porcentajes) ----------

export function allocate({ category, riskScore, signal, topPicks, maxPosPct }) {
  const [eqMin, eqMax] = category.equityRange;
  // dentro de la banda del perfil, el semáforo decide el punto exacto
  const t = signal === 'green' ? 1 : signal === 'amber' ? 0.5 : 0;
  const equityPct = Math.round(eqMin + (eqMax - eqMin) * t);
  const liquidityPct = 100 - equityPct;
  const n = Math.max(topPicks.length, 1);
  const perPositionPct = Math.min(maxPosPct, Math.round((equityPct / n) * 10) / 10);
  // aportación mensual como % de ingresos según perfil y semáforo
  const dcaBase = 8 + Math.round(riskScore / 10); // 8%..18% de los ingresos
  const dcaPct = signal === 'red' ? 0 : signal === 'amber' ? Math.round(dcaBase / 2) : dcaBase;
  return { equityPct, liquidityPct, perPositionPct, dcaPct };
}

// ---------- Etapa 3: ELIGIBILITY (filtro por bróker) ----------

export function eligibilityFilter(rankedAssets, broker, positionEUR) {
  const eligible = [];
  for (const r of rankedAssets) {
    const terms = brokerTerms(broker, r.asset);
    if (!terms) continue; // el bróker no ofrece esta clase de activo
    if (positionEUR != null && positionEUR < terms.minOrder) continue;
    // coste total estimado de la operación en % (variable + fija + cambio de divisa)
    const costPct = terms.feeBps / 100 + terms.fxFeeBps / 100 +
      (positionEUR ? (terms.fixedFeeEUR / positionEUR) * 100 : 0);
    if (costPct > 1.5) continue; // el coste se come la ventaja esperada
    eligible.push({ ...r, terms, costPct: Math.round(costPct * 100) / 100 });
  }
  return eligible;
}

// ---------- Pipeline completo ----------
// ctx: { assets, seriesFor(asset)→analyzer, dateIndex, indexAnalyzer,
//        profile:{score,category}, capitalMid, incomeMid, broker, history, params }

export function generateRecommendations(ctx) {
  const p = ctx.params || DEFAULT_PARAMS;
  const i = ctx.dateIndex;

  // Etapa 5 primero: los ajustes personalizados alimentan al resto
  const adj = computeFeedbackAdjustments(ctx.history || [], ctx.now || Date.now());
  const effScore = Math.max(0, Math.min(100, ctx.profile.score + adj.riskShift));

  // Etapa 1: estado del mercado (índice = referencia macro del semáforo)
  const idxState = ctx.indexAnalyzer.stateAt(i);
  const timing = timingSignal(idxState, p, adj.timingCaution);
  if (!timing) return { timing: null, recommendations: [], marketState: idxState };

  // Etapa 1b: ranking del universo (ctx.seriesFor decide qué activos tienen
  // serie analizable: histórico empaquetado o descarga en vivo, p.ej. cripto)
  const candidates = ctx.assets
    .map(a => ({ asset: a, analyzer: ctx.seriesFor(a) }))
    .filter(c => c.analyzer);
  const ranked = rankAssets(candidates, i, adj);

  // Etapa 2: porcentajes según perfil efectivo + semáforo
  const category = ctx.profile.category;
  const preliminary = allocate({
    category, riskScore: effScore, signal: timing.signal,
    topPicks: ranked.slice(0, p.topN), maxPosPct: category.maxPosPct,
  });
  const positionEUR = ctx.capitalMid ? (ctx.capitalMid * preliminary.perPositionPct) / 100 : null;

  // Etapa 3: filtro duro por bróker (con el tamaño de posición estimado)
  const eligible = eligibilityFilter(ranked, ctx.broker, positionEUR).slice(0, p.topN);
  const alloc = allocate({
    category, riskScore: effScore, signal: timing.signal,
    topPicks: eligible, maxPosPct: category.maxPosPct,
  });

  // Construcción de recomendaciones explicables
  const recommendations = eligible.map(e => {
    const action = timing.signal === 'red' ? 'esperar' : 'comprar';
    const rationale = [
      `Momentum 12m ${pct(e.state.momentum)} con volatilidad ${pct(e.state.vol)} (puntuación ${e.score.toFixed(2)})`,
      `Régimen del activo: ${e.state.regime}`,
      `Disponible en tu bróker con coste estimado ${e.costPct}% por operación`,
      ...(e.terms.fractional ? [] : ['Tu bróker no permite fracciones: redondea a títulos enteros']),
    ];
    return {
      assetId: e.asset.id,
      name: e.asset.name,
      assetClass: e.asset.assetClass,
      action,
      percentOfCapital: alloc.perPositionPct,
      timing: timing.signal,
      rationale,
      terms: e.terms,
      state: { momentum: e.state.momentum, vol: e.state.vol, rsi: e.state.rsi, regime: e.state.regime },
    };
  });

  return {
    timing,
    marketState: idxState,
    allocation: alloc,
    effectiveRiskScore: effScore,
    adjustments: {
      riskShift: adj.riskShift,
      timingCaution: adj.timingCaution,
      suppressed: ctx.assets.filter(a => isSuppressed(adj, a.id)).map(a => a.id),
    },
    recommendations,
  };
}

function pct(x) {
  if (x == null) return '—';
  return (x * 100).toFixed(1) + '%';
}
