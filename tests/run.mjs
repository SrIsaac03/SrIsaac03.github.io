// Suite de tests del Copiloto de Inversión. Uso: node tests/run.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sma, ema, rsi, macd, rollingVolatility, drawdownFromHigh, momentum12m1, dailyReturns } from '../js/core/indicators.js';
import { SeriesAnalyzer, timingSignal, confirmedTiming, allocate, eligibilityFilter, rankAssets, generateRecommendations, DEFAULT_PARAMS } from '../js/core/engine.js';
import { scoreTest, QUESTIONS, CATEGORIES } from '../js/core/profile.js';
import { BROKERS, getBroker, brokerTerms } from '../js/core/brokers.js';
import { computeFeedbackAdjustments, isSuppressed, REJECT_REASONS } from '../js/core/feedback.js';
import { ASSETS, getAsset } from '../js/core/assets.js';
import { derivePreferences } from '../js/core/preferences.js';
import { portfolioSnapshot, positionSnapshot, normalizeHolding, valuationHistory } from '../js/core/holdings.js';
import { xirr, moneyWeightedReturn, timeWeightedReturn, contributionBreakdown, averageHoldingYears } from '../js/core/returns.js';
import { reviewHolding, reviewPortfolio, healthScore } from '../js/core/review.js';
import { generateStrategyOptions } from '../js/core/strategies.js';
// El store lee localStorage de forma perezosa, así que basta con dejar el shim
// puesto antes de llamar a sus funciones. Importarlo estáticamente evita tests
// `async`, que el arnés no sabía esperar (sus fallos se perdían en silencio).
globalThis.localStorage = mkLocalStorage();
import * as storeMod from '../js/core/store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      throw new Error('los tests deben ser síncronos: el arnés no espera promesas');
    }
    passed++; console.log(`  ✓ ${name}`);
  } catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
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

console.log('— Carteras (sin límite de número) —');

test('Sin límite de carteras: se pueden crear todas las que hagan falta', () => {
  const { createPortfolio, listPortfolios, archivePortfolio } = storeMod;
  createPortfolio({ name: 'A', riskLevel: 'moderado' });
  createPortfolio({ name: 'B', riskLevel: 'dinamico' });
  const c = createPortfolio({ name: 'C', riskLevel: 'agresivo' });
  const d = createPortfolio({ name: 'D', riskLevel: 'conservador' });
  assert(listPortfolios().length === 4, `${listPortfolios().length} carteras`);
  // archivar sigue sacándolas del balance sin borrar su historia
  archivePortfolio(c.id); archivePortfolio(d.id);
  assert(listPortfolios().length === 2);
});

test('Cada cartera tiene id propio y nombre por defecto si no se da', () => {
  const { createPortfolio, listPortfolios, archivePortfolio, renamePortfolio } = storeMod;
  const ids = new Set(listPortfolios().map(p => p.id));
  assert(ids.size === listPortfolios().length, 'ids duplicados');
  const sinNombre = createPortfolio({ name: '   ', riskLevel: 'moderado' });
  assert(/^Cartera \d+$/.test(sinNombre.name), `nombre por defecto: ${sinNombre.name}`);
  renamePortfolio(sinNombre.id, '  Jubilación  ');
  assert(listPortfolios().find(p => p.id === sinNombre.id).name === 'Jubilación', 'no recorta espacios');
  renamePortfolio(sinNombre.id, '   ');
  assert(listPortfolios().find(p => p.id === sinNombre.id).name === 'Jubilación', 'un nombre vacío no debe borrar el anterior');
  archivePortfolio(sinNombre.id);
});

console.log('— Preferencias derivadas de las respuestas del test —');

test('Necesitar el dinero en 3 años descarta la cripto y baja el techo de volatilidad', () => {
  const answers = {}; for (const q of QUESTIONS) answers[q.id] = 2;
  answers.q10 = 4; // "necesitaré el dinero en los próximos 3 años"
  const p = derivePreferences(answers);
  assert(p.horizon === 'corto', p.horizon);
  assert(p.excludeClasses.includes('crypto'), 'debería excluir cripto');
  assert(p.volCap <= 0.18, `volCap=${p.volCap}`);
  assert(p.notes.some(n => n.from === 'q10'), 'debe explicar por qué');
});

test('Perfil ansioso y sin experiencia prefiere ETFs y limita volatilidad', () => {
  const answers = {}; for (const q of QUESTIONS) answers[q.id] = 2;
  answers.q4 = 4; answers.q1 = 4; answers.q11 = 0; answers.q6 = 0;
  const p = derivePreferences(answers);
  assert(p.preferDiversified, 'debería preferir diversificado');
  assert(p.volCap <= 0.22, `volCap=${p.volCap}`);
  assert(p.tilt === 'defensivo', p.tilt);
});

