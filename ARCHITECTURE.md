# Copiloto de Inversión — Documento de Arquitectura Técnica

> Diseño de arquitectura, modelo de datos y flujo de producto para una app de
> inversión multiplataforma **no-custodial** basada en recomendaciones por
> porcentaje, *timing* de mercado y sincronización con el banco/bróker del usuario.

---

## 0. Recomendación estratégica (léelo antes que nada)

Antes del detalle técnico, cuatro decisiones de producto que condicionan **todo** lo demás:

1. **El "cuello de botella" no es el algoritmo, es el dato del banco/bróker.**
   La funcionalidad #4 ("filtrar activos según lo que el banco del usuario permite")
   es la más difícil de todo el proyecto. No existe una API universal de catálogos
   de producto de bancos/brókers. Opciones reales:
   - **Agregadores de banca abierta (PSD2)**: Tink, Plaid, TrueLayer, GoCardless
     (ex-Nordigen, gratis en EU). Te dan **saldos y movimientos**, *no* el catálogo
     de fondos/ETFs que el bróker permite contratar.
   - **El catálogo de producto** casi siempre hay que **modelarlo tú** por bróker
     (MyInvestor, Trade Republic, Degiro, IBKR, Revolut, etc.): qué ETFs/fondos
     ofrecen, comisiones, mínimos, fraccionamiento. Es una tabla curada
     manualmente al principio.
   - **Recomendación MVP**: empieza soportando **2-3 brókers** que conozcas bien
     y modela su catálogo a mano. No intentes cubrir "cualquier banco" en la v1.

2. **Esto es producto regulado.** Recomendar inversiones concretas puede constituir
   **asesoramiento financiero** (MiFID II en EU / RIA en US). Dos salidas legales:
   - Posicionarlo como **herramienta educativa / de información** con *disclaimers*
     claros ("esto no es asesoramiento financiero personalizado"), o
   - Operar bajo una **licencia de asesor** o al amparo de una entidad regulada.
   Lo no-custodial (el usuario ejecuta) te ayuda, pero **no** te exime de la parte
   de "recomendación". Consúltalo con un abogado fintech antes de lanzar.

3. **El feedback loop tiene problema de arranque en frío.** Reentrenar el algoritmo
   con aceptaciones/rechazos necesita **volumen de usuarios**. En la v1 el "motor"
   debe ser **reglas + heurística explicable**, no ML. El ML llega cuando tengas datos.

4. **Empieza web, no escritorio.** Windows/iOS/Android es el objetivo final, pero
   una **web app responsive (PWA)** te valida producto en semanas y comparte ~100%
   del código. Escritorio nativo (Windows) y stores móviles vienen después.

> **TL;DR de mi recomendación:** MVP = **web app (React + PWA)** + **backend Python
> (FastAPI)** + **motor de reglas explicable** + **2-3 brókers modelados a mano** +
> datos de mercado vía un solo proveedor. Multiplataforma real (Flutter/React Native
> + Tauri) en fase 2. Todo lo demás del documento describe la arquitectura objetivo.

---

## 1. Stack Tecnológico

Objetivo: máximo código compartido entre **Windows (escritorio), iOS y Android**,
con un backend robusto para el motor analítico.

### 1.1 Frontend / Cliente

| Opción | Cubre | Código compartido | Veredicto |
|---|---|---|---|
| **Flutter** | iOS, Android, Windows, Web, macOS, Linux | ~95% (una sola base Dart) | ✅ **Recomendado** para el producto multiplataforma nativo |
| **React Native + React Native Windows** | iOS, Android, Windows | ~85% | Alternativa si tu equipo es JS/TS |
| **React (web PWA) + Tauri** | Web + escritorio (Win/Mac/Linux); móvil como PWA | ~90% | ✅ **Recomendado para el MVP** por velocidad |

**Recomendación:**
- **MVP (0-3 meses):** **React + TypeScript** como PWA responsive.
  Empaqueta el escritorio con **Tauri** (binario Windows ligero, ~10 MB, usa el
  webview del SO en lugar de Electron). Móvil = la misma PWA instalable.
- **Producto v2 (nativo real en stores):** migrar el cliente a **Flutter**, que es
  hoy la mejor relación *un solo código ↔ Windows + iOS + Android nativos*, con
  rendimiento y *look & feel* nativos y una capa de widgets muy pulida para la
  "baja fricción" que pides.

