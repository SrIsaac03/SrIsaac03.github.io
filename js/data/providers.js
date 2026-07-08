// Proveedores de datos de mercado. La app es 100% cliente: estas APIs se
// consumen desde el navegador del usuario (todas gratuitas, sin clave, con CORS).
//
//   · Binance      → velas diarias BTC/ETH (histórico) + precio spot   [tiempo real]
//   · CoinGecko    → precio spot cripto (fallback de Binance)          [tiempo real]
//   · Frankfurter  → tipo de cambio USD/EUR (BCE)                      [diario]
//   · Yahoo Finance vía proxy CORS → S&P 500 reciente (mejor esfuerzo) [demorado]
//   · Bundle local → histórico real 1990-2022 (garantizado, offline)
//
// Toda petición tiene timeout corto y degradación limpia: si una fuente falla,
// la app sigue funcionando con el histórico local y lo indica en la interfaz.

const TIMEOUT_MS = 6000;

async function fetchJson(url, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// --- Histórico local (siempre disponible) ---

export async function loadBundle() {
  const res = await fetch('data/history.json');
  if (!res.ok) throw new Error('No se pudo cargar el histórico local');
  return res.json();
}

// --- Cripto: Binance (velas diarias) con fallback CoinGecko (spot) ---

export async function fetchCryptoDaily(binanceSymbol, days = 400) {
  const data = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1d&limit=${Math.min(days, 1000)}`);
  return {
    dates: data.map(k => new Date(k[0]).toISOString().slice(0, 10)),
    closes: data.map(k => parseFloat(k[4])),
    lastPrice: parseFloat(data[data.length - 1][4]),
  };
}

export async function fetchCryptoSpot(coingeckoIds) {
  const data = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoIds.join(',')}&vs_currencies=usd&include_24hr_change=true`);
  return data; // { bitcoin: { usd, usd_24h_change }, ... }
}

// --- Divisas: Frankfurter (datos del BCE) ---

export async function fetchUsdEur() {
  const data = await fetchJson('https://api.frankfurter.app/latest?from=USD&to=EUR');
  return { rate: data.rates.EUR, date: data.date };
}

// --- Renta variable reciente: Yahoo Finance vía proxy CORS (mejor esfuerzo) ---
// Yahoo no envía cabeceras CORS; corsproxy.io las añade. Puede fallar o estar
// limitado: por eso es opcional y con timeout corto.

export async function fetchSp500Recent() {
  const yahoo = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=2y';
  const data = await fetchJson('https://corsproxy.io/?url=' + encodeURIComponent(yahoo), 8000);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error('respuesta Yahoo inesperada');
  const closes = r.indicators.quote[0].close;
  const dates = r.timestamp.map(t => new Date(t * 1000).toISOString().slice(0, 10));
  const out = { dates: [], closes: [] };
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null) { out.dates.push(dates[i]); out.closes.push(closes[i]); }
  }
  if (out.closes.length < 100) throw new Error('serie Yahoo demasiado corta');
  return out;
}

// Fusiona el histórico local del S&P 500 con la serie reciente de Yahoo:
// el análisis pasa a reflejar el mercado de HOY en vez de terminar en 2022.
export function mergeSp500(bundle, recent) {
  const dates = [...bundle.dates];
  const sp = [...bundle.series.SP500];
  const lastLocal = dates[dates.length - 1];
  // factor de empalme por si la serie de Yahoo difiere en ajuste
  const overlapIdx = recent.dates.findIndex(d => d > lastLocal) - 1;
  let scale = 1;
  if (overlapIdx >= 0) {
    const localLast = sp[sp.length - 1];
    const yOverlap = recent.closes[overlapIdx];
    if (yOverlap > 0) scale = localLast / yOverlap;
    if (Math.abs(scale - 1) > 0.05) scale = 1; // si difiere >5% no empalmamos a ciegas
  }
  let appended = 0;
  for (let i = 0; i < recent.dates.length; i++) {
    if (recent.dates[i] > lastLocal) {
      dates.push(recent.dates[i]);
      sp.push(Math.round(recent.closes[i] * scale * 1000) / 1000);
      appended++;
    }
  }
  return { dates, sp500: sp, appended, lastDate: dates[dates.length - 1] };
}

// --- Orquestador: se llama al iniciar la app ---
// Devuelve el estado de datos con lo que se haya podido obtener en vivo.

export async function bootstrapMarketData(cryptoAssets) {
  const status = { bundle: null, sp500Live: null, crypto: new Map(), fx: null, errors: [] };
  status.bundle = await loadBundle();

  const jobs = [];

  jobs.push(fetchSp500Recent()
    .then(recent => { status.sp500Live = mergeSp500(status.bundle, recent); })
    .catch(e => status.errors.push(`S&P 500 en vivo no disponible (${e.message}); se usa el histórico local`)));

  for (const a of cryptoAssets) {
    jobs.push(fetchCryptoDaily(a.binance)
      .then(d => status.crypto.set(a.id, d))
      .catch(e => status.errors.push(`${a.symbol}: sin datos de Binance (${e.message})`)));
  }

  jobs.push(fetchUsdEur()
    .then(fx => { status.fx = fx; })
    .catch(e => status.errors.push(`Tipo de cambio no disponible (${e.message})`)));

  await Promise.allSettled(jobs);

  // fallback spot de CoinGecko si Binance falló
  const missing = cryptoAssets.filter(a => !status.crypto.has(a.id));
  if (missing.length) {
    try {
      const spot = await fetchCryptoSpot(missing.map(a => a.live));
      for (const a of missing) {
        if (spot[a.live]) status.crypto.set(a.id, { dates: [], closes: [], lastPrice: spot[a.live].usd, spotOnly: true });
      }
    } catch { /* sin cripto: la app sigue */ }
  }
  return status;
}
