// Afinado del algoritmo por búsqueda en rejilla con validación fuera de muestra.
//   Entrenamiento: 1991-2010 (incluye puntocom y 2008)
//   Validación:    2011-2022 (incluye COVID-2020 y bajista 2022)
// Objetivo: maximizar el Sharpe de la estrategia guiada por el semáforo,
// penalizando configuraciones que pierdan frente a comprar-y-mantener en drawdown.
// Uso: node backtest/tune.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBundle, makeIndicatorCache, computeTimingSeries, evalTiming, simStrategy, simBuyHold, simDCA } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = loadBundle();
const sp = bundle.series.SP500;
const dates = bundle.dates;
const idxOf = (d) => dates.findIndex(x => x >= d);

const TRAIN = [idxOf('1991-01-01'), idxOf('2011-01-01')];
const VALID = [idxOf('2011-01-01'), dates.length];

const GRID = {
  smaLong: [150, 200],
  smaShort: [50],
  rsiOverbought: [70, 75, 80],
  rsiOversold: [25, 30, 35],
  volHigh: [0.20, 0.25, 0.30],
  volExtreme: [0.40, 0.45, 0.55],
  ddDeep: [-0.20, -0.25, -0.30],
};

function* configs(grid) {
  const keys = Object.keys(grid);
  const idx = keys.map(() => 0);
  while (true) {
    yield Object.fromEntries(keys.map((k, j) => [k, grid[k][idx[j]]]));
    let j = keys.length - 1;
    while (j >= 0 && ++idx[j] === grid[keys[j]].length) { idx[j] = 0; j--; }
    if (j < 0) return;
  }
}

const cache = makeIndicatorCache(sp);
const base = { rsiPeriod: 14, volWindow: 30, topN: 5, fwdHorizon: 63 };

function evaluate(params, [from, to]) {
  const signals = computeTimingSeries(cache, params);
  const strat = simStrategy(sp, signals, from, to);
  const bh = simBuyHold(sp, from, to);
  const timing = evalTiming(sp, signals, 63, from, to - 63);
  const dca = simDCA(sp, signals, from, to);
  return { strat, bh, timing, dca, signals };
}

console.log(`Entrenamiento: ${dates[TRAIN[0]]} → ${dates[TRAIN[1]]}, validación: ${dates[VALID[0]]} → ${dates[VALID[1] - 1]}`);
const results = [];
let count = 0;
for (const c of configs(GRID)) {
  const params = { ...base, ...c };
  const { strat, bh, timing } = evaluate(params, TRAIN);
  // objetivo: Sharpe + mejora de drawdown vs B&H + precisión del rojo
  const ddGain = (bh.maxDD - strat.maxDD); // positivo si el semáforo recorta la caída
  const redAcc = timing.red.n > 5 ? (1 - timing.red.hitRate) : 0; // % de rojos seguidos de caída
  const objective = strat.sharpe + ddGain + 0.3 * redAcc;
  results.push({ params: c, objective, trainSharpe: strat.sharpe, trainCagr: strat.cagr, trainMaxDD: strat.maxDD, bhSharpe: bh.sharpe });
  count++;
}
results.sort((a, b) => b.objective - a.objective);
console.log(`${count} configuraciones evaluadas.`);

// Validación fuera de muestra de las 10 mejores
console.log('\nTop 10 (train) → validación 2011-2022:');
const validated = results.slice(0, 10).map(r => {
  const params = { ...base, ...r.params };
  const { strat, bh, timing, dca } = evaluate(params, VALID);
  return {
    ...r,
    validSharpe: strat.sharpe, validCagr: strat.cagr, validMaxDD: strat.maxDD,
    validBhSharpe: bh.sharpe, validBhCagr: bh.cagr, validBhMaxDD: bh.maxDD,
    greenHit: timing.green.hitRate, redHit: timing.red.hitRate, baseHit: timing.all.hitRate,
    dcaRatio: dca.ratio,
  };
});
for (const v of validated) {
  console.log(JSON.stringify(v.params), `obj=${v.objective.toFixed(3)} trainSh=${v.trainSharpe.toFixed(2)} validSh=${v.validSharpe.toFixed(2)} validDD=${(v.validMaxDD * 100).toFixed(0)}% greenHit=${(v.greenHit * 100).toFixed(0)}%`);
}

// Elección robusta: mejor media de Sharpe train+valid entre las top 10
validated.sort((a, b) => (b.trainSharpe + b.validSharpe) - (a.trainSharpe + a.validSharpe));
const winner = validated[0];
console.log('\nGANADORA (robusta train+valid):', JSON.stringify(winner.params));
writeFileSync(join(root, 'backtest/tuning-results.json'), JSON.stringify({ train: `${dates[TRAIN[0]]}..${dates[TRAIN[1]]}`, valid: `${dates[VALID[0]]}..${dates[VALID[1] - 1]}`, winner, top10: validated }, null, 2));
console.log('Resultados guardados en backtest/tuning-results.json');
