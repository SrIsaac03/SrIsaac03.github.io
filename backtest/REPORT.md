# Informe de Backtest — Copiloto de Inversión

**Datos:** S&P 500 diario real, 1990-01-02 → 2022-12-28 (8.313 sesiones) + 20 valores del índice.
**Metodología:** la señal calculada al cierre del día *t* se aplica en *t+1* (sin sesgo de anticipación).
Parámetros elegidos por búsqueda en rejilla (486 configuraciones) **solo con datos 1991–2010** y
validados fuera de muestra en 2011–2022. La liquidez rinde 0% (conservador).

**Parámetros ganadores:** {"smaLong":200,"smaShort":50,"rsiPeriod":14,"rsiOverbought":70,"rsiOversold":35,"volWindow":30,"volHigh":0.25,"volExtreme":0.4,"ddDeep":-0.3,"topN":5,"fwdHorizon":63}

## 1. Estrategia guiada por el semáforo vs. comprar-y-mantener

Exposición: verde = 100% invertido · ámbar = 50% · rojo = 0% (liquidez).

| Período | | CAGR | Volatilidad | Sharpe | Caída máx. |
|---|---|---|---|---|---|
| **Entrenamiento 1991–2010** | Semáforo | 8.8% | 11.4% | 0.80 | -17% |
| | Comprar y mantener | 6.9% | 18.7% | 0.45 | -57% |
| **Validación 2011–2022 (fuera de muestra)** | Semáforo | 6.8% | 11.2% | 0.64 | -15% |
| | Comprar y mantener | 9.6% | 17.8% | 0.61 | -34% |
| **Período completo 1991–2022** | Semáforo | 8.1% | 11.3% | 0.74 | -17% |
| | Comprar y mantener | 7.9% | 18.4% | 0.51 | -57% |

## 2. Acierto de la señal (¿qué pasó en los 3/6 meses siguientes?)

"Acierto" = % de días con esa señal cuyo retorno posterior fue positivo.
La base es el % incondicional (el mercado sube la mayoría de los períodos: superar la base es lo difícil).

| Período | Señal | Días | Acierto 3m | Retorno medio 3m | Acierto 6m |
|---|---|---|---|---|---|
| Entrenamiento 1991–2010 | 🟢 verde | 2923 | 70.1% | 2.5% | 79.8% |
| Entrenamiento 1991–2010 | 🟡 ámbar | 953 | 78.2% | 4.6% | 78.0% |
| Entrenamiento 1991–2010 | 🔴 rojo | 1103 | 45.5% | -2.0% | 40.1% |
| Entrenamiento 1991–2010 | *base (todos)* | 4979 | 66.2% | 1.9% | 70.9% |
| Validación 2011–2022 (fuera de muestra) | 🟢 verde | 2063 | 74.4% | 2.4% | 75.0% |
| Validación 2011–2022 (fuera de muestra) | 🟡 ámbar | 476 | 65.5% | 0.9% | 78.6% |
| Validación 2011–2022 (fuera de muestra) | 🔴 rojo | 416 | 72.4% | 5.4% | 85.6% |
| Validación 2011–2022 (fuera de muestra) | *base (todos)* | 2955 | 72.7% | 2.6% | 76.9% |
| Período completo 1991–2022 | 🟢 verde | 5024 | 72.1% | 2.5% | 78.0% |
| Período completo 1991–2022 | 🟡 ámbar | 1454 | 74.4% | 3.4% | 78.9% |
| Período completo 1991–2022 | 🔴 rojo | 1519 | 52.9% | -0.0% | 52.7% |
| Período completo 1991–2022 | *base (todos)* | 7997 | 68.9% | 2.2% | 73.5% |

**Lectura:** el valor del semáforo no está en "predecir" el mercado sino en (a) que los días verdes
suben con más frecuencia y más cuantía que la base, y (b) que estar fuera en los rojos recorta las
caídas máximas a la mitad (ver tabla 1) a costa de algo de rentabilidad en los rebotes.

## 3. Aportación periódica (DCA): con timing vs. fija

Aportación mensual constante. "Con timing": verde invierte todo lo acumulado, ámbar la mitad, rojo espera en liquidez.

| Período | Valor final DCA fija | Valor final DCA con timing | Ratio |
|---|---|---|---|
| Entrenamiento 1991–2010 | 382.8× | 390.1× | 1.019 |
| Validación 2011–2022 (fuera de muestra) | 251.3× | 249.1× | 0.991 |
| Período completo 1991–2022 | 1399.5× | 1420.0× | 1.015 |

## 4. Selección de activos (momentum/volatilidad, top-5 mensual vs. equiponderado)

| Período | Meses | % meses que el top-5 bate al equiponderado | CAGR top-5 | CAGR equiponderado |
|---|---|---|---|---|
| 1992–2022 | 371 | 58.5% | 23.0% | 16.3% |
| 2011–2022 | 143 | 55.9% | 21.6% | 16.5% |

## 5. Casos de estudio: el semáforo en fechas críticas

| Fecha | Contexto | Señal | Retorno 3m posterior |
|---|---|---|---|
| 2000-03-24 | Techo de la burbuja puntocom | 🟡 ámbar | -5.6% |
| 2001-09-21 | Mínimos tras el 11-S | 🟡 ámbar | 18.0% |
| 2007-10-09 | Techo previo a la crisis financiera | 🟢 verde | -10.0% |
| 2008-09-15 | Quiebra de Lehman Brothers | 🔴 rojo | -26.2% |
| 2009-03-09 | Suelo de la crisis financiera | 🟡 ámbar | 38.8% |
| 2013-05-01 | Mercado alcista consolidado | 🟢 verde | 6.5% |
| 2020-02-19 | Techo pre-COVID | 🟢 verde | -13.7% |
| 2020-03-23 | Suelo del crash COVID | 🔴 rojo | 39.4% |
| 2020-08-03 | Recuperación post-COVID | 🟢 verde | -0.7% |
| 2022-01-03 | Techo previo al bajista de 2022 | 🟢 verde | -4.5% |
| 2022-06-16 | Tramo bajista de 2022 | 🔴 rojo | 5.6% |

## 6. Limitaciones (léelas)

- **Rentabilidades pasadas no garantizan rentabilidades futuras.** Este backtest demuestra que las
  reglas son razonables y explicables, no que predigan el futuro.
- La liquidez se modela al 0%; con letras/remunerada al 2-4% la estrategia con semáforo mejoraría.
- No se descuentan comisiones ni impuestos por rotación (la rotación del semáforo es baja, ~pocas
  señales al año, pero no es cero).
- El universo de 20 valores tiene sesgo de supervivencia (son empresas que siguen existiendo).
- El "margen de error" irreducible: ningún sistema de timing es fiable a corto plazo; el motor
  está calibrado para horizontes de 3-6 meses y para proteger de grandes caídas, no para acertar días.

*Informe generado automáticamente por backtest/backtest.mjs.*
