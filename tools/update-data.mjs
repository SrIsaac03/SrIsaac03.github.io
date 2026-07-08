// Actualiza data/history.json con datos frescos (gratuito, sin clave).
// Pensado para ejecutarse en GitHub Actions cada noche: extiende cada serie
// desde su último dato hasta hoy, empalmando niveles en la fecha de solape.
// Fuente primaria: Yahoo Finance v8 chart (JSON, cierres ajustados por
// dividendos, accesible desde servidores). Reserva: Stooq CSV (bloquea
// algunas IPs de datacenter devolviendo HTML: por eso no es la primaria).
// Uso: node tools/update-data.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_PATH = join(root, 'data/history.json');

// serie del bundle → ticker (Yahoo usa el ticker tal cual; Stooq, minúsculas + .us)
const TICKERS = ['AAPL', 'AMD', 'BAC', 'BBY', 'CVX', 'GE', 'HD', 'JNJ', 'JPM', 'KO',
  'LLY', 'MRK', 'MSFT', 'PEP', 'PFE', 'PG', 'RRC', 'UNH', 'WMT', 'XOM',
  'ETF_MTUM', 'ETF_QUAL', 'ETF_SIZE', 'ETF_USMV', 'ETF_VLUE'];

export const SYMBOLS = {
  SP500: { yahoo: '%5EGSPC', stooq: '%5Espx' },
  ...Object.fromEntries(TICKERS.map(k => {
    const t = k.replace('ETF_', '');
    return [k, { yahoo: t, stooq: t.toLowerCase() + '.us' }];
  })),
};

// si el índice falla, SPY (ETF que lo replica a ~1/10 del nivel) como proxy
const INDEX_PROXY = { yahoo: 'SPY', stooq: 'spy.us' };

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
// opts.allowAnyScale: para instrumentos proxy (p.ej. SPY como sustituto del
// índice) el nivel difiere mucho; el factor de empalme lo normaliza igualmente.
export function spliceSeries(bundle, key, rows, newDates, opts = {}) {
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
  if (!opts.allowAnyScale && Math.abs(scale - 1) > MAX_SPLICE_DEVIATION) {
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

const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' };

// FRED (Reserva Federal de St. Louis): serie SP500 diaria de los últimos 10 años,
// CSV sin clave y accesible desde datacenters. Solo cubre el índice.
export function parseFredCsv(text) {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  if (!/date/i.test(lines[0])) throw new Error('FRED CSV inesperado: ' + lines[0]?.slice(0, 60));
  const rows = [];
  for (const l of lines.slice(1)) {
    const [date, v] = l.split(',');
    const close = parseFloat(v);
    if (date && Number.isFinite(close)) rows.push({ date, close });
  }
  return rows;
}

async function fetchFredSp500() {
  const res = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500', { headers: UA });
  if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
  return parseFredCsv(await res.text());
}

// Yahoo bloquea IPs de datacenter sin cookie: flujo cookie (fc.yahoo.com) + crumb.
let yahooAuth = null;
async function getYahooAuth() {
  if (yahooAuth) return yahooAuth;
  const r1 = await fetch('https://fc.yahoo.com/', { headers: UA, redirect: 'manual' }).catch(e => { throw new Error('cookie: ' + e.message); });
  const cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Yahoo no devolvió cookie');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes('<')) throw new Error(`crumb inválido (HTTP ${r2.status})`);
  yahooAuth = { cookie, crumb };
  return yahooAuth;
}

export function parseYahooChart(data) {
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error('respuesta Yahoo inesperada: ' + JSON.stringify(data?.chart?.error || data).slice(0, 80));
  const closes = r.indicators?.adjclose?.[0]?.adjclose || r.indicators?.quote?.[0]?.close;
  if (!closes) throw new Error('Yahoo sin cierres');
  const rows = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null) {
      rows.push({ date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), close: closes[i] });
    }
  }
  return rows;
}

async function fetchYahoo(symbol, fromDate) {
  const p1 = Math.floor(new Date(fromDate).getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${p1}&period2=${p2}`;
  let res = await fetch(base, { headers: UA });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    // reintento autenticado con cookie + crumb (necesario desde datacenters)
    const auth = await getYahooAuth();
    res = await fetch(`${base}&crumb=${encodeURIComponent(auth.crumb)}`, { headers: { ...UA, Cookie: auth.cookie } });
  }
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}: ${(await res.text()).slice(0, 80)}`);
  return parseYahooChart(await res.json());
}

async function fetchStooq(symbol, fromDate) {
  const d1 = fromDate.replace(/-/g, '');
  const d2 = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://stooq.com/q/d/l/?s=${symbol}&i=d&d1=${d1}&d2=${d2}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
  return parseStooqCsv(await res.text());
}