Librerías clave (Flutter): `riverpod`/`bloc` (estado), `fl_chart` (gráficos),
`dio` (HTTP), `hive`/`isar` (cache local), `flutter_secure_storage` (tokens).

### 1.2 Backend / Motor

- **Lenguaje:** **Python** — es la lengua franca del análisis financiero
  (`pandas`, `numpy`, `scipy`, `scikit-learn`, `TA-Lib`/`pandas-ta` para indicadores
  técnicos, `PyPortfolioOpt` para optimización de carteras).
- **Framework API:** **FastAPI** (async, tipado, OpenAPI automático, WebSockets para
  el streaming de mercado en tiempo real).
- **Motor de tareas / tiempo real:** **Celery + Redis** (o `arq`) para jobs de
  refresco de mercado; **WebSocket** para empujar señales al cliente al abrir la app.
- **Base de datos:** **PostgreSQL** (relacional — encaja perfecto con el modelo de
  datos, y su restricción de "máx. 2 portafolios" se resuelve con constraints).
  **TimescaleDB** (extensión de Postgres) para series temporales de precios.
- **Cache / cola:** **Redis**.
- **Auth:** **Auth0 / Clerk / Supabase Auth** (delega el KYC-light y MFA).

### 1.3 Proveedores de datos (crítico)

| Necesidad | Proveedores | Notas |
|---|---|---|
| Precios de mercado (acciones/ETF/cripto) | **Twelve Data, Financial Modeling Prep, Alpha Vantage, Polygon.io, EOD Historical Data** | Empieza con uno (Twelve Data o FMP tienen buen *free tier*). Datos "tiempo real" reales = de pago. |
| Datos macro / tipos | FRED (gratis), ECB | Para el módulo de *timing*. |
| Conexión a cuentas del usuario (saldos) | **GoCardless Bank Account Data (gratis EU), Tink, Plaid, TrueLayer** | PSD2 / Open Banking. Da saldos/movimientos, no catálogo de producto. |
| Catálogo de producto por bróker | **Curado manualmente** (tabla propia) | No hay API universal. Ver §0.1. |

> **Regla de oro:** abstrae los proveedores tras una **interfaz `MarketDataProvider`**
> y una **`BankConnector`** para poder cambiar de proveedor sin tocar el motor.

### 1.4 Infra / DevOps

- **Hosting:** contenedores en **Fly.io / Render / Railway** (MVP) → **AWS/GCP** (escala).
- **CI/CD:** GitHub Actions.
- **Observabilidad:** Sentry (errores) + Grafana/Prometheus (métricas del motor).
- **Secretos:** nunca en cliente; todas las API keys de mercado viven en el backend.

---

## 2. Flujo de Usuario (UX/UI)

Principio rector: **baja fricción + explicabilidad**. El usuario debe entender el
*por qué* de cada recomendación en < 5 segundos.

### 2.1 Onboarding

1. **Registro** (email/Apple/Google) + MFA.
2. **Test psicométrico de riesgo** (10-15 ítems tipo Likert). Mide:
   tolerancia a pérdidas, horizonte temporal, reacción ante caídas, experiencia previa,
   estabilidad de ingresos. Resultado → **perfil** (`Conservador / Moderado / Dinámico / Agresivo`)
   + un `risk_score` numérico (0-100). *Este es el ÚNICO método de perfilado, por requisito.*
3. **Datos financieros base:** capital disponible e ingresos mensuales
   (por rangos/porcentajes, no hace falta el importe exacto — mejora la privacidad).
4. **Conexión del ecosistema:** el usuario selecciona su **banco/bróker** de una lista.
   Opcional: conectar por Open Banking (solo lectura de saldo) para pre-rellenar capital.
   Aquí se carga su **catálogo de productos disponibles**.
5. **Creación del primer portafolio** (máx. 2): nombre + nivel de riesgo
   (heredado del test o ajustado dentro de los límites del perfil).

### 2.2 Pantalla principal (Home / "Hoy")

- **Semáforo de mercado / Timing:** un indicador claro
  🟢 *Buen momento para invertir* · 🟡 *Neutral* · 🔴 *Mejor esperar en liquidez*,
  con una frase de justificación ("Volatilidad alta + RSI sobrecomprado → esperar").
- **Tarjetas de recomendación** (una por señal): activo, **% del capital/ingreso**
  sugerido (nunca importe fijo), horizonte, y *"por qué"* en 1 línea.
