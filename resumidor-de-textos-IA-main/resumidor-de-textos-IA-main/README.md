# Simplify AI

Aplicación web estática para resumir, simplificar y transformar textos de forma rápida.

## Estado del proyecto

- Frontend estático (HTML/CSS/JS vanilla), sin framework.
- Flujo híbrido 2026: motor remoto configurable + fallback local automático.
- Sistema de cuota gratuita + créditos de pago sincronizables con backend.
- Perfiles de uso (estudio, negocio, contenido, soporte), refinado 1-clic y métricas de calidad.
- Historial local de resultados para iterar más rápido.
- Backend monetizable con Stripe Checkout, webhook y ledger de créditos.
- Tracking de eventos clave de conversión (`generation_*`, `checkout_*`, `result_copied`).

> Nota: puedes usar modo local para demo inmediata y conectar API real cuando quieras.

## Estructura

```text
.
├── README.md
├── scripts/
│   └── validate_static.py
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   └── data/
└── simplify/
    └── public/
        ├── index.html
        ├── styles.css
        ├── pay.config.js
        ├── pay.guard.js
        ├── chips.js
        ├── pay.ui.js
        ├── ai.client.js
        ├── main.js
        ├── css/
        ├── js/
        ├── legal/
        └── pulse/
```

## Cómo ejecutar en local (stack monetizable)

### 1) Backend

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Servidor API por defecto: `http://localhost:8787`

### 2) Frontend estático

Desde la raíz del repo:

```bash
cd simplify/public
python3 -m http.server 4173
```

App en navegador:

```text
http://localhost:4173
```

## Variables de entorno backend

Archivo: `backend/.env`

```env
PORT=8787
APP_BASE_URL=http://localhost:4173
FRONTEND_ORIGINS=http://localhost:4173

OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini

STRIPE_SECRET_KEY=sk_live_... (o sk_test_...)
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ONE=price_...
STRIPE_PRICE_PACK=price_...
STRIPE_PRICE_SUB=price_...
```

Si no defines `STRIPE_PRICE_*`, el backend crea checkout con `price_data` inline usando:

- `PRICE_ONE_CENTS`
- `PRICE_PACK_CENTS`
- `PRICE_SUB_CENTS`

## Validación rápida

Comprueba que los recursos referenciados en `index.html` existen:

```bash
python3 scripts/validate_static.py
```

## Endpoints backend

- `GET /api/health`
- `POST /api/ai/generate`
- `GET /api/pay/plans`
- `POST /api/pay/checkout`
- `GET /api/pay/balance?customerId=...`
- `POST /api/pay/consume`
- `POST /api/pay/webhook` (Stripe webhook)
- `POST /api/events/track`

## Modo admin (debug)

Parámetros de URL útiles durante pruebas:

- `?admin=1` activa modo admin.
- `?bypass=1` activa bypass de cuota.
- `?bypass=0` desactiva bypass.
- `#json` o `#raw` cambia la pestaña de salida por URL.

## Integración IA remota (mercado 2026)

Edita `simplify/public/pay.config.js` y ajusta `backend`:

```js
backend: {
  endpoint: "http://localhost:8787/api/ai/generate",
  timeoutMs: 12000,
  model: "",       // opcional
  mode: "generic", // "openai" o "generic"
  temperature: 0.2,
  headers: {},
}
```

En la UI puedes seleccionar:

- **Auto**: intenta remoto y hace fallback local si falla.
- **Remoto**: prioriza API (si no hay endpoint, informa y cae a local).
- **Local**: todo en cliente, útil para demo/offline.

## Stripe webhook en local (opcional pero recomendado)

Si usas Stripe CLI:

```bash
stripe listen --forward-to localhost:8787/api/pay/webhook
```

Copia el `whsec_...` generado al `STRIPE_WEBHOOK_SECRET`.

## Próximos pasos sugeridos

1. Añadir autenticación (email/Google) y customer mapping real.
2. Migrar ledger JSON a Postgres (idempotencia fuerte + auditoría).
3. Añadir tests E2E de compra y consumo de créditos.
