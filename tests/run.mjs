// Suite de tests del Copiloto de Inversión. Uso: node tests/run.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sma, ema, rsi, macd, rollingVolatility, drawdownFromHigh, momentum12m1, dailyReturns } from '../js/core/indicators.js';
import { SeriesAnalyzer, timingSignal, confirmedTiming, evaluateHolding, allocate, eligibilityFilter, rankAssets, generateRecommendations, DEFAULT_PARAMS } from '../js/core/engine.js';
import { scoreTest, QUESTIONS, CATEGORIES } from '../js/core/profile.js';
import { BROKERS, getBroker, brokerTerms } from '../js/core/brokers.js';
import { computeFeedbackAdjustments, isSuppressed, REJECT_REASONS } from '../js/core/feedback.js';
import { ASSETS, getAsset } from '../js/core/assets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
function approx(a, b, tol = 1e-6, msg) { if (Math.abs(a - b) > tol) throw new Error(msg || `${a} ≉ ${b}`); }

console.log('— Indicadores —');

test('SMA básica', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert(out[0] === null && out[1] === null);
  approx(out[2], 2); approx(out[3], 3); approx(out[4], 4);
});

test('SMA ignora nulls sin romperse', () => {
  const out = sma([1, null, 2, 3, null, 4], 3);
  approx(out[5], 3); // ventana = [2,3,4]
});

test('EMA converge hacia valores recientes', () => {
  const flat = ema(new Array(50).fill(10), 10);
  approx(flat[49], 10);
  const rising = ema(Array.from({ length: 100 }, (_, i) => i + 1), 10);
  assert(rising[99] > 90 && rising[99] < 100, `ema=${rising[99]}`);
});

test('RSI: subida constante → 100, bajada → 0', () => {
  const up = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
  approx(up[29], 100, 0.01);
  const down = rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14);
  approx(down[29], 0, 0.01);
});

test('RSI en rango [0,100] sobre datos reales', () => {
  const bundle = JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
  const r = rsi(bundle.series.SP500, 14);
  for (const v of r) if (v != null) assert(v >= 0 && v <= 100, `RSI fuera de rango: ${v}`);
});

test('MACD: histograma = línea - señal', () => {
  const vals = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.1);
  const m = macd(vals);
  for (let i = 0; i < vals.length; i++) {
    if (m.hist[i] != null) approx(m.hist[i], m.line[i] - m.signal[i], 1e-9);
  }
});

test('Volatilidad anualizada positiva y razonable', () => {
  const vals = Array.from({ length: 200 }, (_, i) => 100 * Math.exp(0.0005 * i + 0.01 * Math.sin(i)));
  const v = rollingVolatility(vals, 30);
  const last = v[199];
  assert(last > 0 && last < 5, `vol=${last}`);
});

test('Drawdown: 0 en máximos nuevos, negativo tras caída', () => {
  const vals = [...Array.from({ length: 260 }, (_, i) => 100 + i), 400, 320];
  const dd = drawdownFromHigh(vals, 252);
  approx(dd[260], 0, 1e-9);          // 400 es máximo nuevo
  approx(dd[261], 320 / 400 - 1, 1e-9); // -20% desde el máximo
});

test('Drawdown con caída del 20%', () => {
  const vals = new Array(300).fill(100); vals[299] = 80;
  const dd = drawdownFromHigh(vals, 252);
  approx(dd[299], -0.2, 1e-9);
});

test('Momentum 12-1 correcto', () => {
  const vals = new Array(300).fill(null).map((_, i) => i < 48 ? 100 : (i < 279 ? 110 : 120));
  // i=290: hace 252 sesiones (i=38) valía 100; hace 21 (i=269) valía 110 → +10%
  approx(momentum12m1(vals, 290), 0.10, 1e-9);
});

console.log('— Perfil psicométrico —');