// Yahoo a través de corsproxy.io: sus IPs de salida no son de datacenter de
// Azure, así que suele pasar donde el acceso directo recibe 429.
async function fetchYahooViaProxy(symbol, fromDate) {
  const p1 = Math.floor(new Date(fromDate).getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const yahoo = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${p1}&period2=${p2}`;
  const res = await fetch('https://corsproxy.io/?url=' + encodeURIComponent(yahoo), { headers: UA });
  if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
  return parseYahooChart(await res.json());
}

// Fetcher por defecto: Yahoo directo → Stooq → Yahoo vía proxy.
async function fetchSeries(key, fromDate) {
  const sym = SYMBOLS[key];
  const errors = [];
  for (const attempt of [
    () => fetchYahoo(sym.yahoo, fromDate),
    () => fetchStooq(sym.stooq, fromDate),
    () => fetchYahooViaProxy(sym.yahoo, fromDate),
  ]) {
    try {
      return await attempt();
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.join(' / '));
}

export async function updateBundle(bundle, fetcher = fetchSeries) {
  const lastDate = bundle.dates[bundle.dates.length - 1];
  const from = new Date(new Date(lastDate).getTime() - 20 * 86400000).toISOString().slice(0, 10);

  // 1) el índice define el calendario maestro nuevo.
  // Cadena de fuentes: fetcher (Yahoo→Stooq) → FRED → SPY como proxy.
  let idxRows = null, idxProxy = false;
  const idxErrors = [];
  try {
    idxRows = await fetcher('SP500', from);
  } catch (e) { idxErrors.push('directa: ' + e.message); }
  if (!idxRows) {
    try {
      idxRows = (await fetchFredSp500()).filter(r => r.date >= from);
      if (!idxRows.length) throw new Error('sin filas en el rango');
    } catch (e) { idxErrors.push('FRED: ' + e.message); idxRows = null; }
  }
  if (!idxRows) {
    try {
      // SPY como proxy: mismo movimiento, nivel ~1/10 (el empalme lo reescala)
      idxRows = await fetchYahoo(INDEX_PROXY.yahoo, from).catch(() => fetchStooq(INDEX_PROXY.stooq, from));
      idxProxy = true;
    } catch (e) {
      idxErrors.push('proxy SPY: ' + e.message);
      throw new Error('Índice inaccesible en todas las fuentes → ' + idxErrors.join(' | '));
    }
  }
  const newDates = [...bundle.dates];
  for (const r of idxRows) if (r.date > lastDate) newDates.push(r.date);
  if (newDates.length === bundle.dates.length) return { added: 0, failures: [] };

  const oldDates = bundle.dates;
  bundle.dates = newDates;
  const failures = [];
  let totalAdded = spliceSeries({ ...bundle, dates: oldDates, series: bundle.series }, 'SP500', idxRows, newDates, { allowAnyScale: idxProxy });
  if (idxProxy) failures.push('SP500: usado proxy SPY (nivel reescalado en el empalme)');

  // 2) resto de series — cada una reanuda desde su propio último dato real
  // (si una serie quedó rezagada por fallos previos, no pierde su empalme)
  for (const key of Object.keys(SYMBOLS)) {
    if (key === 'SP500') continue;
    const s = bundle.series[key];
    try {
      let li = Math.min(s.length, oldDates.length) - 1;
      while (li > 0 && s[li] == null) li--;
      const seriesFrom = new Date(new Date(oldDates[li]).getTime() - 20 * 86400000).toISOString().slice(0, 10);
      const rows = await fetcher(key, seriesFrom);
      totalAdded += spliceSeries({ ...bundle, dates: oldDates, series: bundle.series }, key, rows, newDates);
    } catch (e) {
      failures.push(`${key}: ${e.message}`);
      // sin datos: cola de nulls (el motor evalúa el activo en su último dato real)
      for (let i = s.length; i < newDates.length; i++) s[i] = null;
    }
    await new Promise(r => setTimeout(r, 350)); // cortesía con las APIs
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
    if (!added) { console.log(`Sin datos nuevos (último: ${before}).`); return; }
    // el índice fresco ya vale la pena aunque haya series con fallos: el motor
    // evalúa cada activo en su último dato real y el semáforo queda al día
    writeFileSync(BUNDLE_PATH, JSON.stringify(bundle));
    console.log(`history.json actualizado: ${before} → ${bundle.meta.end} (+${added} puntos, ${failures.length} series con avisos)`);
  }).catch(e => { console.error('Error:', e.message); process.exit(1); });
}
