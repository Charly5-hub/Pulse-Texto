# PERFORMANCE REPORT

## 1) Alcance y metodología

Este análisis se basa en revisión estática del backend (`backend/server.js`) con foco en:

- rutas HTTP y su ruta crítica de ejecución;
- consultas SQL y patrón de acceso a tablas;
- uso de transacciones, I/O externo (Stripe/OpenAI/SMTP) y serialización JSON;
- posibilidades de caché y reducción de round-trips.

Referencias clave en código:

- Endpoints: `backend/server.js:L279-L1599`
- Recovery/reconciliación: `backend/server.js:L1830-L2362`
- Acceso a datos/transacciones: `backend/server.js:L2535-L2587`
- Esquema/índices actuales: `backend/server.js:L2492-L2521`

---

## 2) Endpoints potencialmente lentos

## 2.1 Críticos (alto impacto)

1. **`GET /api/admin/metrics`** (`L1134-L1316`)
   - Ejecuta muchas consultas secuenciales en una sola request (usuarios, revenue, funnel, recovery, eventos diarios).
   - Hace procesamiento en memoria de payloads JSON completos (`recoveryEmailPayloads`) para agrupar variantes/segmentos.
   - Riesgo: latencia creciente con el volumen de `app_events` y `payment_sessions`.

2. **`POST /api/admin/recovery/checkout/run`** (`L1454-L1465` + `L2134-L2362`)
   - Lazo por candidato con:
     - hidratación por usuario (`hydrateRecoveryCandidate`, `L1875-L1905`);
     - chequeo de actividad reciente (`getRecentUserActivityForRecovery`, `L1839-L1872`);
     - llamadas a Stripe (`L2230-L2244`);
     - múltiples transacciones UPDATE/INSERT por iteración (`L2205-L2339`).
   - Patrón claro de N+1 y alto costo de I/O externo.

3. **`POST /api/admin/reconcile/payments`** (`L1550-L1599`)
   - Procesa sesiones pendientes en serie y hace una llamada a Stripe por ítem (`L1577-L1584`).
   - Con `limit` alto, el endpoint escala linealmente en tiempo total.

## 2.2 Relevantes

4. **`GET /api/pay/checkout-status`** (`L797-L880`)
   - Si la sesión no está completada, consulta Stripe en caliente (`L832-L840`).
   - Si frontend hace polling frecuente, puede generar latencia y presión externa innecesaria.

5. **`POST /api/ai/generate`** (`L995-L1132`)
   - Dominado por llamada de red al proveedor IA (`L1064-L1078`) + operaciones de cuota/evento.
   - Es esperable que sea de mayor latencia, pero puede optimizar su overhead interno.

6. **`POST /api/events/track`** (`L964-L993`)
   - Escribe en DB por evento, dentro de transacción, con payload JSONB.
   - Endpoint de alto QPS potencial; sensible a write amplification.

---

## 3) Consultas ineficientes detectadas

## 3.1 Fan-out SQL en métricas administrativas

En `GET /api/admin/metrics` (`L1139-L1195`) hay múltiples `client.query(...)` secuenciales.  
Problemas:

- muchos round-trips por request;
- agregaciones sobre ventanas de tiempo sin índices compuestos suficientes;
- extracción de payloads completa para agregación en aplicación.

### Mejora recomendada

- Consolidar en menos consultas (CTEs) por bloque de negocio.
- Mover agregaciones de `payload` a SQL cuando sea posible.
- Cachear resultado final por ventana (`days`) durante TTL corto.

## 3.2 Consultas sobre `payment_sessions` con filtros combinados sin índice compuesto

Patrones frecuentes:

- `status = 'completed' AND created_at >= $1` (`L1150`, `L1193`)
- `status IN ('created','pending') ORDER BY created_at ... LIMIT ...` (`L1569`, `L2175-L2179`)
- `status = 'completed' AND recovery_email_sent_at IS NOT NULL AND updated_at >= $1` (`L1491`)

Actualmente existen índices separados (`status`, `recovery_next_attempt_at`, `user_id`) en `L2499-L2501`, pero faltan compuestos orientados a consultas reales.