test('Test completo produce score 0..100 y categoría válida', () => {
  const all2 = Object.fromEntries(QUESTIONS.map(q => [q.id, 2]));
  const r = scoreTest(all2);
  assert(r.score === 50, `score=${r.score}`);
  assert(r.category.id === 'moderado');
});

test('Respuestas extremas → conservador / agresivo', () => {
  const timid = Object.fromEntries(QUESTIONS.map(q => [q.id, q.reverse ? 4 : 0]));
  assert(scoreTest(timid).score === 0);
  assert(scoreTest(timid).category.id === 'conservador');
  const bold = Object.fromEntries(QUESTIONS.map(q => [q.id, q.reverse ? 0 : 4]));
  assert(scoreTest(bold).score === 100);
  assert(scoreTest(bold).category.id === 'agresivo');
});

test('Test incompleto lanza error', () => {
  let threw = false;
  try { scoreTest({ q1: 2 }); } catch { threw = true; }
  assert(threw);
});

test('Las bandas de categorías cubren 0..100 sin huecos', () => {
  for (let s = 0; s <= 100; s++) {
    assert(CATEGORIES.some(c => s >= c.min && s <= c.max), `score ${s} sin categoría`);
  }
});

console.log('— Brókers y elegibilidad —');

test('Catálogo: todos los brókers tienen términos coherentes', () => {
  for (const b of BROKERS) {
    for (const cls of b.assetClasses) {
      assert(b.feeBps[cls] != null, `${b.id} sin fee para ${cls}`);
      assert(b.minOrder[cls] != null, `${b.id} sin minOrder para ${cls}`);
      assert(b.fractional[cls] != null, `${b.id} sin fractional para ${cls}`);
    }
  }
});

test('brokerTerms: null para clases no soportadas', () => {
  const bbva = getBroker('bbva');
  assert(brokerTerms(bbva, { assetClass: 'crypto' }) === null);
  assert(brokerTerms(bbva, { assetClass: 'fund', currency: 'EUR' }) !== null);
});

test('eligibilityFilter excluye clases no soportadas y costes excesivos', () => {
  const revolut = getBroker('revolut'); // no tiene ETFs
  const fakeRanked = [
    { asset: { id: 'X', assetClass: 'etf', currency: 'USD' }, state: {}, score: 1 },
    { asset: { id: 'Y', assetClass: 'equity', currency: 'USD' }, state: {}, score: 0.9 },
  ];
  const out = eligibilityFilter(fakeRanked, revolut, 1000);
  assert(out.length === 1 && out[0].asset.id === 'Y', JSON.stringify(out.map(o => o.asset.id)));
});

test('eligibilityFilter: posición menor que el mínimo del bróker → excluida', () => {
  const degiro = getBroker('degiro');
  const bonds = [{ asset: { id: 'B', assetClass: 'bond', currency: 'EUR' }, state: {}, score: 1 }];
  assert(eligibilityFilter(bonds, degiro, 500).length === 0); // min bond 1000€
  assert(eligibilityFilter(bonds, degiro, 2000).length === 1);
});

console.log('— Feedback / personalización —');

test('Rechazos "no me convence" suprimen el activo tras acumularse', () => {
  const now = Date.now();
  const hist = [1, 2, 3].map(() => ({ assetId: 'AAPL', assetClass: 'equity', action: 'rejected', reasonId: 'asset', ts: now }));
  const adj = computeFeedbackAdjustments(hist, now);
  assert(isSuppressed(adj, 'AAPL'), `adj=${adj.assetAdj.get('AAPL')}`);
});

test('El decaimiento temporal reduce el peso de rechazos antiguos', () => {
  const now = Date.now();
  const old = now - 180 * 86400000; // 2 semividas → 25%
  const adj = computeFeedbackAdjustments([{ assetId: 'KO', assetClass: 'equity', action: 'rejected', reasonId: 'asset', ts: old }], now);
  approx(adj.assetAdj.get('KO'), -0.25 * 0.25, 1e-3);
});

