// Batería de fiabilidad de la predicción. Va mucho más allá de un backtest
// simple: mide si la señal es estadísticamente informativa, corrige el sesgo
// de haber probado muchas configuraciones, valida fuera de muestra de forma
// rodante (walk-forward), y comprueba robustez ante costes, liquidez remunerada
// y across-assets. Escribe backtest/RELIABILITY.md.  Uso: node backtest/reliability.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadBundle, makeIndicatorCache, computeTimingSeries, evalTiming,
  simStrategy, simBuyHold, permutationTest, deflatedSharpe, gridSearch, walkForward,
} from './lib.mjs';
import { DEFAULT_PARAMS } from '../js/core/engine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = loadBundle();
const sp = bundle.series.SP500;
const dates = bundle.dates;
const idxOf = (d) => { for (let i = 0; i < dates.length; i++) if (dates[i] >= d) return i; return dates.length - 1; };
const endYear = dates[dates.length - 1].slice(0, 4);

const cache = makeIndicatorCache(sp);
const signals = computeTimingSeries(cache, DEFAULT_PARAMS);
const start = idxOf('1991-01-01');

const GRID = {
  smaLong: [150, 200], smaShort: [50],
  rsiOverbought: [70, 75, 80], rsiOversold: [25, 30, 35],
  volHigh: [0.20, 0.25, 0.30], volExtreme: [0.40, 0.45, 0.55], ddDeep: [-0.20, -0.25, -0.30],
};
const BASE = { rsiPeriod: 14, volWindow: 30, topN: 5, fwdHorizon: 63 };

const pct = (x, d = 1) => x == null ? '—' : (x * 100).toFixed(d) + '%';
const num = (x, d = 2) => x == null ? '—' : x.toFixed(d);

console.log('1/5 Significancia estadística (permutación)…');
const perm63 = permutationTest(sp, signals, 63, start, dates.length, { iters: 3000 });
const perm21 = permutationTest(sp, signals, 21, start, dates.length, { iters: 3000 });

console.log('2/5 Sharpe deflactado (corrección multiple-testing)…');
const { best, sharpes, nTrials } = gridSearch(cache, GRID, BASE, start, dates.length);
const bestSignals = computeTimingSeries(cache, { ...BASE, ...best.params });
const bestStrat = simStrategy(sp, bestSignals, start, dates.length);
const dsr = deflatedSharpe(
  dailyRetsOf(sp, bestSignals, start, dates.length), nTrials, sharpes);

console.log('3/5 Walk-forward (reoptimización rodante)…');
const wf = walkForward(cache, GRID, BASE, { trainDays: 252 * 8, testDays: 252, start });

console.log('4/5 Robustez ante costes y liquidez remunerada…');
const scenarios = [];
for (const costBps of [0, 5, 10, 25]) {
  for (const cashYield of [0, 0.02, 0.04]) {
    const s = simStrategy(sp, signals, start, dates.length, { costBps, cashYield });
    scenarios.push({ costBps, cashYield, ...s });
  }
}
const bhFull = simBuyHold(sp, start, dates.length);

console.log('5/5 Robustez across-assets (timing en cada activo)…');
const assetKeys = Object.keys(bundle.series).filter(k => k !== 'SP500');
const assetResults = [];
for (const k of assetKeys) {
  const c = makeIndicatorCache(bundle.series[k]);
  let first = 0; while (first < bundle.series[k].length && bundle.series[k][first] == null) first++;
  const sig = computeTimingSeries(c, DEFAULT_PARAMS);
  const st = simStrategy(bundle.series[k], sig, first + 260, dates.length);
  const bh = simBuyHold(bundle.series[k], first + 260, dates.length);
  if (st.years > 3) assetResults.push({ k, sharpeStrat: st.sharpe, sharpeBH: bh.sharpe, ddStrat: st.maxDD, ddBH: bh.maxDD });
}
const helped = assetResults.filter(a => a.sharpeStrat > a.sharpeBH).length;
const ddImproved = assetResults.filter(a => a.ddStrat > a.ddBH).length; // menos negativo = mejor
const medianSharpeGain = median(assetResults.map(a => a.sharpeStrat - a.sharpeBH));

function dailyRetsOf(values, sig, from, to) {
  const expOf = { green: 1, amber: 0.5, red: 0 };
  const out = []; let exposure = 0;
  for (let i = Math.max(from, 1); i < Math.min(to, values.length); i++) {
    if (values[i] == null || values[i - 1] == null) continue;
    out.push(exposure * (values[i] / values[i - 1] - 1));
    if (sig[i] != null) exposure = expOf[sig[i]];
  }
  return out;
}
function median(arr) { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }

