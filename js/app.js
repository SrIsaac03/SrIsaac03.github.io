// Copiloto de Inversión — aplicación (SPA sin dependencias).
// Arquitectura: los módulos de js/core son el "backend" (puros, testeados en Node);
// este archivo solo orquesta interfaz + datos en vivo + persistencia local.

import { ASSETS, getAsset } from './core/assets.js';
import { BROKERS, getBroker } from './core/brokers.js';
import { QUESTIONS, LIKERT, CATEGORIES, CAPITAL_BANDS, INCOME_BANDS, scoreTest } from './core/profile.js';
import { REJECT_REASONS } from './core/feedback.js';
import { SeriesAnalyzer, generateRecommendations, timingSignal, DEFAULT_PARAMS } from './core/engine.js';
import { generateStrategyOptions } from './core/strategies.js';
import { derivePreferences } from './core/preferences.js';
import { portfolioSnapshot, valuationHistory } from './core/holdings.js';
import { contributionBreakdown } from './core/returns.js';
import { reviewPortfolio, VERDICTS } from './core/review.js';
import * as store from './core/store.js';
import { bootstrapMarketData } from './data/providers.js';
import { lineChart } from './ui/chart.js';

const $app = document.getElementById('app');
const $badge = document.getElementById('dataBadge');

// Máquina del tiempo: ?fecha=YYYY-MM-DD analiza el mercado como era ese día
// (solo histórico local, sin cripto) y muestra qué pasó en los 3 meses siguientes.
const TIME_MACHINE = /^\d{4}-\d{2}-\d{2}$/.test(new URLSearchParams(location.search).get('fecha') || '')
  ? new URLSearchParams(location.search).get('fecha') : null;

// ---------- Estado de datos de mercado ----------

const market = {
  ready: false,
  bundle: null,
  dates: null,        // calendario efectivo (bundle + S&P500 en vivo si llegó)
  sp500: null,
  lastIndex: 0,
  crypto: new Map(),
  fx: null,
  live: false,
  errors: [],
  analyzers: new Map(),
  indexAnalyzer: null,
};

async function initMarketData() {
  const cryptoAssets = ASSETS.filter(a => a.assetClass === 'crypto' && a.binance);
  const st = await bootstrapMarketData(cryptoAssets);
  market.bundle = st.bundle;
  market.crypto = st.crypto;
  market.fx = st.fx;
  market.errors = st.errors;
  if (st.sp500Live && !TIME_MACHINE) {
    market.dates = st.sp500Live.dates;
    market.sp500 = st.sp500Live.sp500;
    market.live = true;
  } else {
    market.dates = st.bundle.dates;
    market.sp500 = st.bundle.series.SP500;
  }
  market.lastIndex = market.dates.length - 1;
  if (TIME_MACHINE) {
    let idx = -1;
    for (let i = market.dates.length - 1; i >= 0; i--) {
      if (market.dates[i] <= TIME_MACHINE) { idx = i; break; }
    }
    if (idx > 300) { // suficiente calentamiento de indicadores
      market.lastIndex = idx;
      market.timeMachine = market.dates[idx];
    }
  }
  market.indexAnalyzer = new SeriesAnalyzer(market.sp500);
  market.ready = true;
  updateBadge();
}

function updateBadge() {
  if (!market.ready) { $badge.textContent = 'Cargando datos…'; return; }
  const last = market.dates[market.lastIndex];
  if (market.timeMachine) {
    $badge.innerHTML = `🕰 Máquina del tiempo: ${last}`;
    return;
  }
  const cryptoLive = [...market.crypto.values()].some(c => !c.spotOnly);
  $badge.innerHTML =
    `Índice: ${market.live ? 'en vivo' : 'histórico'} · ${last}` +
    (cryptoLive ? ' · cripto en vivo' : '') +
    (market.fx ? ` · 1 USD = ${market.fx.rate.toFixed(3)} €` : '');
}

// El analizador de cada activo (histórico local o serie cripto en vivo)
function seriesFor(asset) {
  if (market.analyzers.has(asset.id)) return market.analyzers.get(asset.id);
  let analyzer = null;
  if (asset.series && market.bundle.series[asset.series]) {
    const vals = asset.series === 'SP500' ? market.sp500 : market.bundle.series[asset.series];
    analyzer = new SeriesAnalyzer(vals);
  } else if (asset.assetClass === 'crypto' && !market.timeMachine) {
    // en la máquina del tiempo no hay histórico cripto local: se excluyen
    const c = market.crypto.get(asset.id);
    if (c && c.closes && c.closes.length > 260) analyzer = new SeriesAnalyzer(c.closes);
  }
  market.analyzers.set(asset.id, analyzer);
  return analyzer;
}

// Contexto común del motor. `preferences` traduce las RESPUESTAS guardadas del
// test (no solo su puntuación) en exclusiones y sesgos sobre qué comprar.
function engineCtx(portfolio) {
  const s = store.getState();
  const category = CATEGORIES.find(c => c.id === (portfolio?.riskLevel || s.profile.categoryId)) || CATEGORIES[1];
  const capital = CAPITAL_BANDS.find(b => b.id === s.finances?.capitalBandId)?.mid ?? 10000;
  const income = INCOME_BANDS.find(b => b.id === s.finances?.incomeBandId)?.mid ?? 2000;
  return {
    assets: ASSETS,
    seriesFor,
    dateIndex: market.lastIndex,
    indexAnalyzer: market.indexAnalyzer,
    profile: { score: s.profile.score, category },
    category,
    capitalMid: capital,
    incomeMid: income,
    broker: getBroker(s.brokerId),
    history: s.decisions,
    preferences: derivePreferences(s.profile?.answers),
    now: Date.now(),
  };
}

function runEngine(portfolio) {
  return generateRecommendations(engineCtx(portfolio));
}

// Varias formas coherentes de invertir hoy el mismo perfil: el usuario elige.
function runStrategies(portfolio) {
  return generateStrategyOptions(engineCtx(portfolio));
}

// ---------- Precios y cartera real ----------

// Último precio conocido de un activo, en su propia divisa.
function priceInfo(asset) {
  if (!market.ready || !asset) return null;
  if (asset.assetClass === 'crypto') {
    const c = market.crypto.get(asset.id);
    return c?.lastPrice ? { price: c.lastPrice, currency: 'USD', date: 'en vivo', ts: Date.now() } : null;
  }
  const vals = asset.series === 'SP500' ? market.sp500 : market.bundle?.series?.[asset.series];
  if (!vals) return null;
  let i = Math.min(market.lastIndex, vals.length - 1);
  while (i > 0 && vals[i] == null) i--;
  if (vals[i] == null) return null;
  return {
    price: vals[i], currency: asset.currency || 'USD',
    date: market.dates[i], ts: Date.parse(market.dates[i]) || null,
  };
}

const fxRate = () => market.fx?.rate ?? 1;

// Homogeneiza la cartera a euros al cambio de HOY: los importes del usuario van
// en la divisa que él eligió; el precio de mercado, en la del activo.
function eurHoldings(holdings) {
  return holdings.map(h => {
    const asset = getAsset(h.assetId);
    const info = priceInfo(asset);
    const hr = h.currency === 'EUR' ? 1 : fxRate();               // importes del usuario
    const ar = (asset?.currency || 'USD') === 'EUR' ? 1 : fxRate(); // precio del activo
    return {
      ...h,
      assetClass: h.assetClass || asset?.assetClass || 'otros',
      assetName: asset?.name || h.assetId,
      invested: h.invested * hr,
      valuations: (h.valuations || []).map(v => ({ ...v, value: v.value * hr })),
      livePrice: info ? info.price * ar : null,
      priceTs: info ? info.ts : null,
      priceDate: info?.date || null,
    };
  });
}

// Estado técnico actual de un activo (mismo criterio que el ranking del motor).
function stateOf(assetId) {
  const a = getAsset(assetId);
  const an = a ? seriesFor(a) : null;
  if (!an) return null;
  return an.stateAt(Math.min(market.lastIndex, an.lastValid));
}

// Todas las posiciones de las carteras activas (las archivadas no cuentan).
function activeHoldings() {
  const ids = new Set(store.listPortfolios().map(p => p.id));
  return store.listHoldings().filter(h => ids.has(h.portfolioId));
}

// Balance consolidado: todo tu patrimonio invertido, sumando carteras.
function globalSnapshot() {
  const s = store.getState();
  const capital = CAPITAL_BANDS.find(b => b.id === s.finances?.capitalBandId)?.mid ?? 10000;
  return portfolioSnapshot(eurHoldings(activeHoldings()), h => h.livePrice,
    { capitalBase: capital, priceTsOf: h => h.priceTs });
}

// Snapshot de una cartera concreta, sin pasar por el motor de revisión.
function snapshotOf(portfolioId) {
  return portfolioSnapshot(eurHoldings(store.listHoldings(portfolioId)), h => h.livePrice,
    { priceTsOf: h => h.priceTs });
}

// Barra de distribución + leyenda. Mismo lenguaje visual que las opciones de
// cartera, para que "distribución" se lea igual en toda la app.
function distribution(segments, { legend = true, max = 8 } = {}) {
  const items = segments.filter(s => s.value > 0).sort((a, b) => b.value - a.value);
  const total = items.reduce((s, x) => s + x.value, 0);
  if (!total) return '';
  // agrupamos la cola en "Otros" para que la leyenda no se dispare
  const shown = items.slice(0, max);
  const rest = items.slice(max);
  if (rest.length) shown.push({ name: `Otros (${rest.length})`, value: rest.reduce((s, x) => s + x.value, 0) });
  const withPct = shown.map((x, i) => ({ ...x, pct: (x.value / total) * 100, color: `var(--cat-${(i % 6) + 1})` }));
  return `
    <div class="stack" role="img" aria-label="Distribución: ${withPct.map(x => `${esc(x.name)} ${round1(x.pct)}%`).join(', ')}">
      ${withPct.map(x => `<span style="width:${x.pct}%;background:${x.color}"></span>`).join('')}
    </div>
    ${legend ? `<ul class="poslist">
      ${withPct.map(x => `<li>
        <span class="dot" style="background:${x.color}" aria-hidden="true"></span>
        <span class="nm">${esc(x.name)}</span>
        <span class="pp">${round1(x.pct)}%</span>
        <span class="pp muted" style="min-width:74px;text-align:right">${fmtEur0.format(x.value)}</span>
      </li>`).join('')}
    </ul>` : ''}`;
}

const CLASS_LABEL = { etf: 'ETFs', equity: 'Acciones', crypto: 'Cripto', fund: 'Fondos', bond: 'Bonos', otros: 'Otros' };

// Revisión completa de la cartera guardada: veredicto por posición + alertas.
function runReview(portfolio, targetEquityPct) {
  const ctx = engineCtx(portfolio);
  const snapshot = portfolioSnapshot(
    eurHoldings(store.listHoldings(portfolio.id)),
    h => h.livePrice,
    { capitalBase: ctx.capitalMid, priceTsOf: h => h.priceTs },
  );
  const out = reviewPortfolio({
    snapshot,
    assetOf: getAsset,
    stateOf,
    category: ctx.category,
    preferences: ctx.preferences,
    targetEquityPct,
  });
  return { ...out, preferences: ctx.preferences, category: ctx.category };
}

