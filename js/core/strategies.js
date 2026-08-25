// Generador de OPCIONES de cartera. En lugar de una única cartera prefabricada,
// construye varias formas coherentes y distintas de aplicar hoy el mismo perfil
// y el mismo semáforo, para que el usuario elija con criterio.
//
// Todas las opciones respetan siempre: la banda de renta variable del perfil,
// el semáforo del día, el catálogo del bróker y las exclusiones del test.
// Lo que cambia entre ellas es QUÉ se compra y CÓMO se reparte.
// Puro y determinista.

import { analyzeUniverse, allocate, eligibilityFilter, DEFAULT_PARAMS } from './engine.js';

const round05 = x => Math.round(x * 2) / 2;
const round1 = x => Math.round(x * 10) / 10;
const pct = x => (x == null ? '—' : (x * 100).toFixed(1) + '%');

// Cada plantilla define su carácter: cuánto se desvía dentro de la banda del
// perfil (tiltAdj), en qué orden prefiere los candidatos y cómo los pondera.
// `minPicks` es su tamaño natural; puede crecer si el tope de concentración del
// perfil no permite desplegar la banda con tan pocas posiciones.
const BLUEPRINTS = [
  {
    id: 'nucleo',
    name: 'Núcleo indexado',
    tagline: 'Un ETF indexado como base y unos pocos satélites. La opción de menos mantenimiento.',
    tiltAdj: 0,
    tiltLevel: 0.45,
    minPicks: 3,
    order(pool) {
      // el indexado primero, luego el resto de ETFs, y ya después acciones
      const rank = c => (c.asset.core ? 0 : c.asset.assetClass === 'etf' ? 1 : 2);
      return [...pool].sort((a, b) => rank(a) - rank(b) || b.score - a.score);
    },
    weightOf: c => (c.asset.core ? 3 : 1),
    pros: ['Diversificación instantánea: el indexado ya contiene cientos de empresas.', 'Requiere revisarla pocas veces al año.'],
    cons: ['Difícilmente batirá al mercado: aspira a acompañarlo.'],
  },
  {
    id: 'defensiva',
    name: 'Defensiva',
    tagline: 'Los activos más tranquilos del universo y más capital en liquidez.',
    tiltAdj: -0.25,
    tiltLevel: 0.15,
    minPicks: 4,
    order(pool) {
      return [...pool].sort((a, b) =>
        (Number(b.asset.defensive || 0) - Number(a.asset.defensive || 0)) ||
        (a.state.vol - b.state.vol));
    },
    weightOf: c => 1 / Math.max(c.state.vol, 0.08),
    pros: ['Menor volatilidad: las caídas se sienten menos.', 'Deja más capital en liquidez para aprovechar caídas.'],
    cons: ['En mercados alcistas fuertes se quedará atrás.'],
  },
  {
    id: 'tendencia',
    name: 'Tendencia',
    tagline: 'Los activos con mejor momentum ajustado a su riesgo, según el motor.',
    tiltAdj: 0.25,
    tiltLevel: 0.85,
    minPicks: 3,
    order: pool => [...pool], // ya viene ordenado por puntuación del motor
    weightOf: c => Math.max(c.score, 0.1),
    pros: ['Se apoya en la señal que mejor puntúa el motor hoy.', 'Concentra en lo que ya está funcionando.'],
    cons: ['Más rotación: exige revisarla cada pocas semanas.', 'Los giros de tendencia le pillan dentro.'],
  },
  {
    id: 'reparto',
    name: 'Reparto amplio',
    tagline: 'Muchas posiciones pequeñas repartidas entre tipos de activo.',
    tiltAdj: 0,
    tiltLevel: 0.55,
    minPicks: 6,
    order(pool) {
      // ronda por clase de activo para no cargar todo en la misma
      const byClass = new Map();
      for (const c of pool) {
        if (!byClass.has(c.asset.assetClass)) byClass.set(c.asset.assetClass, []);
        byClass.get(c.asset.assetClass).push(c);
      }
      const queues = [...byClass.values()];
      const out = [];
      for (let round = 0; out.length < pool.length; round++) {
        let added = false;
        for (const q of queues) if (q[round]) { out.push(q[round]); added = true; }
        if (!added) break;
      }
      return out;
    },
    weightOf: () => 1,
    pros: ['Ningún activo concreto decide el resultado.', 'Reparte entre varias clases de activo.'],
    cons: ['Más órdenes = más comisiones.', 'Diluye también los aciertos.'],
  },
];