test('"Demasiado riesgo" desplaza el riesgo efectivo a la baja (acotado)', () => {
  const now = Date.now();
  const hist = Array.from({ length: 10 }, () => ({ assetId: 'X', assetClass: 'equity', action: 'rejected', reasonId: 'too_risky', ts: now }));
  const adj = computeFeedbackAdjustments(hist, now);
  assert(adj.riskShift === -15, `riskShift=${adj.riskShift}`); // clamp
});

test('Rechazos por timing elevan la cautela y degradan verde→ámbar', () => {
  const now = Date.now();
  const hist = Array.from({ length: 3 }, () => ({ assetId: 'X', assetClass: 'equity', action: 'rejected', reasonId: 'timing', ts: now }));
  const adj = computeFeedbackAdjustments(hist, now);
  assert(adj.timingCaution >= 0.3);
  const green = timingSignal({ regime: 'alcista', rsi: 55, vol: 0.15, drawdown: -0.02, momentum: 0.1, distSmaLong: 0.05, price: 100 }, DEFAULT_PARAMS, adj.timingCaution);
  assert(green.signal === 'amber', green.signal);
});

console.log('— Timing gate —');

const S = (over) => ({ regime: 'alcista', rsi: 55, vol: 0.15, drawdown: -0.02, momentum: 0.1, distSmaLong: 0.05, price: 100, ...over });

test('Alcista tranquilo → verde', () => assert(timingSignal(S({})).signal === 'green'));
test('Alcista con RSI en sobrecompra → ámbar', () => assert(timingSignal(S({ rsi: 80 })).signal === 'amber'));
test('Alcista con vol extrema → rojo', () => assert(timingSignal(S({ vol: 0.5 })).signal === 'red'));
test('Bajista → rojo', () => assert(timingSignal(S({ regime: 'bajista' })).signal === 'red'));
test('Bajista con caída profunda y RSI en sobreventa → ámbar (DCA contrarian)', () =>
  assert(timingSignal(S({ regime: 'bajista', drawdown: -0.35, rsi: 25 })).signal === 'amber'));
test('Transición → ámbar', () => assert(timingSignal(S({ regime: 'transicion' })).signal === 'amber'));

test('confirmedTiming: la histéresis retrasa el cambio hasta confirmarlo N sesiones', () => {
  const green = { regime: 'alcista', rsi: 55, vol: 0.15, drawdown: -0.02, distSmaLong: 0.05, price: 100 };
  const red = { regime: 'bajista', rsi: 45, vol: 0.15, drawdown: -0.10, distSmaLong: -0.05, price: 90 };
  const mk = (redDays) => ({ stateAt: (j) => (j > 100 - redDays ? red : green) });
  const p3 = { ...DEFAULT_PARAMS, signalPersistence: 3 };
  // 1 día rojo al final: no confirma → sigue verde, con la señal cruda pendiente
  const a = confirmedTiming(mk(1), 100, p3);
  assert(a.signal === 'green' && a.pendingRaw === 'red', JSON.stringify(a));
  // 3 días rojos seguidos: confirma el cambio a rojo
  assert(confirmedTiming(mk(3), 100, p3).signal === 'red');
  // persistence=1 equivale a la señal cruda inmediata
  assert(confirmedTiming(mk(1), 100, { ...DEFAULT_PARAMS, signalPersistence: 1 }).signal === 'red');
});

console.log('— Allocation (solo porcentajes) —');

test('Semáforo verde usa el techo de la banda; rojo el suelo', () => {
  const cat = CATEGORIES[2]; // dinámico [55,75]
  const picks = new Array(5).fill({});
  assert(allocate({ category: cat, riskScore: 60, signal: 'green', topPicks: picks, maxPosPct: cat.maxPosPct }).equityPct === 75);
  assert(allocate({ category: cat, riskScore: 60, signal: 'red', topPicks: picks, maxPosPct: cat.maxPosPct }).equityPct === 55);
  const a = allocate({ category: cat, riskScore: 60, signal: 'amber', topPicks: picks, maxPosPct: cat.maxPosPct });
  assert(a.equityPct === 65 && a.liquidityPct === 35);
});

