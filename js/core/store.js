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

// --- Cartera real: activos que el usuario POSEE en cada portafolio ---
// Se guardan en local (no-custodial): solo el activo y una referencia opcional.
// No pedimos importes exactos; el peso es una banda opcional para futuras
// recomendaciones proporcionales.

export function listHoldings(portfolioId) {
  const p = getState().portfolios.find(p => p.id === portfolioId);
  return (p && p.holdings) || [];
}

export function addHolding(portfolioId, { assetId, weightBandId = null, note = null }) {
  const s = getState();
  const p = s.portfolios.find(p => p.id === portfolioId);
  if (!p) throw new Error('Portafolio no encontrado');
  p.holdings ||= [];
  if (p.holdings.some(h => h.assetId === assetId)) {
    throw new Error('Ese activo ya está en esta cartera');
  }
  const holding = {
    id: 'h_' + Math.random().toString(36).slice(2, 10),
    assetId, weightBandId, note: note || null,
    addedAt: Date.now(),
  };
  p.holdings.push(holding);
  save(s);
  return holding;
}

export function removeHolding(portfolioId, holdingId) {
  const s = getState();
  const p = s.portfolios.find(p => p.id === portfolioId);
  if (!p || !p.holdings) return;
  p.holdings = p.holdings.filter(h => h.id !== holdingId);
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