test('Perfil experimentado y contrarian no excluye clases y permite promediar', () => {
  const answers = {}; for (const q of QUESTIONS) answers[q.id] = 4;
  answers.q1 = 0; answers.q4 = 0; answers.q5 = 0; answers.q10 = 0; // invertidas al mínimo
  const p = derivePreferences(answers);
  assert(p.excludeClasses.length === 0, JSON.stringify(p.excludeClasses));
  assert(p.allowContrarianDCA, 'debería permitir DCA contrarian');
  assert(p.tilt === 'crecimiento', p.tilt);
});

test('Sin respuestas guardadas devuelve preferencias neutras sin romperse', () => {
  const p = derivePreferences(undefined);
  assert(p.tilt && p.volCap > 0 && Array.isArray(p.excludeClasses));
});

console.log('— Cartera local: valoración y pesos —');

test('portfolioSnapshot calcula coste, valor, plusvalía y pesos', () => {
  const holdings = [
    { id: 'h1', assetId: 'AAPL', assetClass: 'equity', units: 10, entryPrice: 100 },
    { id: 'h2', assetId: 'KO', assetClass: 'equity', units: 20, entryPrice: 50 },
  ];
  const prices = { h1: 150, h2: 50 };
  const s = portfolioSnapshot(holdings, h => prices[h.id], { capitalBase: 4000 });
  approx(s.totalCost, 2000);
  approx(s.totalValue, 2500);
  approx(s.pnl, 500);
  approx(s.pnlPct, 0.25);
  const aapl = s.positions.find(p => p.assetId === 'AAPL');
  approx(aapl.pnlPct, 0.5);
  approx(aapl.weightPct, 60);          // 1500 de 2500
  approx(aapl.capitalPct, 37.5);       // 1500 de 4000 de capital
  approx(s.investedPct, 62.5);
  approx(s.liquidityPct, 37.5);
});

test('Una posición sin precio se valora a coste y marca la cartera como incompleta', () => {
  const s = portfolioSnapshot(
    [{ id: 'h1', assetId: 'X', assetClass: 'etf', units: 5, entryPrice: 20 }],
    () => null, { capitalBase: 1000 },
  );
  assert(s.stale, 'debería marcarse stale');
  approx(s.totalValue, 100);
  assert(s.positions[0].pnl === null, 'sin precio no hay plusvalía inventada');
});

test('Migración: una posición del modelo antiguo deriva importe y aportación', () => {
  const t = Date.parse('2024-01-01');
  const old = { id: 'h1', assetId: 'AAPL', units: 10, entryPrice: 100, addedAt: t };
  const n = normalizeHolding(old);
  approx(n.invested, 1000);
  assert(n.contributions.length === 1 && n.contributions[0].ts === t, JSON.stringify(n.contributions));
  const p = positionSnapshot(old, 150);
  approx(p.value, 1500); approx(p.pnlPct, 0.5);
});

test('Migración: el modelo con importe agregado se convierte en una aportación', () => {
  const t = Date.parse('2025-03-01');
  const n = normalizeHolding({ id: 'h1', invested: 800, addedAt: t });
  assert(n.contributions.length === 1, JSON.stringify(n.contributions));
  approx(n.contributions[0].amount, 800);
  assert(n.contributions[0].ts === t);
});

test('invested es siempre la suma de las aportaciones', () => {
  const n = normalizeHolding({ contributions: [
    { ts: Date.parse('2026-01-01'), amount: 500 },
    { ts: Date.parse('2027-04-03'), amount: 300 },
    { ts: Date.parse('2027-06-01'), amount: -100 }, // retirada
  ] });
  approx(n.invested, 700);
});

test('Bruto vs neto: aportado, retirado y obtenido se distinguen', () => {
  // pusiste 1000, vendiste 200, lo que queda vale 900 → ganancia real +100
  const s = portfolioSnapshot([{
    id: 'h1', assetId: 'X', assetClass: 'etf', addedAt: Date.parse('2026-01-01'),
    contributions: [
      { ts: Date.parse('2026-01-01'), amount: 1000 },
      { ts: Date.parse('2027-01-01'), amount: -200 },
    ],
    valuations: [{ ts: Date.parse('2027-06-01'), value: 900 }],
  }], () => null, { now: Date.parse('2027-06-02') });
  approx(s.contributed, 1000);   // lo que pusiste de verdad
  approx(s.withdrawn, 200);
  approx(s.totalCost, 800);      // aportado NETO
  approx(s.totalValue, 900);
  approx(s.obtained, 1100);      // 200 en el bolsillo + 900 en cartera
  approx(s.pnl, 100);            // 1100 − 1000, la ganancia real
  approx(s.pnlPct, 0.125);
});