test('DCA en rojo = 0% de los ingresos; nunca importes fijos', () => {
  const cat = CATEGORIES[1];
  const a = allocate({ category: cat, riskScore: 45, signal: 'red', topPicks: [{}], maxPosPct: 8 });
  assert(a.dcaPct === 0);
  for (const k of ['equityPct', 'liquidityPct', 'perPositionPct', 'dcaPct']) assert(typeof a[k] === 'number');
});

test('Tamaño por posición respeta el tope del perfil', () => {
  const cat = CATEGORIES[3]; // agresivo, maxPos 15
  const a = allocate({ category: cat, riskScore: 90, signal: 'green', topPicks: [{}], maxPosPct: cat.maxPosPct });
  assert(a.perPositionPct <= 15, `${a.perPositionPct}`);
});

console.log('— Límite de 2 portafolios (regla de negocio en store) —');

test('El módulo store bloquea el tercer portafolio', async () => {
  global.localStorage = mkLocalStorage();
  const { createPortfolio, listPortfolios } = await import('../js/core/store.js');
  createPortfolio({ name: 'A', riskLevel: 'moderado' });
  createPortfolio({ name: 'B', riskLevel: 'dinamico' });
  let threw = false;
  try { createPortfolio({ name: 'C', riskLevel: 'agresivo' }); } catch (e) { threw = true; }
  assert(threw, 'debería lanzar al crear el 3º');
  assert(listPortfolios().length === 2);
});

test('Cada portafolio ocupa un slot 1|2 único', async () => {
  const { listPortfolios } = await import('../js/core/store.js');
  const slots = listPortfolios().map(p => p.slot).sort();
  assert(JSON.stringify(slots) === '[1,2]', JSON.stringify(slots));
});

console.log('— Cartera real: tenencias en el store —');

test('addHolding / listHoldings / removeHolding y rechazo de duplicados', async () => {
  const store = await import('../js/core/store.js');
  const [pf] = store.listPortfolios();
  assert(store.listHoldings(pf.id).length === 0);
  const h1 = store.addHolding(pf.id, { assetId: 'AAPL', note: 'compré en 2021' });
  store.addHolding(pf.id, { assetId: 'MSFT' });
  assert(store.listHoldings(pf.id).length === 2);
  let threw = false;
  try { store.addHolding(pf.id, { assetId: 'AAPL' }); } catch { threw = true; }
  assert(threw, 'debería rechazar activo duplicado');
  store.removeHolding(pf.id, h1.id);
  const rest = store.listHoldings(pf.id);
  assert(rest.length === 1 && rest[0].assetId === 'MSFT', JSON.stringify(rest));
});

test('Las tenencias están aisladas por portafolio', async () => {
  const store = await import('../js/core/store.js');
  const [pf1, pf2] = store.listPortfolios();
  store.addHolding(pf2.id, { assetId: 'KO' });
  assert(store.listHoldings(pf1.id).some(h => h.assetId === 'MSFT'));
  assert(!store.listHoldings(pf1.id).some(h => h.assetId === 'KO'));
  assert(store.listHoldings(pf2.id).some(h => h.assetId === 'KO'));
});

console.log('— Evaluación de tenencias (mantener/reducir/vender) —');

test('evaluateHolding: alcista sano → mantener con salud alta', () => {
  const r = evaluateHolding({ regime: 'alcista', rsi: 55, vol: 0.15, drawdown: -0.02, momentum: 0.12, distSmaLong: 0.08 });
  assert(r.action === 'mantener', r.action);
  assert(r.health >= 65, `salud=${r.health}`);
});

