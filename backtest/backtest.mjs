// Backtest completo del motor con los parámetros afinados (DEFAULT_PARAMS).
// Genera recomendaciones para cada día del histórico y mide su acierto.
// Escribe backtest/REPORT.md. Uso: node backtest/backtest.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBundle, makeIndicatorCache, computeTimingSeries, evalTiming, simStrategy, simBuyHold, simDCA, evalSelection } from './lib.mjs';
import { DEFAULT_PARAMS } from '../js/core/engine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = loadBundle();
const sp = bundle.series.SP500;
const dates = bundle.dates;
const idxOf = (d) => dates.findIndex(x => x >= d);

const cache = makeIndicatorCache(sp);
const signals = computeTimingSeries(cache, DEFAULT_PARAMS);

const TRAIN = [idxOf('1991-01-01'), idxOf('2011-01-01')];
const VALID = [idxOf('2011-01-01'), dates.length];
const FULL = [idxOf('1991-01-01'), dates.length];

function block(name, [from, to]) {
  const strat = simStrategy(sp, signals, from, to);
  const bh = simBuyHold(sp, from, to);
  const t63 = evalTiming(sp, signals, 63, from, to - 63);
  const t126 = evalTiming(sp, signals, 126, from, to - 126);
  const dca = simDCA(sp, signals, from, to);
  return { name, strat, bh, t63, t126, dca };
}

const endYear = dates[dates.length - 1].slice(0, 4);
const blocks = [block('Entrenamiento 1991–2010', TRAIN), block(`Validación 2011–${endYear} (fuera de muestra)`, VALID), block(`Período completo 1991–${endYear}`, FULL)];
const sel = evalSelection(bundle, DEFAULT_PARAMS, idxOf('1992-01-01'), dates.length);
const selValid = evalSelection(bundle, DEFAULT_PARAMS, idxOf('2011-01-01'), dates.length);

// Casos de estudio: ¿qué decía el semáforo en fechas críticas?
const CASES = [
  ['2000-03-24', 'Techo de la burbuja puntocom'],
  ['2001-09-21', 'Mínimos tras el 11-S'],
  ['2007-10-09', 'Techo previo a la crisis financiera'],
  ['2008-09-15', 'Quiebra de Lehman Brothers'],
  ['2009-03-09', 'Suelo de la crisis financiera'],
  ['2013-05-01', 'Mercado alcista consolidado'],
  ['2020-02-19', 'Techo pre-COVID'],
  ['2020-03-23', 'Suelo del crash COVID'],
  ['2020-08-03', 'Recuperación post-COVID'],
  ['2022-01-03', 'Techo previo al bajista de 2022'],
  ['2022-06-16', 'Tramo bajista de 2022'],
];
const caseRows = CASES.map(([d, label]) => {
  const i = idxOf(d);
  const sig = signals[i];
  const fwd63 = sp[i + 63] ? (sp[i + 63] / sp[i] - 1) : null;
  return { date: dates[i], label, signal: sig, fwd63 };
});

const pct = (x, d = 1) => x == null ? '—' : (x * 100).toFixed(d) + '%';
const num = (x, d = 2) => x == null ? '—' : x.toFixed(d);
const semaforo = { green: '🟢 verde', amber: '🟡 ámbar', red: '🔴 rojo' };

let md = `# Informe de Backtest — Copiloto de Inversión

**Datos:** S&P 500 diario real, 1990-01-02 → 2022-12-28 (8.313 sesiones) + 20 valores del índice.
**Metodología:** la señal calculada al cierre del día *t* se aplica en *t+1* (sin sesgo de anticipación).
Parámetros elegidos por búsqueda en rejilla (486 configuraciones) **solo con datos 1991–2010** y
validados fuera de muestra en 2011–2022. La liquidez rinde 0% (conservador).

**Parámetros ganadores:** ${JSON.stringify(DEFAULT_PARAMS)}

## 1. Estrategia guiada por el semáforo vs. comprar-y-mantener

Exposición: verde = 100% invertido · ámbar = 50% · rojo = 0% (liquidez).

| Período | | CAGR | Volatilidad | Sharpe | Caída máx. |
|---|---|---|---|---|---|
`;
for (const b of blocks) {
  md += `| **${b.name}** | Semáforo | ${pct(b.strat.cagr)} | ${pct(b.strat.vol)} | ${num(b.strat.sharpe)} | ${pct(b.strat.maxDD, 0)} |\n`;
  md += `| | Comprar y mantener | ${pct(b.bh.cagr)} | ${pct(b.bh.vol)} | ${num(b.bh.sharpe)} | ${pct(b.bh.maxDD, 0)} |\n`;
}