test('Aportar más empuja la rentabilidad simple hacia el 0% en ambos sentidos', () => {
  const mk = (extra, value) => portfolioSnapshot([{
    id: 'h1', assetId: 'X', assetClass: 'etf', addedAt: Date.parse('2026-01-01'),
    contributions: [{ ts: Date.parse('2026-01-01'), amount: 1000 },
      ...(extra ? [{ ts: Date.parse('2027-01-01'), amount: extra }] : [])],
    valuations: [{ ts: Date.parse('2027-01-01'), value: value + extra }],
  }], () => null, { now: Date.parse('2027-01-02') });

  // en ganancias: aportar diluye el porcentaje…
  const gain = mk(0, 1200).pnlPct, gainPlus = mk(1000, 1200).pnlPct;
  assert(gainPlus < gain && gainPlus > 0, `${gain} → ${gainPlus}`);
  // …y en pérdidas lo disimula, acercándolo también a cero
  const loss = mk(0, 800).pnlPct, lossPlus = mk(1000, 800).pnlPct;
  assert(lossPlus > loss && lossPlus < 0, `${loss} → ${lossPlus}`);
  // el importe absoluto, en cambio, no se mueve por aportar
  approx(mk(0, 800).pnl, mk(1000, 800).pnl, 1e-9);
});

console.log('— Rentabilidades con aportaciones en distintas fechas —');

const YEAR = 365.25 * 86400000;

test('XIRR: una sola aportación que gana un 10% en un año → 10%', () => {
  const t0 = Date.parse('2026-01-01');
  const r = xirr([{ ts: t0, amount: -1000 }, { ts: t0 + YEAR, amount: 1100 }]);
  approx(r, 0.10, 1e-4, `${r}`);
});

test('XIRR: dos aportaciones en fechas distintas no dan la rentabilidad simple', () => {
  const t0 = Date.parse('2026-01-01');
  // 1000 € al inicio + 1000 € al año; vale 2200 € a los dos años.
  // La rentabilidad simple diría 10% (2200/2000), pero la mitad del dinero
  // solo llevaba un año dentro: la TIR real es mayor.
  const r = xirr([
    { ts: t0, amount: -1000 },
    { ts: t0 + YEAR, amount: -1000 },
    { ts: t0 + 2 * YEAR, amount: 2200 },
  ]);
  assert(r > 0.05 && r < 0.10, `TIR=${r}`);
  // comprobación independiente: el VAN a esa tasa debe anularse
  const npv = -1000 - 1000 / (1 + r) + 2200 / Math.pow(1 + r, 2);
  approx(npv, 0, 1e-6, `VAN=${npv}`);
});

test('XIRR: sin recorrido suficiente no se anualiza (evita cifras absurdas)', () => {
  const t0 = Date.now();
  const r = xirr([{ ts: t0, amount: -1000 }, { ts: t0 + 5 * 86400000, amount: 1020 }]);
  assert(r === null, `un +2% en 5 días no es un ${r} anual`);
});

test('XIRR: flujos sin cambio de signo o insuficientes → null', () => {
  assert(xirr([]) === null);
  assert(xirr([{ ts: 0, amount: -100 }]) === null);
  assert(xirr([{ ts: 0, amount: -100 }, { ts: YEAR, amount: -100 }]) === null);
});

test('moneyWeightedReturn invierte el signo de las aportaciones correctamente', () => {
  const t0 = Date.parse('2026-01-01');
  const r = moneyWeightedReturn({
    contributions: [{ ts: t0, amount: 1000 }],
    currentValue: 1100, now: t0 + YEAR,
  });
  approx(r, 0.10, 1e-4, `${r}`);
});

test('El ejemplo real: 500 € el 1/1/26 y 300 € el 3/4/27', () => {
  const c = [
    { ts: Date.parse('2026-01-01'), amount: 500 },
    { ts: Date.parse('2027-04-03'), amount: 300 },
  ];
  const now = Date.parse('2028-01-01');
  const r = moneyWeightedReturn({ contributions: c, currentValue: 900, now });
  assert(r != null && r > 0, `TIR=${r}`);
  // la rentabilidad simple (900/800 = 12,5%) es de todo el periodo;
  // la TIR es anual, y el segundo tramo llevaba menos tiempo dentro
  const simple = 900 / 800 - 1;
  assert(Math.abs(r - simple) > 1e-3, 'la TIR no debería coincidir con la simple');
  const yrs = averageHoldingYears(c, now);
  assert(yrs > 1 && yrs < 2, `antigüedad media ${yrs} años`);
});

test('TWR encadena los tramos y descuenta el dinero aportado en cada uno', () => {
  const t0 = Date.parse('2026-01-01'), t1 = Date.parse('2027-01-01'), t2 = Date.parse('2028-01-01');
  // 1000 → 1100 (+10%), luego entran 1000 más (2100) → 2310 (+10%)
  const out = timeWeightedReturn({
    valuations: [{ ts: t0, value: 1000 }, { ts: t1, value: 2100 }],
    contributions: [{ ts: t0, amount: 1000 }, { ts: t1, amount: 1000 }],
    currentValue: 2310, now: t2,
  });
  assert(out != null, 'debería poder calcularse');
  approx(out.total, 0.21, 1e-6, `total=${out.total}`);   // 1,10 × 1,10 − 1
  approx(out.annualized, 0.10, 1e-3, `anual=${out.annualized}`);
  assert(out.periods.length === 2, `${out.periods.length} tramos`);
  approx(out.periods[0].ret, 0.10, 1e-6);
  approx(out.periods[1].ret, 0.10, 1e-6);
});

