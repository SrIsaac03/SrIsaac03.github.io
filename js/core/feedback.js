// Etapa 5 del motor: personalización mediante el historial de aceptaciones y
// rechazos. Devuelve un ajuste de puntuación por activo/clase. Determinista y
// explicable: cada rechazo penaliza con decaimiento temporal; cada aceptación
// refuerza ligeramente. Los motivos modulan el efecto.

export const REJECT_REASONS = [
  { id: 'asset', label: 'No me convence este activo', scope: 'asset', weight: 1.0 },
  { id: 'too_risky', label: 'Demasiado riesgo para mí', scope: 'risk', weight: 1.0 },
  { id: 'too_safe', label: 'Demasiado conservador', scope: 'risk', weight: -1.0 },
  { id: 'no_liquidity', label: 'No tengo liquidez ahora', scope: 'none', weight: 0 },
  { id: 'overlap', label: 'Ya tengo exposición a esto', scope: 'class', weight: 0.6 },
  { id: 'timing', label: 'No confío en el momento de mercado', scope: 'timing', weight: 0.5 },
  { id: 'other', label: 'Otro motivo', scope: 'asset', weight: 0.3 },
];

const HALF_LIFE_DAYS = 90; // un rechazo pierde la mitad de su peso a los 90 días

function decay(tsThen, tsNow) {
  const days = Math.max(0, (tsNow - tsThen) / 86400000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

// history: [{assetId, assetClass, action:'accepted'|'rejected', reasonId?, ts}]
// Devuelve { assetAdj: Map<assetId, number>, classAdj: Map<class, number>,
//            riskShift: number, timingCaution: number }
export function computeFeedbackAdjustments(history, now = Date.now()) {
  const assetAdj = new Map(), classAdj = new Map();
  let riskShift = 0, timingCaution = 0;
  for (const h of history || []) {
    const w = decay(h.ts, now);
    if (h.action === 'accepted') {
      assetAdj.set(h.assetId, (assetAdj.get(h.assetId) || 0) + 0.05 * w);
      continue;
    }
    // Solo los rechazos explícitos entrenan el motor. Otras anotaciones del
    // historial (p. ej. ventas registradas en la cartera) son trazabilidad:
    // vender por ruptura de tendencia no significa que el activo no te guste.
    if (h.action !== 'rejected') continue;
    const reason = REJECT_REASONS.find(r => r.id === h.reasonId) || REJECT_REASONS[6];
    switch (reason.scope) {
      case 'asset':
        assetAdj.set(h.assetId, (assetAdj.get(h.assetId) || 0) - 0.25 * reason.weight * w);
        break;
      case 'class':
        classAdj.set(h.assetClass, (classAdj.get(h.assetClass) || 0) - 0.10 * reason.weight * w);
        break;
      case 'risk':
        riskShift -= 4 * reason.weight * w; // too_risky baja el riesgo efectivo; too_safe lo sube
        break;
      case 'timing':
        // ~3 rechazos recientes por timing (peso 0.5) alcanzan el umbral de 0.3
        timingCaution += 0.25 * reason.weight * w;
        break;
    }
  }
  riskShift = Math.max(-15, Math.min(15, riskShift));
  timingCaution = Math.min(0.5, timingCaution);
  return { assetAdj, classAdj, riskShift, timingCaution };
}

// Un activo queda suprimido si acumula fuerte rechazo directo
export function isSuppressed(adjustments, assetId) {
  return (adjustments.assetAdj.get(assetId) || 0) <= -0.5;
}