test('evaluateHolding: bajista + momentum negativo + vol extrema → vender (urgencia alta)', () => {
  const r = evaluateHolding({ regime: 'bajista', rsi: 35, vol: 0.5, drawdown: -0.35, momentum: -0.25, distSmaLong: -0.12 });
  assert(r.action === 'vender' && r.urgency === 'alta', JSON.stringify(r));
  assert(r.health <= 30, `salud=${r.health}`);
});

test('evaluateHolding: bajista suave → reducir', () => {
  const r = evaluateHolding({ regime: 'bajista', rsi: 45, vol: 0.18, drawdown: -0.08, momentum: 0.02, distSmaLong: -0.03 });
  assert(r.action === 'reducir', r.action);
});

test('evaluateHolding: alcista sobrecomprado con vol alta → reducir (toma de beneficios)', () => {
  const r = evaluateHolding({ regime: 'alcista', rsi: 82, vol: 0.30, drawdown: -0.01, momentum: 0.20, distSmaLong: 0.15 });
  assert(r.action === 'reducir', r.action);
});

test('evaluateHolding: caída protectora con vol alta → reducir', () => {
  const r = evaluateHolding({ regime: 'transicion', rsi: 48, vol: 0.28, drawdown: -0.20, momentum: -0.05, distSmaLong: 0.0 });
  assert(r.action === 'reducir', r.action);
});

test('evaluateHolding: estado insuficiente → null', () => {
  assert(evaluateHolding(null) === null);
  assert(evaluateHolding({ regime: 'alcista', rsi: null, vol: null }) === null);
});

test('evaluateHolding sobre datos reales: JNJ en el crash COVID no es "mantener"', () => {
  const bundle = JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
  const an = new SeriesAnalyzer(bundle.series.JNJ);
  const i = bundle.dates.indexOf('2020-03-23');
  const r = evaluateHolding(an.stateAt(i));
  assert(r && r.action !== 'mantener', `acción=${r?.action}`);
});

console.log('— Pipeline end-to-end sobre datos reales —');

test('generateRecommendations produce salida coherente (2021, alcista)', () => {
  const bundle = JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
  const analyzers = new Map();
  const seriesFor = (a) => {
    if (!analyzers.has(a.id)) analyzers.set(a.id, bundle.series[a.series] ? new SeriesAnalyzer(bundle.series[a.series]) : null);
    return analyzers.get(a.id);
  };
  const i = bundle.dates.indexOf('2021-06-01');
  assert(i > 0, 'fecha no encontrada');
  const out = generateRecommendations({
    assets: ASSETS, seriesFor, dateIndex: i,
    indexAnalyzer: new SeriesAnalyzer(bundle.series.SP500),
    profile: { score: 60, category: CATEGORIES[2] },
    capitalMid: 12500, incomeMid: 2750,
    broker: getBroker('traderepublic'),
    history: [], now: new Date('2021-06-01').getTime(),
  });
  assert(out.timing && ['green', 'amber'].includes(out.timing.signal), out.timing?.signal);
  assert(out.recommendations.length > 0 && out.recommendations.length <= DEFAULT_PARAMS.topN);
  for (const r of out.recommendations) {
    assert(r.percentOfCapital > 0 && r.percentOfCapital <= 15, `pos=${r.percentOfCapital}`);
    assert(Array.isArray(r.rationale) && r.rationale.length >= 2);
  }
  assert(out.allocation.equityPct + out.allocation.liquidityPct === 100);
});

test('En marzo de 2009 (suelo tras Lehman) el semáforo NO es verde', () => {
  const bundle = JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
  const idx = new SeriesAnalyzer(bundle.series.SP500);
  const i = bundle.dates.indexOf('2009-03-09');
  const t = timingSignal(idx.stateAt(i));
  assert(t.signal !== 'green', t.signal);
});

