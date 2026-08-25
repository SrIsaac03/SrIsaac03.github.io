// Persistencia local (localStorage). Al ser una app no-custodial y sin backend,
// TODOS los datos del usuario viven en su dispositivo: perfil, portafolios,
// historial de recomendaciones aceptadas/rechazadas.

const KEY = 'copiloto.v1';
export const MAX_PORTFOLIOS = 2;

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function getState() {
  const s = load();
  s.portfolios ||= [];
  s.history ||= [];
  s.decisions ||= [];
  s.holdings ||= [];        // cartera real del usuario (posiciones que ya tiene)
  s.strategyChoices ||= {}; // opción de cartera elegida por portafolio
  return s;
}

export function patchState(patch) {
  const s = getState();
  Object.assign(s, patch);
  save(s);
  return s;
}

export function resetAll() {
  localStorage.removeItem(KEY);
}

// --- Perfil / onboarding ---

export function saveProfile({ score, categoryId, answers }) {
  return patchState({ profile: { score, categoryId, answers, assessedAt: Date.now() } });
}

export function saveFinances({ capitalBandId, incomeBandId }) {
  return patchState({ finances: { capitalBandId, incomeBandId } });
}

export function saveBroker(brokerId) {
  return patchState({ brokerId });
}

// --- Portafolios (límite estricto: MAX_PORTFOLIOS) ---

export function listPortfolios() {
  return getState().portfolios.filter(p => !p.archived);
}

export function createPortfolio({ name, riskLevel }) {
  const s = getState();
  const active = s.portfolios.filter(p => !p.archived);
  if (active.length >= MAX_PORTFOLIOS) {
    throw new Error(`Límite alcanzado: máximo ${MAX_PORTFOLIOS} portafolios simultáneos`);
  }
  const usedSlots = new Set(active.map(p => p.slot));
  const slot = usedSlots.has(1) ? 2 : 1;
  const portfolio = {
    id: 'pf_' + Math.random().toString(36).slice(2, 10),
    name, riskLevel, slot,
    createdAt: Date.now(),
    archived: false,
  };
  s.portfolios.push(portfolio);
  save(s);
  return portfolio;
}

export function archivePortfolio(id) {
  const s = getState();
  const p = s.portfolios.find(p => p.id === id);
  if (p) { p.archived = true; save(s); }
  return p;
}

// --- Cartera real del usuario (posiciones que ya posee) ---
// Se guardan unidades y precio medio de compra EN LA DIVISA DEL ACTIVO. La
// conversión a euros se hace al pintar, con el cambio del día.

export function listHoldings(portfolioId) {
  const hs = getState().holdings;
  return portfolioId ? hs.filter(h => h.portfolioId === portfolioId) : hs;
}

// Si el activo ya está en cartera, promedia el precio de compra en lugar de
// duplicar la línea (es lo que hace cualquier bróker con una segunda compra).
export function addHolding({ portfolioId, assetId, assetClass, currency, units, entryPrice }) {
  const s = getState();
  const u = Number(units), p = Number(entryPrice);
  if (!(u > 0)) throw new Error('Las unidades deben ser mayores que cero');
  if (!(p > 0)) throw new Error('El precio de compra debe ser mayor que cero');
  const existing = s.holdings.find(h => h.portfolioId === portfolioId && h.assetId === assetId);
  if (existing) {
    const total = existing.units + u;
    existing.entryPrice = (existing.units * existing.entryPrice + u * p) / total;
    existing.units = total;
    existing.updatedAt = Date.now();
    save(s);
    return existing;
  }
  const holding = {
    id: 'h_' + Math.random().toString(36).slice(2, 10),
    portfolioId, assetId, assetClass, currency: currency || 'USD',
    units: u, entryPrice: p,
    addedAt: Date.now(),
  };
  s.holdings.push(holding);
  save(s);
  return holding;
}

export function updateHolding(id, patch) {
  const s = getState();
  const h = s.holdings.find(x => x.id === id);
  if (!h) return null;
  if (patch.units != null) h.units = Number(patch.units);
  if (patch.entryPrice != null) h.entryPrice = Number(patch.entryPrice);
  h.updatedAt = Date.now();
  if (h.units <= 0) return removeHolding(id);
  save(s);
  return h;
}

export function removeHolding(id) {
  const s = getState();
  s.holdings = s.holdings.filter(h => h.id !== id);
  save(s);
  return null;
}

// Venta (total o parcial) ejecutada por el usuario en su bróker. Queda anotada
// en el historial con action 'sold': es trazabilidad, no entrena el motor.
export function recordSale({ id, unitsSold, price, verdict }) {
  const s = getState();
  const h = s.holdings.find(x => x.id === id);
  if (!h) return null;
  const sold = Math.min(Number(unitsSold) || 0, h.units);
  if (sold <= 0) return h;
  s.decisions.push({
    assetId: h.assetId, assetClass: h.assetClass, action: 'sold',
    units: sold, price: price ?? null, entryPrice: h.entryPrice,
    verdict: verdict || null, ts: Date.now(),
  });
  h.units -= sold;
  if (h.units <= 1e-9) s.holdings = s.holdings.filter(x => x.id !== id);
  save(s);
  return h.units > 0 ? h : null;
}

// --- Opción de cartera elegida (una por portafolio) ---

export function saveStrategyChoice(portfolioId, strategyId, meta = {}) {
  const s = getState();
  s.strategyChoices[portfolioId] = { strategyId, ...meta, chosenAt: Date.now() };
  save(s);
  return s.strategyChoices[portfolioId];
}

export function getStrategyChoice(portfolioId) {
  return getState().strategyChoices[portfolioId] || null;
}

export function clearStrategyChoice(portfolioId) {
  const s = getState();
  delete s.strategyChoices[portfolioId];
  save(s);
}

// --- Decisiones sobre recomendaciones (feedback loop, etapa 5) ---

export function recordDecision({ assetId, assetClass, action, reasonId, note, snapshot }) {
  const s = getState();
  s.decisions.push({ assetId, assetClass, action, reasonId, note: note || null, snapshot: snapshot || null, ts: Date.now() });
  save(s);
  return s.decisions[s.decisions.length - 1];
}

export function listDecisions() {
  return getState().decisions;
}
