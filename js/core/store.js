// Persistencia local (localStorage). Al ser una app no-custodial y sin backend,
// TODOS los datos del usuario viven en su dispositivo: perfil, portafolios,
// historial de recomendaciones aceptadas/rechazadas.

import { normalizeHolding, positionSnapshot } from './holdings.js';

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
// Se guarda el IMPORTE aportado en la divisa que elija el usuario (por defecto
// euros), opcionalmente las unidades, y el histórico de valoraciones que va
// anotando periódicamente. Ver js/core/holdings.js para el modelo completo.

export function listHoldings(portfolioId) {
  const hs = getState().holdings.map(normalizeHolding);
  return portfolioId ? hs.filter(h => h.portfolioId === portfolioId) : hs;
}

// Si el activo ya está en cartera, suma la aportación en lugar de duplicar la
// línea (es lo que hace cualquier bróker con una segunda compra).
// `at` permite registrar una aportación con su fecha real (puedes dar de alta
// hoy algo que compraste en 2020). Sin las fechas correctas, la TIR miente.
export function addHolding({ portfolioId, assetId, assetClass, currency, invested, units = 0, value = null, at = null }) {
  const s = getState();
  const amount = Number(invested), u = Number(units) || 0;
  if (!(amount > 0)) throw new Error('El importe invertido debe ser mayor que cero');
  if (u < 0) throw new Error('Las unidades no pueden ser negativas');
  const now = Date.now();
  const ts = at != null && Number.isFinite(Number(at)) ? Math.min(Number(at), now) : now;

  const raw = s.holdings.find(h => h.portfolioId === portfolioId && h.assetId === assetId);
  if (raw) {
    Object.assign(raw, normalizeHolding(raw));
    raw.contributions.push({ ts, amount });
    raw.contributions.sort((a, b) => a.ts - b.ts);
    raw.invested += amount;
    raw.units += u;
    raw.addedAt = Math.min(raw.addedAt || ts, ts);
    raw.updatedAt = now;
    if (value != null && Number(value) > 0) applyValuation(raw, Number(value), ts);
    save(s);
    return raw;
  }
  const holding = {
    id: 'h_' + Math.random().toString(36).slice(2, 10),
    portfolioId, assetId, assetClass, currency: currency || 'EUR',
    contributions: [{ ts, amount }],
    invested: amount, units: u,
    valuations: value != null && Number(value) > 0 ? [{ ts, value: Number(value) }] : [],
    addedAt: ts,
  };
  s.holdings.push(holding);
  save(s);
  return holding;
}

// Una valoración por día: reanotar el mismo día corrige, no acumula ruido.
function applyValuation(holding, value, ts) {
  const day = new Date(ts).toISOString().slice(0, 10);
  const sameDay = holding.valuations.find(x => new Date(x.ts).toISOString().slice(0, 10) === day);
  if (sameDay) { sameDay.ts = ts; sameDay.value = value; }
  else holding.valuations.push({ ts, value });
  holding.valuations.sort((a, b) => a.ts - b.ts);
}

// Corregir el importe total ajusta la ÚLTIMA aportación (es lo que se suele
// haber tecleado mal); si la diferencia no cabe en ella, se reparte a prorrata
// entre todas para no inventar fechas que el usuario no ha dado.
export function updateHolding(id, patch) {
  const s = getState();
  const raw = s.holdings.find(x => x.id === id);
  if (!raw) return null;
  Object.assign(raw, normalizeHolding(raw));

  if (patch.invested != null) {
    const target = Number(patch.invested);
    if (!(target > 0)) return removeHolding(id);
    const delta = target - raw.invested;
    const last = raw.contributions[raw.contributions.length - 1];
    if (last && last.amount + delta > 0) {
      last.amount += delta;
    } else if (raw.invested > 0) {
      const k = target / raw.invested;
      raw.contributions = raw.contributions.map(c => ({ ...c, amount: c.amount * k }));
    } else {
      raw.contributions = [{ ts: raw.addedAt || Date.now(), amount: target }];
    }
    raw.invested = raw.contributions.reduce((s2, c) => s2 + c.amount, 0);
  }
  if (patch.units != null) raw.units = Number(patch.units);
  raw.updatedAt = Date.now();
  save(s);
  return raw;
}

// Anota cuánto vale HOY la posición según el bróker del usuario. Es la clave
// para que la cartera refleje la realidad: el histórico local no llega a todos
// los activos ni a todas las fechas.
export function revalueHolding(id, value, ts = Date.now()) {
  const s = getState();
  const raw = s.holdings.find(x => x.id === id);
  if (!raw) return null;
  const v = Number(value);
  if (!(v >= 0)) throw new Error('El valor actual no puede ser negativo');
  Object.assign(raw, normalizeHolding(raw));
  applyValuation(raw, v, ts);
  raw.updatedAt = ts;
  save(s);
  return raw;
}

// Revalorización en bloque: { holdingId: valor }. Pensado para la rutina
// periódica de "abro el bróker y pongo al día toda la cartera de una vez".
export function revalueMany(values, ts = Date.now()) {
  let n = 0;
  for (const [id, value] of Object.entries(values || {})) {
    if (value == null || value === '' || !(Number(value) >= 0)) continue;
    if (revalueHolding(id, Number(value), ts)) n++;
  }
  return n;
}

export function removeHolding(id) {
  const s = getState();
  s.holdings = s.holdings.filter(h => h.id !== id);
  save(s);
  return null;
}

// Venta (total o parcial) ejecutada por el usuario en su bróker. Queda anotada
// en el historial con action 'sold': es trazabilidad, no entrena el motor.
// `amount` es el importe vendido en la divisa de la posición; se descuenta del
// invertido y, proporcionalmente, de las unidades.
export function recordSale({ id, amount, verdict }) {
  const s = getState();
  const raw = s.holdings.find(x => x.id === id);
  if (!raw) return null;
  Object.assign(raw, normalizeHolding(raw));
  const snap = positionSnapshot(raw, null);
  const value = snap.valueOrCost;
  const sold = Math.min(Number(amount) || 0, value);
  if (sold <= 0) return raw;
  const fraction = value > 0 ? sold / value : 1;

  s.decisions.push({
    assetId: raw.assetId, assetClass: raw.assetClass, action: 'sold',
    amount: sold, currency: raw.currency,
    units: raw.units > 0 ? raw.units * fraction : null,
    verdict: verdict || null, ts: Date.now(),
  });

  if (fraction >= 0.999) {
    s.holdings = s.holdings.filter(x => x.id !== id);
    save(s);
    return null;
  }
  // La venta es una RETIRADA fechada: entra como flujo negativo para que la TIR
  // sepa que ese dinero salió, y cuándo. Las unidades y el valor anotado se
  // reducen en la misma proporción.
  const now = Date.now();
  raw.contributions.push({ ts: now, amount: -sold });
  raw.invested = raw.contributions.reduce((s2, c) => s2 + c.amount, 0);
  raw.units *= 1 - fraction;
  raw.valuations = raw.valuations.map(v => ({ ...v, value: v.value * (1 - fraction) }));
  raw.updatedAt = now;
  save(s);
  return raw;
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
