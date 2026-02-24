-- Dashboard SQL snippets for BI / analytics.
-- Usage:
--   psql "$DATABASE_URL" -f backend/sql/dashboard_queries.sql

-- 1) Core KPIs
SELECT
  (SELECT COUNT(*) FROM app_users) AS total_users,
  (SELECT COUNT(*) FROM app_users WHERE provider <> 'anonymous' OR email IS NOT NULL OR google_sub IS NOT NULL) AS authenticated_users,
  (SELECT COUNT(*) FROM user_credits WHERE total_purchased > 0) AS paying_users,
  (SELECT COUNT(*) FROM user_credits WHERE subscription_active = true) AS active_subscriptions,
  (SELECT COALESCE(SUM(amount_total), 0) FROM payment_sessions WHERE status = 'completed') AS revenue_cents,
  (SELECT COALESCE(SUM(credits), 0) FROM user_credits) AS credits_remaining;

-- 2) Daily revenue (last 90 days)
SELECT
  TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS day,
  COUNT(*) AS completed_payments,
  COALESCE(SUM(amount_total), 0)::bigint AS revenue_cents
FROM payment_sessions
WHERE status = 'completed'
  AND created_at >= NOW() - INTERVAL '90 days'
GROUP BY day
ORDER BY day ASC;

-- 3) Funnel events (last 30 days)
SELECT
  event_name,
  COUNT(*)::int AS total
FROM app_events
WHERE created_at >= NOW() - INTERVAL '30 days'
  AND event_name IN (
    'generation_completed',
    'result_copied',
    'checkout_started',
    'checkout_success_return',
    'checkout_failed'
  )
GROUP BY event_name
ORDER BY total DESC;

-- 4) Top actions generated (last 30 days)
SELECT
  COALESCE(payload->>'action', 'unknown') AS action,
  COUNT(*)::int AS total
FROM app_events
WHERE event_name = 'generation_completed'
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY action
ORDER BY total DESC
LIMIT 15;

-- 5) Cohort by auth provider
SELECT
  provider,
  COUNT(*)::int AS users
FROM app_users
GROUP BY provider
ORDER BY users DESC;