test('TWR necesita valoraciones intermedias: sin ellas devuelve null', () => {
  assert(timeWeightedReturn({ valuations: [], contributions: [{ ts: 0, amount: 100 }], currentValue: null }) === null);
});

test('contributionBreakdown detalla cada tramo con su antigüedad', () => {
  const now = Date.parse('2028-01-01');
  const b = contributionBreakdown([
    { ts: Date.parse('2027-04-03'), amount: 300 },
    { ts: Date.parse('2026-01-01'), amount: 500 },
  ], now);
  assert(b[0].ts < b[1].ts, 'debe venir ordenado por fecha');
  approx(b[0].amount, 500);
  assert(b[0].years > b[1].years, 'el dinero más antiguo lleva más tiempo dentro');
  assert(b.every(x => x.kind === 'aportacion'));
});

test('La cartera agrega los flujos de todas sus posiciones para la TIR', () => {
  const now = Date.parse('2028-01-01');
  const hs = [
    { id: 'a', assetId: 'X', assetClass: 'etf', addedAt: Date.parse('2026-01-01'),
      contributions: [{ ts: Date.parse('2026-01-01'), amount: 500 }], valuations: [{ ts: now, value: 600 }] },
    { id: 'b', assetId: 'Y', assetClass: 'etf', addedAt: Date.parse('2027-04-03'),
      contributions: [{ ts: Date.parse('2027-04-03'), amount: 300 }], valuations: [{ ts: now, value: 330 }] },
  ];
  const s = portfolioSnapshot(hs, () => null, { now });
  approx(s.totalCost, 800);
  approx(s.totalValue, 930);
  assert(s.contributions.length === 2, 'debe reunir las aportaciones de ambas posiciones');
  assert(s.irr != null && s.irr > 0, `TIR=${s.irr}`);
  assert(s.avgYears > 1 && s.avgYears < 2, `antigüedad media ${s.avgYears}`);
});

test('Una posición sin unidades se valora por el importe que anotó el usuario', () => {
  const now = Date.parse('2026-06-01');
  const h = { id: 'h1', assetId: 'X', invested: 1000, units: 0, addedAt: Date.parse('2024-06-01'),
    valuations: [{ ts: Date.parse('2026-05-30'), value: 1300 }] };
  const p = positionSnapshot(h, null, { now });
  approx(p.value, 1300);
  approx(p.pnlPct, 0.3);
  assert(p.valueSource === 'manual', p.valueSource);
  assert(p.staleDays === 2, `${p.staleDays}`);
  // aportación única hace 2 años: +30% total ≈ 14% anual
  assert(p.irr > 0.13 && p.irr < 0.15, `TIR=${p.irr}`);
});

test('Gana el dato más fresco: valoración manual vs precio de mercado', () => {
  const base = { id: 'h1', assetId: 'X', invested: 1000, units: 10,
    valuations: [{ ts: Date.parse('2026-05-01'), value: 1300 }] };
  // precio de mercado más antiguo que la anotación → manda el usuario
  const stale = positionSnapshot(base, 200, { priceTs: Date.parse('2022-12-30') });
  approx(stale.value, 1300);
  assert(stale.valueSource === 'manual');
  // precio de mercado más reciente → manda el mercado
  const fresh = positionSnapshot(base, 200, { priceTs: Date.parse('2026-05-20') });
  approx(fresh.value, 2000);
  assert(fresh.valueSource === 'mercado');
});

test('Sin valorar: la posición cuenta a coste y queda marcada como pendiente', () => {
  const s = portfolioSnapshot([{ id: 'h1', assetId: 'X', assetClass: 'etf', invested: 500 }],
    () => null, { capitalBase: 1000 });
  assert(s.unvalued === 1 && s.stale, JSON.stringify({ u: s.unvalued, s: s.stale }));
  approx(s.totalValue, 500);
  assert(s.positions[0].pnl === null, 'sin valor no se inventa plusvalía');
});

test('valuationHistory reconstruye la evolución con lo que se fue anotando', () => {
  const d = s => Date.parse(s);
  const hs = [
    { id: 'a', invested: 1000, addedAt: d('2026-01-01'), valuations: [{ ts: d('2026-02-01'), value: 1100 }, { ts: d('2026-03-01'), value: 1250 }] },
    { id: 'b', invested: 500, addedAt: d('2026-01-01'), valuations: [{ ts: d('2026-03-01'), value: 480 }] },
  ];
  const hist = valuationHistory(hs);
  assert(hist.length === 2, `${hist.length} puntos`);
  approx(hist[0].value, 1600); // 1100 + b aún a coste (500)
  approx(hist[1].value, 1730); // 1250 + 480
  approx(hist[1].cost, 1500);
  assert(hist[0].date === '2026-02-01' && hist[1].date === '2026-03-01');
});