test('El bróker filtra: BBVA (sin ETFs ni acciones USA baratas) vs IBKR', () => {
  const bundle = JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
  const analyzers = new Map();
  const seriesFor = (a) => {
    if (!analyzers.has(a.id)) analyzers.set(a.id, bundle.series[a.series] ? new SeriesAnalyzer(bundle.series[a.series]) : null);
    return analyzers.get(a.id);
  };
  const i = bundle.dates.indexOf('2021-06-01');
  const base = {
    assets: ASSETS, seriesFor, dateIndex: i,
    indexAnalyzer: new SeriesAnalyzer(bundle.series.SP500),
    profile: { score: 60, category: CATEGORIES[2] },
    capitalMid: 12500, incomeMid: 2750, history: [], now: new Date('2021-06-01').getTime(),
  };
  const ibkr = generateRecommendations({ ...base, broker: getBroker('ibkr') });
  const bbva = generateRecommendations({ ...base, broker: getBroker('bbva') });
  assert(ibkr.recommendations.length >= bbva.recommendations.length);
  for (const r of bbva.recommendations) assert(r.assetClass !== 'etf', 'BBVA no ofrece ETFs en el catálogo MVP');
});

test('Una serie con cola de nulls se evalúa en su último dato real (no desaparece)', () => {
  const clean = Array.from({ length: 400 }, (_, i) => 100 * Math.exp(0.001 * i));
  const stale = [...clean, ...new Array(50).fill(null)];
  const a1 = new SeriesAnalyzer(clean);
  const a2 = new SeriesAnalyzer(stale);
  assert(a2.lastValid === 399, `lastValid=${a2.lastValid}`);
  const r = rankAssets([
    { asset: { id: 'CLEAN', assetClass: 'equity' }, analyzer: a1 },
    { asset: { id: 'STALE', assetClass: 'equity' }, analyzer: a2 },
  ], 449, null);
  assert(r.length === 2, `solo ${r.length} activos rankeados`);
  approx(r[0].score, r[1].score, 1e-9, 'misma serie → misma puntuación');
});

console.log('— Fiabilidad estadística (backtest/lib) —');

const { simStrategy, simBuyHold, permutationTest, deflatedSharpe, normCdf, rng, walkForward, makeIndicatorCache, computeTimingSeries, gridSearch } = await import('../backtest/lib.mjs');

test('normCdf: valores conocidos', () => {
  approx(normCdf(0), 0.5, 1e-6);
  approx(normCdf(1.96), 0.975, 2e-3);
  approx(normCdf(-1.96), 0.025, 2e-3);
  assert(normCdf(6) > 0.999999);
});

test('rng determinista y en [0,1)', () => {
  const a = rng(42), b = rng(42);
  for (let i = 0; i < 100; i++) { const v = a(); assert(v >= 0 && v < 1); approx(v, b(), 1e-12); }
});

test('simStrategy: los costes reducen el capital final y la liquidez remunerada lo sube', () => {
  // serie con tramos alcistas y bajistas para que el semáforo cambie de exposición
  const vals = [];
  for (let i = 0; i < 900; i++) vals.push(100 * Math.exp(0.0004 * i + 0.15 * Math.sin(i / 40)));
  const cache = makeIndicatorCache(vals);
  const sig = computeTimingSeries(cache, DEFAULT_PARAMS);
  const free = simStrategy(vals, sig, 260, vals.length, { costBps: 0, cashYield: 0 });
  const costly = simStrategy(vals, sig, 260, vals.length, { costBps: 50, cashYield: 0 });
  const remun = simStrategy(vals, sig, 260, vals.length, { costBps: 0, cashYield: 0.04 });
  assert(costly.finalMultiple <= free.finalMultiple, 'coste no reduce capital');
  assert(free.trades > 0, 'no hubo operaciones para cobrar coste');
  if (free.avgExposure < 0.99) assert(remun.finalMultiple >= free.finalMultiple, 'liquidez remunerada no mejora');
});

