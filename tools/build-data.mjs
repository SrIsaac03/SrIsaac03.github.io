// Convierte los CSV históricos (skfolio: S&P500 1990-2022) en un bundle JSON
// consumible por la app (navegador) y por el backtester (Node).
// Uso: node tools/build-data.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseCsv(path) {
  const lines = readFileSync(path, 'utf8').replace(/\r/g, '').trim().split('\n');
  const header = lines[0].split(',');
  const cols = header.slice(1);
  const rows = lines.slice(1).map(l => l.split(','));
  return { cols, rows };
}

const prices = parseCsv(join(root, 'data/sp500_dataset.csv'));
const index = parseCsv(join(root, 'data/sp500_index.csv'));
const factors = parseCsv(join(root, 'data/factors_dataset.csv'));

// Index de fechas maestro = el del dataset de precios (coincide con el índice)
const dates = prices.rows.map(r => r[0]);
const dateIdx = new Map(dates.map((d, i) => [d, i]));

const series = {};
function addSeries(name, values) {
  series[name] = values;
}

// Índice S&P 500
{
  const vals = new Array(dates.length).fill(null);
  for (const r of index.rows) {
    const i = dateIdx.get(r[0]);
    if (i !== undefined) vals[i] = Math.round(parseFloat(r[1]) * 1000) / 1000;
  }
  addSeries('SP500', vals);
}

// 20 acciones
prices.cols.forEach((sym, c) => {
  const vals = prices.rows.map(r => {
    const v = parseFloat(r[c + 1]);
    return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  });
  addSeries(sym, vals);
});

// 5 ETFs de factores (empiezan en 2014; null antes)
factors.cols.forEach((sym, c) => {
  const vals = new Array(dates.length).fill(null);
  for (const r of factors.rows) {
    const i = dateIdx.get(r[0]);
    if (i !== undefined) {
      const v = parseFloat(r[c + 1]);
      if (Number.isFinite(v)) vals[i] = Math.round(v * 1000) / 1000;
    }
  }
  addSeries('ETF_' + sym, vals);
});

const bundle = {
  meta: {
    source: 'skfolio datasets (precios ajustados reales, uso educativo)',
    built: new Date().toISOString().slice(0, 10),
    start: dates[0],
    end: dates[dates.length - 1],
    days: dates.length,
  },
  dates,
  series,
};

writeFileSync(join(root, 'data/history.json'), JSON.stringify(bundle));
console.log(`history.json: ${dates.length} días, ${Object.keys(series).length} series, ${bundle.meta.start} → ${bundle.meta.end}`);