- Cada tarjeta indica si el activo es **contratable en tu bróker** (si no, no aparece).

### 2.3 Ciclo de una recomendación (aceptar / rechazar)

```
[Tarjeta de recomendación]
   ├─ "Ver detalle"  → gráfico, indicadores, comisión estimada en tu bróker, riesgo
   ├─ ✅ "La voy a ejecutar"
   │      → la app NO opera. Muestra pasos: "Abre <bróker> y compra X% (~importe)".
   │      → marca la recomendación como ACEPTADA (para el feedback loop)
   │      → recordatorio opcional: "¿Ejecutada?" a las 24h
   └─ ❌ "Descartar"
          → OBLIGATORIO elegir motivo de rechazo:
             · No me convence el activo
             · Demasiado riesgo / poco riesgo
             · No tengo liquidez ahora
             · Ya tengo exposición a esto
             · No confío en el timing
             · Otro (texto libre)
          → se registra en RejectedRecommendation (alimenta el reentrenamiento)
```

### 2.4 Otras pantallas

- **Mis portafolios (máx. 2):** rendimiento, distribución, drift vs. objetivo.
- **Historial:** recomendaciones aceptadas/rechazadas, con motivos (transparencia).
- **Ajustes:** re-hacer test de riesgo, gestionar bróker conectado, privacidad.

> **Nota no-custodial (repetir en UI):** en ningún punto la app ejecuta órdenes.
> Siempre redirige/instruye al usuario para que opere en su propia plataforma.

---

## 3. Modelo de Datos (PostgreSQL)

Esquema relacional. Presto atención especial al **límite de 2 portafolios** y al
**historial de recomendaciones rechazadas**.

### 3.1 Entidades principales

```sql
-- Usuario
User(
  id UUID PK,
  email TEXT UNIQUE,
  created_at TIMESTAMPTZ,
  monthly_income_band TEXT,      -- rango, no importe exacto
  available_capital_band TEXT
)

-- Perfil de riesgo (resultado del test psicométrico)
RiskProfile(
  id UUID PK,
  user_id UUID FK -> User,
  risk_score INT,               -- 0..100
  category TEXT,                -- Conservador|Moderado|Dinamico|Agresivo
  assessed_at TIMESTAMPTZ,
  answers JSONB                 -- respuestas crudas del test (auditoría)
)

-- Bróker/banco del usuario y su catálogo
Broker(
  id UUID PK,
  name TEXT,                    -- MyInvestor, Trade Republic, Degiro...
  country TEXT
)

BrokerProduct(                  -- catálogo curado: qué se puede contratar y cómo
  id UUID PK,
  broker_id UUID FK -> Broker,
  asset_id UUID FK -> Asset,
  fee_bps INT,                  -- comisión en puntos básicos
  min_amount NUMERIC,
  fractional BOOLEAN            -- ¿permite fracciones?
)

UserBrokerLink(
  id UUID PK,
  user_id UUID FK -> User,
  broker_id UUID FK -> Broker,
  connected_via TEXT,           -- manual | openbanking
  linked_at TIMESTAMPTZ
)

-- Universo de activos
Asset(
  id UUID PK,
  symbol TEXT,
  name TEXT,
  asset_class TEXT,             -- equity|etf|bond|crypto|fund
  isin TEXT
)

-- Portafolios (¡MÁXIMO 2 POR USUARIO!)
Portfolio(
  id UUID PK,
  user_id UUID FK -> User,
  name TEXT,
  risk_level TEXT,              -- cada portafolio tiene su propio nivel
  slot SMALLINT CHECK (slot IN (1,2)),   -- ranura 1 o 2
  created_at TIMESTAMPTZ,
  archived BOOLEAN DEFAULT false,
  UNIQUE (user_id, slot) WHERE archived = false   -- índice parcial
)

-- Recomendaciones generadas por el motor
Recommendation(
  id UUID PK,
  user_id UUID FK -> User,
  portfolio_id UUID FK -> Portfolio,
  asset_id UUID FK -> Asset,
  action TEXT,                  -- buy|hold|wait|reduce
  percent_of_capital NUMERIC,   -- SIEMPRE %, nunca importe fijo
  timing_signal TEXT,           -- green|amber|red
  rationale TEXT,               -- explicación legible
  market_snapshot JSONB,        -- estado de indicadores en el momento
  generated_at TIMESTAMPTZ,
  status TEXT                    -- pending|accepted|rejected|expired
)

-- Historial de ACEPTADAS
AcceptedRecommendation(
  id UUID PK,
  recommendation_id UUID FK -> Recommendation,
  accepted_at TIMESTAMPTZ,
  executed_confirmed BOOLEAN    -- el usuario confirmó que operó (opcional)
)

-- Historial de RECHAZADAS (clave para el reentrenamiento)
RejectedRecommendation(
  id UUID PK,
  recommendation_id UUID FK -> Recommendation,
  user_id UUID FK -> User,
  reason_code TEXT,             -- catálogo cerrado de motivos
  reason_note TEXT,             -- texto libre opcional
  rejected_at TIMESTAMPTZ
)
```

