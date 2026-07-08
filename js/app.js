// Copiloto de Inversión — aplicación (SPA sin dependencias).
// Arquitectura: los módulos de js/core son el "backend" (puros, testeados en Node);
// este archivo solo orquesta interfaz + datos en vivo + persistencia local.

import { ASSETS, getAsset } from './core/assets.js';
import { BROKERS, getBroker } from './core/brokers.js';
import { QUESTIONS, LIKERT, CATEGORIES, CAPITAL_BANDS, INCOME_BANDS, scoreTest } from './core/profile.js';
import { REJECT_REASONS } from './core/feedback.js';
import { SeriesAnalyzer, generateRecommendations, DEFAULT_PARAMS } from './core/engine.js';
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

function runEngine(portfolio) {
  const s = store.getState();
  const category = CATEGORIES.find(c => c.id === (portfolio?.riskLevel || s.profile.categoryId)) || CATEGORIES[1];
  const capital = CAPITAL_BANDS.find(b => b.id === s.finances?.capitalBandId)?.mid ?? 10000;
  const income = INCOME_BANDS.find(b => b.id === s.finances?.incomeBandId)?.mid ?? 2000;
  return generateRecommendations({
    assets: ASSETS,
    seriesFor,
    dateIndex: market.lastIndex,
    indexAnalyzer: market.indexAnalyzer,
    profile: { score: s.profile.score, category },
    capitalMid: capital,
    incomeMid: income,
    broker: getBroker(s.brokerId),
    history: s.decisions,
    now: Date.now(),
  });
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

const fmtPct = (x, d = 1) => x == null ? '—' : (x * 100).toFixed(d) + '%';

// ---------- Navegación ----------

const TABS = [
  { id: 'hoy', label: 'Hoy', ico: '🧭' },
  { id: 'portafolios', label: 'Portafolios', ico: '💼' },
  { id: 'mercado', label: 'Mercado', ico: '📈' },
  { id: 'historial', label: 'Historial', ico: '🗂️' },
  { id: 'ajustes', label: 'Ajustes', ico: '⚙️' },
];
let currentTab = 'hoy';

function renderNav() {
  const nav = document.getElementById('tabs');
  nav.innerHTML = '';
  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = t.id === currentTab ? 'active' : '';
    b.innerHTML = `<span class="ico">${t.ico}</span>${t.label}`;
    b.onclick = () => { currentTab = t.id; render(); };
    nav.appendChild(b);
  }
}

function onboarded() {
  const s = store.getState();
  return s.profile && s.finances && s.brokerId && store.listPortfolios().length > 0;
}

function render() {
  const nav = document.getElementById('tabs');
  if (!onboarded()) { nav.style.display = 'none'; renderOnboarding(); return; }
  nav.style.display = '';
  renderNav();
  const views = { hoy: viewHoy, portafolios: viewPortafolios, mercado: viewMercado, historial: viewHistorial, ajustes: viewAjustes };
  views[currentTab]();
}

// ---------- Onboarding ----------

const ob = { step: 0, answers: {}, capitalBandId: null, incomeBandId: null, brokerId: null, pfName: 'Mi cartera', pfRisk: null };

