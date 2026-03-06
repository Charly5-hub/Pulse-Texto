# SECURITY REPORT

Fecha de auditoria: 2026-03-06  
Repositorio: `resumidor-de-textos-IA-main`  
Alcance: revision estatica de codigo y configuracion (backend, frontend, compose, CI) + auditoria de dependencias (`npm audit`).

---

## 1) Resumen ejecutivo

Se detectaron hallazgos relevantes de seguridad, con un riesgo **critico** en autenticacion/autorizacion por uso de `customerId` como identificador suficiente para operar en endpoints sensibles.

### Severidad global

- **Criticos:** 1
- **Altos:** 3
- **Medios:** 4
- **Bajos:** 2

### Estado de dependencias

- `npm audit` en `backend/`: **0 vulnerabilidades conocidas** (high/critical = 0).

---

## 2) Metodologia aplicada

1. Revision de configuraciones:
   - `backend/.env.example`
   - `.env.compose.example`
   - `docker-compose.yml`
2. Revision de backend:
   - `backend/server.js` (auth, CORS, endpoints, manejo de errores, seguridad)
3. Revision de frontend:
   - `simplify/public/auth.client.js`
   - `simplify/public/index.html`
4. Revision CI:
   - `.github/workflows/ci.yml`
5. Escaneo de secretos hardcodeados en repositorio:
   - patrones `sk_live`, `sk_test`, `whsec_`, `BEGIN PRIVATE KEY`, etc.

---

## 3) Hallazgos detallados

## F-01 (CRITICO) - Suplantacion de cuenta via `customerId`

**Area:** autenticacion debil / endpoints inseguros  
**Evidencia:**
- `POST /api/auth/session/anonymous` acepta `customerId` del cliente y devuelve JWT del usuario asociado (`backend/server.js:384-393`).
- `ensureUserByCustomerId(...)` retorna usuario existente por `customer_id` (`backend/server.js:2589+`).
- Multiples endpoints aceptan `customerId` sin exigir sesion autenticada:
  - `/api/pay/balance` (`backend/server.js:890+`)
  - `/api/pay/consume` (`backend/server.js:917+`)
  - `/api/pay/checkout-status` con control basado en customer (`backend/server.js:797+`)
  - `/api/legal/consent*` (`backend/server.js:613+`, `652+`)

**Riesgo:**
Si un atacante conoce/obtiene el `customerId` de una victima, puede:
- generar JWT de esa cuenta,
- consultar balance,
- consumir creditos,
- alterar estado funcional/legal asociado.

**Impacto:** toma de cuenta funcional (A/B testing, creditos, operaciones de cuenta), fraude y manipulacion de datos.

**Recomendacion:**
1. **Eliminar `customerId` como factor de autenticacion.**
2. `POST /api/auth/session/anonymous` debe **ignorar customerId externo** y generar uno nuevo server-side.
3. Endpoints de cuenta (`balance`, `consume`, `consent`, `checkout-status`) deben requerir `requireAuth`.
4. Si se mantiene modo anonimo, usar JWT anonimo como identidad real, no `customerId` enviado por cliente.

---

## F-02 (ALTO) - Configuracion de despliegue con secretos inseguros por defecto

**Area:** variables de entorno inseguras  
**Evidencia:**
- `.env.compose.example` incluye:
  - `JWT_SECRET=change-me`
  - `ADMIN_API_KEY=change-me`
  - `OTP_PEPPER=change-me`
- `docker-compose.yml` define defaults inseguros:
  - `JWT_SECRET: ${JWT_SECRET:-change-me-docker-jwt-secret}`
  - `ADMIN_API_KEY: ${ADMIN_API_KEY:-change-me-docker-admin-key}`
  - `OTP_PEPPER: ${OTP_PEPPER:-change-me-docker-otp-pepper}`

**Riesgo:**
Despliegues reales con secretos triviales si no se sobreescriben explicitamente.

**Recomendacion:**
1. Eliminar defaults inseguros en `docker-compose.yml` para secretos criticos.
2. Fallar startup si faltan secretos en runtime productivo.
3. Usar gestor de secretos (Docker secrets, Vault, AWS/GCP secret manager).

---

## F-03 (ALTO) - `NODE_ENV` no definido en compose puede desactivar guardas de produccion

**Area:** variables de entorno inseguras / seguridad operacional  
**Evidencia:**
- `NODE_ENV` por defecto cae en `development` (`backend/server.js:14-15`).
- En `docker-compose.yml` no se define `NODE_ENV`.
- Varias validaciones de seguridad fuerte dependen de `IS_PRODUCTION`.

**Riesgo:**
Despliegue en modo no productivo por omision (mayor superficie de error de configuracion y comportamiento no endurecido).

**Recomendacion:**
1. Definir `NODE_ENV=production` para despliegues reales.
2. Añadir validacion de arranque: rechazar ejecucion si `NODE_ENV` no es explicitamente esperado.
3. Separar claramente archivos/env para dev y prod.

---

## F-04 (ALTO) - Exposicion de OTP en logs de desarrollo

**Area:** autenticacion debil / logging sensible  
**Evidencia:**
- Se registra OTP en logs cuando no hay SMTP (`dev.otp.generated`) (`backend/server.js`, `deliverOTPEmail`).
- `SHOW_DEV_OTP` puede habilitar devolucion de OTP en respuesta en entornos no endurecidos.

**Riesgo:**
Acceso a logs = acceso a codigos OTP validos en ventana activa.

