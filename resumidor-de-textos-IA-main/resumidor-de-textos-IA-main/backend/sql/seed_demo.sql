-- Demo seed for local environments (Postgres).
-- Run manually after backend starts and migrations are created.
-- Example:
--   psql "$DATABASE_URL" -f backend/sql/seed_demo.sql

BEGIN;

INSERT INTO app_users (id, customer_id, email, name, role, provider, created_at, updated_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'cust_demo_admin', 'admin@simplify.local', 'Admin Demo', 'admin', 'email', NOW(), NOW()),
  ('22222222-2222-4222-8222-222222222222', 'cust_demo_user', 'user@simplify.local', 'User Demo', 'user', 'email', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_credits (
  user_id, credits, free_used, free_uses, total_purchased, total_consumed,
  subscription_active, subscription_credits_cycle, stripe_customer_id, stripe_subscription_id, updated_at
)
VALUES
  ('11111111-1111-4111-8111-111111111111', 1000, 0, 3, 1000, 0, true, 250, 'cus_demo_admin', 'sub_demo_admin', NOW()),
  ('22222222-2222-4222-8222-222222222222', 25, 1, 3, 25, 4, false, 250, 'cus_demo_user', NULL, NOW())
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO payment_sessions (
  session_id, user_id, customer_id, plan_id, status, amount_total, currency, credits_granted, granted,
  stripe_customer_id, stripe_subscription_id, created_at, updated_at
)
VALUES
  ('cs_demo_paid_1', '22222222-2222-4222-8222-222222222222', 'cust_demo_user', 'pack', 'completed', 500, 'eur', 10, true, 'cus_demo_user', NULL, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),
  ('cs_demo_paid_2', '11111111-1111-4111-8111-111111111111', 'cust_demo_admin', 'sub', 'completed', 800, 'eur', 250, true, 'cus_demo_admin', 'sub_demo_admin', NOW() - INTERVAL '12 days', NOW() - INTERVAL '12 days')
ON CONFLICT (session_id) DO NOTHING;

INSERT INTO app_events (event_name, user_id, customer_id, payload, created_at)
VALUES
  ('generation_completed', '22222222-2222-4222-8222-222222222222', 'cust_demo_user', '{"action":"summary","mode":"remote","engine":"remote"}'::jsonb, NOW() - INTERVAL '2 days'),
  ('result_copied', '22222222-2222-4222-8222-222222222222', 'cust_demo_user', '{"action":"summary"}'::jsonb, NOW() - INTERVAL '2 days'),
  ('checkout_started', '22222222-2222-4222-8222-222222222222', 'cust_demo_user', '{"plan":"pack"}'::jsonb, NOW() - INTERVAL '5 days'),
  ('checkout_success_return', '22222222-2222-4222-8222-222222222222', 'cust_demo_user', '{"plan":"pack"}'::jsonb, NOW() - INTERVAL '5 days'),
  ('auth_email_verified', '11111111-1111-4111-8111-111111111111', 'cust_demo_admin', '{"provider":"email"}'::jsonb, NOW() - INTERVAL '12 days')
ON CONFLICT DO NOTHING;

COMMIT;
