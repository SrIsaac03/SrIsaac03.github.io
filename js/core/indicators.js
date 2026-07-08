// Indicadores técnicos sobre series de cierre diarias.
// Todas las funciones devuelven arrays alineados con la entrada (null hasta tener datos).

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out[i] = null; continue; }
    sum += v; count++;
    if (count > period) {
      // retirar el valor que sale de la ventana (buscando hacia atrás valores no nulos)
      let j = i, seen = 0;
      while (j >= 0 && seen < period + 1) { if (values[j] != null) seen++; j--; }
      sum -= values[j + 1]; count--;
    }
    out[i] = count === period ? sum / period : null;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null, warm = [], warmed = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out[i] = prev; continue; }
    if (!warmed) {
      warm.push(v);
      if (warm.length === period) {
        prev = warm.reduce((a, b) => a + b, 0) / period;
        out[i] = prev;
        warmed = true;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI de Wilder (suavizado exponencial 1/period)
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let avgGain = null, avgLoss = null, prevPrice = null, count = 0, gains = 0, losses = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out[i] = null; continue; }
    if (prevPrice == null) { prevPrice = v; continue; }
    const ch = v - prevPrice;
    prevPrice = v;
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (avgGain == null) {
      gains += gain; losses += loss; count++;
      if (count === period) { avgGain = gains / period; avgLoss = losses / period; }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgGain != null) {
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast), es = ema(values, slow);
  const line = values.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v != null && sig[i] != null) ? v - sig[i] : null);
  return { line, signal: sig, hist };
}

// Retornos logarítmicos diarios
export function dailyReturns(values) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev != null) out[i] = Math.log(v / prev);
    prev = v;
  }
  return out;
}

// Volatilidad anualizada en ventana móvil (por defecto 30 sesiones)
export function rollingVolatility(values, window = 30) {
  const rets = dailyReturns(values);
  const out = new Array(values.length).fill(null);
  const buf = [];
  for (let i = 0; i < rets.length; i++) {
    if (rets[i] == null) { out[i] = buf.length === window ? out[i - 1] : null; continue; }
    buf.push(rets[i]);
    if (buf.length > window) buf.shift();
    if (buf.length === window) {
      const mean = buf.reduce((a, b) => a + b, 0) / window;
      const varr = buf.reduce((a, b) => a + (b - mean) ** 2, 0) / (window - 1);
      out[i] = Math.sqrt(varr * 252);
    }
  }
  return out;
}

// Caída desde el máximo de las últimas `window` sesiones (0 = en máximos, -0.2 = -20%)
export function drawdownFromHigh(values, window = 252) {
  const out = new Array(values.length).fill(null);
  const deque = []; // índices con valores decrecientes (máximo deslizante)
  const idxs = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out[i] = out[i - 1] ?? null; continue; }
    idxs.push(i);
    while (deque.length && values[deque[deque.length - 1]] <= v) deque.pop();
    deque.push(i);
    while (deque.length && idxs.length > window && deque[0] < idxs[idxs.length - window]) deque.shift();
    const high = values[deque[0]];
    out[i] = v / high - 1;
  }
  return out;
}

// Momentum 12-1: retorno de los últimos ~12 meses excluyendo el último mes
export function momentum12m1(values, i, lookback = 252, skip = 21) {
  if (i - lookback < 0) return null;
  const a = values[i - lookback], b = values[i - skip];
  if (a == null || b == null || a <= 0) return null;
  return b / a - 1;
}

export function lastNonNull(arr, i) {
  for (let j = i; j >= 0; j--) if (arr[j] != null) return arr[j];
  return null;
}
