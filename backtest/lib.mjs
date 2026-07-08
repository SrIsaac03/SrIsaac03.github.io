// Librería de backtesting: evalúa el semáforo de timing y la selección de
// activos del motor contra el histórico real (S&P 500, 1990-2022).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sma, rsi, rollingVolatility, drawdownFromHigh, momentum12m1 } from '../js/core/indicators.js';
import { timingSignal, DEFAULT_PARAMS } from '../js/core/engine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadBundle() {
  return JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
}

// Cache de indicadores que no dependen de los parámetros afinables
// (RSI14, vol30, drawdown252) + SMAs bajo demanda por longitud.
export function makeIndicatorCache(values) {
  const smas = new Map();
  return {
    values,
    rsi: rsi(values, 14),
    vol: rollingVolatility(values, 30),
    dd: drawdownFromHigh(values, 252),
    sma(period) {
      if (!smas.has(period)) smas.set(period, sma(values, period));
      return smas.get(period);
    },
  };
}

function stateAt(cache, i, params) {
  const price = cache.values[i];
  const smaL = cache.sma(params.smaLong)[i];
  const smaS = cache.sma(params.smaShort)[i];
  if (price == null || smaL == null || smaS == null) return null;
  const aboveLong = price > smaL, shortAboveLong = smaS > smaL;
  const regime = aboveLong && shortAboveLong ? 'alcista' : (!aboveLong && !shortAboveLong ? 'bajista' : 'transicion');
  return { price, regime, rsi: cache.rsi[i], vol: cache.vol[i], drawdown: cache.dd[i], distSmaLong: price / smaL - 1 };
}

// Señal de timing para cada día de la serie (null durante el calentamiento).
// Aplica la misma histéresis (params.signalPersistence) que la app, para que los
// backtests reflejen el comportamiento real que ve el usuario.
export function computeTimingSeries(cache, params) {
  const raw = new Array(cache.values.length).fill(null);
  for (let i = 0; i < cache.values.length; i++) {
    const st = stateAt(cache, i, params);
    if (!st || st.rsi == null || st.vol == null) continue;
    raw[i] = timingSignal(st, params, 0).signal;
  }
  const k = params.signalPersistence || 1;
  if (k <= 1) return raw;
  const out = raw.slice();
  let cur = null, cand = null, run = 0;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (s == null) { out[i] = cur; continue; }
    if (cur == null) { cur = s; cand = s; run = 0; out[i] = cur; continue; }
    if (s === cand) run++; else { cand = s; run = 1; }
    if (cand !== cur && run >= k) cur = cand;
    out[i] = cur;
  }
  return out;
}

// --- Métricas de acierto de la señal ---
// Para cada día con señal: ¿el retorno a `horizon` sesiones fue positivo?
export function evalTiming(values, signals, horizon, from = 0, to = Infinity) {
  const stats = { green: { n: 0, pos: 0, sum: 0 }, amber: { n: 0, pos: 0, sum: 0 }, red: { n: 0, pos: 0, sum: 0 }, all: { n: 0, pos: 0, sum: 0 } };
  for (let i = Math.max(from, 0); i < Math.min(to, values.length - horizon); i++) {
    const s = signals[i];
    if (!s || values[i] == null || values[i + horizon] == null) continue;
    const fwd = values[i + horizon] / values[i] - 1;
    for (const key of [s, 'all']) {
      stats[key].n++; stats[key].sum += fwd;
      if (fwd > 0) stats[key].pos++;
    }
  }
  const out = {};
  for (const k of Object.keys(stats)) {
    const s = stats[k];
    out[k] = { n: s.n, hitRate: s.n ? s.pos / s.n : null, avgFwd: s.n ? s.sum / s.n : null };
  }
  return out;
}