### 3.2 Cómo se modela el **límite de 2 portafolios**

Tres capas de defensa (defensa en profundidad):

1. **A nivel de BD (la fuente de verdad):** columna `slot SMALLINT CHECK (slot IN (1,2))`
   + **índice único parcial** `UNIQUE (user_id, slot) WHERE archived = false`.
   Garantiza que un usuario no pueda tener dos portafolios activos en la misma ranura,
   y por tanto **máximo 2 activos** a la vez. Es imposible violarlo aunque el backend
   tenga un bug o haya condición de carrera.
2. **A nivel de aplicación:** el servicio `PortfolioService.create()` cuenta los
   activos antes de insertar y devuelve un error de negocio claro.
3. **A nivel de UI:** el botón "Crear portafolio" se deshabilita al llegar a 2.

> Alternativa NoSQL (si se usara MongoDB): un documento `User` con un array
> `portfolios` y validación de esquema `{ portfolios: { $maxItems: 2 } }`.
> Pero **recomiendo Postgres**: las constraints declarativas hacen este requisito
> trivial y a prueba de balas, algo que en NoSQL queda solo a nivel de aplicación.

### 3.3 Cómo se modela el **historial de rechazos**

- Tabla `RejectedRecommendation` separada (no un simple flag) para conservar
  **motivo + timestamp + nota** de cada rechazo → dataset limpio para el motor.
- `reason_code` es un **catálogo cerrado** (enum) para poder agregar/analizar;
  `reason_note` guarda el texto libre.
- Se enlaza a `Recommendation`, que a su vez guarda el `market_snapshot` (JSONB):
  así el reentrenamiento sabe **en qué condiciones de mercado** el usuario dijo "no".

---

## 4. Arquitectura del Motor (lógica algorítmica)

El motor cruza tres fuentes: **estado de mercado (tiempo real)**, **perfil + finanzas
del usuario** y **restricciones del bróker**. Se ejecuta como pipeline de etapas.

```
                    ┌─────────────────────────────────────────────┐
                    │              MOTOR (pipeline)                │
                    └─────────────────────────────────────────────┘

 [Datos mercado]        [Perfil + finanzas]        [Catálogo bróker]
 precios, RSI,          risk_score, capital,        BrokerProduct
 volatilidad, macro     ingresos, portafolios       (fees, mínimos)
      │                        │                          │
      ▼                        ▼                          ▼
 ┌─────────┐            ┌──────────────┐          ┌──────────────┐
 │ 1.MARKET │           │ 2.ALLOCATION │          │ 3.ELIGIBILITY│
 │  STATE   │──señal──▶ │ (% capital)  │──────────│   FILTER     │
 └─────────┘  timing    └──────────────┘  candidatos└──────┬─────┘
      │                                                     │
      ▼                                                     ▼
 ┌──────────────┐                                  ┌──────────────────┐
 │ 4.TIMING GATE│◀─────────────────────────────────│ 5.PERSONALIZATION│
 │ ¿ahora o     │                                  │ (feedback loop)  │
 │  esperar?    │                                  └──────────────────┘
 └──────┬───────┘                                           ▲
        │                                                   │
        ▼                                          [Accepted/Rejected history]
   Recommendation (action, %, timing, rationale)
```

### Etapa 1 — Market State (estado de mercado en tiempo real)

Al abrir la app se dispara un refresco. Calcula indicadores por activo y a nivel índice:
- **Tendencia:** medias móviles (SMA/EMA 50/200), cruce dorado/muerte.
- **Momentum:** RSI, MACD.
- **Riesgo:** volatilidad (ATR, desviación estándar 30d), VIX / drawdown.
- **Macro:** tipos de interés (FRED/ECB), inflación.
Produce un `market_regime` ∈ {alcista, lateral, bajista, alta-volatilidad}.

