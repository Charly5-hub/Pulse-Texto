# Simplify · Go-live checklist (staging -> canary -> prod)

Ultima revision: 24/02/2026

## 1) Preflight de seguridad y cumplimiento

- [ ] `JWT_SECRET`, `ADMIN_API_KEY`, `OTP_PEPPER` y claves API generadas con alta entropia.
- [ ] `SHOW_DEV_OTP=0` en entornos no-dev.
- [ ] `LEGAL_VERSION` definido y consistente con paginas `/legal/*`.
- [ ] `LEGAL_REQUIRE_CHECKOUT_CONSENT=1` en produccion.
- [ ] Politicas de privacidad/terminos revisadas con asesor legal local.
- [ ] Plan de respuesta a incidentes y canal de soporte operativo.

## 2) Staging

- [ ] Deploy completo (frontend + backend + postgres + webhooks Stripe de test).
- [ ] Ejecutar checks:
  - [ ] `python3 scripts/validate_static.py`
  - [ ] `cd backend && npm run check`
  - [ ] `cd backend && npm test`
  - [ ] `cd backend && npm run test:ui`
- [ ] Verificar flujo E2E:
  - [ ] Sesion anonima -> email OTP -> compra -> credito usable.
  - [ ] Retorno `?checkout=success&session_id=...` concilia correctamente.
  - [ ] Consentimiento legal requerido antes de checkout.
  - [ ] Estilo narrativo aplicado en salida (al menos 3 estilos).
- [ ] Revisar logs estructurados con `x-request-id`.
- [ ] Confirmar backups Postgres restaurables (prueba de restore).

## 3) Canary (1-5% trafico)

- [ ] Activar despliegue gradual.
- [ ] Monitorear 30-60 minutos:
  - [ ] Error rate API (`5xx`, `4xx` por endpoint).
  - [ ] Latencia p95 `/api/ai/generate`.
  - [ ] Conversion checkout started -> checkout success.
  - [ ] Tasa de conciliacion en `/api/pay/checkout-status`.
- [ ] Validar no hay incremento anomalo en reclamaciones de soporte/pagos.

## 4) Produccion completa

- [ ] Escalar a 100% trafico tras estabilidad en canary.
- [ ] Verificar alertas activas para:
  - [ ] Healthcheck backend.
  - [ ] Caida webhook Stripe.
  - [ ] Saturacion DB y errores de conexion.
  - [ ] Spike de `rate_limit` o `auth` fallida.
- [ ] Congelar cambios no criticos durante ventana de estabilizacion inicial (24-48h).

## 5) Post go-live (24h / 7d)

- [ ] Revisar cohortes iniciales de conversion y retencion.
- [ ] Auditar prompts de estilos narrativos con muestras reales anonimizadas.
- [ ] Priorizar mejoras segun:
  1. Incidencias de pago/compliance.
  2. Calidad percibida de resultados de texto.
  3. Rendimiento/coste por generacion.

## 6) Rollback plan

- [ ] Mantener imagen anterior lista para rollback inmediato.
- [ ] Script documentado para volver a version estable.
- [ ] Procedimiento de comunicacion a usuarios en caso de degradacion critica.