### Índices sugeridos

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_sessions_status_created_at
ON payment_sessions (status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_sessions_recovery_queue
ON payment_sessions (status, recovery_next_attempt_at, created_at ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_sessions_status_updated_at
ON payment_sessions (status, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_sessions_recovery_email_sent_at
ON payment_sessions (recovery_email_sent_at);
```

## 3.3 Consultas sobre `app_events` con filtros compuestos y payload JSON

Patrones:

- `event_name = ... AND created_at >= $1` (`L1177`, `L1185`, `L1495`, `L1499`)
- actividad reciente por `user_id/customer_id` + `created_at` (`L1850-L1867`)
- agrupación por `payload->>'action'` (`L1185`)

Solo hay índices simples por `created_at` y `event_name` (`L2506-L2507`).

### Índices sugeridos

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_app_events_event_created_at
ON app_events (event_name, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_app_events_user_created_at
ON app_events (user_id, created_at DESC)
WHERE user_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_app_events_customer_created_at
ON app_events (customer_id, created_at DESC)
WHERE customer_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_app_events_generation_action
ON app_events ((payload->>'action'), created_at DESC)
WHERE event_name = 'generation_completed';
```

## 3.4 N+1 en recovery

En `runCheckoutRecoverySweep` (`L2196-L2342`):

- por cada candidato se hacen queries adicionales de hidratación (`L1886-L1893`) y actividad (`L1869`);
- además se ejecutan varios `UPDATE + recordEvent` por iteración.

### Mejora recomendada

- Obtener candidatos ya hidratados en una sola query con `JOIN app_users` + `JOIN user_credits`.
- Resolver actividad reciente en lote (por ejemplo, con una tabla temporal o CTE de candidatos + `EXISTS`).
- Reducir cantidad de transacciones por iteración (agrupar operaciones cuando aplique).

## 3.5 Sobrecosto de transacciones para lecturas simples

`withTransaction` (`L2535-L2547`) se usa también en rutas predominantemente de lectura, lo que agrega `BEGIN/COMMIT` y tiempo de conexión innecesario.

### Mejora recomendada

- Para lecturas simples, usar `pool.query(...)` o helper read-only sin transacción explícita.
- Reservar transacciones para cambios atómicos multisentencia.

---

## 4) Propuestas de caché

## 4.1 Caché de endpoint (TTL corto)

1. **`GET /api/admin/metrics?days=N`**
   - Cache key: `admin:metrics:{days}`
   - TTL sugerido: 30-120s
   - Invalida por tiempo (suficiente para dashboard operativo).

2. **`GET /api/admin/recovery/checkout/stats?days=N`**
   - Cache key: `admin:recovery:stats:{days}`
   - TTL sugerido: 30-60s

3. **`GET /api/pay/plans`**
   - Cache HTTP (`ETag` + `Cache-Control`) por ser semi-estático.

## 4.2 Caché de integración externa (Stripe/OpenAI)

1. **Checkout status (`/api/pay/checkout-status`)**
   - Evitar consultar Stripe en cada request para la misma sesión.
   - Guardar `last_stripe_check_at` y respetar un cooldown (ej. 15-30s).

2. **Reconciliación/recovery**
   - Reusar estado reciente de sesión Stripe dentro de la misma corrida para no duplicar llamadas.

## 4.3 Caché de identidad/autorización

- Para requests con JWT repetitivas: micro-cache en memoria/Redis de `userId -> perfil` (TTL 15-60s) para reducir lecturas de `authOptional` (`L2959-L2961`), especialmente bajo alta concurrencia.

> Nota: en despliegue multi-instancia, preferir Redis sobre caché local para coherencia.

---

## 5) Optimización de manejo de datos

1. **Reducir payload transferido**
   - Evitar `SELECT payload` completo cuando solo se requieren campos (`variant`, `segmentPlan`, `segmentChannel`, `stepNumber`).
   - Extraer y agrupar directamente en SQL.

2. **Batching de eventos**
   - `POST /api/events/track`: considerar cola asíncrona y batch insert para alta tasa de eventos.
   - Beneficio: menor latencia en request y menor presión de escritura.

3. **Paralelismo controlado de I/O externo**
   - En reconciliación, usar concurrencia limitada (ej. 5-10 workers) en lugar de serie estricta.
   - Evita tiempos lineales excesivos.

4. **Retención/particionado de tablas de eventos**
   - `app_events` crecerá rápido; aplicar:
     - retención (por ejemplo, mover histórico viejo),
     - o particionado por fecha para mantener consultas recientes rápidas.

5. **Evitar scans globales en dashboards**
   - Construir tablas de agregados diarios (materialización incremental) para revenue/eventos/funnel.
   - `admin/metrics` consultaría agregados, no tablas crudas.

---

## 6) Plan recomendado (priorizado)

## Fase 1 (quick wins, 1-2 días)

- Añadir índices compuestos de `payment_sessions` y `app_events`.
- Cache TTL corto para `admin/metrics` y `recovery/stats`.
- Cooldown de consulta Stripe en `checkout-status`.

## Fase 2 (1 semana)

- Refactor `runCheckoutRecoverySweep` para eliminar N+1 (JOIN + consulta de actividad en lote).
- Paralelizar `reconcile/payments` con límite de concurrencia.
- Reducir uso de transacciones en lecturas simples.

## Fase 3 (2-4 semanas)

- Pipeline de agregados diarios para métricas.
- Estrategia de retención/particionado de `app_events`.
- Opcional: cola para ingestión de eventos.

---

## 7) Métricas de validación recomendadas

Para verificar mejoras:

- p50/p95/p99 por endpoint (`request.completed.durationMs` ya existe en logs, `L3326-L3333`).
- Tiempo SQL total por request (sumatorio de query timings).
- Cantidad de queries por request (especialmente en recovery/admin).
- Tasa y latencia de llamadas externas (Stripe/OpenAI/SMTP).
- Hit ratio de caché por endpoint.

Objetivo inicial sugerido:

- Reducir p95 de `GET /api/admin/metrics` en 40-70%.
- Reducir tiempo total de `POST /api/admin/reconcile/payments` en 50%+ con concurrencia limitada.
- Reducir lecturas sobre `app_events` en dashboards mediante agregados/caché.