console.log('— Revisión de cartera: cuándo vender —');

const upTrend = Array.from({ length: 600 }, (_, i) => 100 * Math.pow(1.0008, i));
const downTrend = Array.from({ length: 600 }, (_, i) =>
  i < 250 ? 100 * Math.pow(1.001, i) : 100 * Math.pow(1.001, 250) * Math.pow(0.9975, i - 250));
const stateOfSeries = (vals) => {
  const an = new SeriesAnalyzer(vals);
  return an.stateAt(vals.length - 1);
};
const prefsNeutral = derivePreferences(Object.fromEntries(QUESTIONS.map(q => [q.id, 2])));
const mkPos = (over) => ({ assetId: 'X', units: 10, entryPrice: 100, capitalPct: 5, pnlPct: 0.1, ...over });

test('Ruptura de tendencia (bajista + momentum negativo) → vender', () => {
  const r = reviewHolding({
    position: mkPos({}), asset: { id: 'X', assetClass: 'equity' },
    state: stateOfSeries(downTrend), capPct: 8, preferences: prefsNeutral,
  });
  assert(r.verdict === 'vender', r.verdict);
  assert(r.targetPct === 0, `${r.targetPct}`);
  assert(r.reasons.some(x => /media de 200|momentum/i.test(x)), r.reasons.join(' | '));
});

test('El contrarian declarado en el test aguanta la caída profunda en vez de vender', () => {
  const contrarian = { ...prefsNeutral, allowContrarianDCA: true };
  const state = stateOfSeries(downTrend);
  // solo aplica si de verdad hay sobreventa y caída profunda
  if (state.drawdown < DEFAULT_PARAMS.ddDeep && state.rsi < DEFAULT_PARAMS.rsiOversold) {
    const r = reviewHolding({ position: mkPos({}), asset: { id: 'X', assetClass: 'equity' }, state, capPct: 8, preferences: contrarian });
    assert(r.verdict !== 'vender', `${r.verdict}: el contrarian no debería vender en sobreventa profunda`);
  }
});

test('Tendencia alcista con poco peso → reforzar; con exceso de peso → reducir', () => {
  const state = stateOfSeries(upTrend);
  const small = reviewHolding({ position: mkPos({ capitalPct: 2 }), asset: { id: 'X', assetClass: 'equity' }, state, capPct: 8, preferences: prefsNeutral });
  assert(small.verdict === 'reforzar', small.verdict);
  const big = reviewHolding({ position: mkPos({ capitalPct: 30 }), asset: { id: 'X', assetClass: 'equity' }, state, capPct: 8, preferences: prefsNeutral });
  assert(big.verdict === 'reducir', big.verdict);
  approx(big.targetPct, 8);
  assert(big.reasons.some(x => /Concentración/.test(x)), big.reasons.join(' | '));
});

test('Nunca se vende solo por estar en pérdidas si la tendencia aguanta', () => {
  const r = reviewHolding({
    position: mkPos({ pnlPct: -0.35 }), asset: { id: 'X', assetClass: 'equity' },
    state: stateOfSeries(upTrend), capPct: 8, preferences: prefsNeutral,
  });
  assert(r.verdict !== 'vender' && r.verdict !== 'reducir', r.verdict);
});

test('Sin serie analizable el veredicto es «sin datos», no una venta', () => {
  const r = reviewHolding({ position: mkPos({}), asset: { id: 'X', assetClass: 'crypto' }, state: null, capPct: 8, preferences: prefsNeutral });
  assert(r.verdict === 'sin_datos', r.verdict);
});

test('Sobre datos reales: en el crash del COVID ninguna posición es «mantener»', () => {
  const bundle = JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
  const i = bundle.dates.indexOf('2020-03-23');
  for (const sym of ['JNJ', 'XOM', 'AAPL']) {
    const an = new SeriesAnalyzer(bundle.series[sym]);
    const r = reviewHolding({
      position: mkPos({ assetId: sym }), asset: getAsset(sym),
      state: an.stateAt(i), capPct: 8, preferences: prefsNeutral,
    });
    assert(r.verdict === 'vender' || r.verdict === 'reducir', `${sym}: ${r.verdict} en pleno crash`);
  }
});

test('El índice de salud es 0-100 y ordena bien alcista vs bajista', () => {
  const up = healthScore(stateOfSeries(upTrend));
  const down = healthScore(stateOfSeries(downTrend));
  assert(up >= 0 && up <= 100 && down >= 0 && down <= 100, `${up} / ${down}`);
  assert(up > down, `alcista ${up} debería puntuar más que bajista ${down}`);
  assert(healthScore(null) === null);
});