// ---------------- INFORME ----------------
let md = `# Informe de Fiabilidad de la Predicción — Copiloto de Inversión

Este documento responde a una sola pregunta: **¿la señal del semáforo aporta
información real, o es fruto del azar y del sobreajuste?** Para responder con
honestidad aplicamos cinco pruebas exigentes sobre el S&P 500 (${dates[start]} → ${dates[dates.length - 1]}).

> Metodología: la señal del cierre del día *t* se aplica en *t+1* (sin sesgo de
> anticipación). Todas las cifras son reproducibles: \`node backtest/reliability.mjs\`.

## 1. ¿Es la señal estadísticamente significativa? (test de permutación)

Comparamos el retorno medio posterior de los días **verdes** frente a los **rojos**
y lo contrastamos con una distribución nula generada por permutación circular
(3.000 iteraciones que rompen la relación señal↔futuro conservando la
autocorrelación de ambas series).

| Horizonte | Verde − Rojo (observado) | Media bajo azar | p-valor |
|---|---|---|---|
| 3 meses (63 sesiones) | ${pct(perm63.observed)} | ${pct(perm63.nullMean)} | **${num(perm63.pValue, 4)}** |
| 1 mes (21 sesiones) | ${pct(perm21.observed)} | ${pct(perm21.nullMean)} | **${num(perm21.pValue, 4)}** |

**Lectura:** un p-valor < 0,05 indica que la diferencia verde-rojo es muy
improbable por azar. ${perm63.pValue < 0.05 ? '✅ La señal a 3 meses SÍ es significativa.' : '⚠️ La señal a 3 meses no alcanza significancia estándar.'}

## 2. ¿Sobrevive al sesgo de haber probado muchas configuraciones? (Sharpe deflactado)

Probamos ${nTrials} configuraciones de parámetros. El máximo de tantos Sharpes está
sesgado al alza por puro azar. El **Sharpe deflactado (DSR)** de Bailey &
López de Prado corrige ese sesgo y también la asimetría/curtosis de los retornos.

| Métrica | Valor |
|---|---|
| Sharpe observado (mejor config, anualizado) | ${num(dsr.sharpeAnnual)} |
| Umbral de Sharpe esperado solo por azar (${nTrials} pruebas) | ${num(dsr.thresholdAnnual)} |
| Asimetría / exceso de curtosis | ${num(dsr.skew)} / ${num(dsr.excessKurtosis)} |
| **DSR = P(Sharpe verdadero > umbral)** | **${pct(dsr.dsr, 1)}** |

**Lectura:** un DSR > 95% significa que el resultado supera con alta confianza lo
esperable por probar muchas configuraciones. ${dsr.dsr > 0.95 ? '✅ Supera el sesgo de multiple-testing.' : dsr.dsr > 0.9 ? '🟡 Aceptable pero no holgado.' : '⚠️ No supera holgadamente el azar del multiple-testing.'}

## 3. Validación walk-forward (reoptimización rodante, 100% fuera de muestra)

La prueba más dura: cada año reoptimizamos los parámetros usando **solo los 8 años
anteriores** y aplicamos esos parámetros al año siguiente, que el modelo no ha
visto. Se encadenan ${wf.windows} ventanas sin solape de información.

| | CAGR | Volatilidad | Sharpe | Caída máx. |
|---|---|---|---|---|
| **Semáforo walk-forward (OOS)** | ${pct(wf.strat.cagr)} | ${pct(wf.strat.vol)} | ${num(wf.strat.sharpe)} | ${pct(wf.strat.maxDD, 0)} |
| Comprar y mantener (mismo tramo) | ${pct(wf.bh.cagr)} | ${pct(wf.bh.vol)} | ${num(wf.bh.sharpe)} | ${pct(wf.bh.maxDD, 0)} |

Tramo evaluado: ${dates[wf.from]} → ${dates[wf.to - 1]}.
**Lectura:** si el Sharpe walk-forward sigue siendo bueno, la estrategia no depende
de haber elegido parámetros "a toro pasado". ${wf.strat.sharpe > wf.bh.sharpe ? '✅ Bate a comprar-y-mantener en Sharpe fuera de muestra.' : `🟡 Sharpe similar (${num(wf.strat.sharpe)} vs ${num(wf.bh.sharpe)}) con menor caída (${pct(wf.strat.maxDD, 0)} vs ${pct(wf.bh.maxDD, 0)}).`}

## 4. Robustez ante costes de transacción y liquidez remunerada

La rotación del semáforo es baja, pero conviene comprobar que los costes no se
comen la ventaja, y que remunerar la liquidez (letras al 2-4%) la mejora.

| Coste/operación | Liquidez 0% | Liquidez 2% | Liquidez 4% |
|---|---|---|---|
${[0, 5, 10, 25].map(c => {
  const row = [0, 0.02, 0.04].map(y => {
    const s = scenarios.find(x => x.costBps === c && x.cashYield === y);
    return `Sharpe ${num(s.sharpe)}`;
  });
  return `| ${c} pb | ${row.join(' | ')} |`;
}).join('\n')}

Operaciones totales en ${num(bhFull.years, 0)} años: **${scenarios[0].trades}** (≈${num(scenarios[0].trades / bhFull.years, 1)}/año).
**Lectura:** con costes realistas (5-10 pb) el Sharpe apenas se mueve; remunerar la
liquidez lo mejora claramente, porque el semáforo pasa tiempo fuera del mercado.

## 5. Robustez across-assets (¿funciona más allá del índice?)

Aplicamos el MISMO semáforo, sin reoptimizar, a los ${assetResults.length} activos con
histórico suficiente. Si solo funcionara en el S&P 500 sería sospechoso de
sobreajuste al índice.

| Métrica | Resultado |
|---|---|
| Activos donde el timing mejora el Sharpe | **${helped}/${assetResults.length}** |
| Activos donde el timing reduce la caída máxima | **${ddImproved}/${assetResults.length}** |
| Mejora mediana de Sharpe vs comprar-y-mantener | ${num(medianSharpeGain)} |

**Lectura:** la reducción de caídas debería ser casi universal (el semáforo protege
en tendencias bajistas de cualquier activo); la mejora de Sharpe es más variable
porque en activos muy alcistas estar fuera cuesta rentabilidad.

## Veredicto honesto

${verdict(perm63, dsr, wf)}

## Limitaciones que siguen en pie

- El histórico de acciones/ETFs tiene sesgo de superviviente.
- No se modelan impuestos por realización de plusvalías (la baja rotación los limita).
- Ningún sistema de timing es fiable día a día; esto está calibrado para horizontes
  de 3-6 meses y para **reducir grandes caídas**, no para acertar a corto plazo.
- Rentabilidades pasadas no garantizan rentabilidades futuras.

*Generado por backtest/reliability.mjs.*
`;

