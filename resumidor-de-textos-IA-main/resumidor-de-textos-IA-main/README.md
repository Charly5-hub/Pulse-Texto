# Simplify AI

Aplicación web estática para resumir, simplificar y transformar textos de forma rápida.

## Estado del proyecto

- Frontend estático (HTML/CSS/JS vanilla), sin framework.
- Flujo híbrido 2026: motor remoto configurable + fallback local automático.
- Sistema de cuota gratuita con persistencia local (`localStorage`).
- Perfiles de uso (estudio, negocio, contenido, soporte), refinado 1-clic y métricas de calidad.
- Historial local de resultados para iterar más rápido.
- Estructura legal básica y assets organizados.

> Nota: puedes usar modo local para demo inmediata y conectar API real cuando quieras.

## Estructura

```text
.
├── README.md
├── scripts/
│   └── validate_static.py
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

## Cómo ejecutar en local

Desde la raíz del repo:

```bash
cd simplify/public
python3 -m http.server 4173
```

Abrir en navegador:

```text
http://localhost:4173
```

## Validación rápida

Comprueba que los recursos referenciados en `index.html` existen:

```bash
python3 scripts/validate_static.py
```

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
  endpoint: "https://tu-backend.ai/generate",
  timeoutMs: 12000,
  model: "gpt-4.1-mini",
  mode: "openai", // "openai" o "generic"
  temperature: 0.2,
  headers: {
    // "X-Api-Key": "tu-clave-si-aplica"
  },
}
```

En la UI puedes seleccionar:

- **Auto**: intenta remoto y hace fallback local si falla.
- **Remoto**: prioriza API (si no hay endpoint, informa y cae a local).
- **Local**: todo en cliente, útil para demo/offline.

## Próximos pasos sugeridos

1. Conectar checkout real (Stripe) y sincronizar créditos con backend.
2. Añadir autenticación y workspace por usuario.
3. Añadir tests automatizados de UI/regresión y E2E.