// Demostración de protección en vivo: sobre TODO el histórico disponible, compara
// la peor caída del semáforo (exposición 100/50/0% según señal confirmada, aplicada
// al día siguiente, liquidez al 0%) frente a comprar-y-mantener. Se cachea.
let _protectionStats = null;
function computeProtectionStats() {
  if (_protectionStats) return _protectionStats;
  const sp = market.sp500, N = market.lastIndex + 1;
  const k = DEFAULT_PARAMS.signalPersistence || 1;
  // señal confirmada en todo el histórico (FSM en una pasada)
  const conf = new Array(N).fill(null);
  let cur = null, cand = null, run = 0;
  for (let i = 0; i < N; i++) {
    const st = market.indexAnalyzer.stateAt(i);
    const raw = st ? timingSignal(st, DEFAULT_PARAMS, 0)?.signal : null;
    if (raw == null) { conf[i] = cur; continue; }
    if (cur == null) { cur = raw; cand = raw; run = 0; }
    else { if (raw === cand) run++; else { cand = raw; run = 1; } if (cand !== cur && run >= k) cur = cand; }
    conf[i] = cur;
  }
  const expOf = { green: 1, amber: 0.5, red: 0 };
  const start = market.dates.findIndex(d => d >= '1991-01-01');
  let sEq = 1, sPeak = 1, sDD = 0, bEq = 1, bPeak = 1, bDD = 0, exposure = 0;
  for (let i = Math.max(start, 1); i < N; i++) {
    if (sp[i] == null || sp[i - 1] == null) continue;
    const r = sp[i] / sp[i - 1] - 1;
    sEq *= 1 + exposure * r; sPeak = Math.max(sPeak, sEq); sDD = Math.min(sDD, sEq / sPeak - 1);
    bEq *= 1 + r; bPeak = Math.max(bPeak, bEq); bDD = Math.min(bDD, bEq / bPeak - 1);
    if (conf[i] != null) exposure = expOf[conf[i]];
  }
  const years = (N - start) / 252;
  _protectionStats = { years, stratMaxDD: sDD, bhMaxDD: bDD, stratMult: sEq, bhMult: bEq };
  return _protectionStats;
}

// ---------- Utilidades de render ----------

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Formato numérico español (coma decimal, punto de millares).
const _pctFmt = {};
const fmtPct = (x, d = 1) => {
  if (x == null) return '—';
  const f = _pctFmt[d] || (_pctFmt[d] = new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
  return f.format(x * 100) + '%';
};
const fmtNum0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const fmtEur0 = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmtEur2 = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const fmtUnits = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 6 });
const round1 = x => Math.round(x * 10) / 10;

// De dónde sale el valor de una posición, para que nunca haya duda de si la
// cifra que se ve es un dato del usuario o una cotización.
function valuationLabel(p) {
  if (!p.valued) return 'sin valorar: se usa el coste';
  const when = p.staleDays === 0 ? 'hoy'
    : p.staleDays === 1 ? 'ayer'
    : p.staleDays != null ? `hace ${p.staleDays} días`
    : '';
  return p.valueSource === 'manual' ? `valor que anotaste ${when}` : `a precio de mercado ${when}`;
}

// ---------- Navegación ----------

const TABS = [
  { id: 'hoy', label: 'Hoy', ico: '🧭' },
  { id: 'cartera', label: 'Cartera', ico: '💼' },
  { id: 'mercado', label: 'Mercado', ico: '📈' },
  { id: 'historial', label: 'Historial', ico: '🗂️' },
  { id: 'ajustes', label: 'Ajustes', ico: '⚙️' },
];
let currentTab = 'hoy';

function renderNav() {
  const nav = document.getElementById('tabs');
  nav.setAttribute('role', 'tablist');
  nav.innerHTML = '';
  TABS.forEach((t, idx) => {
    const b = document.createElement('button');
    const active = t.id === currentTab;
    b.className = active ? 'active' : '';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', active ? 'true' : 'false');
    b.setAttribute('tabindex', active ? '0' : '-1'); // patrón roving tabindex
    b.setAttribute('aria-label', t.label);
    b.innerHTML = `<span class="ico" aria-hidden="true">${t.ico}</span>${t.label}`;
    b.onclick = () => { currentTab = t.id; render(); };
    b.onkeydown = (e) => {
      let ni = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') ni = (idx + 1) % TABS.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ni = (idx - 1 + TABS.length) % TABS.length;
      else if (e.key === 'Home') ni = 0;
      else if (e.key === 'End') ni = TABS.length - 1;
      if (ni != null) { e.preventDefault(); currentTab = TABS[ni].id; render(); document.querySelector('nav.tabs button.active')?.focus(); }
    };
    nav.appendChild(b);
  });
}

function onboarded() {
  const s = store.getState();
  return s.profile && s.finances && s.brokerId && store.listPortfolios().length > 0;
}

// Refleja el estado de selección de los botones .opt para lectores de pantalla.
function decorateA11y() {
  document.querySelectorAll('.opt').forEach(el => {
    el.setAttribute('aria-pressed', el.classList.contains('selected') ? 'true' : 'false');
  });
}

function render() {
  const nav = document.getElementById('tabs');
  if (!onboarded()) { nav.style.display = 'none'; renderOnboarding(); return; }
  nav.style.display = '';
  renderNav();
  const views = { hoy: viewHoy, cartera: viewCartera, mercado: viewMercado, historial: viewHistorial, ajustes: viewAjustes };
  views[currentTab]();
  decorateA11y();
}

// ---------- Onboarding ----------

const ob = { step: 0, answers: {}, capitalBandId: null, incomeBandId: null, brokerId: null, pfName: 'Mi cartera', pfRisk: null };

const OB_STEP_NAMES = ['', 'Test de riesgo', 'Tus finanzas', 'Tu bróker', 'Tu portafolio'];

function renderOnboarding() {
  const steps = [obWelcome, obTest, obFinances, obBroker, obPortfolio];
  $app.innerHTML = '';
  const container = h('<div class="fade-in" id="ob"></div>').firstElementChild;
  // indicador de progreso (pasos 1-4; la bienvenida no lo muestra)
  if (ob.step >= 1) {
    const pctDone = (ob.step / (steps.length - 1)) * 100;
    container.appendChild(h(`
      <div class="ob-steps" role="group" aria-label="Progreso del onboarding: paso ${ob.step} de ${steps.length - 1}, ${OB_STEP_NAMES[ob.step]}">
        <div class="ob-steps-bar"><div style="width:${pctDone}%"></div></div>
        <div class="ob-steps-label small muted">Paso ${ob.step} de ${steps.length - 1} · ${OB_STEP_NAMES[ob.step]}</div>
      </div>`));
  }
  const slot = h('<div></div>').firstElementChild;
  container.appendChild(slot);
  $app.appendChild(container);
  steps[ob.step](slot);
  decorateA11y();
}

function obWelcome(el) {
  el.appendChild(h(`
    <div class="hero">
      <h1>Copiloto de Inversión<span style="color:var(--accent)">.</span></h1>
      <p>Te dice <strong>qué porcentaje</strong> de tu capital invertir, <strong>cuándo</strong> es buen momento
      y <strong>qué activos</strong> puedes contratar en tu propio banco o bróker. Tú siempre ejecutas; nosotros nunca tocamos tu dinero.</p>
    </div>
    <div class="card">
      <h2>Antes de empezar</h2>
      <p class="small ink2">· Esta app es <strong>educativa</strong>: no es asesoramiento financiero personalizado.<br>
      · Es <strong>no-custodial</strong>: nunca opera por ti ni conecta con tus cuentas.<br>
      · Tus datos se guardan <strong>solo en este dispositivo</strong>.</p>
      <div style="margin-top:14px"><button class="btn" id="start">Empezar (2 minutos)</button></div>
    </div>`));
  el.querySelector('#start').onclick = () => { ob.step = 1; renderOnboarding(); };
}

