// Catálogo curado de brókers/bancos y sus capacidades (MVP: 6 plataformas).
// No existe API universal de catálogos de producto: esta tabla se mantiene a mano
// y es la fuente del "filtro de elegibilidad" del motor (etapa 3).
// fee_bps = comisión aproximada por operación en puntos básicos (0.01%).

export const BROKERS = [
  {
    id: 'myinvestor',
    name: 'MyInvestor',
    country: 'ES',
    assetClasses: ['etf', 'fund', 'equity'],
    feeBps: { etf: 12, fund: 0, equity: 12 },
    minOrder: { etf: 1, fund: 10, equity: 1 },
    fractional: { etf: false, fund: true, equity: false },
    fxFeeBps: 30,
    notes: 'Fondos indexados sin comisión de compra; ETFs con comisión por operación.',
  },
  {
    id: 'traderepublic',
    name: 'Trade Republic',
    country: 'DE/ES',
    assetClasses: ['etf', 'equity', 'crypto'],
    feeBps: { etf: 0, equity: 0, crypto: 100 },
    fixedFeeEUR: 1,
    minOrder: { etf: 1, equity: 1, crypto: 1 },
    fractional: { etf: true, equity: true, crypto: true },
    fxFeeBps: 0,
    notes: '1€ fijo por orden; planes de inversión periódicos gratis; fraccionado.',
  },
  {
    id: 'degiro',
    name: 'DEGIRO',
    country: 'NL/ES',
    assetClasses: ['etf', 'equity', 'bond'],
    feeBps: { etf: 5, equity: 15, bond: 20 },
    fixedFeeEUR: 1,
    minOrder: { etf: 1, equity: 1, bond: 1000 },
    fractional: { etf: false, equity: false, bond: false },
    fxFeeBps: 25,
    notes: 'Selección de ETFs con condiciones favorables; sin fraccionado.',
  },
  {
    id: 'ibkr',
    name: 'Interactive Brokers',
    country: 'US/EU',
    assetClasses: ['etf', 'equity', 'bond', 'fund'],
    feeBps: { etf: 5, equity: 5, bond: 10, fund: 10 },
    minOrder: { etf: 1, equity: 1, bond: 1000, fund: 100 },
    fractional: { etf: true, equity: true, bond: false, fund: true },
    fxFeeBps: 2,
    notes: 'Acceso global, fraccionado en acciones/ETFs USA, FX casi al contado.',
  },
  {
    id: 'revolut',
    name: 'Revolut',
    country: 'EU',
    assetClasses: ['equity', 'crypto'],
    feeBps: { equity: 25, crypto: 149 },
    minOrder: { equity: 1, crypto: 1 },
    fractional: { equity: true, crypto: true },
    fxFeeBps: 40,
    notes: 'Solo acciones USA y cripto; comisiones más altas fuera del plan premium.',
  },
  {
    id: 'bbva',
    name: 'BBVA (banca tradicional)',
    country: 'ES',
    assetClasses: ['fund', 'equity'],
    feeBps: { fund: 0, equity: 60 },
    minOrder: { fund: 30, equity: 1 },
    fractional: { fund: true, equity: false },
    fxFeeBps: 50,
    notes: 'Fondos propios sin comisión de compra; renta variable con corretaje alto.',
  },
];

export function getBroker(id) {
  return BROKERS.find(b => b.id === id) || null;
}

// ¿Puede este bróker contratar este activo? Devuelve null si no, o los términos si sí.
export function brokerTerms(broker, asset) {
  if (!broker || !broker.assetClasses.includes(asset.assetClass)) return null;
  return {
    feeBps: broker.feeBps[asset.assetClass] ?? 0,
    fixedFeeEUR: broker.fixedFeeEUR ?? 0,
    minOrder: broker.minOrder[asset.assetClass] ?? 1,
    fractional: broker.fractional[asset.assetClass] ?? false,
    fxFeeBps: asset.currency && asset.currency !== 'EUR' ? (broker.fxFeeBps ?? 0) : 0,
  };
}
