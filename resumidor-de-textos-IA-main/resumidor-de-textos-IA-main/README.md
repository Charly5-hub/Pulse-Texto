# Simplify AI

Plataforma de transformacion de texto con frontend ligero y backend monetizable (IA, Stripe, autenticacion y analitica).

---

## Tabla de contenidos

- [1. Resumen](#1-resumen)
- [2. Requisitos](#2-requisitos)
- [3. Ejecucion local](#3-ejecucion-local)
  - [3.1 Opcion recomendada: Docker Compose](#31-opcion-recomendada-docker-compose)
  - [3.2 Ejecucion manual](#32-ejecucion-manual)
    - [Backend](#backend)
    - [Frontend](#frontend)
- [4. Tests y validaciones](#4-tests-y-validaciones)
- [5. Variables de entorno](#5-variables-de-entorno)
- [6. Estructura del proyecto](#6-estructura-del-proyecto)
- [7. Endpoints principales](#7-endpoints-principales)
- [8. CI](#8-ci)
- [9. Seguridad y operacion](#9-seguridad-y-operacion)

---

## 1. Resumen

### Frontend
- Vanilla HTML/CSS/JS (sin framework ni bundler).
- Acciones de transformacion de texto.
- Modos IA (`auto`, `remote`, `local`).
- Login por email OTP + Google.
- Checkout y estado de balance.
- Panel admin para metricas, reconciliacion y operaciones.

### Backend
- API Node.js + Express + PostgreSQL.
- Integracion con OpenAI-compatible API.
- Stripe Checkout + webhook idempotente.
- Ledger de creditos y limites por plan (`free`, `one`, `pack`, `sub`).
- Consentimiento legal versionado.
- Recovery de checkout abandonado con secuencia y A/B.

---

## 2. Requisitos

- Node.js 22+
- npm 10+
- Python 3.10+ (para servidor estatico local y validacion estatica)
- PostgreSQL 16+ (si no usas Docker Compose)
- Docker + Docker Compose (opcional, recomendado)

---

## 3. Ejecucion local

## 3.1 Opcion recomendada: Docker Compose

Desde la raiz del repositorio:

```bash
cp .env.compose.example .env.compose
docker compose --env-file .env.compose up --build
```

Servicios:
- Frontend: `http://localhost:4173`
- Backend: `http://localhost:8787`
- PostgreSQL: `localhost:5432`
- Backups de Postgres en volumen `pg_backups`

## 3.2 Ejecucion manual

### Backend

1. Levanta PostgreSQL (ejemplo rapido):

```bash
docker run --name simplify-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=simplify -p 5432:5432 -d postgres:16
```

2. Configura y ejecuta backend:

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Backend disponible en `http://localhost:8787`.

### Frontend

En otra terminal:

```bash
cd simplify/public
python3 -m http.server 4173
```

Frontend disponible en `http://localhost:4173`.

---

## 4. Tests y validaciones

Todos los comandos se ejecutan en `backend/` salvo que se indique lo contrario.

### Checks de sintaxis backend

```bash
npm run check
```

### Tests E2E de API (Node test runner + pg-mem)

```bash
npm test
```

### Tests E2E de UI (Playwright)

En entorno local limpio:

```bash
npm run test:ui:local
```

Si Chromium de Playwright ya esta instalado:

```bash
npm run test:ui
```

### Suite completa

```bash
npm run test:all
```

### Validacion estatica de assets frontend

Desde la raiz del repo:

```bash
python3 scripts/validate_static.py
```

---

## 5. Variables de entorno

Referencia principal: `backend/.env.example`.

> Recomendado:
>
> ```bash
> cd backend
> cp .env.example .env
> ```

### 5.1 Servidor y base de datos

| Variable | Requerida | Default | Descripcion |
|---|---|---|---|
| `NODE_ENV` | No | `development` | Entorno de ejecucion (`development` / `production`). |
| `PORT` | No | `8787` | Puerto HTTP del backend. |
| `APP_BASE_URL` | No | `http://localhost:4173` | URL publica del frontend para redirects. |
| `FRONTEND_ORIGINS` | No | `http://localhost:4173` | Lista CSV de origins permitidos por CORS. |
| `DATABASE_URL` | Si (excepto tests con pg-mem) | - | Conexion PostgreSQL. |
| `POSTGRES_SSL` | No | `false` | Habilita SSL para PostgreSQL. |
| `USE_PG_MEM` | No | `0` | Usa DB en memoria (principalmente tests). |

### 5.2 Auth y seguridad

| Variable | Requerida | Default | Descripcion |
|---|---|---|---|
| `JWT_SECRET` | Si en produccion | `dev-jwt-secret-change-me` interno | Secreto para firmar JWT. |
| `JWT_EXPIRES_IN` | No | `30d` | TTL del token JWT. |
| `ADMIN_API_KEY` | Recomendado en produccion | vacio | Clave para endpoints admin (`x-admin-key`). |
| `OTP_PEPPER` | Si en produccion | `dev-otp-pepper-change-me` interno | Pepper del hash OTP. |
| `OTP_TTL_MINUTES` | No | `10` | Minutos de validez del OTP. |
| `OTP_MAX_ATTEMPTS` | No | `5` | Intentos maximos de OTP por email. |
| `SHOW_DEV_OTP` | No | `1` en dev | Muestra OTP en respuesta para entornos de desarrollo. |
| `GOOGLE_CLIENT_ID` | No | vacio | Habilita login con Google. |

### 5.3 SMTP (OTP y recovery)

| Variable | Requerida | Default | Descripcion |
|---|---|---|---|
| `SMTP_HOST` | No | vacio | Host SMTP. |
| `SMTP_PORT` | No | `587` | Puerto SMTP. |
| `SMTP_SECURE` | No | `false` | Usa TLS implicito (465) si `true`. |
| `SMTP_USER` | No | vacio | Usuario SMTP. |
| `SMTP_PASS` | No | vacio | Password SMTP. |
| `SMTP_FROM` | No | `noreply@simplify.local` | Remitente de emails. |

### 5.4 IA

| Variable | Requerida | Default | Descripcion |
|---|---|---|---|
| `OPENAI_API_BASE` | No | `https://api.openai.com/v1` | Base URL de proveedor compatible OpenAI. |
| `OPENAI_API_KEY` | Si para modo remoto real | vacio | API key del proveedor IA. |
| `OPENAI_MODEL` | No | `gpt-4.1-mini` | Modelo de generacion usado por backend. |

### 5.5 Stripe y monetizacion

| Variable | Requerida | Default | Descripcion |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | Si para cobros reales | vacio | Secret key de Stripe. |
| `STRIPE_WEBHOOK_SECRET` | Si para validar webhooks | vacio | Secreto de firma de webhook Stripe. |
| `STRIPE_PRICE_ONE` | No | vacio | Price ID para plan `one` (opcional). |
| `STRIPE_PRICE_PACK` | No | vacio | Price ID para plan `pack` (opcional). |
| `STRIPE_PRICE_SUB` | No | vacio | Price ID para plan `sub` (opcional). |
| `PRICE_CURRENCY` | No | `eur` | Moneda de precios. |
| `PRICE_ONE_CENTS` | No | `100` | Precio en centimos plan `one`. |
| `PRICE_PACK_CENTS` | No | `500` | Precio en centimos plan `pack`. |
| `PRICE_SUB_CENTS` | No | `800` | Precio en centimos plan `sub`. |
| `CREDIT_ONE` | No | `1` | Creditos otorgados por plan `one`. |
| `CREDIT_PACK` | No | `10` | Creditos otorgados por plan `pack`. |
| `CREDIT_SUB_MONTH` | No | `250` | Creditos por ciclo de suscripcion. |
| `FREE_USES` | No | `3` | Usos gratis iniciales por usuario. |

### 5.6 Legal, recovery y limites de input

| Variable | Requerida | Default | Descripcion |
|---|---|---|---|
| `LEGAL_VERSION` | No | `2026-02` | Version legal vigente. |
| `LEGAL_REQUIRE_CHECKOUT_CONSENT` | No | `1` | Exige consentimiento legal para checkout. |
| `MARKETING_SPEND_MONTHLY_CENTS` | No | `0` | Coste marketing mensual para metricas. |
| `RECOVERY_SWEEP_MINUTES` | No | `15` | Frecuencia de barrido recovery. |
| `RECOVERY_DELAY_MINUTES` | No | `45` | Retardo inicial base recovery. |
| `RECOVERY_SEQUENCE_HOURS` | No | `1,24,72` | Secuencia de emails recovery por horas. |
| `RECOVERY_MAX_ATTEMPTS` | No | `3` | Maximo de intentos recovery por sesion. |
| `RECOVERY_BATCH_SIZE` | No | `25` | Tamano de lote por ejecucion recovery. |
| `RECOVERY_AB_ENABLED` | No | `1` | Activa variante A/B de asuntos. |
| `RECOVERY_STOP_ON_ACTIVITY` | No | `1` | Detiene recovery si usuario vuelve activo. |
| `RECOVERY_ACTIVITY_WINDOW_HOURS` | No | `168` | Ventana para detectar actividad reciente. |
| `MAX_INPUT_FREE` | No | `8000` | Limite de input para tier `free`. |
| `MAX_INPUT_ONE` | No | `12000` | Limite de input para tier `one`. |
| `MAX_INPUT_PACK` | No | `20000` | Limite de input para tier `pack`. |
| `MAX_INPUT_SUB` | No | `32000` | Limite de input para tier `sub`. |

---

## 6. Estructura del proyecto

```text
.
├── README.md
├── docker-compose.yml
├── .env.compose.example
├── scripts/
│   └── validate_static.py
├── docs/
│   ├── PRODUCTION_GO_LIVE_CHECKLIST.md
│   ├── nginx-security.conf
│   └── reports/
│       ├── ARCHITECTURE_ANALYSIS.md
│       └── SECURITY_REPORT.md
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── package-lock.json
│   ├── .env.example
│   ├── Dockerfile
│   ├── sql/
│   │   ├── seed_demo.sql
│   │   └── dashboard_queries.sql
│   └── tests/
│       ├── api.guards-and-errors.test.mjs
│       ├── e2e.auth-billing.test.mjs
│       └── ui/app.critical-flows.spec.mjs
└── simplify/
    └── public/
        ├── index.html
        ├── styles.css
        ├── main.js
        ├── pay.config.js
        ├── pay.guard.js
        ├── pay.ui.js
        ├── auth.client.js
        ├── ai.client.js
        ├── admin.panel.js
        ├── chips.js
        ├── css/
        ├── js/
        ├── legal/
        └── pulse/
```

---

## 7. Endpoints principales

### Auth
- `POST /api/auth/session/anonymous`
- `GET /api/auth/me`
- `POST /api/auth/email/request-code`
- `POST /api/auth/email/verify-code`
- `POST /api/auth/google`
- `POST /api/auth/logout`

### Monetizacion
- `GET /api/pay/plans`
- `POST /api/pay/checkout`
- `GET /api/pay/checkout-status`
- `GET /api/pay/balance`
- `POST /api/pay/consume`
- `POST /api/pay/webhook`

### Legal
- `POST /api/legal/consent`
- `GET /api/legal/consent-status`

### IA y eventos
- `POST /api/ai/generate`
- `GET /api/ai/history` (requiere autenticación)
- `DELETE /api/ai/history/:id` (requiere autenticación)
- `POST /api/events/track`

### Admin
- `GET /api/admin/metrics`
- `POST /api/admin/reconcile/payments`
- `POST /api/admin/credits/grant`
- `POST /api/admin/plan/assign`
- `POST /api/admin/marketing/spend`
- `POST /api/admin/recovery/checkout/run`
- `GET /api/admin/recovery/checkout/stats`

---

## 8. CI

Workflow: `.github/workflows/ci.yml`

La CI ejecuta:
1. Checks backend (`npm run check`).
2. Tests API E2E (`npm test`).
3. Validacion estatica (`python3 scripts/validate_static.py` + `node --check` en JS frontend clave).
4. Tests UI Playwright (`npm run test:ui`) instalando Chromium previamente.

---

## 9. Seguridad y operacion

- Las claves de IA/Stripe se gestionan solo en backend.
- Webhook Stripe con validacion de firma + idempotencia en DB.
- Cuota y creditos validados server-side.
- Rate limiting por IP/usuario en auth, IA, checkout, eventos y admin.
- Headers de seguridad HTTP activados (incluye HSTS bajo HTTPS).
- Request tracing con `x-request-id` y logs estructurados JSON.
- En produccion, configura secretos reales y desactiva `SHOW_DEV_OTP`.

Documentacion adicional:
- `docs/nginx-security.conf`
- `docs/PRODUCTION_GO_LIVE_CHECKLIST.md`
- `docs/reports/ARCHITECTURE_ANALYSIS.md`
- `docs/reports/SECURITY_REPORT.md`