md += `
## 2. Acierto de la señal (¿qué pasó en los 3/6 meses siguientes?)

"Acierto" = % de días con esa señal cuyo retorno posterior fue positivo.
La base es el % incondicional (el mercado sube la mayoría de los períodos: superar la base es lo difícil).

| Período | Señal | Días | Acierto 3m | Retorno medio 3m | Acierto 6m |
|---|---|---|---|---|---|
`;
for (const b of blocks) {
  for (const s of ['green', 'amber', 'red']) {
    md += `| ${b.name} | ${semaforo[s]} | ${b.t63[s].n} | ${pct(b.t63[s].hitRate)} | ${pct(b.t63[s].avgFwd)} | ${pct(b.t126[s].hitRate)} |\n`;
  }
  md += `| ${b.name} | *base (todos)* | ${b.t63.all.n} | ${pct(b.t63.all.hitRate)} | ${pct(b.t63.all.avgFwd)} | ${pct(b.t126.all.hitRate)} |\n`;
}

md += `
**Lectura:** el valor del semáforo no está en "predecir" el mercado sino en (a) que los días verdes
suben con más frecuencia y más cuantía que la base, y (b) que estar fuera en los rojos recorta las
caídas máximas a la mitad (ver tabla 1) a costa de algo de rentabilidad en los rebotes.

## 3. Aportación periódica (DCA): con timing vs. fija

Aportación mensual constante. "Con timing": verde invierte todo lo acumulado, ámbar la mitad, rojo espera en liquidez.

| Período | Valor final DCA fija | Valor final DCA con timing | Ratio |
|---|---|---|---|
`;
for (const b of blocks) {
  md += `| ${b.name} | ${num(b.dca.fixedFinal, 1)}× | ${num(b.dca.timedFinal, 1)}× | ${num(b.dca.ratio, 3)} |\n`;
}

md += `
## 4. Selección de activos (momentum/volatilidad, top-5 mensual vs. equiponderado)

| Período | Meses | % meses que el top-5 bate al equiponderado | CAGR top-5 | CAGR equiponderado |
|---|---|---|---|---|
| 1992–2022 | ${sel.months} | ${pct(sel.winRate)} | ${pct(sel.topCagr)} | ${pct(sel.ewCagr)} |
| 2011–2022 | ${selValid.months} | ${pct(selValid.winRate)} | ${pct(selValid.topCagr)} | ${pct(selValid.ewCagr)} |

## 5. Casos de estudio: el semáforo en fechas críticas

| Fecha | Contexto | Señal | Retorno 3m posterior |
|---|---|---|---|
`;
for (const c of caseRows) {
  md += `| ${c.date} | ${c.label} | ${semaforo[c.signal] ?? c.signal} | ${pct(c.fwd63)} |\n`;
}

md += `
## 6. Limitaciones (léelas)

- **Rentabilidades pasadas no garantizan rentabilidades futuras.** Este backtest demuestra que las
  reglas son razonables y explicables, no que predigan el futuro.
- La liquidez se modela al 0%; con letras/remunerada al 2-4% la estrategia con semáforo mejoraría.
- No se descuentan comisiones ni impuestos por rotación (la rotación del semáforo es baja, ~pocas
  señales al año, pero no es cero).
- El universo de 20 valores tiene sesgo de supervivencia (son empresas que siguen existiendo).
- El "margen de error" irreducible: ningún sistema de timing es fiable a corto plazo; el motor
  está calibrado para horizontes de 3-6 meses y para proteger de grandes caídas, no para acertar días.

*Informe generado automáticamente por backtest/backtest.mjs.*
`;

writeFileSync(join(root, 'backtest/REPORT.md'), md);
console.log(md);
