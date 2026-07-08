# Copiloto de Inversión 🧭

Web app **no-custodial** que te dice **qué porcentaje** de tu capital invertir, **cuándo** es buen
momento (semáforo de timing) y **qué activos puedes contratar en tu propio banco/bróker** — tú
siempre ejecutas las órdenes en tu plataforma. Herramienta educativa; no es asesoramiento
financiero personalizado.

**En vivo:** https://srisaac03.github.io/

## Características

- **Test psicométrico** de perfil de riesgo (12 ítems) — único método de perfilado.
- **Recomendaciones por porcentajes** del capital y de los ingresos, nunca importes fijos.
- **Semáforo de timing** (invertir / escalonar / esperar en liquidez) validado por backtest.
- **Filtro por bróker**: solo se recomienda lo que tu plataforma permite contratar, con sus
  comisiones y mínimos reales (catálogo curado: MyInvestor, Trade Republic, DEGIRO, IBKR, Revolut, BBVA).
- **Máximo 2 portafolios** simultáneos, cada uno con su nivel de riesgo.
- **Feedback loop**: cada aceptación/rechazo (con motivo) reajusta el motor, con decaimiento temporal.
- **Máquina del tiempo** (`?fecha=2008-09-15`): mira qué habría recomendado el motor en cualquier
  fecha desde 1991 y qué pasó en los 3 meses siguientes.
- **Datos**: histórico real S&P 500 1990–2022 empaquetado + APIs en vivo desde el navegador
  (Binance/CoinGecko para cripto, Frankfurter para divisas, Yahoo vía proxy CORS para el índice),
  con degradación limpia si alguna fuente falla.
- **Privacidad**: sin backend; todo el estado del usuario vive en `localStorage`.

## Arquitectura

- `ARCHITECTURE.md` — documento técnico completo (stack, UX, modelo de datos, motor).
- `js/core/` — motor puro (indicadores, pipeline de 5 etapas, perfil, brókers, feedback, store).
  Se ejecuta idéntico en navegador y en Node (tests/backtest).
- `js/data/providers.js` — proveedores de datos con timeout y fallback.
- `backtest/` — backtesting y afinado de parámetros con validación fuera de muestra.

## Desarrollo

```bash
node tools/build-data.mjs     # regenerar data/history.json desde los CSV
node tests/run.mjs            # suite de tests unitarios (36 tests)
node backtest/tune.mjs        # búsqueda en rejilla de parámetros (train 1991-2010)
node backtest/backtest.mjs    # informe completo → backtest/REPORT.md
python3 -m http.server 8321   # servir la app en local
node tests/e2e.mjs            # test end-to-end con Playwright (requiere Chromium)
```

## Resultados del backtest (resumen honesto)

Período 1991–2022, señal aplicada al día siguiente, liquidez al 0%:

| | CAGR | Volatilidad | Sharpe | Caída máxima |
|---|---|---|---|---|
| Estrategia con semáforo | 8,1% | 11,3% | 0,74 | **-17%** |
| Comprar y mantener | 7,9% | 18,4% | 0,51 | -57% |

Los días con señal verde subieron a 3 meses vista el 72% de las veces (base incondicional: 69%);
los días rojos, solo el 53%. Detalles y limitaciones en `backtest/REPORT.md`.
**Rentabilidades pasadas no garantizan rentabilidades futuras.**