// --- Simulación de estrategia diaria ---
// Exposición: verde=100%, ámbar=50%, rojo=0% (liquidez).
// La señal del cierre de i se aplica al día i+1 (sin sesgo de anticipación).
// opts.costBps: coste por operación en puntos básicos aplicado a |Δexposición|.
// opts.cashYield: rendimiento anual de la parte en liquidez (letras/remunerada).
export function simStrategy(values, signals, from = 0, to = Infinity, opts = {}) {
  const expOf = { green: 1, amber: 0.5, red: 0 };
  const cost = (opts.costBps || 0) / 10000;
  const dailyCash = opts.cashYield ? Math.pow(1 + opts.cashYield, 1 / 252) - 1 : 0;
  let eq = 1, peak = 1, maxDD = 0;
  const dailyRets = [];
  let exposure = 0, exposedDays = 0, n = 0, turnover = 0, trades = 0;
  for (let i = Math.max(from, 1); i < Math.min(to, values.length); i++) {
    if (values[i] == null || values[i - 1] == null) continue;
    const r = values[i] / values[i - 1] - 1;
    // el capital invertido rinde r; el no invertido rinde el interés de liquidez
    const stratR = exposure * r + (1 - exposure) * dailyCash;
    eq *= 1 + stratR;
    dailyRets.push(stratR);
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq / peak - 1);
    exposedDays += exposure; n++;
    if (signals[i] != null) {
      const target = expOf[signals[i]];
      if (target !== exposure) {
        const delta = Math.abs(target - exposure);
        turnover += delta; trades++;
        eq *= 1 - cost * delta; // coste de rebalanceo
      }
      exposure = target;
    }
  }
  return { ...metrics(dailyRets, eq), maxDD, avgExposure: n ? exposedDays / n : 0, turnover, trades };
}

export function simBuyHold(values, from = 0, to = Infinity) {
  let eq = 1, peak = 1, maxDD = 0;
  const dailyRets = [];
  for (let i = Math.max(from, 1); i < Math.min(to, values.length); i++) {
    if (values[i] == null || values[i - 1] == null) continue;
    const r = values[i] / values[i - 1] - 1;
    eq *= 1 + r;
    dailyRets.push(r);
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq / peak - 1);
  }
  return { ...metrics(dailyRets, eq), maxDD };
}

function metrics(dailyRets, finalEq) {
  const n = dailyRets.length;
  if (!n) return { years: 0, cagr: 0, vol: 0, sharpe: 0, finalMultiple: 1 };
  const mean = dailyRets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const years = n / 252;
  return {
    years,
    cagr: Math.pow(finalEq, 1 / years) - 1,
    vol: sd * Math.sqrt(252),
    sharpe: sd ? (mean / sd) * Math.sqrt(252) : 0,
    finalMultiple: finalEq,
  };
}

// --- DCA con timing vs DCA fijo ---
// Cada ~21 sesiones llega una aportación de 1. Fijo: se invierte siempre.
// Con timing: verde invierte aportación+hucha, ámbar invierte la mitad, rojo ahucha.
export function simDCA(values, signals, from = 0, to = Infinity) {
  let sharesFixed = 0, sharesTimed = 0, cashTimed = 0, invested = 0;
  const end = Math.min(to, values.length) - 1;
  for (let i = Math.max(from, 0); i <= end; i++) {
    const isContribution = (i - from) % 21 === 0;
    if (!isContribution || values[i] == null || signals[i] == null) continue;
    invested += 1;
    sharesFixed += 1 / values[i];
    cashTimed += 1;
    if (signals[i] === 'green') {
      sharesTimed += cashTimed / values[i];
      cashTimed = 0;
    } else if (signals[i] === 'amber') {
      sharesTimed += (cashTimed / 2) / values[i];
      cashTimed /= 2;
    }
  }
  const px = values[end];
  return {
    invested,
    fixedFinal: sharesFixed * px,
    timedFinal: sharesTimed * px + cashTimed,
    ratio: (sharesTimed * px + cashTimed) / (sharesFixed * px),
  };
}