// Reparte `equityPct` entre las posiciones proporcionalmente a su peso,
// respetando el tope individual de cada activo. Lo que no cabe se queda en
// liquidez (nunca se fuerza por encima del tope del perfil).
function spread(items, equityPct, capOf) {
  const out = items.map(i => ({ ...i, pct: 0 }));
  let remaining = equityPct;
  for (let iter = 0; iter < 8 && remaining > 0.05; iter++) {
    const open = out.filter(o => o.pct < capOf(o) - 1e-9);
    if (!open.length) break;
    const totalW = open.reduce((s, o) => s + o.weight, 0) || open.length;
    let used = 0;
    for (const o of open) {
      const want = remaining * (o.weight / totalW);
      const give = Math.min(want, capOf(o) - o.pct);
      o.pct += give;
      used += give;
    }
    remaining -= used;
    if (used < 1e-9) break;
  }
  return out.map(o => ({ ...o, pct: round05(o.pct) })).filter(o => o.pct >= 0.5);
}

// Encaje de la opción con lo que el usuario respondió en el test (0..100).
// Sirve para ORDENAR y explicar, nunca para elegir por él.
function fitOf(strategy, preferences) {
  if (!preferences) return { score: 50, notes: [] };
  let score = 100;
  const notes = [];

  if (strategy.metrics.avgVol != null && strategy.metrics.avgVol > preferences.volCap) {
    score -= 30;
    notes.push({ ok: false, text: `Su volatilidad media (${pct(strategy.metrics.avgVol)}) supera el ${pct(preferences.volCap)} que sugieren tus respuestas sobre riesgo.` });
  } else if (strategy.metrics.avgVol != null) {
    notes.push({ ok: true, text: `Volatilidad media ${pct(strategy.metrics.avgVol)}, dentro de tu techo del ${pct(preferences.volCap)}.` });
  }

  if (strategy.positions.length < preferences.minPositions) {
    score -= 15;
    notes.push({ ok: false, text: `${strategy.positions.length} posiciones: por debajo de las ${preferences.minPositions} que te convienen según tu experiencia declarada.` });
  }

  const etfShare = strategy.positions.filter(p => p.assetClass === 'etf').reduce((s, p) => s + p.pct, 0);
  const totalPct = strategy.positions.reduce((s, p) => s + p.pct, 0) || 1;
  if (preferences.preferDiversified) {
    if (etfShare / totalPct < 0.5) {
      score -= 15;
      notes.push({ ok: false, text: 'Apoya buena parte del peso en acciones sueltas, y tus respuestas apuntan a preferir ETFs.' });
    } else {
      notes.push({ ok: true, text: 'Se apoya sobre todo en ETFs, que es lo que encaja con tu nivel de experiencia.' });
    }
  }

  const preferredLevel = { defensivo: 0.2, equilibrado: 0.5, crecimiento: 0.85 }[preferences.tilt] ?? 0.5;
  const gap = Math.abs(strategy.tiltLevel - preferredLevel);
  score -= Math.round(gap * 40);
  if (gap <= 0.2) notes.push({ ok: true, text: `Su carácter encaja con el perfil ${preferences.tilt} que sale de tu test.` });

  return { score: Math.max(0, Math.min(100, score)), notes };
}