### Etapa 2 — Allocation (lógica por porcentajes)

**Nunca importes fijos.** El objetivo `%` se deriva de:
- el **perfil de riesgo** (mapea `risk_score` → pesos por clase de activo, p.ej. vía
  fronteras de asignación tipo *glidepath*),
- el **capital e ingresos** del usuario (tamaño de posición como % del capital;
  aportaciones recurrentes como % del ingreso mensual → *dollar-cost averaging*),
- el estado actual del portafolio (evitar sobre-concentración; *rebalancing*).
Herramienta: `PyPortfolioOpt` (optimización media-varianza / *risk parity*) acotada
por los límites del perfil.

### Etapa 3 — Eligibility Filter (sincronización con el bróker)

**Filtro duro:** solo sobreviven los `Asset` que existen en `BrokerProduct` para el
bróker del usuario. Además ajusta por:
- **comisión** (`fee_bps`): descarta si el coste se come el retorno esperado,
- **mínimo de inversión** (`min_amount`) vs. el `% * capital` sugerido,
- **fraccionamiento**: si el bróker no permite fracciones, redondea a unidades enteras.
Sin este filtro, jamás se recomienda algo que el usuario no puede contratar.

### Etapa 4 — Timing Gate (recomendación de tempos)

Decide 🟢/🟡/🔴 combinando `market_regime` + indicadores de sobrecompra/sobreventa +
volatilidad. Reglas ejemplo:
- RSI > 70 y volatilidad alta → 🔴 *esperar en liquidez*.
- Tendencia alcista + RSI 40-60 → 🟢 *buen momento*.
- Señal mixta → 🟡 *neutral / entrada escalonada (DCA)*.
El *gate* puede convertir un "buy" en "wait" o proponer **entrada fraccionada**.

### Etapa 5 — Personalization (feedback loop)

Ajusta las recomendaciones con el historial del usuario:
- **v1 (reglas):** si el usuario rechazó repetidamente un activo/clase por un motivo
  (`reason_code`), se penaliza o suprime esa recomendación (pesos ajustables).
  Ej.: 3 rechazos "demasiado riesgo" → baja el riesgo efectivo del perfil.
- **v2 (ML, cuando haya datos):** modelo de *learning-to-rank* / clasificación
  (features = market_snapshot + perfil + activo; label = accepted/rejected) que
  ordena candidatos por probabilidad de aceptación **útil**. Cuidado con el sesgo:
  optimizar "aceptación" no es lo mismo que optimizar "buen consejo" — hay que
  ponderar con resultados reales, no solo con que al usuario le guste.

### Explicabilidad (transversal)

Cada `Recommendation` guarda un `rationale` generado a partir de las reglas que se
activaron y un `market_snapshot`. Esto es obligatorio por: (a) confianza del usuario,
(b) requisitos regulatorios de transparencia, (c) depuración del motor.

---

## 5. Roadmap sugerido (de menos a más riesgo)

| Fase | Alcance | Duración aprox. |
|---|---|---|
| **F0 — Validación** | Este documento + validación legal (¿asesoramiento?) + elegir 2-3 brókers | 1-2 sem |
| **F1 — MVP web** | React PWA + FastAPI + Postgres + motor de **reglas** + 1 proveedor de mercado + catálogo bróker manual | 6-10 sem |
| **F2 — Multiplataforma** | Migrar cliente a **Flutter** (Win/iOS/Android) o empaquetar con Tauri; publicar en stores | 6-8 sem |
| **F3 — Open Banking** | Conexión PSD2 (saldos), más brókers | 4-6 sem |
| **F4 — ML feedback** | Cuando haya volumen de datos aceptado/rechazado, sustituir reglas por modelo | continuo |

---

### Resumen de decisiones clave

- **Cliente:** React PWA + Tauri (MVP) → **Flutter** (nativo multiplataforma).
- **Backend:** **Python + FastAPI + PostgreSQL + Redis**.
- **Motor:** pipeline de **5 etapas** con reglas explicables; ML solo cuando haya datos.
- **Límite de 2 portafolios:** garantizado por **constraint de BD** (índice único parcial).
- **Rechazos:** tabla dedicada con `reason_code` + `market_snapshot` para reentrenar.
- **No-custodial y regulación:** la app **nunca** opera; validar el encaje legal antes de lanzar.
