// Cartera real del usuario: las posiciones que YA tiene, guardadas en su
// dispositivo. Cálculo puro de coste, valor, plusvalías y pesos.
//
// Modelo de una posición:
//   { id, portfolioId, assetId, assetClass, currency,
//     contributions: [{ts, amount}], // cada aportación CON SU FECHA (negativo = retirada)
//     invested,                      // suma de las aportaciones (derivado)
//     units,                         // opcional: nº de participaciones/acciones
//     valuations: [{ts, value}],     // revalorizaciones que el usuario va anotando
//     addedAt }
//
// El importe es lo primario porque es lo que el usuario conoce sin dudar
// ("metí 500 €"); las unidades son opcionales y solo sirven para poder valorar
// a precio de mercado.
//
// Las aportaciones se guardan una a una con su fecha, no agregadas: 500 € de
// hace tres años y 300 € del mes pasado no han corrido la misma suerte, y sin
// las fechas no hay forma de calcular la TIR ni el rendimiento por tramos
// (ver js/core/returns.js). Como el histórico local se queda corto para muchos
// activos, el usuario puede anotar periódicamente cuánto vale hoy su posición:
// esa valoración manual es la fuente de verdad cuando es más reciente que el
// último precio disponible.
//
// Convención de divisa: el llamante entrega importes y precios ya homogéneos
// (todo en la misma divisa). El módulo no convierte nada: así permanece puro.

import { moneyWeightedReturn, timeWeightedReturn, averageHoldingYears } from './returns.js';

// Migra una posición de los modelos antiguos al actual.
//   v1: units + entryPrice          → invested derivado
//   v2: invested agregado           → una aportación única en addedAt
// `invested` pasa a ser SIEMPRE la suma de las aportaciones: guardar cada una
// con su fecha es lo que permite calcular TIR y rentabilidad por tramos.
export function normalizeHolding(h) {
  const units = Number(h.units) || 0;
  const legacyInvested = h.invested != null
    ? Number(h.invested) || 0
    : units * (Number(h.entryPrice) || 0);

  let contributions = Array.isArray(h.contributions) ? h.contributions : null;
  if (!contributions || !contributions.length) {
    contributions = legacyInvested > 0
      ? [{ ts: h.addedAt || Date.now(), amount: legacyInvested }]
      : [];
  }
  const invested = contributions.reduce((s, c) => s + (Number(c.amount) || 0), 0);

  return {
    ...h,
    units,
    contributions,
    invested,
    valuations: Array.isArray(h.valuations) ? h.valuations : [],
  };
}

// La valoración manual más reciente, o null si nunca ha anotado ninguna.
export function latestValuation(holding) {
  const vs = holding.valuations;
  if (!vs || !vs.length) return null;
  return vs.reduce((a, b) => (b.ts > a.ts ? b : a));
}

// El valor de la posición en un momento dado según lo que el usuario anotó
// (la última valoración con fecha <= ts). Sirve para reconstruir la evolución.
export function valuationAt(holding, ts) {
  let best = null;
  for (const v of holding.valuations || []) {
    if (v.ts <= ts && (!best || v.ts > best.ts)) best = v;
  }
  return best ? best.value : null;
}

// price: precio de mercado por unidad · priceTs: fecha de ese precio (ms)
export function positionSnapshot(holding, price, { priceTs = null, now = Date.now() } = {}) {
  const h = normalizeHolding(holding);
  const cost = h.invested;
  const marked = latestValuation(h);
  const hasPrice = price != null && Number.isFinite(price) && h.units > 0;
  const byMarket = hasPrice ? h.units * price : null;

  // Gana la información más fresca: si el usuario anotó el valor después de la
  // fecha del último precio disponible, su dato manda (viene de su bróker).
  let value = null, valueSource = null, valuedAt = null;
  if (marked && byMarket != null) {
    if (priceTs != null && priceTs > marked.ts) {
      value = byMarket; valueSource = 'mercado'; valuedAt = priceTs;
    } else {
      value = marked.value; valueSource = 'manual'; valuedAt = marked.ts;
    }
  } else if (marked) {
    value = marked.value; valueSource = 'manual'; valuedAt = marked.ts;
  } else if (byMarket != null) {
    value = byMarket; valueSource = 'mercado'; valuedAt = priceTs;
  }

  const valued = value != null;
  const pnlPct = valued && cost > 0 ? value / cost - 1 : null;
  // TIR: tiene en cuenta cuánto tiempo lleva dentro cada aportación
  const irr = valued
    ? moneyWeightedReturn({ contributions: h.contributions, currentValue: value, now })
    : null;

  return {
    ...h,
    price: hasPrice ? price : null,
    cost,
    entryPrice: h.units > 0 ? cost / h.units : null,
    value: valued ? value : null,
    valued,
    valueSource,
    valuedAt,
    // días desde la última valoración: para avisar de que está desfasada
    staleDays: valuedAt != null ? Math.floor((now - valuedAt) / 86400000) : null,
    // si nunca se ha valorado, el coste es la mejor estimación disponible
    valueOrCost: valued ? value : cost,
    pnl: valued ? value - cost : null,
    pnlPct,
    // rentabilidad anual real de tu dinero, ponderada por cuándo lo aportaste
    irr,
    avgYears: averageHoldingYears(h.contributions, now),
    contributionCount: h.contributions.length,
    valuationCount: (h.valuations || []).length,
  };
}