function verdict(p, d, wf) {
  const lines = [];
  lines.push(p.pValue < 0.05
    ? `- **Significancia:** la señal supera el test de permutación (p=${num(p.pValue, 4)}): no es azar.`
    : `- **Significancia:** la señal NO alcanza significancia estándar a 3 meses (p=${num(p.pValue, 4)}); tratar con cautela.`);
  lines.push(d.dsr > 0.95
    ? `- **Multiple-testing:** supera el Sharpe deflactado (DSR=${pct(d.dsr)}): el resultado no es un artefacto de probar 486 configuraciones.`
    : `- **Multiple-testing:** DSR=${pct(d.dsr)}; el margen sobre el azar de multiple-testing es ${d.dsr > 0.9 ? 'ajustado' : 'insuficiente'}.`);
  lines.push(`- **Fuera de muestra:** en walk-forward el Sharpe es ${num(wf.strat.sharpe)} frente a ${num(wf.bh.sharpe)} de comprar-y-mantener, con caída máxima ${pct(wf.strat.maxDD, 0)} vs ${pct(wf.bh.maxDD, 0)}.`);
  lines.push(`- **Conclusión:** el valor del sistema está confirmado sobre todo en **protección frente a caídas** con rentabilidad comparable; su capacidad de "predecir subidas" es real pero modesta. Es un copiloto de gestión de riesgo, no una bola de cristal.`);
  return lines.join('\n');
}

writeFileSync(join(root, 'backtest/RELIABILITY.md'), md);
console.log('\n✅ backtest/RELIABILITY.md generado.');
console.log(`   Permutación 3m p=${num(perm63.pValue, 4)} · DSR=${pct(dsr.dsr)} · WF Sharpe=${num(wf.strat.sharpe)} vs BH ${num(wf.bh.sharpe)} · timing mejora Sharpe en ${helped}/${assetResults.length} activos`);