test('reviewPortfolio resume la salud ponderada por valor de cada posición', () => {
  const snapshot = portfolioSnapshot(
    [{ id: 'h1', assetId: 'AAPL', assetClass: 'equity', units: 10, entryPrice: 100 }],
    () => 100, { capitalBase: 1000 },
  );
  const out = reviewPortfolio({
    snapshot, assetOf: getAsset, stateOf: () => stateOfSeries(upTrend),
    category: CATEGORIES[1], preferences: prefsNeutral,
  });
  assert(out.health != null && out.health >= 0 && out.health <= 100, `salud=${out.health}`);
  approx(out.health, out.reviews[0].health, 1); // una sola posición → misma salud
});

test('reviewPortfolio avisa de la deriva frente al objetivo y de la concentración', () => {
  const snapshot = portfolioSnapshot(
    [{ id: 'h1', assetId: 'AAPL', assetClass: 'equity', units: 10, entryPrice: 100 }],
    () => 100, { capitalBase: 1000 },
  );
  const out = reviewPortfolio({
    snapshot, assetOf: getAsset, stateOf: () => stateOfSeries(upTrend),
    category: CATEGORIES[1], preferences: prefsNeutral, targetEquityPct: 40,
  });
  assert(out.alerts.some(a => /invertido/.test(a.text)), JSON.stringify(out.alerts));
  assert(out.reviews.length === 1);
  assert(out.counts && typeof out.counts === 'object');
});

console.log('— Opciones de cartera (varias, no una prefabricada) —');

test('generateStrategyOptions ofrece varias opciones distintas y todas dentro del perfil', () => {
  const bundle = JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
  const analyzers = new Map();
  const seriesFor = (a) => {
    if (!analyzers.has(a.id)) analyzers.set(a.id, bundle.series[a.series] ? new SeriesAnalyzer(bundle.series[a.series]) : null);
    return analyzers.get(a.id);
  };
  const idx = new SeriesAnalyzer(bundle.series.SP500);
  const i = bundle.dates.indexOf('2021-06-01');
  const category = CATEGORIES[2]; // dinámico
  const out = generateStrategyOptions({
    assets: ASSETS, seriesFor, dateIndex: i, indexAnalyzer: idx,
    profile: { score: 60, category },
    capitalMid: 20000, incomeMid: 3000,
    broker: getBroker('traderepublic'), history: [],
    preferences: derivePreferences(Object.fromEntries(QUESTIONS.map(q => [q.id, 2]))),
    now: Date.parse('2021-06-01'),
  });
  assert(out.strategies.length >= 2, `solo ${out.strategies.length} opciones`);
  const fingerprints = new Set(out.strategies.map(s => s.positions.map(p => p.assetId).join(',')));
  assert(fingerprints.size === out.strategies.length, 'las opciones deben ser distintas entre sí');
  for (const s of out.strategies) {
    assert(s.positions.length >= 2, `${s.id} tiene ${s.positions.length} posiciones`);
    // el objetivo del día siempre cae dentro de la banda del perfil
    assert(s.targetEquityPct <= category.equityRange[1] && s.targetEquityPct >= category.equityRange[0],
      `${s.id}: objetivo ${s.targetEquityPct}% fuera de la banda`);
    // y lo desplegado nunca supera ese objetivo (lo que falte queda en liquidez)
    assert(s.equityPct <= s.targetEquityPct + 0.5, `${s.id}: despliega ${s.equityPct}% sobre un objetivo de ${s.targetEquityPct}%`);
    if (s.underDeployed) assert(s.cons.some(c => /liquidez/.test(c)), `${s.id}: debe explicar por qué no llega al objetivo`);
    for (const p of s.positions) {
      const cap = p.assetId === 'SP500' ? category.maxPosPct * 3 : category.maxPosPct;
      assert(p.pct <= cap + 0.5, `${s.id}: ${p.assetId} pesa ${p.pct}%, sobre el tope ${cap}%`);
    }
    const total = s.positions.reduce((x, p) => x + p.pct, 0);
    approx(total, s.equityPct, 0.51, `${s.id}: las posiciones (${total}) no suman la renta variable (${s.equityPct})`);
    assert(s.fit && s.fit.score >= 0 && s.fit.score <= 100, `${s.id}: fit inválido`);
    assert(s.pros.length && s.cons.length, `${s.id} debe declarar sus contras`);
  }
  assert(out.strategies.some(s => s.bestFit), 'debe marcarse el mejor encaje');
  assert(out.strategies[0].fit.score >= out.strategies[out.strategies.length - 1].fit.score, 'ordenadas por encaje');
});