function obTest(el) {
  const answered = Object.keys(ob.answers).length;
  el.appendChild(h(`
    <div class="card">
      <h2>Test de perfil de riesgo</h2>
      <p class="muted">Único método de perfilado: responde con sinceridad. ${answered}/${QUESTIONS.length}</p>
      <div class="progress"><div style="width:${(answered / QUESTIONS.length) * 100}%"></div></div>
      <div id="qs"></div>
      <div class="row spread" style="margin-top:14px">
        <button class="btn ghost sm" id="back">Atrás</button>
        <button class="btn" id="next" ${answered < QUESTIONS.length ? 'disabled' : ''}>Ver mi perfil</button>
      </div>
    </div>`));
  const qs = el.querySelector('#qs');
  QUESTIONS.forEach((q, qi) => {
    const cur = ob.answers[q.id];
    const block = h(`
      <div style="margin:16px 0">
        <p id="q_${q.id}"><strong>${qi + 1}.</strong> ${esc(q.text)}</p>
        <div class="likert" data-q="${q.id}" role="radiogroup" aria-labelledby="q_${q.id}">
          ${LIKERT.map((l, v) => `<button type="button" role="radio" data-v="${v}" class="${cur === v ? 'selected' : ''}" aria-checked="${cur === v ? 'true' : 'false'}" tabindex="${(cur === v || (cur == null && v === 0)) ? '0' : '-1'}" aria-label="${esc(l)}"><span aria-hidden="true">${['--', '-', '·', '+', '++'][v]}</span></button>`).join('')}
        </div>
      </div>`);
    qs.appendChild(block);
  });
  const choose = (b, keepFocus = false) => {
    const qid = b.parentElement.dataset.q;
    ob.answers[qid] = parseInt(b.dataset.v, 10);
    renderOnboarding();
    requestAnimationFrame(() => {
      if (keepFocus) {
        document.querySelector(`.likert[data-q="${qid}"] button[aria-checked="true"]`)?.focus();
      }
      const idx = QUESTIONS.findIndex(q => q.id === qid);
      const next = document.querySelectorAll('#qs > div')[Math.min(idx + 1, QUESTIONS.length - 1)];
      if (!keepFocus) next?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };
  qs.querySelectorAll('.likert').forEach(group => {
    const btns = [...group.querySelectorAll('button')];
    btns.forEach((b, i) => {
      b.onclick = () => choose(b);
      b.onkeydown = (e) => {
        let ni = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') ni = Math.min(i + 1, btns.length - 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ni = Math.max(i - 1, 0);
        else if (e.key === 'Home') ni = 0;
        else if (e.key === 'End') ni = btns.length - 1;
        if (ni != null) { e.preventDefault(); choose(btns[ni], true); }
      };
    });
  });
  el.querySelector('#back').onclick = () => { ob.step = 0; renderOnboarding(); };
  el.querySelector('#next').onclick = () => {
    const r = scoreTest(ob.answers);
    ob.pfRisk = r.category.id;
    ob.step = 2; renderOnboarding();
  };
}

function obFinances(el) {
  const r = scoreTest(ob.answers);
  el.appendChild(h(`
    <div class="card">
      <h2>Tu perfil: ${r.category.name} (${r.score}/100)</h2>
      <p class="small ink2">Banda de inversión en renta variable: ${r.category.equityRange[0]}–${r.category.equityRange[1]}% de tu capital, según el momento de mercado.</p>
    </div>
    <div class="card">
      <h2>Capital disponible para invertir</h2>
      <p class="muted">Solo rangos: las recomendaciones son siempre en porcentajes.</p>
      <div class="options" id="cap">${CAPITAL_BANDS.map(b => `<button class="opt ${ob.capitalBandId === b.id ? 'selected' : ''}" data-id="${b.id}">${b.label}</button>`).join('')}</div>
      <h2 style="margin-top:16px">Ingresos mensuales</h2>
      <div class="options" id="inc">${INCOME_BANDS.map(b => `<button class="opt ${ob.incomeBandId === b.id ? 'selected' : ''}" data-id="${b.id}">${b.label}</button>`).join('')}</div>
      <div class="row spread" style="margin-top:14px">
        <button class="btn ghost sm" id="back">Atrás</button>
        <button class="btn" id="next" ${ob.capitalBandId && ob.incomeBandId ? '' : 'disabled'}>Continuar</button>
      </div>
    </div>`));
  el.querySelectorAll('#cap .opt').forEach(b => b.onclick = () => { ob.capitalBandId = b.dataset.id; renderOnboarding(); });
  el.querySelectorAll('#inc .opt').forEach(b => b.onclick = () => { ob.incomeBandId = b.dataset.id; renderOnboarding(); });
  el.querySelector('#back').onclick = () => { ob.step = 1; renderOnboarding(); };
  el.querySelector('#next').onclick = () => { ob.step = 3; renderOnboarding(); };
}

function obBroker(el) {
  el.appendChild(h(`
    <div class="card">
      <h2>¿Dónde inviertes ya?</h2>
      <p class="muted">Solo te recomendaremos activos que tu banco o bróker permite contratar, con sus comisiones reales.</p>
      <div class="options" id="brk">
        ${BROKERS.map(b => `<button class="opt ${ob.brokerId === b.id ? 'selected' : ''}" data-id="${b.id}">${esc(b.name)}<span class="sub">${esc(b.notes)}</span></button>`).join('')}
      </div>
      <div class="row spread" style="margin-top:14px">
        <button class="btn ghost sm" id="back">Atrás</button>
        <button class="btn" id="next" ${ob.brokerId ? '' : 'disabled'}>Continuar</button>
      </div>
    </div>`));
  el.querySelectorAll('#brk .opt').forEach(b => b.onclick = () => { ob.brokerId = b.dataset.id; renderOnboarding(); });
  el.querySelector('#back').onclick = () => { ob.step = 2; renderOnboarding(); };
  el.querySelector('#next').onclick = () => { ob.step = 4; renderOnboarding(); };
}

function obPortfolio(el) {
  const r = scoreTest(ob.answers);
  el.appendChild(h(`
    <div class="card">
      <h2>Tu primer portafolio</h2>
      <p class="muted">Puedes tener como máximo 2 portafolios, cada uno con su nivel de riesgo.</p>
      <label class="small ink2">Nombre</label>
      <input id="pfname" value="${esc(ob.pfName)}" style="width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--plane);color:var(--ink);margin:6px 0 12px">
      <label class="small ink2">Nivel de riesgo</label>
      <div class="options" id="risk">
        ${CATEGORIES.map(c => `<button class="opt ${ob.pfRisk === c.id ? 'selected' : ''}" data-id="${c.id}">${c.name}<span class="sub">${c.equityRange[0]}–${c.equityRange[1]}% en renta variable${c.id === r.category.id ? ' · recomendado por tu test' : ''}</span></button>`).join('')}
      </div>
      <div class="row spread" style="margin-top:14px">
        <button class="btn ghost sm" id="back">Atrás</button>
        <button class="btn" id="done">Crear y empezar</button>
      </div>
    </div>`));
  el.querySelector('#pfname').oninput = (e) => { ob.pfName = e.target.value; };
  el.querySelectorAll('#risk .opt').forEach(b => b.onclick = () => { ob.pfRisk = b.dataset.id; renderOnboarding(); });
  el.querySelector('#back').onclick = () => { ob.step = 3; renderOnboarding(); };
  el.querySelector('#done').onclick = () => {
    const r2 = scoreTest(ob.answers);
    store.saveProfile({ score: r2.score, categoryId: r2.category.id, answers: ob.answers });
    store.saveFinances({ capitalBandId: ob.capitalBandId, incomeBandId: ob.incomeBandId });
    store.saveBroker(ob.brokerId);
    store.createPortfolio({ name: ob.pfName.trim() || 'Mi cartera', riskLevel: ob.pfRisk || r2.category.id });
    currentTab = 'hoy';
    render();
  };
}

// ---------- Vista: Hoy ----------

let selectedPortfolioId = null;

function viewHoy() {
  const s = store.getState();
  const portfolios = store.listPortfolios();
  const pf = portfolios.find(p => p.id === selectedPortfolioId) || portfolios[0];
  selectedPortfolioId = pf?.id;

  if (!market.ready) {
    $app.innerHTML = '<div class="card"><h2>Analizando el mercado…</h2><p class="muted">Cargando histórico y consultando cotizaciones en vivo.</p></div>';
    return;
  }

  let out;
  try {
    out = runStrategies(pf);
  } catch (e) {
    console.error('Fallo del motor:', e);
    $app.innerHTML = `<div class="card"><h2>No se pudo generar el análisis</h2>
      <p class="ink2">Ha ocurrido un problema procesando los datos de mercado. Puedes reintentar o revisar tus ajustes.</p>
      <button class="btn sm" id="retry" style="margin-top:10px">Reintentar</button></div>`;
    document.getElementById('retry').onclick = () => location.reload();
    return;
  }
  const t = out.timing;
  if (!t) {
    $app.innerHTML = '<div class="card"><h2>Datos insuficientes</h2><p class="ink2">No hay suficiente histórico para analizar el mercado en esta fecha.</p></div>';
    return;
  }
  const semaClass = t.signal === 'green' ? 'green' : t.signal === 'amber' ? 'amber' : 'red';
  const semaColorName = t.signal === 'green' ? 'verde' : t.signal === 'amber' ? 'ámbar' : 'rojo';
  const semaIcon = t.signal === 'green' ? '✓' : t.signal === 'amber' ? '≈' : '⏸';
  const semaTitle = t.signal === 'green' ? 'Buen momento para invertir'
    : t.signal === 'amber' ? 'Momento neutro: entrada escalonada'
    : 'Mejor esperar en liquidez';

  const choice = store.getStrategyChoice(pf.id);
  const chosen = out.strategies.find(x => x.id === choice?.strategyId) || null;
  const review = runReview(pf, chosen ? chosen.equityPct : null);
  const toAct = review.reviews.filter(r => r.verdict === 'vender' || r.verdict === 'reducir');

  const decidedToday = new Set(s.decisions.filter(d => d.action !== 'sold' && sameDay(d.ts, Date.now())).map(d => d.assetId));
  const pending = (chosen?.positions || []).filter(r => !decidedToday.has(r.assetId));
  const waiting = t.signal === 'red';
  const eqs = out.strategies.map(x => x.equityPct);
  const dcas = out.strategies.map(x => x.dcaPct);
  const range = (arr) => {
    if (!arr.length) return '—';
    const a = Math.min(...arr), b = Math.max(...arr);
    return a === b ? `${a}%` : `${a}–${b}%`;
  };

  // en la máquina del tiempo conocemos el futuro: retorno real a 3 meses
  const outcomeOf = (assetId) => {
    if (!market.timeMachine) return null;
    const a = getAsset(assetId);
    const vals = a?.series === 'SP500' ? market.sp500 : market.bundle.series[a?.series];
    const i = market.lastIndex;
    if (!vals || vals[i] == null || vals[i + 63] == null) return null;
    return vals[i + 63] / vals[i] - 1;
  };

  const frag = h(`<div class="fade-in">
    ${market.timeMachine ? `<div class="banner info">🕰 Estás viendo el mercado tal y como era el <strong>${market.timeMachine}</strong>. Cada recomendación indica qué pasó en los 3 meses siguientes. <a href="./" style="color:var(--accent)">Volver a hoy</a></div>` : ''}
    ${portfolios.length > 1 ? `
      <div class="row" style="margin-top:10px" role="group" aria-label="Elegir portafolio">
        ${portfolios.map(p => `<button class="btn sm ${p.id === pf.id ? '' : 'ghost'}" data-pf="${p.id}" aria-pressed="${p.id === pf.id}">${esc(p.name)}</button>`).join('')}
      </div>` : ''}

    <div class="semaforo ${semaClass}" role="status" aria-label="Semáforo ${semaColorName}: ${esc(semaTitle)}. ${esc(t.reasons[0] || '')}">
      <div class="light" aria-hidden="true">${semaIcon}</div>
      <div>
        <div class="title">${semaTitle}</div>
        <div class="small ink2">${esc(t.reasons[0] || '')}</div>
      </div>
    </div>

    <div class="tiles" role="list">
      <div class="tile" role="listitem"><div class="k">Renta variable</div><div class="v">${chosen ? chosen.equityPct + '%' : range(eqs)}</div><div class="k">${chosen ? 'de tu capital' : 'según la opción'}</div></div>
      <div class="tile" role="listitem"><div class="k">En liquidez</div><div class="v">${chosen ? chosen.liquidityPct + '%' : range(eqs.map(x => 100 - x))}</div><div class="k">esperando momento</div></div>
      <div class="tile" role="listitem"><div class="k">Aportación mensual</div><div class="v">${chosen ? chosen.dcaPct + '%' : range(dcas)}</div><div class="k">de tus ingresos</div></div>
    </div>

    ${toAct.length ? `
      <div class="banner warn" role="status">
        <strong>Tu cartera pide atención:</strong> ${toAct.length} ${toAct.length === 1 ? 'posición tiene' : 'posiciones tienen'} señal de
        ${toAct.some(r => r.verdict === 'vender') ? 'venta' : 'reducción'} por tendencia.
        <button class="btn sm" id="goCartera" style="margin-top:8px">Revisar mi cartera</button>
      </div>` : ''}

    <h2 style="margin:18px 2px 4px;font-size:18px">${waiting ? 'Planes en vigilancia' : 'Elige cómo invertir hoy'}</h2>
    <p class="muted" style="margin:0 2px 10px">${waiting
      ? 'El semáforo está en rojo: hoy no se compra. Estas son las formas de entrar que tendrías disponibles cuando mejore el momento.'
      : `No hay una única cartera correcta. Estas son ${out.strategies.length} maneras distintas de aplicar tu perfil ${esc(review.category.name.toLowerCase())} con el mercado de hoy, todas contratables en ${esc(getBroker(s.brokerId)?.name || 'tu bróker')}. Elige la que te convenza: cambiarla es gratis.`}</p>
    <div id="strats"></div>

    <div id="orders"></div>

    ${market.errors.length ? `<div class="banner">${market.errors.map(esc).join('<br>')}</div>` : ''}
    ${!market.live ? '<div class="banner info">El análisis de renta variable usa el histórico local (hasta fin de 2022) porque la fuente en vivo no respondió. Las señales cripto y divisas sí son en vivo.</div>' : ''}
    <p class="disclaimer">Herramienta educativa. No constituye asesoramiento financiero personalizado. Rentabilidades pasadas no garantizan rentabilidades futuras.</p>
  </div>`);

  frag.querySelectorAll('[data-pf]').forEach(b => b.onclick = () => { selectedPortfolioId = b.dataset.pf; render(); });

  // --- Opciones de cartera ---
  const stratsEl = frag.querySelector('#strats');
  if (!out.strategies.length) {
    stratsEl.appendChild(h(`<div class="card"><p class="ink2">Ningún activo del universo supera hoy los filtros de tu bróker y de tus respuestas al test. Revisa el bróker seleccionado en Ajustes.</p></div>`));
  }
  for (const st of out.strategies) {
    const isChosen = chosen?.id === st.id;
    stratsEl.appendChild(h(`
      <article class="strat ${isChosen ? 'chosen' : ''}" aria-label="Opción ${esc(st.name)}, ${st.positions.length} posiciones, ${st.equityPct}% en renta variable">
        <div class="head">
          <div>
            <span class="name">${esc(st.name)}</span>
            ${st.bestFit ? '<span class="chip good">Mejor encaje con tu test</span>' : ''}
            ${isChosen ? '<span class="chip">Elegida</span>' : ''}
          </div>
          <div class="pct">${st.equityPct}%<span class="small ink2" style="font-weight:400"> en bolsa</span></div>
        </div>
        <p class="small ink2" style="margin:2px 0 10px">${esc(st.tagline)}</p>
        <div class="stack" role="img" aria-label="Composición: ${st.positions.map(p => `${esc(p.name)} ${p.pct}%`).join(', ')}, liquidez ${st.liquidityPct}%">
          ${st.positions.map((p, i) => `<span style="width:${p.pct}%;background:var(--cat-${(i % 6) + 1})"></span>`).join('')}
          <span style="width:${st.liquidityPct}%;background:var(--grid)"></span>
        </div>
        <ul class="poslist">
          ${st.positions.map((p, i) => `<li><span class="dot" style="background:var(--cat-${(i % 6) + 1})" aria-hidden="true"></span><span class="nm">${esc(p.name)}</span><span class="pp">${p.pct}%</span></li>`).join('')}
          <li class="liq"><span class="dot" style="background:var(--grid)" aria-hidden="true"></span><span class="nm">Liquidez</span><span class="pp">${st.liquidityPct}%</span></li>
        </ul>
        <p class="small muted" style="margin:8px 0 0">${st.positions.length} posiciones · volatilidad media ${fmtPct(st.metrics.avgVol)} · coste estimado ${st.metrics.estCostPct}% por orden</p>
        <details style="margin-top:8px">
          <summary class="small">Por qué esta opción y qué te cuesta</summary>
          <ul class="small ink2" style="margin:8px 0 0 18px">
            ${st.pros.map(x => `<li>${esc(x)}</li>`).join('')}
            ${st.cons.map(x => `<li class="con">${esc(x)}</li>`).join('')}
            ${st.fit.notes.map(n => `<li class="${n.ok ? 'fit-ok' : 'fit-no'}">${esc(n.text)}</li>`).join('')}
          </ul>
        </details>
        <div class="actions" style="margin-top:12px">
          ${isChosen
            ? `<button class="btn ghost sm" data-unchoose="${st.id}">Cambiar de opción</button>`
            : `<button class="btn sm" data-choose="${st.id}">Elegir esta opción</button>`}
        </div>
      </article>`));
  }

  // --- Órdenes concretas de la opción elegida ---
  const ordersEl = frag.querySelector('#orders');
  if (chosen) {
    ordersEl.appendChild(h(`
      <h2 style="margin:22px 2px 4px;font-size:18px">${waiting ? 'Qué comprarías con «' + esc(chosen.name) + '»' : 'Órdenes de «' + esc(chosen.name) + '»'}</h2>
      <p class="muted" style="margin:0 2px 8px">${waiting
        ? 'No ejecutes todavía: el semáforo sigue en rojo.'
        : 'Tú decides y ejecutas en tu plataforma. La app nunca opera por ti.'}</p>`));
    if (!pending.length) {
      ordersEl.appendChild(h(`<div class="card"><p class="ink2">Ya has decidido hoy sobre todas las posiciones de esta opción. Vuelve mañana o revisa tu historial.</p></div>`));
    }
    for (const r of pending) {
      const fwd = outcomeOf(r.assetId);
      ordersEl.appendChild(h(`
        <article class="rec" aria-label="${esc(r.name)}, ${waiting ? 'vigilar' : 'comprar'}, ${r.pct}% del capital">
          <div class="head">
            <div>
              <span class="name">${esc(r.name)}</span>
              <span class="chip">${r.assetClass.toUpperCase()}</span>
              <span class="chip">${waiting ? 'Vigilar' : 'Comprar'}</span>
            </div>
            <div class="pct">${r.pct}%<span class="small ink2" style="font-weight:400"> ${waiting ? 'objetivo' : 'del capital'}</span></div>
          </div>
          <ul>
            <li>${esc(r.why)}</li>
            <li>Régimen del activo: ${esc(r.state.regime)}</li>
            <li>Disponible en tu bróker con coste estimado ${r.costPct}% por operación</li>
            ${r.terms.fractional ? '' : '<li>Tu bróker no permite fracciones: redondea a títulos enteros</li>'}
          </ul>
          ${fwd != null ? `<p class="small" style="margin:0 0 12px;color:${fwd >= 0 ? 'var(--good-text)' : 'var(--critical)'}"><strong>Comprobación:</strong> 3 meses después este activo ${fwd >= 0 ? 'subió' : 'cayó'} un ${fmtPct(Math.abs(fwd))}.</p>` : ''}
          <div class="actions">
            ${waiting ? '' : `<button class="btn sm" data-acc="${r.assetId}" aria-label="La ejecutaré: ${esc(r.name)}"><span aria-hidden="true">✓ </span>La ejecutaré</button>`}
            <button class="btn ghost sm" data-rej="${r.assetId}" aria-label="${waiting ? 'No me interesa' : 'Descartar'}: ${esc(r.name)}"><span aria-hidden="true">✕ </span>${waiting ? 'No me interesa' : 'Descartar'}</button>
          </div>
        </article>`));
    }
  } else if (out.strategies.length) {
    ordersEl.appendChild(h(`<div class="card"><p class="ink2">Elige una de las opciones de arriba para ver las órdenes concretas y poder registrarlas.</p></div>`));
  }

  $app.innerHTML = '';
  $app.appendChild(frag);

  document.getElementById('goCartera')?.addEventListener('click', () => { currentTab = 'cartera'; render(); });
  $app.querySelectorAll('[data-choose]').forEach(b => b.onclick = () => {
    const st = out.strategies.find(x => x.id === b.dataset.choose);
    // guardamos también el objetivo del día: la vista Cartera lo usa para medir
    // la deriva sin tener que recalcular todo el motor
    store.saveStrategyChoice(pf.id, st.id, { name: st.name, equityPct: st.equityPct });
    render();
  });
  $app.querySelectorAll('[data-unchoose]').forEach(b => b.onclick = () => {
    store.clearStrategyChoice(pf.id);
    render();
  });
  $app.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => {
    const r = chosen.positions.find(x => x.assetId === b.dataset.acc);
    store.recordDecision({ assetId: r.assetId, assetClass: r.assetClass, action: 'accepted', snapshot: r.state });
    showExecutionModal({ ...r, percentOfCapital: r.pct }, s);
  });
  $app.querySelectorAll('[data-rej]').forEach(b => b.onclick = () => {
    const r = chosen.positions.find(x => x.assetId === b.dataset.rej);
    showRejectModal(r);
  });
}

function sameDay(a, b) {
  const da = new Date(a), db = new Date(b);
  return da.toISOString().slice(0, 10) === db.toISOString().slice(0, 10);
}

// Modal accesible: role=dialog, aria-modal, trampa de foco, Escape para cerrar
// y restauración del foco al elemento que lo abrió. `innerHTML` es el contenido
// de .modal; debe incluir un <h2 id="modalTitle">. onClose se llama al cerrar.
let modalKeydownHandler = null;
function openModal(innerHTML, { onClose } = {}) {
  const previouslyFocused = document.activeElement;
  const frag = h(`
    <div class="modal-backdrop" id="mb">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">${innerHTML}</div>
    </div>`);
  document.body.appendChild(frag);
  const mb = document.getElementById('mb');
  const dialog = mb.querySelector('.modal');
  const focusables = () => [...dialog.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);

  const close = () => {
    document.removeEventListener('keydown', modalKeydownHandler, true);
    modalKeydownHandler = null;
    mb.remove();
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    onClose?.();
  };

  modalKeydownHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', modalKeydownHandler, true);
  mb.addEventListener('click', (e) => { if (e.target === mb) close(); });
  requestAnimationFrame(() => (focusables()[0] || dialog).focus());
  return { mb, close };
}

function showExecutionModal(r, s) {
  const broker = getBroker(s.brokerId);
  const capital = CAPITAL_BANDS.find(b => b.id === s.finances?.capitalBandId);
  const { mb, close } = openModal(`
    <h2 id="modalTitle">Ejecuta la orden en tu plataforma</h2>
    <p class="ink2" style="margin:10px 0">La app no opera por ti. Pasos:</p>
    <ol class="ink2" style="margin:0 0 12px 18px">
      <li>Abre <strong>${esc(broker.name)}</strong>.</li>
      <li>Busca <strong>${esc(r.name)}</strong>.</li>
      <li>Invierte el <strong>${r.percentOfCapital}% de tu capital</strong> (sobre ${esc(capital?.label || 'tu capital')}, calcula el importe en tu plataforma).</li>
      ${r.terms.fractional ? '' : '<li>Este bróker no permite fracciones: redondea a títulos enteros.</li>'}
    </ol>
    <p class="muted small">Coste estimado: ${r.terms.feeBps / 100}% + ${r.terms.fixedFeeEUR || 0}€ fijos${r.terms.fxFeeBps ? ` + ${r.terms.fxFeeBps / 100}% cambio de divisa` : ''}.</p>
    <p class="small ink2" style="margin-top:12px">Cuando la hayas ejecutado, anótala en tu cartera para que el motor siga su tendencia y te avise si toca vender.</p>
    <div class="row spread" style="margin-top:14px">
      <button class="btn ghost sm" id="ok">Ahora no</button>
      <button class="btn sm" id="toWallet">Anotar en mi cartera</button>
    </div>`,
    { onClose: render });
  mb.querySelector('#ok').onclick = close;
  mb.querySelector('#toWallet').onclick = () => { close(); currentTab = 'cartera'; render(); };
}

function showRejectModal(r) {
  const { mb, close } = openModal(`
    <h2 id="modalTitle">¿Por qué la descartas?</h2>
    <p class="muted">Tu motivo reentrena el algoritmo: la próxima vez afinamos más.</p>
    <div class="options" style="margin-top:12px" role="group" aria-label="Motivo del rechazo">
      ${REJECT_REASONS.map(x => `<button class="opt" data-r="${x.id}">${esc(x.label)}</button>`).join('')}
    </div>
    <label for="note" class="sr-only">Detalle opcional del motivo</label>
    <textarea id="note" placeholder="Detalle opcional…" style="width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--plane);color:var(--ink);min-height:56px"></textarea>
    <div class="row spread" style="margin-top:12px">
      <button class="btn ghost sm" id="cancel">Cancelar</button>
    </div>`);
  mb.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    store.recordDecision({
      assetId: r.assetId, assetClass: r.assetClass, action: 'rejected',
      reasonId: b.dataset.r, note: mb.querySelector('#note').value.trim(), snapshot: r.state,
    });
    close();
    render();
  });
  mb.querySelector('#cancel').onclick = close;
}