// --- Selección de activos: top-N por momentum/vol vs equiponderado ---
export function evalSelection(bundle, params, from, to, topN = 5) {
  const symbols = Object.keys(bundle.series).filter(s => s !== 'SP500' && !s.startsWith('ETF_'));
  const caches = Object.fromEntries(symbols.map(s => [s, {
    values: bundle.series[s],
    vol: rollingVolatility(bundle.series[s], 30),
  }]));
  let wins = 0, months = 0, topRet = 1, ewRet = 1;
  for (let i = Math.max(from, 260); i + 21 < Math.min(to, bundle.dates.length); i += 21) {
    const scored = [];
    for (const s of symbols) {
      const m = momentum12m1(caches[s].values, i);
      const v = caches[s].vol[i];
      if (m == null || v == null || !caches[s].values[i] || !caches[s].values[i + 21]) continue;
      scored.push({ s, score: m / Math.max(v, 0.08), fwd: caches[s].values[i + 21] / caches[s].values[i] - 1 });
    }
    if (scored.length < 10) continue;
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topN);
    const avgTop = top.reduce((a, b) => a + b.fwd, 0) / top.length;
    const avgAll = scored.reduce((a, b) => a + b.fwd, 0) / scored.length;
    months++;
    if (avgTop > avgAll) wins++;
    topRet *= 1 + avgTop;
    ewRet *= 1 + avgAll;
  }
  return { months, winRate: wins / months, topCagr: Math.pow(topRet, 12 / months) - 1, ewCagr: Math.pow(ewRet, 12 / months) - 1 };
}

// ===================== FIABILIDAD DE LA PREDICCIÓN =====================

// PRNG determinista (mulberry32) para bootstraps reproducibles.
export function rng(seed = 12345) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Test de significancia por PERMUTACIÓN CIRCULAR.
// H0: la señal no aporta información sobre el retorno futuro.
// Estadístico: retorno medio a `horizon` en días verdes − en días rojos.
// Se desplaza circularmente la serie de señales respecto a los retornos por un
// offset aleatorio (rompe la relación real preservando la autocorrelación de
// ambas series) y se reconstruye la distribución nula. p = P(nulo ≥ observado).
export function permutationTest(values, signals, horizon, from, to, { iters = 2000, seed = 7 } = {}) {
  const lo = Math.max(from, 0), hi = Math.min(to, values.length - horizon);
  const fwd = [], sig = [];
  for (let i = lo; i < hi; i++) {
    if (values[i] == null || values[i + horizon] == null || signals[i] == null) continue;
    fwd.push(values[i + horizon] / values[i] - 1);
    sig.push(signals[i]);
  }
  const n = fwd.length;
  const diff = (shift) => {
    let gs = 0, gn = 0, rs = 0, rn = 0;
    for (let i = 0; i < n; i++) {
      const s = sig[(i + shift) % n];
      if (s === 'green') { gs += fwd[i]; gn++; }
      else if (s === 'red') { rs += fwd[i]; rn++; }
    }
    if (!gn || !rn) return null;
    return gs / gn - rs / rn;
  };
  const observed = diff(0);
  const rand = rng(seed);
  let ge = 0, valid = 0;
  const nulls = [];
  for (let k = 0; k < iters; k++) {
    const shift = 1 + Math.floor(rand() * (n - 1));
    const d = diff(shift);
    if (d == null) continue;
    valid++; nulls.push(d);
    if (d >= observed) ge++;
  }
  nulls.sort((a, b) => a - b);
  return {
    observed, n,
    pValue: (ge + 1) / (valid + 1), // +1: corrección de continuidad
    nullMean: nulls.reduce((a, b) => a + b, 0) / nulls.length,
    null95: nulls[Math.floor(0.95 * nulls.length)],
  };
}