test('Las exclusiones del test se aplican a todas las opciones', () => {
  const bundle = JSON.parse(readFileSync(join(root, 'data/history.json'), 'utf8'));
  const analyzers = new Map();
  const seriesFor = (a) => {
    if (!analyzers.has(a.id)) analyzers.set(a.id, bundle.series[a.series] ? new SeriesAnalyzer(bundle.series[a.series]) : null);
    return analyzers.get(a.id);
  };
  const answers = Object.fromEntries(QUESTIONS.map(q => [q.id, 2]));
  answers.q10 = 4; // horizonte corto → sin cripto
  const prefs = derivePreferences(answers);
  const out = generateStrategyOptions({
    assets: ASSETS, seriesFor, dateIndex: bundle.dates.indexOf('2021-06-01'),
    indexAnalyzer: new SeriesAnalyzer(bundle.series.SP500),
    profile: { score: 60, category: CATEGORIES[2] },
    capitalMid: 20000, incomeMid: 3000,
    broker: getBroker('traderepublic'), history: [],
    preferences: prefs, now: Date.parse('2021-06-01'),
  });
  for (const s of out.strategies) {
    for (const p of s.positions) {
      assert(p.assetClass !== 'crypto', `${s.id} propone cripto pese a la exclusión del test`);
    }
  }
});

console.log('— Cartera en el almacén local —');

test('addHolding suma una segunda aportación al mismo activo', () => {
  const st = storeMod;
  const pf = st.listPortfolios()[0];
  st.addHolding({ portfolioId: pf.id, assetId: 'AAPL', assetClass: 'equity', currency: 'EUR', invested: 1000, units: 10 });
  st.addHolding({ portfolioId: pf.id, assetId: 'AAPL', assetClass: 'equity', currency: 'EUR', invested: 2000, units: 10 });
  const hs = st.listHoldings(pf.id);
  assert(hs.length === 1, `${hs.length} líneas: debería sumarse en una`);
  approx(hs[0].invested, 3000); approx(hs[0].units, 20);
});

test('addHolding acepta una posición sin unidades, solo con el importe', () => {
  const st = storeMod;
  const pf = st.listPortfolios()[0];
  const h = st.addHolding({ portfolioId: pf.id, assetId: 'MSFT', assetClass: 'equity', currency: 'EUR', invested: 750 });
  approx(h.invested, 750); approx(h.units, 0);
  st.removeHolding(h.id);
});

test('addHolding exige un importe invertido positivo', () => {
  const st = storeMod;
  const pf = st.listPortfolios()[0];
  let threw = 0;
  try { st.addHolding({ portfolioId: pf.id, assetId: 'KO', invested: 0 }); } catch { threw++; }
  try { st.addHolding({ portfolioId: pf.id, assetId: 'KO', invested: -5 }); } catch { threw++; }
  assert(threw === 2, `${threw} errores de 2`);
});

test('revalueHolding anota el valor y reanotar el mismo día corrige en vez de acumular', () => {
  const st = storeMod;
  const pf = st.listPortfolios()[0];
  const h = st.listHoldings(pf.id).find(x => x.assetId === 'AAPL');
  st.revalueHolding(h.id, 3600);
  st.revalueHolding(h.id, 3800); // mismo día: corrige
  const cur = st.listHoldings(pf.id).find(x => x.assetId === 'AAPL');
  assert(cur.valuations.length === 1, `${cur.valuations.length} valoraciones el mismo día`);
  approx(cur.valuations[0].value, 3800);
  // y otra en una fecha distinta sí se acumula
  st.revalueHolding(h.id, 3500, Date.now() - 5 * 86400000);
  assert(st.listHoldings(pf.id).find(x => x.assetId === 'AAPL').valuations.length === 2);
});

test('revalueMany actualiza varias posiciones e ignora las vacías', () => {
  const st = storeMod;
  const pf = st.listPortfolios()[0];
  const a = st.listHoldings(pf.id).find(x => x.assetId === 'AAPL');
  const b = st.addHolding({ portfolioId: pf.id, assetId: 'KO', assetClass: 'equity', currency: 'EUR', invested: 400 });
  const n = st.revalueMany({ [a.id]: 4000, [b.id]: '', bogus: 100 });
  assert(n === 1, `actualizadas ${n}: solo la que traía valor válido`);
  approx(st.listHoldings(pf.id).find(x => x.assetId === 'AAPL').valuations.slice(-1)[0].value, 4000);
  st.removeHolding(b.id);
});

test('recordSale descuenta el importe proporcionalmente y cierra al vender todo', () => {
  const st = storeMod;
  const pf = st.listPortfolios()[0];
  const h = st.listHoldings(pf.id).find(x => x.assetId === 'AAPL');
  const before = positionSnapshot(h, null);
  const cobrado = before.valueOrCost / 4;
  st.recordSale({ id: h.id, amount: cobrado, verdict: 'reducir' });
  const after = positionSnapshot(st.listHoldings(pf.id).find(x => x.assetId === 'AAPL'), null);
  // el aportado queda NETO (lo puesto menos lo cobrado), no prorrateado: es lo
  // que hace que la ganancia incluya la parte ya realizada
  approx(after.cost, before.cost - cobrado, 1e-6);
  approx(after.units, before.units * 0.75, 1e-6);
  approx(after.valueOrCost, before.valueOrCost * 0.75, 1e-6);
  // comprobación de verdad: aportado − cobrado − valor restante = ganancia total
  approx(after.valueOrCost - after.cost, (cobrado + before.valueOrCost * 0.75) - before.cost, 1e-6);
  const sales = st.listDecisions().filter(d => d.action === 'sold');
  assert(sales.length === 1, JSON.stringify(sales));
  approx(sales[0].amount, cobrado, 1e-6);
  st.recordSale({ id: h.id, amount: 1e9 });
  assert(!st.listHoldings(pf.id).some(x => x.assetId === 'AAPL'), 'vender todo debe cerrar la posición');
});

