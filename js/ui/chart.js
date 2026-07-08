// Gráfico de línea SVG con crosshair + tooltip y bandas de señal opcionales.
// Sin dependencias. Specs: línea 2px, rejilla recesiva, ejes en tinta muted,
// tooltip que sigue al puntero, punto resaltado con anillo de superficie.
// opts.signals: array alineado con `values` ('green'|'amber'|'red'|null) que
// pinta bandas de fondo mostrando cómo se comportó el semáforo históricamente.

const SIGNAL_LABEL = { green: 'invertir', amber: 'escalonar', red: 'esperar' };

export function lineChart(el, { dates, values, label = '', formatValue = v => v.toFixed(0), signals = null }) {
  const W = 720, H = 260, PAD = { t: 14, r: 12, b: 26, l: 52 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;

  const pts = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] != null) pts.push({ d: dates[i], v: values[i], s: signals ? signals[i] : null });
  }
  if (pts.length < 2) { el.innerHTML = '<p class="muted">Sin datos suficientes</p>'; return; }

  let min = Infinity, max = -Infinity;
  for (const p of pts) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
  const range = max - min || 1;
  min -= range * 0.05; max += range * 0.05;

  const x = i => PAD.l + (i / (pts.length - 1)) * iw;
  const y = v => PAD.t + (1 - (v - min) / (max - min)) * ih;

  let path = '';
  for (let i = 0; i < pts.length; i++) path += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pts[i].v).toFixed(1)}`;

  // Bandas de señal: agrupa tramos consecutivos con la misma señal.
  let bands = '';
  let hasSignals = false;
  if (signals) {
    const half = iw / (pts.length - 1) / 2;
    let runStart = 0;
    for (let i = 1; i <= pts.length; i++) {
      if (i === pts.length || pts[i].s !== pts[runStart].s) {
        const s = pts[runStart].s;
        if (s) {
          hasSignals = true;
          const x0 = Math.max(PAD.l, x(runStart) - half);
          const x1 = Math.min(W - PAD.r, x(i - 1) + half);
          bands += `<rect class="band band-${s}" x="${x0.toFixed(1)}" y="${PAD.t}" width="${(x1 - x0).toFixed(1)}" height="${ih}"/>`;
        }
        runStart = i;
      }
    }
  }

  // ticks de eje Y (4) y X (5 fechas)
  const yTicks = Array.from({ length: 4 }, (_, k) => min + ((k + 0.5) / 4) * (max - min));
  const xTickIdx = Array.from({ length: 5 }, (_, k) => Math.round((k / 4) * (pts.length - 1)));

  // aria-label: resumen textual accesible (evolución global del periodo)
  const change = pts[pts.length - 1].v / pts[0].v - 1;
  const aria = `${label}. De ${formatValue(pts[0].v)} el ${pts[0].d} a ${formatValue(pts[pts.length - 1].v)} el ${pts[pts.length - 1].d} (${(change * 100).toFixed(1)}%).`;

  const legend = hasSignals ? `
    <div class="chart-legend" aria-hidden="true">
      <span><i class="sw band-green"></i>Invertir</span>
      <span><i class="sw band-amber"></i>Escalonar</span>
      <span><i class="sw band-red"></i>Esperar</span>
    </div>` : '';

  el.innerHTML = `
  <div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${aria}">
      ${bands}
      ${yTicks.map(t => `<line x1="${PAD.l}" y1="${y(t)}" x2="${W - PAD.r}" y2="${y(t)}" class="grid"/>
        <text x="${PAD.l - 6}" y="${y(t) + 3}" class="tick" text-anchor="end">${formatValue(t)}</text>`).join('')}
      ${xTickIdx.map(i => `<text x="${x(i)}" y="${H - 8}" class="tick" text-anchor="middle">${pts[i].d.slice(0, 7)}</text>`).join('')}
      <line x1="${PAD.l}" y1="${PAD.t + ih}" x2="${W - PAD.r}" y2="${PAD.t + ih}" class="axis"/>
      <path d="${path}" class="series" fill="none"/>
      <line class="xhair" y1="${PAD.t}" y2="${PAD.t + ih}" style="display:none"/>
      <circle class="dot" r="4" style="display:none"/>
    </svg>
    ${legend}
    <div class="tooltip" style="display:none"></div>
  </div>`;

  const svg = el.querySelector('svg');
  const xhair = el.querySelector('.xhair');
  const dot = el.querySelector('.dot');
  const tip = el.querySelector('.tooltip');

  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((sx - PAD.l) / iw) * (pts.length - 1))));
    const px = x(i), py = y(pts[i].v);
    xhair.setAttribute('x1', px); xhair.setAttribute('x2', px); xhair.style.display = '';
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.style.display = '';
    tip.style.display = '';
    const sig = pts[i].s ? ` · ${SIGNAL_LABEL[pts[i].s]}` : '';
    tip.textContent = `${pts[i].d} · ${formatValue(pts[i].v)}${sig}`;
    const tipX = Math.min(Math.max((px / W) * rect.width - 60, 4), rect.width - 140);
    tip.style.left = tipX + 'px';
    tip.style.top = Math.max((py / H) * rect.height - 34, 2) + 'px';
  }
  function onLeave() {
    xhair.style.display = 'none'; dot.style.display = 'none'; tip.style.display = 'none';
  }
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerleave', onLeave);
}
