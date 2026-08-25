// Cartera real del usuario: las posiciones que YA tiene, guardadas en su
// dispositivo. Cálculo puro de coste, valor, plusvalías y pesos.
//
// Convención de divisa: el llamante entrega precios ya homogéneos (misma
// divisa que `entryPrice`, o ambos convertidos). El módulo no convierte nada:
// así permanece puro y testeable sin datos de cambio.

// Una posición almacenada: { id, portfolioId, assetId, assetClass, units, entryPrice, addedAt }
export function positionSnapshot(holding, price) {
  const units = Number(holding.units) || 0;
  const entryPrice = Number(holding.entryPrice) || 0;
  const cost = units * entryPrice;
  const priced = price != null && Number.isFinite(price);
  const value = priced ? units * price : null;
  return {
    ...holding,
    units, entryPrice,
    price: priced ? price : null,
    priced,
    cost,
    value,
    // si no hay precio, el coste es la mejor estimación disponible del valor
    valueOrCost: value == null ? cost : value,
    pnl: value == null ? null : value - cost,
    pnlPct: value == null || cost <= 0 ? null : value / cost - 1,
  };
}

// holdings: array de posiciones · priceOf(holding) → precio actual o null
// capitalBase: capital total estimado del usuario (para % sobre capital, no
// solo sobre lo ya invertido). Si es menor que lo invertido, manda lo invertido.
export function portfolioSnapshot(holdings, priceOf, { capitalBase = 0 } = {}) {
  const positions = (holdings || []).map(h => positionSnapshot(h, priceOf(h)));
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

  return {
    positions,
    byClass,
    totalCost,
    totalValue,
    capitalBase: base,
    pnl: totalValue - totalCost,
    pnlPct: totalCost > 0 ? totalValue / totalCost - 1 : null,
    investedPct: base > 0 ? (totalValue / base) * 100 : 0,
    liquidityPct: base > 0 ? Math.max(0, 100 - (totalValue / base) * 100) : 100,
    stale: positions.some(p => !p.priced),
  };
}

// Suma posiciones del mismo activo en un precio medio ponderado. Se usa al
// añadir una compra sobre un activo que ya está en cartera.
export function mergeLots(existing, addedUnits, addedPrice) {
  const u0 = Number(existing?.units) || 0;
  const p0 = Number(existing?.entryPrice) || 0;
  const u1 = Number(addedUnits) || 0;
  const p1 = Number(addedPrice) || 0;
  const units = u0 + u1;
  if (units <= 0) return { units: 0, entryPrice: 0 };
  return { units, entryPrice: (u0 * p0 + u1 * p1) / units };
}