test('Las ventas registradas NO penalizan al activo en el motor de feedback', () => {
  const now = Date.now();
  const adj = computeFeedbackAdjustments([{ assetId: 'AAPL', assetClass: 'equity', action: 'sold', ts: now }], now);
  assert(!adj.assetAdj.has('AAPL') || adj.assetAdj.get('AAPL') === 0, 'una venta por tendencia no es un rechazo');
  const rejected = computeFeedbackAdjustments([{ assetId: 'AAPL', assetClass: 'equity', action: 'rejected', reasonId: 'asset', ts: now }], now);
  assert(rejected.assetAdj.get('AAPL') < 0, 'un rechazo explícito sí penaliza');
});

test('moveHolding traslada la posición conservando aportaciones y valoraciones', () => {
  const st = storeMod;
  const [a, b] = st.listPortfolios();
  const h = st.addHolding({ portfolioId: a.id, assetId: 'PG', assetClass: 'equity', currency: 'EUR', invested: 600, units: 5 });
  st.revalueHolding(h.id, 700);
  st.moveHolding(h.id, b.id);
  assert(!st.listHoldings(a.id).some(x => x.assetId === 'PG'), 'sigue en el origen');
  const moved = st.listHoldings(b.id).find(x => x.assetId === 'PG');
  assert(moved, 'no llegó al destino');
  approx(moved.invested, 600); approx(moved.units, 5);
  assert(moved.valuations.length === 1 && moved.valuations[0].value === 700, 'perdió la valoración');
  st.removeHolding(moved.id);
});

test('moveHolding fusiona si el destino ya tiene ese activo', () => {
  const st = storeMod;
  const [a, b] = st.listPortfolios();
  const origen = st.addHolding({ portfolioId: a.id, assetId: 'JNJ', assetClass: 'equity', currency: 'EUR', invested: 300, units: 3 });
  st.addHolding({ portfolioId: b.id, assetId: 'JNJ', assetClass: 'equity', currency: 'EUR', invested: 700, units: 7 });
  st.moveHolding(origen.id, b.id);
  const dest = st.listHoldings(b.id).filter(x => x.assetId === 'JNJ');
  assert(dest.length === 1, `${dest.length} líneas: debería fusionarse en una`);
  approx(dest[0].invested, 1000); approx(dest[0].units, 10);
  assert(dest[0].contributions.length === 2, 'debe conservar ambas aportaciones con su fecha');
  st.removeHolding(dest[0].id);
});

test('El balance consolidado suma las carteras activas y excluye las archivadas', () => {
  const st = storeMod;
  const [a, b] = st.listPortfolios();
  st.addHolding({ portfolioId: a.id, assetId: 'WMT', assetClass: 'equity', currency: 'EUR', invested: 1000 });
  st.addHolding({ portfolioId: b.id, assetId: 'PEP', assetClass: 'equity', currency: 'EUR', invested: 500 });
  const activos = new Set(st.listPortfolios().map(p => p.id));
  const total = portfolioSnapshot(st.listHoldings().filter(h => activos.has(h.portfolioId)), () => null);
  approx(total.contributed, st.listHoldings().filter(h => activos.has(h.portfolioId))
    .reduce((s, h) => s + h.invested, 0));

  // al archivar una cartera, sus posiciones dejan de contar en el balance
  const antes = total.totalValue;
  st.archivePortfolio(b.id);
  const activos2 = new Set(st.listPortfolios().map(p => p.id));
  const despues = portfolioSnapshot(st.listHoldings().filter(h => activos2.has(h.portfolioId)), () => null);
  assert(despues.totalValue < antes, `${despues.totalValue} debería ser menor que ${antes}`);
  assert(!activos2.has(b.id), 'la archivada sigue activa');
});

test('La opción elegida se recuerda por portafolio', () => {
  const st = storeMod;
  const pf = st.listPortfolios()[0];
  st.saveStrategyChoice(pf.id, 'nucleo', { name: 'Núcleo indexado', equityPct: 40 });
  assert(st.getStrategyChoice(pf.id).strategyId === 'nucleo');
  approx(st.getStrategyChoice(pf.id).equityPct, 40);
  st.clearStrategyChoice(pf.id);
  assert(st.getStrategyChoice(pf.id) === null);
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

await testAsync('updateBundle extiende el calendario con el índice y tolera fallos por serie', async () => {
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
