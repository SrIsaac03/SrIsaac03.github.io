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

// Señal de timing para cada día de la serie (null durante el calentamiento)
export function computeTimingSeries(cache, params) {
  const out = new Array(cache.values.length).fill(null);
  for (let i = 0; i < cache.values.length; i++) {
    const st = stateAt(cache, i, params);
    if (!st || st.rsi == null || st.vol == null) continue;
    out[i] = timingSignal(st, params, 0).signal;
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
// Exposición: verde=100%, ámbar=50%, rojo=0% (liquidez, rendimiento 0).
// La señal del cierre de i se aplica al día i+1 (sin sesgo de anticipación).
export function simStrategy(values, signals, from = 0, to = Infinity) {
  const expOf = { green: 1, amber: 0.5, red: 0 };
  let eq = 1, peak = 1, maxDD = 0;
  const dailyRets = [];
  let exposure = 0, exposedDays = 0, n = 0;
  for (let i = Math.max(from, 1); i < Math.min(to, values.length); i++) {
    if (values[i] == null || values[i - 1] == null) continue;
    const r = values[i] / values[i - 1] - 1;
    const stratR = exposure * r;
    eq *= 1 + stratR;
    dailyRets.push(stratR);
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq / peak - 1);
    exposedDays += exposure; n++;
    if (signals[i] != null) exposure = expOf[signals[i]];
  }
  return { ...metrics(dailyRets, eq), maxDD, avgExposure: n ? exposedDays / n : 0 };
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

export { DEFAULT_PARAMS };