test('permutationTest: señal informativa → p pequeño; señal aleatoria → p no pequeño', () => {
  // regímenes APERIÓDICOS (cambian con baja probabilidad): la señal refleja el
  // régimen actual y predice de verdad el tramo siguiente. Al ser aperiódicos,
  // los desplazamientos circulares desalinean señal↔futuro → p pequeño.
  const n = 4000, vals = [100], sig = [null];
  const rand = rng(3);
  let up = true;
  for (let i = 1; i < n; i++) {
    if (rand() < 1 / 150) up = !up;           // cambio de régimen ocasional
    vals.push(vals[i - 1] * (1 + (up ? 0.0015 : -0.0015)));
    sig.push(up ? 'green' : 'red');
  }
  const informative = permutationTest(vals, sig, 63, 0, n, { iters: 1500, seed: 1 });
  assert(informative.pValue < 0.05, `p informativa=${informative.pValue}`);
  assert(informative.observed > 0.05, `diff observada=${informative.observed}`);
  // señal aleatoria sobre los mismos precios: no debe ser significativa
  const rsig = sig.map((_, i) => i < 1 ? null : (rand() < 0.5 ? 'green' : 'red'));
  const noise = permutationTest(vals, rsig, 63, 0, n, { iters: 1500, seed: 2 });
  assert(noise.pValue > 0.1, `ruido demasiado significativo: ${noise.pValue}`);
});

test('deflatedSharpe: umbral crece con nº de pruebas y DSR alto para señal fuerte', () => {
  const rand = rng(9);
  // retornos con Sharpe positivo claro
  const rets = Array.from({ length: 2000 }, () => 0.0006 + (rand() - 0.5) * 0.01);
  const few = deflatedSharpe(rets, 2, []);
  const many = deflatedSharpe(rets, 1000, []);
  assert(many.thresholdAnnual > few.thresholdAnnual, 'umbral no crece con nº de pruebas');
  assert(few.dsr > 0.9, `DSR bajo para señal fuerte: ${few.dsr}`);
  assert(deflatedSharpe([0.001], 10, []) === null, 'muestra corta no devuelve null');
});

test('walkForward: las señales OOS solo existen tras la primera ventana de entrenamiento', () => {
  const vals = [];
  for (let i = 0; i < 3000; i++) vals.push(100 * Math.exp(0.0003 * i + 0.2 * Math.sin(i / 80)));
  const cache = makeIndicatorCache(vals);
  const grid = { smaLong: [150, 200], smaShort: [50], rsiOverbought: [70, 80], rsiOversold: [30], volHigh: [0.25], volExtreme: [0.45], ddDeep: [-0.25] };
  const wf = walkForward(cache, grid, { rsiPeriod: 14, volWindow: 30, topN: 5, fwdHorizon: 63 }, { trainDays: 252 * 4, testDays: 252, start: 260 });
  assert(wf.windows >= 2, `pocas ventanas: ${wf.windows}`);
  for (let i = 0; i < wf.from; i++) assert(wf.oosSignals[i] === null, `señal OOS antes del primer test en i=${i}`);
  assert(wf.oosSignals.slice(wf.from, wf.to).some(s => s != null), 'sin señales OOS en el tramo de test');
  assert(wf.strat.years > 1, 'tramo OOS demasiado corto');
});

console.log('— Actualizador de datos (empalme Stooq) —');

const { parseStooqCsv, parseYahooChart, parseFredCsv, spliceSeries, updateBundle } = await import('../tools/update-data.mjs');

test('parseFredCsv extrae observaciones y descarta puntos faltantes (".")', () => {
  const rows = parseFredCsv('observation_date,SP500\n2026-07-01,6200.5\n2026-07-02,.\n2026-07-03,6250.1\n');
  assert(rows.length === 2 && rows[1].close === 6250.1, JSON.stringify(rows));
});