// Sharpe DEFLACTADO (Bailey & López de Prado): corrige el Sharpe observado por
// (a) haber probado N configuraciones —el máximo de N Sharpes tiene sesgo al
// alza— y (b) sesgo/curtosis de los retornos. Devuelve la probabilidad de que
// el Sharpe verdadero sea > 0 tras la corrección.
export function deflatedSharpe(dailyRets, nTrials, sharpesTried = []) {
  const n = dailyRets.length;
  if (n < 30) return null;
  const mean = dailyRets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  if (sd === 0) return null;
  const z = dailyRets.map(r => (r - mean) / sd);
  const skew = z.reduce((a, b) => a + b ** 3, 0) / n;
  const kurt = z.reduce((a, b) => a + b ** 4, 0) / n; // curtosis (normal = 3)
  const shDaily = mean / sd; // Sharpe diario (no anualizado)

  // Sharpe esperado del máximo de N pruebas independientes bajo H0 (~N(0, varSh))
  const varTried = sharpesTried.length > 1
    ? variance(sharpesTried.map(s => s / Math.sqrt(252))) // pasar a Sharpe diario
    : 1 / n;
  const emc = 0.5772156649;
  const maxZ = Math.sqrt(2 * Math.log(Math.max(nTrials, 2)))
    - (Math.log(Math.log(Math.max(nTrials, 2))) + Math.log(4 * Math.PI)) / (2 * Math.sqrt(2 * Math.log(Math.max(nTrials, 2))));
  const shBenchmark = Math.sqrt(varTried) * (maxZ + emc * (1 / Math.sqrt(2 * Math.log(Math.max(nTrials, 2)))) * 0); // umbral esperado
  const sh0 = Math.sqrt(varTried) * maxZ; // Sharpe diario umbral por azar

  // Probabilistic Sharpe Ratio contra ese umbral (con ajuste por momentos)
  const num = (shDaily - sh0) * Math.sqrt(n - 1);
  const den = Math.sqrt(1 - skew * shDaily + ((kurt - 1) / 4) * shDaily * shDaily);
  const dsr = normCdf(num / den);
  return {
    sharpeAnnual: shDaily * Math.sqrt(252),
    thresholdAnnual: sh0 * Math.sqrt(252),
    skew, excessKurtosis: kurt - 3,
    dsr, // P(Sharpe verdadero > umbral por azar) tras corregir multiple-testing
  };
}

function variance(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(arr.length - 1, 1);
}

// CDF normal estándar (aproximación de Abramowitz-Stegun 7.1.26)
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// Búsqueda en rejilla reutilizable: devuelve la mejor config por Sharpe de la
// estrategia en [from,to), y la lista de Sharpes probados (para deflactar).
export function gridSearch(cache, grid, baseParams, from, to, opts = {}) {
  const keys = Object.keys(grid);
  const idx = keys.map(() => 0);
  let best = null;
  const sharpes = [];
  while (true) {
    const params = { ...baseParams, ...Object.fromEntries(keys.map((k, j) => [k, grid[k][idx[j]]])) };
    const signals = computeTimingSeries(cache, params);
    const strat = simStrategy(cache.values, signals, from, to, opts);
    sharpes.push(strat.sharpe);
    if (!best || strat.sharpe > best.sharpe) best = { params, sharpe: strat.sharpe };
    let j = keys.length - 1;
    while (j >= 0 && ++idx[j] === grid[keys[j]].length) { idx[j] = 0; j--; }
    if (j < 0) break;
  }
  return { best, sharpes, nTrials: sharpes.length };
}

// VALIDACIÓN WALK-FORWARD: reoptimiza en una ventana móvil de entrenamiento y
// aplica los parámetros ganadores al tramo siguiente, SIEMPRE fuera de muestra.
// Concatena la curva de resultados OOS. Es el estándar de oro para estrategias
// temporales: cada decisión usa solo información pasada.
export function walkForward(cache, grid, baseParams, { trainDays = 252 * 8, testDays = 252, start = 260, opts = {} } = {}) {
  const N = cache.values.length;
  const oosSignals = new Array(N).fill(null);
  const windows = [];
  for (let trainEnd = start + trainDays; trainEnd + 1 < N; trainEnd += testDays) {
    const trainStart = trainEnd - trainDays;
    const testEnd = Math.min(trainEnd + testDays, N);
    const { best } = gridSearch(cache, grid, baseParams, trainStart, trainEnd, opts);
    const sig = computeTimingSeries(cache, best.params);
    for (let i = trainEnd; i < testEnd; i++) oosSignals[i] = sig[i];
    windows.push({ trainStart, trainEnd, testEnd, params: best.params });
  }
  const firstTest = windows.length ? windows[0].trainEnd : start;
  const lastTest = windows.length ? windows[windows.length - 1].testEnd : N;
  const strat = simStrategy(cache.values, oosSignals, firstTest, lastTest, opts);
  const bh = simBuyHold(cache.values, firstTest, lastTest);
  return { windows: windows.length, from: firstTest, to: lastTest, strat, bh, oosSignals };
}

export { DEFAULT_PARAMS };
