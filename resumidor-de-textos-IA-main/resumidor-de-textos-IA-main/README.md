# Simplify AI

Aplicación web estática para resumir, simplificar y transformar textos de forma rápida.

## Estado del proyecto

- Frontend estático (HTML/CSS/JS vanilla), sin framework.
- Flujo funcional completo en cliente (fallback local para acciones de texto).
- Sistema de cuota gratuita con persistencia local (`localStorage`).
- Estructura legal básica y assets organizados.

> Nota: la lógica de transformación actual funciona en modo local para facilitar pruebas y demo.  
> Si se desea integración con backend/IA real, el punto de entrada está preparado en `SIMPLIFY_PAY_CONFIG.backend`.

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

## Próximos pasos sugeridos

1. Conectar `main.js` a un endpoint IA real (OpenAI/otro proveedor).
2. Sustituir links de pago `#` por URLs reales de checkout.
3. Añadir tests automatizados de UI y regresión.