test('parseStooqCsv extrae fechas y cierres, tolera CRLF', () => {
  const rows = parseStooqCsv('Date,Open,High,Low,Close,Volume\r\n2023-01-02,10,11,9,10.5,100\r\n2023-01-03,10.5,12,10,11,90\r\n');
  assert(rows.length === 2 && rows[1].close === 11, JSON.stringify(rows));
});

test('parseYahooChart usa adjclose y descarta nulls', () => {
  const ts = [1672704000, 1672790400, 1672876800]; // 2023-01-03..05 UTC
  const rows = parseYahooChart({ chart: { result: [{ timestamp: ts, indicators: { adjclose: [{ adjclose: [100, null, 102] }], quote: [{ close: [99, 100, 101] }] } }] } });
  assert(rows.length === 2, JSON.stringify(rows));
  assert(rows[0].date === '2023-01-03' && rows[0].close === 100);
  assert(rows[1].close === 102);
});

test('parseYahooChart rechaza respuestas HTML/errores', () => {
  let threw = false;
  try { parseYahooChart({ chart: { error: { code: 'Not Found' } } }); } catch { threw = true; }
  assert(threw);
});

test('spliceSeries empalma con factor de escala y respeta el calendario', () => {
  const bundle = { dates: ['2022-12-27', '2022-12-28'], series: { X: [100, 102] } };
  // Stooq da niveles un 2% más bajos (sin dividendos): factor = 102/100 = 1.02
  const rows = [
    { date: '2022-12-28', close: 100 },
    { date: '2022-12-29', close: 101 },
    { date: '2022-12-30', close: 99 },
  ];
  const newDates = [...bundle.dates, '2022-12-29', '2022-12-30'];
  const added = spliceSeries(bundle, 'X', rows, newDates);
  assert(added === 2, `added=${added}`);
  approx(bundle.series.X[2], 103.02, 1e-9);
  approx(bundle.series.X[3], 100.98, 1e-9);
});

test('spliceSeries rechaza desviaciones de empalme sospechosas (>25%)', () => {
  const bundle = { dates: ['2022-12-28'], series: { X: [100] } };
  const rows = [{ date: '2022-12-28', close: 60 }, { date: '2022-12-29', close: 61 }];
  let threw = false;
  try { spliceSeries(bundle, 'X', rows, ['2022-12-28', '2022-12-29']); } catch { threw = true; }
  assert(threw, 'debería rechazar factor 1.67');
});

test('updateBundle extiende el calendario con el índice y tolera fallos por serie', async () => {
  const bundle = JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
  const lastDate = bundle.dates[bundle.dates.length - 1];
  const spLast = bundle.series.SP500[bundle.series.SP500.length - 1];
  const dPlus = (n) => new Date(new Date(lastDate).getTime() + n * 86400000).toISOString().slice(0, 10);
  const fakeFetcher = async (key) => {
    if (key === 'SP500') return [
      { date: lastDate, close: spLast },
      { date: dPlus(1), close: spLast * 1.01 },
      { date: dPlus(2), close: spLast * 1.02 },
    ];
    throw new Error('simulated outage');
  };
  const { added, failures } = await updateBundle(bundle, fakeFetcher);
  assert(added === 2, `added=${added}`);
  assert(failures.length === 25, `failures=${failures.length}`);
  assert(bundle.meta.end === dPlus(2), bundle.meta.end);
  assert(bundle.dates.length === bundle.series.SP500.length, 'calendario y serie desalineados');
  assert(bundle.series.AAPL.length === bundle.dates.length, 'series con fallo no rellenadas con null');
  assert(bundle.series.AAPL[bundle.dates.length - 1] === null);
});

function mkLocalStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
  };
}

console.log(`\n${passed} pasados, ${failed} fallidos`);
process.exit(failed ? 1 : 0);