function renderOnboarding() {
  const steps = [obWelcome, obTest, obFinances, obBroker, obPortfolio];
  $app.innerHTML = '';
  $app.appendChild(h('<div class="fade-in" id="ob"></div>'));
  steps[ob.step](document.getElementById('ob'));
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
    const block = h(`
      <div style="margin:16px 0">
        <p><strong>${qi + 1}.</strong> ${esc(q.text)}</p>
        <div class="likert" data-q="${q.id}">
          ${LIKERT.map((l, v) => `<button data-v="${v}" class="${ob.answers[q.id] === v ? 'selected' : ''}" title="${esc(l)}">${['--', '-', '·', '+', '++'][v]}</button>`).join('')}
        </div>
      </div>`);
    qs.appendChild(block);
  });
  qs.querySelectorAll('.likert button').forEach(b => {
    b.onclick = () => {
      const qid = b.parentElement.dataset.q;
      ob.answers[qid] = parseInt(b.dataset.v, 10);
      renderOnboarding();
      requestAnimationFrame(() => {
        const idx = QUESTIONS.findIndex(q => q.id === qid);
        const next = document.querySelectorAll('#qs > div')[Math.min(idx + 1, QUESTIONS.length - 1)];
        next?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    };
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

  const out = runEngine(pf);
  const t = out.timing;
  const semaClass = t.signal === 'green' ? 'green' : t.signal === 'amber' ? 'amber' : 'red';
  const semaIcon = t.signal === 'green' ? '✓' : t.signal === 'amber' ? '≈' : '⏸';
  const semaTitle = t.signal === 'green' ? 'Buen momento para invertir'
    : t.signal === 'amber' ? 'Momento neutro: entrada escalonada'
    : 'Mejor esperar en liquidez';

  const decidedToday = new Set(s.decisions.filter(d => sameDay(d.ts, Date.now())).map(d => d.assetId));
  const pending = out.recommendations.filter(r => !decidedToday.has(r.assetId));
  const waiting = t.signal === 'red';

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
      <div class="row" style="margin-top:10px">
        ${portfolios.map(p => `<button class="btn sm ${p.id === pf.id ? '' : 'ghost'}" data-pf="${p.id}">${esc(p.name)}</button>`).join('')}
      </div>` : ''}

    <div class="semaforo ${semaClass}" role="status">
      <div class="light">${semaIcon}</div>
      <div>
        <div class="title">${semaTitle}</div>
        <div class="small ink2">${esc(t.reasons[0] || '')}</div>
      </div>
    </div>

    <div class="tiles">
      <div class="tile"><div class="k">Renta variable objetivo</div><div class="v">${out.allocation.equityPct}%</div><div class="k">de tu capital</div></div>
      <div class="tile"><div class="k">En liquidez</div><div class="v">${out.allocation.liquidityPct}%</div><div class="k">esperando momento</div></div>
      <div class="tile"><div class="k">Aportación mensual</div><div class="v">${out.allocation.dcaPct}%</div><div class="k">de tus ingresos</div></div>
    </div>

    <h2 style="margin:18px 2px 4px;font-size:18px">${waiting ? 'Candidatos en vigilancia' : `Recomendaciones para «${esc(pf.name)}»`}</h2>
    <p class="muted" style="margin:0 2px 8px">${waiting
      ? 'El semáforo está en rojo: no compres todavía. Estos son los activos que entrarían en cartera cuando mejore el momento.'
      : `Filtradas por tu bróker (${esc(getBroker(s.brokerId)?.name || '')}). Tú decides y ejecutas.`}</p>
    <div id="recs"></div>
    ${out.adjustments.suppressed.length ? `<p class="muted small">Ocultos por tus rechazos previos: ${out.adjustments.suppressed.join(', ')}</p>` : ''}
    ${market.errors.length ? `<div class="banner">${market.errors.map(esc).join('<br>')}</div>` : ''}
    ${!market.live ? '<div class="banner info">El análisis de renta variable usa el histórico local (hasta fin de 2022) porque la fuente en vivo no respondió. Las señales cripto y divisas sí son en vivo.</div>' : ''}
    <p class="disclaimer">Herramienta educativa. No constituye asesoramiento financiero personalizado. Rentabilidades pasadas no garantizan rentabilidades futuras.</p>
  </div>`);

  frag.querySelectorAll('[data-pf]').forEach(b => b.onclick = () => { selectedPortfolioId = b.dataset.pf; render(); });

  const recsEl = frag.getElementById ? frag.getElementById('recs') : frag.querySelector('#recs');
  if (!pending.length) {
    recsEl.appendChild(h(`<div class="card"><p class="ink2">${out.recommendations.length ? 'Ya has decidido sobre todas las recomendaciones de hoy. Vuelve mañana o revisa tu historial.' : (t.signal === 'red' ? 'Hoy el motor recomienda mantenerse en liquidez: no hay compras sugeridas.' : 'Sin candidatos que superen los filtros de tu bróker ahora mismo.')}</p></div>`));
  }
  for (const r of pending) {
    const fwd = outcomeOf(r.assetId);
    const card = h(`
      <div class="rec">
        <div class="head">
          <div>
            <span class="name">${esc(r.name)}</span>
            <span class="chip">${r.assetClass.toUpperCase()}</span>
            <span class="chip">${waiting ? 'Vigilar' : 'Comprar'}</span>
          </div>
          <div class="pct">${r.percentOfCapital}%<span class="small ink2" style="font-weight:400"> ${waiting ? 'objetivo' : 'del capital'}</span></div>
        </div>
        <ul>${r.rationale.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        ${fwd != null ? `<p class="small" style="margin:0 0 12px;color:${fwd >= 0 ? 'var(--good-text)' : 'var(--critical)'}"><strong>Comprobación:</strong> 3 meses después este activo ${fwd >= 0 ? 'subió' : 'cayó'} un ${fmtPct(Math.abs(fwd))}.</p>` : ''}
        <div class="actions">
          ${waiting ? '' : `<button class="btn sm" data-acc="${r.assetId}">✓ La ejecutaré</button>`}
          <button class="btn ghost sm" data-rej="${r.assetId}">✕ ${waiting ? 'No me interesa' : 'Descartar'}</button>
        </div>
      </div>`);
    recsEl.appendChild(card);
  }

  $app.innerHTML = '';
  $app.appendChild(frag);

  $app.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => {
    const r = out.recommendations.find(x => x.assetId === b.dataset.acc);
    store.recordDecision({ assetId: r.assetId, assetClass: r.assetClass, action: 'accepted', snapshot: r.state });
    showExecutionModal(r, s);
  });
  $app.querySelectorAll('[data-rej]').forEach(b => b.onclick = () => {
    const r = out.recommendations.find(x => x.assetId === b.dataset.rej);
    showRejectModal(r);
  });
}

function sameDay(a, b) {
  const da = new Date(a), db = new Date(b);
  return da.toISOString().slice(0, 10) === db.toISOString().slice(0, 10);
}

function showExecutionModal(r, s) {
  const broker = getBroker(s.brokerId);
  const capital = CAPITAL_BANDS.find(b => b.id === s.finances?.capitalBandId);
  const modal = h(`
    <div class="modal-backdrop" id="mb">
      <div class="modal">
        <h2>Ejecuta la orden en tu plataforma</h2>
        <p class="ink2" style="margin:10px 0">La app no opera por ti. Pasos:</p>
        <ol class="ink2" style="margin:0 0 12px 18px">
          <li>Abre <strong>${esc(broker.name)}</strong>.</li>
          <li>Busca <strong>${esc(r.name)}</strong>.</li>
          <li>Invierte el <strong>${r.percentOfCapital}% de tu capital</strong> (sobre ${esc(capital?.label || 'tu capital')}, calcula el importe en tu plataforma).</li>
          ${r.terms.fractional ? '' : '<li>Este bróker no permite fracciones: redondea a títulos enteros.</li>'}
        </ol>
        <p class="muted small">Coste estimado: ${r.terms.feeBps / 100}% + ${r.terms.fixedFeeEUR || 0}€ fijos${r.terms.fxFeeBps ? ` + ${r.terms.fxFeeBps / 100}% cambio de divisa` : ''}.</p>
        <div style="margin-top:14px"><button class="btn" id="ok">Entendido</button></div>
      </div>
    </div>`);
  document.body.appendChild(modal);
  document.getElementById('mb').onclick = (e) => { if (e.target.id === 'mb' || e.target.id === 'ok') { document.getElementById('mb').remove(); render(); } };
}

function showRejectModal(r) {
  const modal = h(`
    <div class="modal-backdrop" id="mb">
      <div class="modal">
        <h2>¿Por qué la descartas?</h2>
        <p class="muted">Tu motivo reentrena el algoritmo: la próxima vez afinamos más.</p>
        <div class="options" style="margin-top:12px">
          ${REJECT_REASONS.map(x => `<button class="opt" data-r="${x.id}">${esc(x.label)}</button>`).join('')}
        </div>
        <textarea id="note" placeholder="Detalle opcional…" style="width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--plane);color:var(--ink);min-height:56px"></textarea>
        <div class="row spread" style="margin-top:12px">
          <button class="btn ghost sm" id="cancel">Cancelar</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(modal);
  const mb = document.getElementById('mb');
  mb.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    store.recordDecision({
      assetId: r.assetId, assetClass: r.assetClass, action: 'rejected',
      reasonId: b.dataset.r, note: mb.querySelector('#note').value.trim(), snapshot: r.state,
    });
    mb.remove();
    render();
  });
  mb.querySelector('#cancel').onclick = () => mb.remove();
  mb.onclick = (e) => { if (e.target === mb) mb.remove(); };
}

// ---------- Vista: Portafolios ----------

function viewPortafolios() {
  const portfolios = store.listPortfolios();
  const frag = h(`<div class="fade-in">
    <div class="card">
      <h2>Tus portafolios (${portfolios.length}/${store.MAX_PORTFOLIOS})</h2>
      <p class="muted">Máximo ${store.MAX_PORTFOLIOS} modelos simultáneos, cada uno con su nivel de riesgo.</p>
    </div>
    <div id="list"></div>
    <div class="card" id="createCard"></div>
  </div>`);
  const list = frag.querySelector('#list');
  for (const p of portfolios) {
    const cat = CATEGORIES.find(c => c.id === p.riskLevel);
    list.appendChild(h(`
      <div class="card">
        <div class="row spread">
          <div>
            <h3>${esc(p.name)} <span class="chip">slot ${p.slot}</span></h3>
            <p class="small ink2">Riesgo: ${cat?.name} · ${cat?.equityRange[0]}–${cat?.equityRange[1]}% renta variable · creado ${new Date(p.createdAt).toLocaleDateString('es-ES')}</p>
          </div>
          <button class="btn ghost sm" data-del="${p.id}">Archivar</button>
        </div>
      </div>`));
  }
  const cc = frag.querySelector('#createCard');
  if (portfolios.length >= store.MAX_PORTFOLIOS) {
    cc.innerHTML = '<p class="ink2">Has alcanzado el límite de 2 portafolios. Archiva uno para crear otro.</p>';
  } else {
    cc.innerHTML = `
      <h3>Crear portafolio</h3>
      <input id="npfname" placeholder="Nombre (ej. Jubilación)" style="width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--plane);color:var(--ink);margin:8px 0">
      <div class="options" id="npfrisk">
        ${CATEGORIES.map(c => `<button class="opt" data-id="${c.id}">${c.name}<span class="sub">${c.equityRange[0]}–${c.equityRange[1]}% renta variable</span></button>`).join('')}
      </div>
      <button class="btn" id="npfcreate" disabled>Crear</button>`;
  }
  $app.innerHTML = '';
  $app.appendChild(frag);

  let riskSel = null;
  $app.querySelectorAll('#npfrisk .opt').forEach(b => b.onclick = () => {
    riskSel = b.dataset.id;
    $app.querySelectorAll('#npfrisk .opt').forEach(x => x.classList.toggle('selected', x === b));
    document.getElementById('npfcreate').disabled = false;
  });
  const createBtn = document.getElementById('npfcreate');
  if (createBtn) createBtn.onclick = () => {
    try {
      store.createPortfolio({ name: document.getElementById('npfname').value.trim() || 'Portafolio', riskLevel: riskSel });
      render();
    } catch (e) { alert(e.message); }
  };
  $app.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (confirm('¿Archivar este portafolio? Podrás crear otro en su lugar.')) {
      store.archivePortfolio(b.dataset.del);
      if (selectedPortfolioId === b.dataset.del) selectedPortfolioId = null;
      render();
    }
  });
}

// ---------- Vista: Mercado ----------

function viewMercado() {
  if (!market.ready) { $app.innerHTML = '<div class="card"><p class="muted">Cargando…</p></div>'; return; }
  const st = market.indexAnalyzer.stateAt(market.lastIndex);
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
      <h2>¿Cómo de fiable es el semáforo?</h2>
      <p class="small ink2">Backtest 1990–2022 con validación fuera de muestra: misma rentabilidad que comprar-y-mantener
      (8,1% vs 7,9% anual) con <strong>un tercio de la caída máxima</strong> (-17% vs -57%). Los días con señal verde
      subieron a 3 meses vista el 72% de las veces (base: 69%); los rojos, solo el 53%.
      <a href="backtest/REPORT.md" style="color:var(--accent)">Informe completo</a>.</p>
    </div>
  </div>`);
  $app.innerHTML = '';
  $app.appendChild(frag);

  lineChart(document.getElementById('chart'), {
    dates: market.dates.slice(from, market.lastIndex + 1),
    values: market.sp500.slice(from, market.lastIndex + 1),
    label: 'Evolución del S&P 500, últimos dos años',
    formatValue: v => v.toFixed(0),
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
  const frag = h(`<div class="fade-in">
    <div class="card">
      <h2>Perfil de riesgo</h2>
      <p class="ink2">${cat?.name} — ${s.profile.score}/100 · evaluado ${new Date(s.profile.assessedAt).toLocaleDateString('es-ES')}</p>
      <button class="btn ghost sm" id="redo" style="margin-top:8px">Repetir el test</button>
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
  $app.querySelectorAll('#brk .opt').forEach(b => b.onclick = () => { store.saveBroker(b.dataset.id); market.analyzers.clear(); render(); });
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