// ---------- Vista: Cartera ----------
// Las posiciones que el usuario ya tiene, guardadas en su dispositivo, con el
// veredicto del motor sobre cada una (vender / reducir / mantener / reforzar).

function viewCartera() {
  const portfolios = store.listPortfolios();

  if (!market.ready) {
    $app.innerHTML = '<div class="card"><h2>Cargando precios…</h2><p class="muted">Necesitamos las cotizaciones para valorar tu cartera.</p></div>';
    return;
  }

  // «Todas» es una vista de pleno derecho, no un caso especial: es lo primero
  // que quieres ver al abrir la app.
  const pf = portfolios.find(p => p.id === selectedPortfolioId) || null;
  const global = globalSnapshot();
  const pnlColor = x => (x == null ? 'var(--ink-2)' : x >= 0 ? 'var(--good-text)' : 'var(--critical)');
  const signed = (x, fmt) => (x >= 0 ? '+' : '') + fmt.format(x);

  const frag = h(`<div class="fade-in">
    <div class="card">
      <div class="row spread">
        <h2 style="margin:0">${pf ? esc(pf.name) : 'Todas tus carteras'}</h2>
        ${pf ? `<button class="btn ghost sm" id="editPf">Ajustes de esta cartera</button>` : ''}
      </div>
      <div id="summary"></div>
    </div>

    <div class="pf-switch" role="tablist" aria-label="Elegir cartera">
      <button class="pf-chip ${pf ? '' : 'on'}" data-pf="" role="tab" aria-selected="${!pf}">
        <span class="nm">Todas</span><span class="vv">${fmtEur0.format(global.totalValue)}</span>
      </button>
      ${portfolios.map(p => {
        const s = snapshotOf(p.id);
        return `<button class="pf-chip ${pf?.id === p.id ? 'on' : ''}" data-pf="${p.id}" role="tab" aria-selected="${pf?.id === p.id}">
          <span class="nm">${esc(p.name)}</span><span class="vv">${fmtEur0.format(s.totalValue)}</span>
        </button>`;
      }).join('')}
      <button class="pf-chip add" id="newPf" aria-label="Crear una cartera nueva"><span class="nm">+ Nueva</span></button>
    </div>

    <div id="body"></div>
  </div>`);

  const summary = frag.querySelector('#summary');
  const snap = pf ? snapshotOf(pf.id) : global;
  // la revisión (veredictos, alertas, salud) solo aplica a una cartera concreta
  const choice = pf ? store.getStrategyChoice(pf.id) : null;
  const rv = pf ? runReview(pf, choice?.equityPct ?? null) : null;

  if (!snap.positions.length) {
    summary.innerHTML = `
      <p class="ink2" style="margin-top:10px">${pf
        ? 'Esta cartera está vacía. Añade lo que <strong>ya tienes</strong> en tu bróker.'
        : 'Aún no has registrado nada. Añade lo que <strong>ya tienes</strong> y el motor analizará la tendencia de cada activo.'}</p>
      <p class="small muted">Se guarda solo en este dispositivo. No conectamos con tu bróker ni enviamos nada a ningún servidor.</p>`;
  } else {
    const staleWarn = snap.staleDays != null && snap.staleDays > 30;
    summary.innerHTML = `
      <div class="tiles" role="list" style="margin-top:12px">
        <div class="tile" role="listitem"><div class="k">Valor actual</div><div class="v">${fmtEur0.format(snap.totalValue)}</div><div class="k">aportado ${fmtEur0.format(snap.contributed)}</div></div>
        <div class="tile" role="listitem"><div class="k">Ganancia / pérdida</div><div class="v" style="color:${pnlColor(snap.pnl)}">${signed(snap.pnl, fmtEur0)}</div><div class="k">${fmtPct(snap.pnlPct)}</div></div>
        ${snap.irr != null ? `<div class="tile" role="listitem"><div class="k">TIR anual</div><div class="v" style="color:${pnlColor(snap.irr)}">${fmtPct(snap.irr)}</div><div class="k">${snap.avgYears != null ? `${snap.avgYears.toFixed(1)} años de media` : 'tu dinero'}</div></div>` : ''}
        ${snap.withdrawn > 0 ? `<div class="tile" role="listitem"><div class="k">Retirado</div><div class="v">${fmtEur0.format(snap.withdrawn)}</div><div class="k">ya en tu bolsillo</div></div>` : ''}
        ${rv?.health != null ? `<div class="tile" role="listitem"><div class="k">Salud de la cartera</div><div class="v">${rv.health}<span class="small muted" style="font-weight:400">/100</span></div><div class="k">media ponderada por valor</div></div>` : ''}
      </div>
      <div class="row spread" style="margin-top:12px">
        <span class="small ${staleWarn ? 'ink2' : 'muted'}">${esc(
          snap.staleDays == null ? 'Sin valores anotados todavía'
          : snap.staleDays === 0 ? 'Valores al día de hoy'
          : `Última actualización hace ${snap.staleDays} ${snap.staleDays === 1 ? 'día' : 'días'}`)}</span>
        <button class="btn sm" id="revalAll">Actualizar valores</button>
      </div>
      ${staleWarn ? `<div class="banner warn" style="margin-bottom:0">Los valores llevan ${snap.staleDays} días sin actualizarse: las rentabilidades y los veredictos pueden no reflejar tu situación real.</div>` : ''}`;
  }

  const body = frag.querySelector('#body');

  if (!pf) {
    // ---------- Vista consolidada ----------
    if (portfolios.length > 1 && global.totalValue > 0) {
      body.appendChild(h(`<div class="card">
        <h2>Reparto entre carteras</h2>
        ${distribution(portfolios.map(p => ({ name: p.name, value: snapshotOf(p.id).totalValue })))}
      </div>`));
    }
    if (global.totalValue > 0) {
      body.appendChild(h(`<div class="card">
        <h2>Reparto por tipo de activo</h2>
        ${distribution(Object.entries(global.byClass).map(([c, weight]) => ({
          name: CLASS_LABEL[c] || c, value: (weight / 100) * global.totalValue,
        })))}
      </div>`));
    }
    for (const p of portfolios) {
      const s = snapshotOf(p.id);
      const cat = CATEGORIES.find(c => c.id === p.riskLevel);
      body.appendChild(h(`<div class="card pf-card" data-open="${p.id}" role="button" tabindex="0"
          aria-label="Abrir ${esc(p.name)}: ${fmtEur0.format(s.totalValue)}">
        <div class="row spread">
          <div>
            <h3 style="margin:0">${esc(p.name)}</h3>
            <p class="small muted" style="margin:2px 0 0">${cat?.name || '—'} · ${s.positions.length} ${s.positions.length === 1 ? 'posición' : 'posiciones'}</p>
          </div>
          <div style="text-align:right">
            <div style="font-size:19px;font-weight:700">${fmtEur0.format(s.totalValue)}</div>
            <div class="small" style="color:${pnlColor(s.pnl)}">${s.positions.length ? `${signed(s.pnl, fmtEur0)} · ${fmtPct(s.pnlPct)}` : 'vacía'}</div>
          </div>
        </div>
        ${s.positions.length ? distribution(s.positions.map(x => ({ name: x.assetName, value: x.valueOrCost })), { legend: false }) : ''}
      </div>`));
    }
    if (!portfolios.length) {
      body.appendChild(h(`<div class="card"><p class="ink2">No tienes ninguna cartera. Crea la primera con «+ Nueva».</p></div>`));
    }
  } else {
    // ---------- Detalle de una cartera ----------
    const reviewOf = id => rv.reviews.find(r => r.assetId === id);
    const history = valuationHistory(eurHoldings(store.listHoldings(pf.id)));

    if (snap.positions.length) {
      body.appendChild(h(`<div class="card">
        <h2>Distribución de esta cartera</h2>
        ${distribution(snap.positions.map(x => ({ name: x.assetName, value: x.valueOrCost })))}
        ${Object.keys(snap.byClass).length > 1 ? `
          <h3 style="margin-top:16px">Por tipo de activo</h3>
          ${distribution(Object.entries(snap.byClass).map(([c, w]) => ({
            name: CLASS_LABEL[c] || c, value: (w / 100) * snap.totalValue,
          })))}` : ''}
      </div>`));
    }

    for (const a of rv.alerts) {
      body.appendChild(h(`<div class="banner ${a.level === 'warn' ? 'warn' : 'info'}">${esc(a.text)}</div>`));
    }

    if (snap.positions.length && (snap.irr != null || snap.twr)) {
      body.appendChild(h(returnsCard(snap, pnlColor)));
    }

    if (history.length >= 2) {
      body.appendChild(h(`<div class="card">
        <h2>Evolución</h2>
        <p class="small muted">Con los valores que has ido anotando (${history.length} actualizaciones).</p>
        <div id="evolution"></div>
      </div>`));
    }

    const posWrap = h(`<div><h2 style="margin:22px 2px 8px;font-size:18px">Posiciones (${snap.positions.length})</h2><div id="positions"></div></div>`);
    body.appendChild(posWrap);
    const posEl = body.querySelector('#positions');
    for (const p of snap.positions) {
      posEl.appendChild(h(positionCard(p, reviewOf(p.assetId), pnlColor, signed)));
    }
    body.appendChild(h(`<details class="card" id="addCard"><summary><strong>+ Añadir una posición</strong></summary><div id="addBody"></div></details>`));
    body.querySelector('#addBody').innerHTML = addFormHTML();
  }

  $app.innerHTML = '';
  $app.appendChild(frag);
  wireCartera({ pf, snap, portfolios });
}