**Recomendacion:**
1. No loggear OTP completo; enmascarar (`***495`) o omitir.
2. Limitar `SHOW_DEV_OTP` a test local estricto.
3. Reforzar politicas de acceso/retencion de logs.

---

## F-05 (MEDIO) - CORS potencialmente permisivo con credenciales

**Area:** configuracion incorrecta de CORS  
**Evidencia:**
- `ALLOW_ANY_ORIGIN = frontendOrigins.includes("*")` (`backend/server.js:121`).
- CORS permite origenes segun callback y `credentials: true` (`backend/server.js:268-276`).

**Riesgo:**
Si se configura `*` por error, cualquier origen podria operar con credenciales habilitadas (dependiendo de agente/browser y cabeceras devueltas).

**Recomendacion:**
1. Prohibir `*` de forma absoluta cuando `credentials: true`.
2. Mantener allowlist cerrada y validada por entorno.
3. Agregar pruebas automatizadas de CORS en CI.

---

## F-06 (MEDIO) - `trust proxy` habilitado globalmente

**Area:** endpoints/API seguridad perimetral  
**Evidencia:**
- `app.set("trust proxy", true)` (`backend/server.js:264`).

**Riesgo:**
Si el servicio queda expuesto sin proxy confiable, cabeceras como `X-Forwarded-For` pueden afectar:
- rate limiting por IP,
- trazabilidad y diagnostico,
- decisiones dependientes de proto/IP.

**Recomendacion:**
1. Configurar `trust proxy` segun entorno (false en local/directo).
2. Limitar a hops/proxies conocidos (`app.set("trust proxy", <policy>)`).

---

## F-07 (MEDIO) - Tokens JWT en `localStorage`

**Area:** autenticacion debil (frontend)  
**Evidencia:**
- `authToken` y `authUser` se guardan en `localStorage` (`simplify/public/auth.client.js:8-36`).

**Riesgo:**
Ante XSS, exfiltracion directa de JWT.

**Recomendacion:**
1. Preferir cookies `HttpOnly + Secure + SameSite`.
2. Si se mantiene bearer, minimizar permanencia (memoria + refresh de corta vida).
3. Endurecer CSP y sanitizacion para reducir vector XSS.

---

## F-08 (MEDIO) - Verificacion JWT sin restricciones explicitas de algoritmo/claims

**Area:** autenticacion debil  
**Evidencia:**
- `jwt.verify(token, CONFIG.jwtSecret)` sin `algorithms`, `issuer`, `audience` explicitos (`backend/server.js:2953`).

**Riesgo:**
Mayor dependencia de defaults de libreria y menor robustez criptografica/politica.

**Recomendacion:**
1. Definir `algorithms: ["HS256"]` (o el que corresponda).
2. Definir y validar `issuer`/`audience`.
3. Considerar `jti` + revocacion para sesiones de alto riesgo.

---

## F-09 (BAJO) - Exposicion de metadatos operativos en `/api/health`

**Area:** endpoints de API inseguros (info disclosure)  
**Evidencia:**
- `/api/health` expone flags y configuraciones operativas (`stripeConfigured`, `aiConfigured`, `plans`, `planLimits`, recovery settings) en `backend/server.js:344+`.

**Riesgo:**
Facilita reconnaissance para atacante.

**Recomendacion:**
1. Reducir payload de health para publico.
2. Separar health interno vs externo.

---

## F-10 (BAJO) - Falta de escaneo de seguridad en CI

**Area:** dependencias vulnerables / proceso  
**Evidencia:**
- CI actual no ejecuta `npm audit` ni SCA dedicado (`.github/workflows/ci.yml`).

**Riesgo:**
Demora en detectar vulnerabilidades nuevas en dependencias.

**Recomendacion:**
1. Agregar job de seguridad (`npm audit --production` con politica por severidad).
2. Habilitar Dependabot/Renovate con PR automaticas.
3. Complementar con escaneo de imagen/container (Trivy/Grype).

---

## 4) Estado de dependencias y secretos

## 4.1 Dependencias (backend)

Resultado de `npm audit --json`:
- Vulnerabilidades: **0**
- Criticas: **0**
- Altas: **0**

## 4.2 Secretos hardcodeados en repositorio

Busqueda por patrones comunes (`sk_live`, `sk_test`, `whsec_`, `BEGIN PRIVATE KEY`, etc.):
- **Sin coincidencias detectadas** en archivos versionados.

---

## 5) Plan de remediacion recomendado (priorizado)

## Prioridad inmediata (0-48h)

1. Corregir F-01:
   - eliminar autenticacion basada en `customerId`.
   - exigir JWT para endpoints de cuenta.
2. Corregir F-02 y F-03:
   - secretos obligatorios en runtime productivo.
   - `NODE_ENV=production` explicito en despliegue.

## Corto plazo (1-2 semanas)

3. Corregir F-05/F-06:
   - CORS estricta sin `*` con credenciales.
   - `trust proxy` por politica de entorno.
4. Corregir F-07/F-08:
   - mejorar estrategia de tokens y validaciones JWT.

## Medio plazo (2-4 semanas)

5. Corregir F-09/F-10:
   - hardening de `/api/health`.
   - pipeline CI con escaneo de seguridad continuo.

---

## 6) Nota de alcance

Este informe es una auditoria tecnica de codigo/configuracion (no pentest activo ni auditoria de infraestructura cloud completa).  
Para cierre formal, se recomienda:
- pruebas dinamicas de autorizacion (IDOR/BOLA),
- pruebas de penetracion de API,
- revision de secretos y politicas IAM en entorno de despliegue.
