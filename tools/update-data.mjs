// Actualiza data/history.json con datos frescos de Stooq (gratuito, sin clave).
// Pensado para ejecutarse en GitHub Actions cada noche: extiende cada serie
// desde su último dato hasta hoy, empalmando niveles en la fecha de solape
// (el histórico base está ajustado por dividendos y Stooq no: el factor de
// empalme garantiza continuidad; los retornos nuevos son de precio).
// Uso: node tools/update-data.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_PATH = join(root, 'data/history.json');

// serie del bundle → símbolo Stooq
export const STOOQ_SYMBOLS = {
  SP500: '^spx',
  AAPL: 'aapl.us', AMD: 'amd.us', BAC: 'bac.us', BBY: 'bby.us', CVX: 'cvx.us',
  GE: 'ge.us', HD: 'hd.us', JNJ: 'jnj.us', JPM: 'jpm.us', KO: 'ko.us',
  LLY: 'lly.us', MRK: 'mrk.us', MSFT: 'msft.us', PEP: 'pep.us', PFE: 'pfe.us',
  PG: 'pg.us', RRC: 'rrc.us', UNH: 'unh.us', WMT: 'wmt.us', XOM: 'xom.us',
  ETF_MTUM: 'mtum.us', ETF_QUAL: 'qual.us', ETF_SIZE: 'size.us',
  ETF_USMV: 'usmv.us', ETF_VLUE: 'vlue.us',
};

const MAX_SPLICE_DEVIATION = 0.25; // si el nivel difiere >25% en el solape, algo va mal

export function parseStooqCsv(text) {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  if (!/^Date,Open,High,Low,Close/i.test(lines[0])) throw new Error('CSV inesperado: ' + lines[0]?.slice(0, 60));
  const rows = [];
  for (const l of lines.slice(1)) {
    const p = l.split(',');
    const close = parseFloat(p[4]);
    if (p[0] && Number.isFinite(close)) rows.push({ date: p[0], close });
  }
  return rows;
}

// Empalma `rows` (fecha ascendente) al final de la serie `key` del bundle.
// `newDates` es el calendario maestro ya extendido. Devuelve nº de puntos añadidos.
export function spliceSeries(bundle, key, rows, newDates) {
  const series = bundle.series[key];
  const oldLen = bundle.dates.length;
  // último valor no nulo del histórico y su fecha
  let lastIdx = -1;
  for (let i = oldLen - 1; i >= 0; i--) if (series[i] != null) { lastIdx = i; break; }
  if (lastIdx < 0) return 0;
  const lastDate = bundle.dates[lastIdx];
  const lastVal = series[lastIdx];

  // factor de empalme en la fecha de solape más cercana
  const byDate = new Map(rows.map(r => [r.date, r.close]));
  let scale = null;
  for (let i = lastIdx; i >= Math.max(0, lastIdx - 15); i--) {
    const sv = byDate.get(bundle.dates[i]);
    if (sv > 0 && series[i] != null) { scale = series[i] / sv; break; }
  }
  if (scale == null) throw new Error(`${key}: sin fecha de solape con Stooq`);
  if (Math.abs(scale - 1) > MAX_SPLICE_DEVIATION) {
    throw new Error(`${key}: desviación de empalme sospechosa (factor ${scale.toFixed(3)})`);
  }

  // completar la serie sobre el calendario maestro extendido
  let added = 0;
  for (let i = oldLen; i < newDates.length; i++) {
    const v = byDate.get(newDates[i]);
    series[i] = v > 0 ? Math.round(v * scale * 1000) / 1000 : null;
    if (series[i] != null) added++;
  }
  // sanidad: sin saltos absurdos día a día (>60%)
  let prev = lastVal;
  for (let i = oldLen; i < newDates.length; i++) {
    if (series[i] == null) continue;
    if (Math.abs(series[i] / prev - 1) > 0.6) throw new Error(`${key}: salto >60% el ${newDates[i]}`);
    prev = series[i];
  }
  return added;
}

async function fetchStooq(symbol, fromDate) {
  const d1 = fromDate.replace(/-/g, '');
  const d2 = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d&d1=${d1}&d2=${d2}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseStooqCsv(await res.text());
}

export async function updateBundle(bundle, fetcher = fetchStooq) {
  const lastDate = bundle.dates[bundle.dates.length - 1];
  const from = new Date(new Date(lastDate).getTime() - 20 * 86400000).toISOString().slice(0, 10);

  // 1) el índice define el calendario maestro nuevo
  const idxRows = await fetcher(STOOQ_SYMBOLS.SP500, from);
  const newDates = [...bundle.dates];
  for (const r of idxRows) if (r.date > lastDate) newDates.push(r.date);
  if (newDates.length === bundle.dates.length) return { added: 0, failures: [] };

  const oldDates = bundle.dates;
  bundle.dates = newDates;
  const failures = [];
  let totalAdded = spliceSeries({ ...bundle, dates: oldDates, series: bundle.series }, 'SP500', idxRows, newDates);

  // 2) resto de series
  for (const [key, sym] of Object.entries(STOOQ_SYMBOLS)) {
    if (key === 'SP500') continue;
    try {
      const rows = await fetcher(sym, from);
      totalAdded += spliceSeries({ ...bundle, dates: oldDates, series: bundle.series }, key, rows, newDates);
    } catch (e) {
      failures.push(`${key}: ${e.message}`);
      // sin datos: rellenar con null (el motor excluye el activo limpiamente)
      const s = bundle.series[key];
      for (let i = s.length; i < newDates.length; i++) s[i] = null;
    }
    await new Promise(r => setTimeout(r, 400)); // cortesía con Stooq
  }

  bundle.meta.end = newDates[newDates.length - 1];
  bundle.meta.days = newDates.length;
  bundle.meta.updated = new Date().toISOString().slice(0, 10);
  return { added: totalAdded, failures };
}

// --- ejecución directa ---
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));
  const before = bundle.meta.end;
  updateBundle(bundle).then(({ added, failures }) => {
    if (failures.length) console.error('Avisos:\n  ' + failures.join('\n  '));
    if (failures.length > 10) { console.error('Demasiados fallos: no se guarda.'); process.exit(1); }
    if (!added) { console.log(`Sin datos nuevos (último: ${before}).`); return; }
    writeFileSync(BUNDLE_PATH, JSON.stringify(bundle));
    console.log(`history.json actualizado: ${before} → ${bundle.meta.end} (+${added} puntos)`);
  }).catch(e => { console.error('Error:', e.message); process.exit(1); });
}