// ---------- Componentes de la vista Cartera ----------

function returnsCard(snap, pnlColor) {
  return `<div class="card">
    <h2>Rentabilidad</h2>
    <p class="small muted">Lo que has puesto frente a lo que has obtenido, y las dos formas correctas de convertirlo en un porcentaje anual.</p>
    <table class="data" style="margin-top:10px">
      <tbody>
        <tr><td>Aportado</td><td class="num">${fmtEur2.format(snap.contributed)}</td><td class="small ink2">Todo el dinero que has metido.</td></tr>
        ${snap.withdrawn > 0 ? `<tr><td>Retirado por ventas</td><td class="num">${fmtEur2.format(snap.withdrawn)}</td><td class="small ink2">Ya está en tu bolsillo.</td></tr>` : ''}
        <tr><td>Valor en cartera</td><td class="num">${fmtEur2.format(snap.totalValue)}</td><td class="small ink2">Lo que vale hoy lo que aún tienes.</td></tr>
        <tr>
          <td><strong>Obtenido</strong></td>
          <td class="num"><strong>${fmtEur2.format(snap.obtained)}</strong></td>
          <td class="small ink2">Retirado + valor actual. La diferencia con lo aportado es tu ganancia real:
            <strong style="color:${pnlColor(snap.pnl)}">${snap.pnl >= 0 ? '+' : ''}${fmtEur2.format(snap.pnl)}</strong>.</td>
        </tr>
        <tr>
          <td><strong>Simple</strong><br><span class="small muted">obtenido ÷ aportado − 1</span></td>
          <td class="num" style="color:${pnlColor(snap.pnlPct)}">${fmtPct(snap.pnlPct)}</td>
          <td class="small ink2">De todo el periodo. Ojo: cada aportación nueva empuja este número
            <strong>hacia el 0%</strong> — diluye las ganancias, pero también disimula las pérdidas.
            El euro absoluto de arriba no tiene ese sesgo.</td>
        </tr>
        ${snap.irr != null ? `<tr>
          <td><strong>TIR anual</strong><br><span class="small muted">ponderada por dinero</span></td>
          <td class="num" style="color:${pnlColor(snap.irr)}">${fmtPct(snap.irr)}</td>
          <td class="small ink2">Lo que ha rentado <strong>tu dinero</strong> al año, contando que cada aportación lleva dentro un tiempo distinto.</td>
        </tr>` : ''}
        ${snap.twr?.annualized != null ? `<tr>
          <td><strong>TWR anual</strong><br><span class="small muted">ponderada por tiempo</span></td>
          <td class="num" style="color:${pnlColor(snap.twr.annualized)}">${fmtPct(snap.twr.annualized)}</td>
          <td class="small ink2">Lo que han rentado <strong>los activos</strong>, sin el efecto de cuándo aportaste. Es la comparable con un índice.</td>
        </tr>` : ''}
      </tbody>
    </table>
    ${snap.twr?.annualized == null ? '<p class="small muted" style="margin-top:8px">La TWR necesita saber cuánto valía la cartera en varias fechas: seguirá saliendo en cuanto vayas anotando valores con el tiempo.</p>' : ''}
    <details style="margin-top:10px">
      <summary class="small">Ver mis aportaciones (${snap.contributions.length})</summary>
      <table class="data" style="margin-top:8px">
        <thead><tr><th>Fecha</th><th style="text-align:right">Importe</th><th style="text-align:right">Tiempo dentro</th></tr></thead>
        <tbody>
          ${contributionBreakdown(snap.contributions).map(c => `<tr>
            <td>${new Date(c.ts).toLocaleDateString('es-ES')}</td>
            <td class="num" style="color:${c.amount >= 0 ? 'var(--ink)' : 'var(--critical)'}">${c.amount >= 0 ? '+' : ''}${fmtEur2.format(c.amount)}</td>
            <td class="num">${c.years >= 1 ? `${c.years.toFixed(1)} años` : `${c.days} días`}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </details>
  </div>`;
}

function positionCard(p, review, pnlColor, signed) {
  const r = review || { verdict: 'sin_datos', reasons: [], info: [] };
  const v = VERDICTS[r.verdict];
  const meter = r.health == null ? '' : `
    <div class="row" style="gap:8px;margin:2px 0 8px">
      <div class="health-meter" role="img" aria-label="Salud técnica ${r.health} sobre 100">
        <div class="hm-fill hm-${r.verdict}" style="width:${r.health}%"></div>
      </div>
      <span class="small muted">salud ${r.health}/100</span>
    </div>`;
  return `
    <article class="rec holding v-${r.verdict}" aria-label="${esc(p.assetName)}: ${esc(v.label)}">
      <div class="head">
        <div>
          <span class="name">${esc(p.assetName)}</span>
          <span class="chip">${esc((p.assetClass || '').toUpperCase())}</span>
          <span class="chip verdict ${r.verdict}">${esc(v.label)}</span>
        </div>
        <div class="pct" style="color:${pnlColor(p.pnlPct)}">${p.pnlPct == null ? '—' : (p.pnlPct >= 0 ? '+' : '') + fmtPct(p.pnlPct)}</div>
      </div>
      ${meter}
      <p class="small" style="margin:0 0 4px">
        <strong>${fmtEur2.format(p.valueOrCost)}</strong>
        <span class="muted">· aportado ${fmtEur2.format(p.cost)}
        ${p.pnl != null ? `· <span style="color:${pnlColor(p.pnl)}">${signed(p.pnl, fmtEur2)}</span>` : ''}
        ${p.irr != null ? `· ${fmtPct(p.irr)} anual (TIR)` : ''}</span>
      </p>
      <p class="small muted" style="margin:0 0 8px">
        ${p.units > 0 ? `${fmtUnits.format(p.units)} uds. · ` : ''}
        ${round1(p.weightPct)}% de esta cartera · ${esc(valuationLabel(p))}
      </p>
      <ul>${[...r.reasons, ...(r.info || [])].map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      <div class="actions">
        <button class="btn sm" data-reval="${p.id}">Actualizar valor</button>
        ${r.verdict === 'vender' || r.verdict === 'reducir'
          ? `<button class="btn ghost sm" data-sell="${p.id}">Registrar venta</button>` : ''}
        <details class="more"><summary class="btn ghost sm" aria-label="Más acciones">⋯</summary>
          <div class="more-menu">
            <button class="btn ghost sm" data-edit="${p.id}">Editar importe</button>
            <button class="btn ghost sm" data-move="${p.id}">Mover de cartera</button>
            <button class="btn ghost sm" data-drop="${p.id}">Quitar</button>
          </div>
        </details>
      </div>
    </article>`;
}

function addFormHTML() {
  const priceable = ASSETS.map(a => ({ a, info: priceInfo(a) })).filter(x => x.info);
  const byClass = {};
  for (const x of priceable) (byClass[x.a.assetClass] ||= []).push(x);
  const today = new Date().toISOString().slice(0, 10);
  return `
    <p class="small muted">Lo único imprescindible es <strong>cuánto dinero</strong> tienes puesto. Si ya tienes ese activo, se suma a lo que había.</p>
    <label class="small ink2" for="hAsset">Activo</label>
    <select id="hAsset" class="field">
      ${Object.entries(byClass).map(([cls, items]) => `<optgroup label="${esc((CLASS_LABEL[cls] || cls).toUpperCase())}">
        ${items.map(({ a, info }) => `<option value="${a.id}">${esc(a.name)} — ${info.price.toFixed(2)} ${esc(info.currency)}</option>`).join('')}
      </optgroup>`).join('')}
    </select>
    <div class="row" style="gap:10px;margin-top:10px">
      <div style="flex:1;min-width:120px">
        <label class="small ink2" for="hInvested">Importe invertido (€)</label>
        <input id="hInvested" class="field" type="number" min="0" step="any" inputmode="decimal" placeholder="ej. 1500">
      </div>
      <div style="flex:1;min-width:120px">
        <label class="small ink2" for="hValue">Valor actual (€) <span class="muted">opcional</span></label>
        <input id="hValue" class="field" type="number" min="0" step="any" inputmode="decimal" placeholder="lo que marca tu bróker">
      </div>
    </div>
    <label class="small ink2" for="hDate">¿Cuándo aportaste este dinero?</label>
    <input id="hDate" class="field" type="date" max="${today}" value="${today}">
    <p class="small muted">Si lo compraste hace años, pon la fecha real: es lo que permite calcular tu rentabilidad anual de verdad.</p>
    <details style="margin-top:6px">
      <summary class="small muted">Añadir también las unidades (opcional)</summary>
      <label class="small ink2" for="hUnits" style="display:block;margin-top:8px">Nº de participaciones o acciones</label>
      <input id="hUnits" class="field" type="number" min="0" step="any" inputmode="decimal" placeholder="ej. 12">
      <p class="small muted">Con las unidades podemos valorar la posición a precio de mercado cuando tengamos cotización, sin que tengas que actualizarla a mano.</p>
    </details>
    <p class="small muted" id="hHint" style="margin-top:8px"></p>
    <button class="btn" id="hAdd" style="margin-top:6px">Añadir a mi cartera</button>`;
}

// Cablea todos los eventos de la vista Cartera.
function wireCartera({ pf, snap, portfolios }) {
  $app.querySelectorAll('[data-pf]').forEach(b => b.onclick = () => {
    selectedPortfolioId = b.dataset.pf || null;
    render();
  });
  $app.querySelectorAll('[data-open]').forEach(el => {
    const open = () => { selectedPortfolioId = el.dataset.open; render(); };
    el.onclick = open;
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
  document.getElementById('newPf')?.addEventListener('click', () => showPortfolioModal(null));
  document.getElementById('editPf')?.addEventListener('click', () => showPortfolioModal(pf));
  document.getElementById('revalAll')?.addEventListener('click', () => showRevalueAllModal(snap));

  const evo = document.getElementById('evolution');
  if (evo && pf) {
    const history = valuationHistory(eurHoldings(store.listHoldings(pf.id)));
    lineChart(evo, {
      dates: history.map(x => x.date),
      values: history.map(x => x.value),
      label: 'Valor total de tu cartera según los valores que has ido anotando',
      formatValue: v => fmtEur0.format(v),
    });
  }

  // alta de posición
  const sel = document.getElementById('hAsset');
  const hint = document.getElementById('hHint');
  if (sel) {
    const showHint = () => {
      const a = getAsset(sel.value);
      const info = priceInfo(a);
      hint.textContent = info
        ? `Último precio conocido de ${a.name}: ${info.price.toFixed(2)} ${info.currency} (${info.date}). Los importes van en euros.`
        : '';
    };
    sel.onchange = showHint; showHint();
  }
  document.getElementById('hAdd')?.addEventListener('click', () => {
    const a = getAsset(sel.value);
    const invested = parseFloat(document.getElementById('hInvested').value);
    const units = parseFloat(document.getElementById('hUnits').value) || 0;
    const value = parseFloat(document.getElementById('hValue').value);
    const dateStr = document.getElementById('hDate').value;
    if (!a || !(invested > 0)) {
      hint.textContent = 'Indica al menos cuánto dinero tienes invertido en este activo.';
      return;
    }
    try {
      store.addHolding({
        portfolioId: pf.id, assetId: a.id, assetClass: a.assetClass,
        currency: 'EUR', invested, units,
        at: dateStr ? Date.parse(dateStr + 'T12:00:00') : null,
        value: value > 0 ? value : null,
      });
      render();
    } catch (e) { hint.textContent = e.message; }
  });

  // acciones por posición
  const find = id => snap.positions.find(x => x.id === id);
  $app.querySelectorAll('[data-reval]').forEach(b => b.onclick = () => showRevalueModal(find(b.dataset.reval)));
  $app.querySelectorAll('[data-sell]').forEach(b => b.onclick = () => {
    const p = find(b.dataset.sell);
    showSellModal(p, runReview(pf, null).reviews.find(r => r.assetId === p.assetId));
  });
  $app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => showEditHoldingModal(find(b.dataset.edit)));
  $app.querySelectorAll('[data-move]').forEach(b => b.onclick = () => showMoveModal(find(b.dataset.move)));
  $app.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => {
    const p = find(b.dataset.drop);
    if (confirm(`¿Quitar ${p.assetName} de tu cartera? Solo borra el registro en esta app; no vende nada.`)) {
      store.removeHolding(p.id);
      render();
    }
  });
}

// Crear o editar una cartera. Sin límite de número: el usuario organiza como quiera.
function showPortfolioModal(portfolio) {
  const editing = !!portfolio;
  const cur = portfolio?.riskLevel || store.getState().profile?.categoryId || CATEGORIES[1].id;
  const { mb, close } = openModal(`
    <h2 id="modalTitle">${editing ? 'Ajustes de ' + esc(portfolio.name) : 'Nueva cartera'}</h2>
    <label class="small ink2" for="pfName" style="display:block;margin-top:10px">Nombre</label>
    <input id="pfName" class="field" value="${editing ? esc(portfolio.name) : ''}" placeholder="ej. Jubilación, Ahorro, Especulativa">
    <label class="small ink2" style="display:block;margin-top:10px">Nivel de riesgo</label>
    <p class="small muted">Marca la banda de renta variable con la que el motor evalúa esta cartera.</p>
    <div class="options" id="pfRisk">
      ${CATEGORIES.map(c => `<button class="opt ${c.id === cur ? 'selected' : ''}" data-id="${c.id}">${c.name}<span class="sub">${c.equityRange[0]}–${c.equityRange[1]}% en renta variable</span></button>`).join('')}
    </div>
    <div class="row spread" style="margin-top:14px">
      <button class="btn ghost sm" id="cancel">Cancelar</button>
      <div class="row" style="gap:8px">
        ${editing ? '<button class="btn ghost sm danger" id="archive">Archivar</button>' : ''}
        <button class="btn sm" id="ok">${editing ? 'Guardar' : 'Crear'}</button>
      </div>
    </div>`);
  let risk = cur;
  mb.querySelectorAll('#pfRisk .opt').forEach(b => b.onclick = () => {
    risk = b.dataset.id;
    mb.querySelectorAll('#pfRisk .opt').forEach(x => x.classList.toggle('selected', x === b));
  });
  mb.querySelector('#cancel').onclick = close;
  mb.querySelector('#archive')?.addEventListener('click', () => {
    if (!confirm('¿Archivar esta cartera? Sus posiciones dejarán de contar en tu balance.')) return;
    store.archivePortfolio(portfolio.id);
    selectedPortfolioId = null;
    close(); render();
  });
  mb.querySelector('#ok').onclick = () => {
    const name = mb.querySelector('#pfName').value;
    if (editing) {
      store.renamePortfolio(portfolio.id, name);
      store.setPortfolioRisk(portfolio.id, risk);
    } else {
      const p = store.createPortfolio({ name, riskLevel: risk });
      selectedPortfolioId = p.id;
    }
    close(); render();
  };
}

// Mover una posición a otra cartera: reorganizar sin tener que borrar y recrear.
function showMoveModal(position) {
  const others = store.listPortfolios().filter(p => p.id !== position.portfolioId);
  const { mb, close } = openModal(`
    <h2 id="modalTitle">Mover ${esc(position.assetName)}</h2>
    ${others.length ? `
      <p class="ink2" style="margin:10px 0">Elige la cartera de destino. Se conservan las aportaciones, sus fechas y las valoraciones.</p>
      <div class="options" id="dest">
        ${others.map(p => `<button class="opt" data-id="${p.id}">${esc(p.name)}</button>`).join('')}
      </div>`
    : '<p class="ink2" style="margin:10px 0">Solo tienes una cartera. Crea otra para poder mover posiciones entre ellas.</p>'}
    <div class="row spread" style="margin-top:12px"><button class="btn ghost sm" id="cancel">Cancelar</button></div>`);
  mb.querySelectorAll('#dest .opt').forEach(b => b.onclick = () => {
    store.moveHolding(position.id, b.dataset.id);
    close(); render();
  });
  mb.querySelector('#cancel').onclick = close;
}

// Anotar cuánto vale HOY una posición según el bróker del usuario. Es lo que
// mantiene la cartera pegada a la realidad cuando no hay cotización fiable.
function showRevalueModal(position) {
  const { mb, close } = openModal(`
    <h2 id="modalTitle">Actualizar valor de ${esc(position.assetName)}</h2>
    <p class="ink2" style="margin:10px 0">Abre tu bróker y copia aquí lo que vale hoy esta posición.
      Con eso calculamos tu rentabilidad real y afinamos el veredicto.</p>
    <p class="small muted">Invertido: ${fmtEur2.format(position.cost)} · valor registrado ahora: ${fmtEur2.format(position.valueOrCost)} (${esc(valuationLabel(position))}).</p>
    <label class="small ink2" for="rValue" style="display:block;margin-top:10px">Valor actual (€)</label>
    <input id="rValue" class="field" type="number" min="0" step="any" inputmode="decimal" value="${Math.round(position.valueOrCost * 100) / 100}">
    <div class="row spread" style="margin-top:14px">
      <button class="btn ghost sm" id="cancel">Cancelar</button>
      <button class="btn sm" id="ok">Guardar valor</button>
    </div>`);
  mb.querySelector('#cancel').onclick = close;
  mb.querySelector('#ok').onclick = () => {
    const v = parseFloat(mb.querySelector('#rValue').value);
    if (!(v >= 0)) return;
    store.revalueHolding(position.id, toHoldingCurrency(position, v));
    close();
    render();
  };
}

// Puesta al día de toda la cartera de una sentada: la rutina periódica.
function showRevalueAllModal(snap) {
  const { mb, close } = openModal(`
    <h2 id="modalTitle">Actualizar toda la cartera</h2>
    <p class="ink2" style="margin:10px 0">Con tu bróker delante, pon el valor de hoy de cada posición.
      Deja en blanco las que no quieras tocar.</p>
    <div id="rows">
      ${snap.positions.map(p => `
        <div style="margin-bottom:10px">
          <label class="small ink2" for="rv_${p.id}">${esc(p.assetName)}
            <span class="muted">· invertido ${fmtEur2.format(p.cost)} · ${esc(valuationLabel(p))}</span></label>
          <input id="rv_${p.id}" data-h="${p.id}" class="field rv" type="number" min="0" step="any"
                 inputmode="decimal" value="${Math.round(p.valueOrCost * 100) / 100}">
        </div>`).join('')}
    </div>
    <div class="row spread" style="margin-top:14px">
      <button class="btn ghost sm" id="cancel">Cancelar</button>
      <button class="btn sm" id="ok">Guardar todo</button>
    </div>`);
  mb.querySelector('#cancel').onclick = close;
  mb.querySelector('#ok').onclick = () => {
    const values = {};
    mb.querySelectorAll('.rv').forEach(inp => {
      const v = parseFloat(inp.value);
      if (!(v >= 0)) return;
      const p = snap.positions.find(x => x.id === inp.dataset.h);
      values[inp.dataset.h] = toHoldingCurrency(p, v);
    });
    store.revalueMany(values);
    close();
    render();
  };
}

// La vista trabaja en euros; el almacén, en la divisa que eligió la posición.
function toHoldingCurrency(position, eurAmount) {
  return position.currency === 'EUR' ? eurAmount : eurAmount / fxRate();
}

// Registrar una venta (total o parcial). La app no vende: anota lo que el
// usuario ha ejecutado en su bróker para que la cartera siga siendo fiel.
function showSellModal(position, review) {
  const value = position.valueOrCost;
  const suggested = review?.verdict === 'vender'
    ? value
    : value * Math.min(1, (review?.reduceByPct || 0) / Math.max(position.capitalPct, 0.001));
  const defAmount = Math.round(Math.min(value, suggested || value) * 100) / 100;
  const { mb, close } = openModal(`
    <h2 id="modalTitle">Registrar venta de ${esc(position.assetName)}</h2>
    <p class="ink2" style="margin:10px 0">Vende tú en tu bróker y anótalo aquí. El motor sugiere
      ${review?.verdict === 'vender' ? '<strong>salir de la posición</strong>' : `<strong>reducir hasta el ${review?.targetPct}% de tu capital</strong>`}.</p>
    <label class="small ink2" for="sAmount">Importe vendido en € (la posición vale ${fmtEur2.format(value)})</label>
    <input id="sAmount" class="field" type="number" min="0" step="any" inputmode="decimal" value="${defAmount}">
    <p class="small muted">Se descuenta del importe invertido y, si las tienes anotadas, de las unidades en la misma proporción.</p>
    <div class="row spread" style="margin-top:14px">
      <button class="btn ghost sm" id="cancel">Cancelar</button>
      <button class="btn sm" id="ok">Registrar</button>
    </div>`);
  mb.querySelector('#cancel').onclick = close;
  mb.querySelector('#ok').onclick = () => {
    const amount = parseFloat(mb.querySelector('#sAmount').value);
    if (!(amount > 0)) return;
    store.recordSale({ id: position.id, amount: toHoldingCurrency(position, amount), verdict: review?.verdict });
    close();
    render();
  };
}

function showEditHoldingModal(position) {
  const { mb, close } = openModal(`
    <h2 id="modalTitle">Editar ${esc(position.assetName)}</h2>
    <p class="small muted" style="margin:10px 0">Corrige lo que no coincida con tu bróker. Para el valor de hoy usa «Actualizar valor».</p>
    <label class="small ink2" for="eInvested">Importe invertido (€)</label>
    <input id="eInvested" class="field" type="number" min="0" step="any" inputmode="decimal" value="${Math.round(position.cost * 100) / 100}">
    <label class="small ink2" for="eUnits" style="display:block;margin-top:10px">Unidades <span class="muted">opcional</span></label>
    <input id="eUnits" class="field" type="number" min="0" step="any" inputmode="decimal" value="${position.units || ''}">
    <div class="row spread" style="margin-top:14px">
      <button class="btn ghost sm" id="cancel">Cancelar</button>
      <button class="btn sm" id="ok">Guardar</button>
    </div>`);
  mb.querySelector('#cancel').onclick = close;
  mb.querySelector('#ok').onclick = () => {
    const investedEur = parseFloat(mb.querySelector('#eInvested').value);
    const units = parseFloat(mb.querySelector('#eUnits').value) || 0;
    if (!(investedEur > 0)) return;
    store.updateHolding(position.id, { invested: toHoldingCurrency(position, investedEur), units });
    close();
    render();
  };
}

// ---------- Vista: Mercado ----------

function viewMercado() {
  if (!market.ready) { $app.innerHTML = '<div class="card"><p class="muted">Cargando…</p></div>'; return; }
  const st = market.indexAnalyzer.stateAt(market.lastIndex);
  const prot = computeProtectionStats();
  const twoYears = 504;
  const from = Math.max(0, market.lastIndex - twoYears);
  const frag = h(`<div class="fade-in">
    <div class="card">
      <h2>S&P 500 — últimos 2 años ${market.live ? '<span class="chip">en vivo</span>' : '<span class="chip">histórico a ' + market.dates[market.lastIndex] + '</span>'}</h2>
      <div id="chart"></div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Régimen</div><div class="v" style="font-size:17px">${st.regime}</div></div>
      <div class="tile"><div class="k">RSI 14</div><div class="v">${st.rsi?.toFixed(0) ?? '—'}</div></div>
      <div class="tile"><div class="k">Volatilidad 30d</div><div class="v">${fmtPct(st.vol)}</div></div>
      <div class="tile"><div class="k">Desde máximos 52s</div><div class="v ${st.drawdown < -0.05 ? 'down' : ''}">${fmtPct(st.drawdown)}</div></div>
    </div>
    <div class="card" id="cryptoCard"><h2>Cripto (en vivo)</h2><div id="cryptoBody"><p class="muted">Sin datos en vivo disponibles.</p></div></div>
    <div class="card">
      <h2>🕰 Máquina del tiempo</h2>
      <p class="small ink2">Mira qué habría recomendado el motor en momentos clave — y qué pasó después:</p>
      <div class="row" style="margin-top:10px">
        <a class="btn ghost sm" href="?fecha=2000-03-24" style="text-decoration:none">Burbuja puntocom</a>
        <a class="btn ghost sm" href="?fecha=2008-09-15" style="text-decoration:none">Caída de Lehman</a>
        <a class="btn ghost sm" href="?fecha=2009-03-09" style="text-decoration:none">Suelo de 2009</a>
        <a class="btn ghost sm" href="?fecha=2020-03-23" style="text-decoration:none">Crash COVID</a>
        <a class="btn ghost sm" href="?fecha=2021-06-01" style="text-decoration:none">Alcista 2021</a>
        ${market.timeMachine ? '<a class="btn sm" href="./" style="text-decoration:none">Volver a hoy</a>' : ''}
      </div>
    </div>
    <div class="card">
      <h2>Protección demostrada sobre el histórico real</h2>
      <div class="tiles" role="list" style="margin:10px 0 4px">
        <div class="tile" role="listitem"><div class="k">Peor caída — semáforo</div><div class="v up">${fmtPct(prot.stratMaxDD, 0)}</div></div>
        <div class="tile" role="listitem"><div class="k">Peor caída — mercado</div><div class="v down">${fmtPct(prot.bhMaxDD, 0)}</div></div>
        <div class="tile" role="listitem"><div class="k">Capital ×${' '}(${Math.round(prot.years)} años)</div><div class="v">${prot.stratMult.toFixed(1)}× / ${prot.bhMult.toFixed(1)}×</div></div>
      </div>
      <p class="small muted">Simulación sobre el S&P 500 (${Math.round(prot.years)} años): exposición 100/50/0% según el semáforo,
      aplicada al día siguiente, liquidez sin remunerar. La peor caída es mucho menor; el capital final es comparable.
      No es una promesa de resultados futuros.</p>
    </div>
    <div class="card">
      <h2>¿Cómo de fiable es el semáforo?</h2>
      <p class="small ink2">Es una <strong>herramienta de gestión de riesgo</strong>, no un oráculo. En validación
      walk-forward (100% fuera de muestra, reoptimizada cada año) reduce la caída máxima a <strong>-19% vs -57%</strong>
      de comprar-y-mantener con rentabilidad comparable, y recorta la caída en los 25/25 activos probados.
      Con honestidad: su capacidad de predecir subidas a 3 meses no alcanza significancia estadística (p≈0,15);
      su valor está en <strong>proteger de las grandes caídas</strong>.</p>
      <p class="small"><a href="backtest/RELIABILITY.md" style="color:var(--accent)">Informe de fiabilidad</a> ·
      <a href="backtest/REPORT.md" style="color:var(--accent)">Backtest completo</a></p>
    </div>
  </div>`);
  $app.innerHTML = '';
  $app.appendChild(frag);

  // señal confirmada (histéresis) en cada día del tramo visible → bandas de color.
  // FSM en una sola pasada: arranca 90 sesiones antes para estabilizar el estado.
  const warm = Math.max(0, from - 90);
  const k = DEFAULT_PARAMS.signalPersistence || 1;
  const conf = new Array(market.lastIndex + 1).fill(null);
  let cur = null, cand = null, run = 0;
  for (let i = warm; i <= market.lastIndex; i++) {
    const st = market.indexAnalyzer.stateAt(i);
    const rawSig = st ? timingSignal(st, DEFAULT_PARAMS, 0)?.signal : null;
    if (rawSig == null) { conf[i] = cur; continue; }
    if (cur == null) { cur = rawSig; cand = rawSig; run = 0; }
    else { if (rawSig === cand) run++; else { cand = rawSig; run = 1; } if (cand !== cur && run >= k) cur = cand; }
    conf[i] = cur;
  }
  const winSignals = conf.slice(from, market.lastIndex + 1);
  lineChart(document.getElementById('chart'), {
    dates: market.dates.slice(from, market.lastIndex + 1),
    values: market.sp500.slice(from, market.lastIndex + 1),
    signals: winSignals,
    label: 'Evolución del S&P 500 con las bandas del semáforo',
    formatValue: v => fmtNum0.format(v),
  });

  const cb = document.getElementById('cryptoBody');
  const rows = [];
  for (const a of ASSETS.filter(x => x.assetClass === 'crypto')) {
    const c = market.crypto.get(a.id);
    if (!c) continue;
    let extra = '';
    if (!c.spotOnly && c.closes.length > 260) {
      const an = seriesFor(a);
      const cst = an?.stateAt(c.closes.length - 1);
      if (cst) extra = `<td>${cst.regime}</td><td class="num">${cst.rsi?.toFixed(0) ?? '—'}</td><td class="num">${fmtPct(cst.vol)}</td>`;
    }
    rows.push(`<tr><td><strong>${a.symbol}</strong> ${esc(a.name)}</td><td class="num">$${c.lastPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>${extra || '<td colspan="3" class="muted">solo precio spot</td>'}</tr>`);
  }
  if (rows.length) {
    cb.innerHTML = `<table class="data"><thead><tr><th>Activo</th><th style="text-align:right">Precio</th><th>Régimen</th><th style="text-align:right">RSI</th><th style="text-align:right">Vol 30d</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
}

// ---------- Vista: Historial ----------

function viewHistorial() {
  const s = store.getState();
  const ds = [...s.decisions].reverse();
  const frag = h(`<div class="fade-in">
    <div class="card">
      <h2>Historial de decisiones</h2>
      <p class="muted">Todo lo que aceptas o rechazas reentrena el motor (los rechazos pesan más y decaen a los 90 días).</p>
    </div>
    <div id="list"></div>
  </div>`);
  const list = frag.querySelector('#list');
  if (!ds.length) list.appendChild(h('<div class="card"><p class="ink2">Aún no has decidido sobre ninguna recomendación.</p></div>'));
  for (const d of ds) {
    const asset = getAsset(d.assetId);
    const reason = REJECT_REASONS.find(r => r.id === d.reasonId);
    list.appendChild(h(`
      <div class="card">
        <div class="row spread">
          <div>
            <strong>${esc(asset?.name || d.assetId)}</strong>
            <span class="chip">${d.action === 'accepted' ? '✓ aceptada' : '✕ rechazada'}</span>
            ${reason ? `<span class="chip">${esc(reason.label)}</span>` : ''}
            ${d.note ? `<p class="small ink2" style="margin-top:4px">«${esc(d.note)}»</p>` : ''}
          </div>
          <span class="muted small">${new Date(d.ts).toLocaleDateString('es-ES')}</span>
        </div>
      </div>`));
  }
  $app.innerHTML = '';
  $app.appendChild(frag);
}

// ---------- Vista: Ajustes ----------

function viewAjustes() {
  const s = store.getState();
  const cat = CATEGORIES.find(c => c.id === s.profile.categoryId);
  const prefs = derivePreferences(s.profile?.answers);
  const frag = h(`<div class="fade-in">
    <div class="card">
      <h2>Perfil de riesgo</h2>
      <p class="ink2">${cat?.name} — ${s.profile.score}/100 · evaluado ${new Date(s.profile.assessedAt).toLocaleDateString('es-ES')}</p>
      <button class="btn ghost sm" id="redo" style="margin-top:8px">Repetir el test</button>
    </div>
    <div class="card">
      <h2>Lo que el motor recuerda de tu test</h2>
      <p class="small muted">Tus respuestas se guardan enteras, no solo la nota: de ahí salen estas reglas sobre <em>qué</em> comprar.</p>
      <ul class="small ink2" style="margin:10px 0 0 18px">
        <li>Sesgo de cartera: <strong>${esc(prefs.tilt)}</strong> · horizonte <strong>${esc(prefs.horizon)}</strong></li>
        <li>Techo de volatilidad por activo: <strong>${fmtPct(prefs.volCap)}</strong> anualizada</li>
        <li>Diversificación mínima sugerida: <strong>${prefs.minPositions} posiciones</strong></li>
        ${prefs.excludeClasses.length ? `<li>Clases descartadas: <strong>${prefs.excludeClasses.map(esc).join(', ')}</strong></li>` : ''}
        ${prefs.notes.map(n => `<li>${esc(n.text)}</li>`).join('')}
      </ul>
    </div>
    <div class="card">
      <h2>Tu bróker</h2>
      <div class="options" id="brk">
        ${BROKERS.map(b => `<button class="opt ${s.brokerId === b.id ? 'selected' : ''}" data-id="${b.id}">${esc(b.name)}<span class="sub">${esc(b.notes)}</span></button>`).join('')}
      </div>
    </div>
    <div class="card">
      <h2>Datos financieros</h2>
      <p class="small muted">Capital</p>
      <div class="options" id="cap">${CAPITAL_BANDS.map(b => `<button class="opt ${s.finances.capitalBandId === b.id ? 'selected' : ''}" data-id="${b.id}">${b.label}</button>`).join('')}</div>
      <p class="small muted">Ingresos</p>
      <div class="options" id="inc">${INCOME_BANDS.map(b => `<button class="opt ${s.finances.incomeBandId === b.id ? 'selected' : ''}" data-id="${b.id}">${b.label}</button>`).join('')}</div>
    </div>
    <div class="card">
      <h2>Privacidad</h2>
      <p class="small ink2">Todos tus datos viven en este dispositivo (localStorage). Nada se envía a ningún servidor.</p>
      <button class="btn danger sm" id="reset" style="margin-top:10px">Borrar todos mis datos</button>
    </div>
    <p class="disclaimer">Copiloto de Inversión es una herramienta educativa de código abierto. No es asesoramiento financiero personalizado (MiFID II). La operativa siempre la ejecutas tú en tu propia plataforma.</p>
  </div>`);
  $app.innerHTML = '';
  $app.appendChild(frag);

  document.getElementById('redo').onclick = () => {
    ob.step = 1; ob.answers = {};
    ob.capitalBandId = s.finances.capitalBandId; ob.incomeBandId = s.finances.incomeBandId; ob.brokerId = s.brokerId;
    // repetir test conserva portafolios: solo actualiza el perfil al terminar
    const nav = document.getElementById('tabs'); nav.style.display = 'none';
    renderTestOnly();
  };
  // el bróker no afecta al análisis técnico: no invalidamos la caché de analizadores
  $app.querySelectorAll('#brk .opt').forEach(b => b.onclick = () => { store.saveBroker(b.dataset.id); render(); });
  $app.querySelectorAll('#cap .opt').forEach(b => b.onclick = () => { store.saveFinances({ ...s.finances, capitalBandId: b.dataset.id }); render(); });
  $app.querySelectorAll('#inc .opt').forEach(b => b.onclick = () => { store.saveFinances({ ...s.finances, incomeBandId: b.dataset.id }); render(); });
  document.getElementById('reset').onclick = () => {
    if (confirm('¿Seguro? Se borrará tu perfil, portafolios e historial de este dispositivo.')) {
      store.resetAll();
      location.reload();
    }
  };
}

function renderTestOnly() {
  $app.innerHTML = '';
  const el = document.createElement('div');
  $app.appendChild(el);
  obTest(el);
  // al terminar, guardar solo el perfil
  el.querySelector('#next').onclick = () => {
    const r = scoreTest(ob.answers);
    store.saveProfile({ score: r.score, categoryId: r.category.id, answers: ob.answers });
    currentTab = 'ajustes';
    render();
  };
  el.querySelector('#back').onclick = () => { currentTab = 'ajustes'; render(); };
}

// ---------- Arranque ----------

render();
initMarketData().then(() => { if (onboarded()) render(); updateBadge(); })
  .catch(e => {
    $app.innerHTML = `<div class="card"><h2>Error cargando datos</h2><p class="ink2">${esc(e.message)}</p></div>`;
  });

// PWA: registra el service worker para carga instantánea y uso offline.
// Se registra tras la carga para no competir con el arranque. Silencioso si falla
// (p. ej. en contextos sin service workers): la app funciona igual sin él.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin PWA, sin drama */ });
  });
}
