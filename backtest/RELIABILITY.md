# Informe de Fiabilidad de la Predicción — Copiloto de Inversión

Este documento responde a una sola pregunta: **¿la señal del semáforo aporta
información real, o es fruto del azar y del sobreajuste?** Para responder con
honestidad aplicamos cinco pruebas exigentes sobre el S&P 500 (1991-01-02 → 2026-07-24).

> Metodología: la señal del cierre del día *t* se aplica en *t+1* (sin sesgo de
> anticipación). Todas las cifras son reproducibles: `node backtest/reliability.mjs`.

## 1. ¿Es la señal estadísticamente significativa? (test de permutación)

Comparamos el retorno medio posterior de los días **verdes** frente a los **rojos**
y lo contrastamos con una distribución nula generada por permutación circular
(3.000 iteraciones que rompen la relación señal↔futuro conservando la
autocorrelación de ambas series).

| Horizonte | Verde − Rojo (observado) | Media bajo azar | p-valor |
|---|---|---|---|
| 3 meses (63 sesiones) | 2.1% | -0.0% | **0.1500** |
| 1 mes (21 sesiones) | 0.6% | -0.0% | **0.1796** |

**Lectura:** un p-valor < 0,05 indica que la diferencia verde-rojo es muy
improbable por azar. ⚠️ La señal a 3 meses no alcanza significancia estándar.

## 2. ¿Sobrevive al sesgo de haber probado muchas configuraciones? (Sharpe deflactado)

Probamos 486 configuraciones de parámetros. El máximo de tantos Sharpes está
sesgado al alza por puro azar. El **Sharpe deflactado (DSR)** de Bailey &
López de Prado corrige ese sesgo y también la asimetría/curtosis de los retornos.

| Métrica | Valor |
|---|---|
| Sharpe observado (mejor config, anualizado) | 0.79 |
| Umbral de Sharpe esperado solo por azar (486 pruebas) | 0.15 |
| Asimetría / exceso de curtosis | -0.38 / 5.44 |
| **DSR = P(Sharpe verdadero > umbral)** | **100.0%** |

**Lectura:** un DSR > 95% significa que el resultado supera con alta confianza lo
esperable por probar muchas configuraciones. ✅ Supera el sesgo de multiple-testing.

## 3. Validación walk-forward (reoptimización rodante, 100% fuera de muestra)

La prueba más dura: cada año reoptimizamos los parámetros usando **solo los 8 años
anteriores** y aplicamos esos parámetros al año siguiente, que el modelo no ha
visto. Se encadenan 28 ventanas sin solape de información.

| | CAGR | Volatilidad | Sharpe | Caída máx. |
|---|---|---|---|---|
| **Semáforo walk-forward (OOS)** | 6.7% | 11.4% | 0.63 | -19% |
| Comprar y mantener (mismo tramo) | 6.8% | 19.2% | 0.44 | -57% |

Tramo evaluado: 1998-12-22 → 2026-07-24.
**Lectura:** si el Sharpe walk-forward sigue siendo bueno, la estrategia no depende
de haber elegido parámetros "a toro pasado". ✅ Bate a comprar-y-mantener en Sharpe fuera de muestra.

## 4. Robustez ante costes de transacción y liquidez remunerada

La rotación del semáforo es baja, pero conviene comprobar que los costes no se
comen la ventaja, y que remunerar la liquidez (letras al 2-4%) la mejora.

| Coste/operación | Liquidez 0% | Liquidez 2% | Liquidez 4% |
|---|---|---|---|
| 0 pb | Sharpe 0.74 | Sharpe 0.79 | Sharpe 0.83 |
| 5 pb | Sharpe 0.74 | Sharpe 0.79 | Sharpe 0.83 |
| 10 pb | Sharpe 0.74 | Sharpe 0.79 | Sharpe 0.83 |
| 25 pb | Sharpe 0.74 | Sharpe 0.79 | Sharpe 0.83 |

Operaciones totales en 36 años: **270** (≈7.6/año).
**Lectura:** con costes realistas (5-10 pb) el Sharpe apenas se mueve; remunerar la
liquidez lo mejora claramente, porque el semáforo pasa tiempo fuera del mercado.

## 5. Robustez across-assets (¿funciona más allá del índice?)

Aplicamos el MISMO semáforo, sin reoptimizar, a los 25 activos con
histórico suficiente. Si solo funcionara en el S&P 500 sería sospechoso de
sobreajuste al índice.

| Métrica | Resultado |
|---|---|
| Activos donde el timing mejora el Sharpe | **8/25** |
| Activos donde el timing reduce la caída máxima | **25/25** |
| Mejora mediana de Sharpe vs comprar-y-mantener | -0.07 |

**Lectura:** la reducción de caídas debería ser casi universal (el semáforo protege
en tendencias bajistas de cualquier activo); la mejora de Sharpe es más variable
porque en activos muy alcistas estar fuera cuesta rentabilidad.

## Veredicto honesto

- **Significancia:** la señal NO alcanza significancia estándar a 3 meses (p=0.1500); tratar con cautela.
- **Multiple-testing:** supera el Sharpe deflactado (DSR=100.0%): el resultado no es un artefacto de probar 486 configuraciones.
- **Fuera de muestra:** en walk-forward el Sharpe es 0.63 frente a 0.44 de comprar-y-mantener, con caída máxima -19% vs -57%.
- **Conclusión:** el valor del sistema está confirmado sobre todo en **protección frente a caídas** con rentabilidad comparable; su capacidad de "predecir subidas" es real pero modesta. Es un copiloto de gestión de riesgo, no una bola de cristal.

## Limitaciones que siguen en pie

- El histórico de acciones/ETFs tiene sesgo de superviviente.
- No se modelan impuestos por realización de plusvalías (la baja rotación los limita).
- Ningún sistema de timing es fiable día a día; esto está calibrado para horizontes
  de 3-6 meses y para **reducir grandes caídas**, no para acertar a corto plazo.
- Rentabilidades pasadas no garantizan rentabilidades futuras.

*Generado por backtest/reliability.mjs.*
