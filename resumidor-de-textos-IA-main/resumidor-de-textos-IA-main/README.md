# Simplify AI

Aplicación de transformación de texto con enfoque productivo (2026): UX rápida en frontend + backend monetizable con IA, Stripe y analítica.

## Qué incluye hoy

- Frontend vanilla (HTML/CSS/JS) con:
  - acciones de transformación,
  - selector de estilo narrativo (neutro, ejecutivo, técnico, académico, storytelling, persuasivo, creativo),
  - refinado 1 clic,
  - historial local,
  - control de modos IA (auto/remoto/local),
  - login por email OTP + Google,
  - checkout con consentimiento legal y conciliación de pago por `session_id`,
  - panel admin de métricas/reconciliación.
- Backend Node.js + Postgres con:
  - generación IA server-side (`/api/ai/generate`) con control de cuota segura,
  - prompt hardening por estilo narrativo + control de temperatura por estilo,
  - Stripe Checkout + webhook idempotente,
  - ledger de créditos en PostgreSQL,
  - auth JWT (anónimo, email OTP, Google),
  - consentimiento legal versionado (`/api/legal/*`),
  - eventos de producto y métricas admin.

## Estructura

```text
.
├── README.md
├── docker-compose.yml
├── .env.compose.example
├── scripts/
│   └── validate_static.py
├── backend/
│   ├── Dockerfile
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   ├── tests/
│   └── sql/
├── docs/
│   ├── PRODUCTION_GO_LIVE_CHECKLIST.md
│   └── nginx-security.conf
└── simplify/
    └── public/
        ├── index.html
        ├── styles.css
        ├── pay.config.js
        ├── auth.client.js
        ├── pay.guard.js
        ├── pay.ui.js
        ├── ai.client.js
        ├── admin.panel.js
        ├── main.js
        ├── css/
        ├── js/
        ├── legal/
        └── pulse/
```

## Ejecución local

### 1) Postgres

Levanta Postgres local (ejemplo Docker):

```bash
docker run --name simplify-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=simplify -p 5432:5432 -d postgres:16
```

### 2) Backend

```bash
cd backend
cp .env.example .env
npm install
npm start
```

API: `http://localhost:8787`

### 3) Frontend estático

```bash
cd simplify/public
python3 -m http.server 4173
```

App: `http://localhost:4173`

### Opción rápida con Docker Compose

Desde la raíz del repo:

```bash
cp .env.compose.example .env.compose
docker compose --env-file .env.compose up --build
```

Servicios:
- Frontend: `http://localhost:4173`
- Backend: `http://localhost:8787`
- Postgres: `localhost:5432`
- Backups automáticos de Postgres en volumen `pg_backups`

## Variables de entorno (`backend/.env`)

Mínimas para funcionar:

```env
PORT=8787
APP_BASE_URL=http://localhost:4173
FRONTEND_ORIGINS=http://localhost:4173
DATABASE_URL=postgres://postgres:postgres@localhost:5432/simplify
POSTGRES_SSL=false

OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Opcionales importantes:

- `JWT_SECRET`, `JWT_EXPIRES_IN`
- `ADMIN_API_KEY`
- `GOOGLE_CLIENT_ID`
- SMTP (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`)
- precios y créditos (`PRICE_*`, `CREDIT_*`, `FREE_USES`)
- legal/compliance (`LEGAL_VERSION`, `LEGAL_REQUIRE_CHECKOUT_CONSENT`)

## Endpoints principales

### Auth
- `POST /api/auth/session/anonymous`
- `GET /api/auth/me`
- `POST /api/auth/email/request-code`
- `POST /api/auth/email/verify-code`
- `POST /api/auth/google`
- `POST /api/auth/logout`

### Monetización
- `GET /api/pay/plans`
- `POST /api/pay/checkout`
- `GET /api/pay/checkout-status`
- `GET /api/pay/balance`
- `POST /api/pay/consume`
- `POST /api/pay/webhook` (Stripe)

### Legal/Compliance
- `POST /api/legal/consent`
- `GET /api/legal/consent-status`

### IA y eventos
- `POST /api/ai/generate`
- `POST /api/events/track`

### Admin
- `GET /api/admin/metrics`
- `POST /api/admin/reconcile/payments`
- `POST /api/admin/credits/grant`

## Webhook Stripe en local

```bash
stripe listen --forward-to localhost:8787/api/pay/webhook
```

Copia el `whsec_...` en `STRIPE_WEBHOOK_SECRET`.

## Validación rápida

```bash
python3 scripts/validate_static.py
```

## Tests E2E backend

El backend incluye suite E2E con `pg-mem` (sin Postgres real) y mock de proveedor IA:

```bash
cd backend
npm test
```

Cobertura actual del flujo:
- sesión anónima + login email OTP,
- consumo de cuota en generación IA,
- acreditación admin y consumo de créditos,
- métricas admin.

## Tests E2E frontend (Playwright)

La UI crítica (transformación, auth OTP, admin y checkout mock) está cubierta con Playwright:

```bash
cd backend
npm run test:ui
```

Suite incluida:
- `backend/tests/ui/app.critical-flows.spec.mjs`
- mocks de API para flujos de frontend sin depender de servicios externos.

## CI (GitHub Actions)

Pipeline en `.github/workflows/ci.yml` con:
- checks backend (`npm run check`),
- tests API E2E (`npm test`),
- validación estática (`python3 scripts/validate_static.py` + `node --check`),
- tests UI Playwright (instala Chromium y ejecuta `npm run test:ui`).

## SQL útil (seed + BI)

```bash
# Seed demo opcional
psql "$DATABASE_URL" -f backend/sql/seed_demo.sql

# Queries de dashboard
psql "$DATABASE_URL" -f backend/sql/dashboard_queries.sql
```

## Notas de seguridad

- Claves de IA y Stripe se mantienen en backend.
- Webhook Stripe es idempotente por `event_id` en DB.
- El consumo de cuota para IA se valida server-side (free uses + créditos).
- Checkout exige consentimiento legal versionado antes de cobro.
- Retorno de pago usa conciliación por `session_id` para reducir fricción por latencia webhook.
- Admin protegido por `x-admin-key` o rol `admin` en JWT.
- Rate limiting anti-abuso por IP/usuario en auth, IA, eventos, checkout y admin.
- Headers de seguridad en backend (nosniff, frame deny, referrer, permissions, COOP/CORP, HSTS bajo HTTPS).
- Trazabilidad por request con `x-request-id` y logs estructurados JSON.

## Go-live recomendado (2026)

- Configuración de headers/CSP en reverse proxy: `docs/nginx-security.conf`
- Checklist de despliegue por fases (staging -> canary -> prod): `docs/PRODUCTION_GO_LIVE_CHECKLIST.md`
