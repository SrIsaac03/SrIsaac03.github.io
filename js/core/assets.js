// Universo de activos del MVP. Los símbolos con histórico apuntan a series del
// bundle data/history.json; los cripto se cotizan en vivo (CoinGecko/Binance).

export const ASSETS = [
  // Índice (proxy de ETF indexado global/USA — el activo "core" recomendable)
  { id: 'SP500', symbol: 'SP500', name: 'ETF S&P 500 (indexado)', assetClass: 'etf', currency: 'USD', series: 'SP500', core: true },
  // ETFs de factores (histórico desde 2014)
  { id: 'USMV', symbol: 'USMV', name: 'ETF Mínima Volatilidad USA', assetClass: 'etf', currency: 'USD', series: 'ETF_USMV', defensive: true },
  { id: 'QUAL', symbol: 'QUAL', name: 'ETF Calidad USA', assetClass: 'etf', currency: 'USD', series: 'ETF_QUAL' },
  { id: 'MTUM', symbol: 'MTUM', name: 'ETF Momentum USA', assetClass: 'etf', currency: 'USD', series: 'ETF_MTUM' },
  { id: 'VLUE', symbol: 'VLUE', name: 'ETF Value USA', assetClass: 'etf', currency: 'USD', series: 'ETF_VLUE' },
  { id: 'SIZE', symbol: 'SIZE', name: 'ETF Small Size USA', assetClass: 'etf', currency: 'USD', series: 'ETF_SIZE' },
  // Acciones individuales (histórico 1990-2022)
  { id: 'AAPL', symbol: 'AAPL', name: 'Apple', assetClass: 'equity', currency: 'USD', series: 'AAPL' },
  { id: 'MSFT', symbol: 'MSFT', name: 'Microsoft', assetClass: 'equity', currency: 'USD', series: 'MSFT' },
  { id: 'JNJ', symbol: 'JNJ', name: 'Johnson & Johnson', assetClass: 'equity', currency: 'USD', series: 'JNJ', defensive: true },
  { id: 'PG', symbol: 'PG', name: 'Procter & Gamble', assetClass: 'equity', currency: 'USD', series: 'PG', defensive: true },
  { id: 'KO', symbol: 'KO', name: 'Coca-Cola', assetClass: 'equity', currency: 'USD', series: 'KO', defensive: true },
  { id: 'JPM', symbol: 'JPM', name: 'JPMorgan', assetClass: 'equity', currency: 'USD', series: 'JPM' },
  { id: 'UNH', symbol: 'UNH', name: 'UnitedHealth', assetClass: 'equity', currency: 'USD', series: 'UNH' },
  { id: 'HD', symbol: 'HD', name: 'Home Depot', assetClass: 'equity', currency: 'USD', series: 'HD' },
  { id: 'PEP', symbol: 'PEP', name: 'PepsiCo', assetClass: 'equity', currency: 'USD', series: 'PEP', defensive: true },
  { id: 'LLY', symbol: 'LLY', name: 'Eli Lilly', assetClass: 'equity', currency: 'USD', series: 'LLY' },
  { id: 'CVX', symbol: 'CVX', name: 'Chevron', assetClass: 'equity', currency: 'USD', series: 'CVX' },
  { id: 'XOM', symbol: 'XOM', name: 'ExxonMobil', assetClass: 'equity', currency: 'USD', series: 'XOM' },
  { id: 'WMT', symbol: 'WMT', name: 'Walmart', assetClass: 'equity', currency: 'USD', series: 'WMT', defensive: true },
  { id: 'MRK', symbol: 'MRK', name: 'Merck', assetClass: 'equity', currency: 'USD', series: 'MRK' },
  { id: 'BAC', symbol: 'BAC', name: 'Bank of America', assetClass: 'equity', currency: 'USD', series: 'BAC' },
  // Cripto (solo cotización en vivo; sin histórico local)
  { id: 'BTC', symbol: 'BTC', name: 'Bitcoin', assetClass: 'crypto', currency: 'USD', live: 'bitcoin', binance: 'BTCUSDT' },
  { id: 'ETH', symbol: 'ETH', name: 'Ethereum', assetClass: 'crypto', currency: 'USD', live: 'ethereum', binance: 'ETHUSDT' },
];

export function getAsset(id) {
  return ASSETS.find(a => a.id === id) || null;
}