// holdings: array de posiciones · priceOf(holding) → precio actual o null
// priceTsOf(holding) → fecha de ese precio en ms (opcional)
// capitalBase: capital total estimado del usuario (para % sobre capital, no
// solo sobre lo ya invertido). Si es menor que lo invertido, manda lo invertido.
export function portfolioSnapshot(holdings, priceOf, { capitalBase = 0, priceTsOf = () => null, now = Date.now() } = {}) {
  const positions = (holdings || []).map(h =>
    positionSnapshot(h, priceOf(h), { priceTs: priceTsOf(h), now }));
  const totalCost = positions.reduce((s, p) => s + p.cost, 0);
  const totalValue = positions.reduce((s, p) => s + p.valueOrCost, 0);
  const base = Math.max(Number(capitalBase) || 0, totalValue);

  for (const p of positions) {
    p.weightPct = totalValue > 0 ? (p.valueOrCost / totalValue) * 100 : 0;
    p.capitalPct = base > 0 ? (p.valueOrCost / base) * 100 : 0;
  }
  positions.sort((a, b) => b.valueOrCost - a.valueOrCost);

  const byClass = {};
  for (const p of positions) {
    const c = p.assetClass || 'otros';
    byClass[c] = (byClass[c] || 0) + (totalValue > 0 ? (p.valueOrCost / totalValue) * 100 : 0);
  }

  const pnlPct = totalCost > 0 ? totalValue / totalCost - 1 : null;

  // Rentabilidades con todas las aportaciones de la cartera y sus fechas
  const contributions = positions.flatMap(p => p.contributions || []);
  const irr = totalValue > 0
    ? moneyWeightedReturn({ contributions, currentValue: totalValue, now })
    : null;
  // TWR: exige saber cuánto valía la cartera en cada tramo, así que solo sale
  // si el usuario ha ido anotando valoraciones en fechas distintas
  const history = valuationHistory(holdings, { now });
  const twr = history.length >= 1
    ? timeWeightedReturn({
        valuations: history.map(x => ({ ts: Date.parse(x.date), value: x.value })),
        contributions, currentValue: totalValue, now,
      })
    : null;

  // La posición más desfasada marca cuánto hace que la foto no se refresca
  const staleDays = positions.reduce((m, p) => (p.staleDays != null && (m == null || p.staleDays > m) ? p.staleDays : m), null);

  return {
    positions,
    byClass,
    totalCost,
    totalValue,
    capitalBase: base,
    pnl: totalValue - totalCost,
    pnlPct,
    contributions,
    irr,                                        // TIR anualizada de tu dinero
    twr,                                        // rentabilidad de los activos (comparable con índices)
    avgYears: averageHoldingYears(contributions, now),
    investedPct: base > 0 ? (totalValue / base) * 100 : 0,
    liquidityPct: base > 0 ? Math.max(0, 100 - (totalValue / base) * 100) : 100,
    staleDays,
    // posiciones sin ninguna valoración: la foto todavía no es real
    unvalued: positions.filter(p => !p.valued).length,
    stale: positions.some(p => !p.valued),
  };
}

// Evolución del valor total de la cartera a partir de las valoraciones que el
// usuario ha ido anotando. En cada fecha suma, por posición, la última
// valoración conocida hasta ese día (y su coste si aún no tenía ninguna).
// Devuelve [{ date:'YYYY-MM-DD', value, cost }] ordenado por fecha.
export function valuationHistory(holdings, { now = Date.now() } = {}) {
  const hs = (holdings || []).map(normalizeHolding);
  const stamps = new Set();
  for (const h of hs) for (const v of h.valuations) stamps.add(v.ts);
  if (stamps.size < 2) return [];

  const sorted = [...stamps].sort((a, b) => a - b);
  const out = [];
  for (const ts of sorted) {
    let value = 0, cost = 0;
    for (const h of hs) {
      if (h.addedAt && h.addedAt > ts) continue; // aún no estaba en cartera
      const v = valuationAt(h, ts);
      value += v == null ? h.invested : v;
      cost += h.invested;
    }
    const date = new Date(ts).toISOString().slice(0, 10);
    // una sola entrada por día: la última del día manda
    if (out.length && out[out.length - 1].date === date) out[out.length - 1] = { date, value, cost };
    else out.push({ date, value, cost });
  }
  return out;
}