// ctx: el mismo de generateRecommendations + { preferences }
// Devuelve { timing, marketState, effectiveRiskScore, preferences, strategies: [...] }
export function generateStrategyOptions(ctx) {
  const { params: p, adj, effScore, marketState, timing, ranked } = analyzeUniverse(ctx);
  if (!timing) return { timing: null, marketState, strategies: [] };

  const category = ctx.profile.category;
  const preferences = ctx.preferences || null;
  const maxPosPct = category.maxPosPct * (preferences?.maxPosFactor ?? 1);

  // Tamaño de posición representativo para el filtro del bróker (mínimos y
  // comisión fija). Se calcula con el reparto equilibrado, igual que el motor.
  const balanced = allocate({ category, riskScore: effScore, signal: timing.signal, topPicks: ranked.slice(0, p.topN), maxPosPct });
  const positionEUR = ctx.capitalMid ? (ctx.capitalMid * balanced.perPositionPct) / 100 : null;
  const pool = eligibilityFilter(ranked, ctx.broker, positionEUR);

  const strategies = [];
  const seen = new Set();

  for (const bp of BLUEPRINTS) {
    const ordered = bp.order(pool).filter(c => c.state && c.state.vol != null);
    if (ordered.length < 2) continue;

    const alloc = allocate({
      category, riskScore: effScore, signal: timing.signal,
      topPicks: ordered.slice(0, bp.minPicks), maxPosPct, tiltAdj: bp.tiltAdj,
    });
    const targetEquityPct = alloc.equityPct;
    const capOf = o => (o.asset.core ? Math.min(targetEquityPct, maxPosPct * 3) : maxPosPct);

    // El tope de concentración del perfil puede impedir desplegar toda la banda
    // con pocas posiciones: en ese caso la opción crece hasta poder cubrirla.
    let placed = [];
    for (let n = Math.min(bp.minPicks, ordered.length); n <= ordered.length; n++) {
      const picks = ordered.slice(0, n).map(c => ({ ...c, weight: bp.weightOf(c) }));
      placed = spread(picks, targetEquityPct, capOf);
      if (placed.reduce((s, o) => s + o.pct, 0) >= targetEquityPct - 0.5) break;
    }
    if (placed.length < 2) continue;

    // Dos plantillas pueden converger en la misma cartera: nos quedamos con una
    const fingerprint = placed.map(o => `${o.asset.id}:${o.pct}`).sort().join('|');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const investedPct = round1(placed.reduce((s, o) => s + o.pct, 0));
    const wSum = placed.reduce((s, o) => s + o.pct, 0) || 1;
    const avgVol = placed.reduce((s, o) => s + o.state.vol * o.pct, 0) / wSum;
    const avgMom = placed.reduce((s, o) => s + (o.state.momentum ?? 0) * o.pct, 0) / wSum;
    const estCostPct = placed.reduce((s, o) => s + o.costPct * o.pct, 0) / wSum;

    const strategy = {
      id: bp.id,
      name: bp.name,
      tagline: bp.tagline,
      tiltLevel: bp.tiltLevel,
      equityPct: investedPct,
      targetEquityPct,
      // si el tope de concentración no deja llegar al objetivo, se dice
      underDeployed: investedPct < targetEquityPct - 0.5,
      liquidityPct: round1(100 - investedPct),
      dcaPct: alloc.dcaPct,
      action: timing.signal === 'red' ? 'esperar' : 'comprar',
      positions: placed.map(o => ({
        assetId: o.asset.id,
        name: o.asset.name,
        assetClass: o.asset.assetClass,
        pct: o.pct,
        terms: o.terms,
        costPct: o.costPct,
        state: { momentum: o.state.momentum, vol: o.state.vol, rsi: o.state.rsi, regime: o.state.regime },
        why: o.asset.core
          ? 'Núcleo indexado: cientos de empresas en un solo producto.'
          : o.asset.defensive
            ? `Perfil defensivo con volatilidad ${pct(o.state.vol)}.`
            : `Momentum 12m ${pct(o.state.momentum)} con volatilidad ${pct(o.state.vol)}.`,
      })),
      metrics: {
        nPositions: placed.length,
        avgVol,
        avgMomentum: avgMom,
        estCostPct: round1(estCostPct * 10) / 10,
      },
      pros: bp.pros,
      cons: bp.cons,
    };
    if (strategy.underDeployed) {
      strategy.cons = [...strategy.cons,
        `Solo despliega un ${investedPct}% de los ${targetEquityPct}% que tocarían hoy: el tope de concentración de tu perfil (${round1(maxPosPct)}% por activo) no da para más con estos candidatos. El resto se queda en liquidez.`];
    }
    strategy.fit = fitOf(strategy, preferences);
    strategies.push(strategy);
  }

  // Mejor encaje primero. El usuario sigue eligiendo: solo se etiqueta.
  strategies.sort((a, b) => b.fit.score - a.fit.score);
  if (strategies.length) strategies[0].bestFit = true;

  return {
    timing,
    marketState,
    effectiveRiskScore: effScore,
    preferences,
    adjustments: { riskShift: adj.riskShift, timingCaution: adj.timingCaution },
    strategies,
  };
}
