// Rentabilidades de una cartera con aportaciones en distintas fechas.
//
// Cuando el dinero no entra de golpe, "valor / invertido − 1" deja de decir
// gran cosa: 500 € puestos hace tres años y 300 € puestos el mes pasado no han
// corrido la misma suerte. Hay dos formas correctas de resumirlo, y responden a
// preguntas distintas:
//
//   · TIR (money-weighted / XIRR): qué rentabilidad anual ha sacado TU dinero,
//     teniendo en cuenta cuánto tiempo llevaba dentro cada euro. Es la que
//     contesta "¿cómo me ha ido?". Solo necesita las aportaciones y el valor
//     actual, así que casi siempre se puede calcular.
//
//   · TWR (time-weighted): qué rentabilidad han tenido los ACTIVOS, neutralizando
//     el efecto de cuándo metiste dinero. Es la que publican los fondos, así que
//     es la comparable con un índice. Necesita saber cuánto valía la cartera en
//     cada tramo, así que exige valoraciones intermedias.
//
// Puro y determinista.

const MS_YEAR = 365.25 * 86400000;

// Tasa interna de retorno con flujos en fechas arbitrarias (XIRR).
// flows: [{ts, amount}] con el signo del inversor — negativo lo que sale de tu
// bolsillo, positivo lo que vuelve (ventas y el valor final).
// Se resuelve por bisección: más lento que Newton pero no diverge nunca, que en
// una cartera real con flujos irregulares es lo que importa.
export function xirr(flows, { minSpanDays = 30 } = {}) {
  if (!flows || flows.length < 2) return null;
  if (!flows.some(f => f.amount > 0) || !flows.some(f => f.amount < 0)) return null;

  const t0 = Math.min(...flows.map(f => f.ts));
  const t1 = Math.max(...flows.map(f => f.ts));
  // anualizar un recorrido de días produce cifras absurdas (un +2% en una semana
  // no es un +180% anual en ningún sentido útil)
  if ((t1 - t0) / 86400000 < minSpanDays) return null;

  const years = ts => (ts - t0) / MS_YEAR;
  const npv = r => {
    let s = 0;
    for (const f of flows) {
      const d = Math.pow(1 + r, years(f.ts));
      if (!Number.isFinite(d) || d === 0) return NaN;
      s += f.amount / d;
    }
    return s;
  };

  let lo = -0.9999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const f = npv(mid);
    if (!Number.isFinite(f)) return null;
    if (Math.abs(f) < 1e-9 || hi - lo < 1e-10) return mid;
    if (f * flo > 0) { lo = mid; flo = f; } else { hi = mid; fhi = f; }
  }
  return (lo + hi) / 2;
}

// TIR de una cartera. contributions: [{ts, amount}] con la convención de la app
// (positivo = aportación, negativo = retirada); aquí se invierte el signo.
export function moneyWeightedReturn({ contributions, currentValue, now = Date.now() }) {
  if (currentValue == null) return null;
  const flows = (contributions || []).map(c => ({ ts: c.ts, amount: -c.amount }));
  if (!flows.length) return null;
  flows.push({ ts: now, amount: currentValue });
  return xirr(flows);
}

// Rentabilidad ponderada por tiempo: encadena el rendimiento de cada tramo
// entre valoraciones conocidas, descontando el dinero que entró en el tramo.
// Convención: una valoración con la misma fecha que una aportación recoge el
// valor DESPUÉS de esa aportación (es lo que el usuario ve en su bróker).
export function timeWeightedReturn({ valuations, contributions, currentValue, now = Date.now() }) {
  const anchors = [...(valuations || [])].sort((a, b) => a.ts - b.ts);
  if (currentValue != null) {
    const last = anchors[anchors.length - 1];
    if (!last || now > last.ts) anchors.push({ ts: now, value: currentValue });
  }
  if (anchors.length < 2) return null;

  const flows = [...(contributions || [])].sort((a, b) => a.ts - b.ts);
  const periods = [];
  let factor = 1;

  for (let i = 1; i < anchors.length; i++) {
    const start = anchors[i - 1].value;
    if (!(start > 0)) return null;
    // dinero aportado (o retirado) dentro del tramo, ya incluido en el valor final
    let flow = 0;
    for (const f of flows) if (f.ts > anchors[i - 1].ts && f.ts <= anchors[i].ts) flow += f.amount;
    const end = anchors[i].value - flow;
    if (!(end > 0)) return null;
    const r = end / start - 1;
    factor *= 1 + r;
    periods.push({ from: anchors[i - 1].ts, to: anchors[i].ts, flow, ret: r });
  }

  const years = (anchors[anchors.length - 1].ts - anchors[0].ts) / MS_YEAR;
  return {
    total: factor - 1,
    annualized: years >= 0.5 ? Math.pow(factor, 1 / years) - 1 : null,
    from: anchors[0].ts,
    to: anchors[anchors.length - 1].ts,
    periods,
  };
}

// Detalle por aportación: cuánto lleva dentro cada tramo de dinero. No inventa
// una rentabilidad por tramo (haría falta el precio de cada lote), pero sí deja
// ver por qué la TIR difiere de la rentabilidad simple.
export function contributionBreakdown(contributions, now = Date.now()) {
  return [...(contributions || [])]
    .sort((a, b) => a.ts - b.ts)
    .map(c => ({
      ts: c.ts,
      amount: c.amount,
      years: Math.max(0, (now - c.ts) / MS_YEAR),
      days: Math.max(0, Math.floor((now - c.ts) / 86400000)),
      kind: c.amount >= 0 ? 'aportacion' : 'retirada',
    }));
}

// Antigüedad media del dinero, ponderada por importe: la intuición de por qué
// la TIR y la rentabilidad simple no coinciden.
export function averageHoldingYears(contributions, now = Date.now()) {
  let w = 0, s = 0;
  for (const c of contributions || []) {
    if (c.amount <= 0) continue;
    w += c.amount;
    s += c.amount * Math.max(0, (now - c.ts) / MS_YEAR);
  }
  return w > 0 ? s / w : null;
}
