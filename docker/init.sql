-- Demo database for pg-auditor-mcp
-- Intentionally omits key secondary indexes so auditing tools can detect
-- sequential scans, slow queries, and missing indexes out of the box.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  succeeded BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed 1,000 users
INSERT INTO users (email, plan, created_at)
SELECT
  'user' || g || '@example.com',
  CASE WHEN g % 5 = 0 THEN 'pro' ELSE 'free' END,
  NOW() - (g || ' minutes')::interval
FROM generate_series(1, 1000) AS g;

-- Seed 20,000 orders (intentionally missing indexes on user_id, status, created_at)
INSERT INTO orders (user_id, status, total_cents, metadata, created_at)
SELECT
  1 + (g % 1000),
  CASE
    WHEN g % 10 = 0 THEN 'pending'
    WHEN g % 7 = 0 THEN 'refunded'
    ELSE 'paid'
  END,
  500 + (g % 25000),
  jsonb_build_object('region', CASE WHEN g % 2 = 0 THEN 'us' ELSE 'latam' END),
  NOW() - ((g % 5000) || ' minutes')::interval
FROM generate_series(1, 20000) AS g;

-- Seed 20,000 transactions (intentionally missing index on order_id, provider)
INSERT INTO transactions (order_id, provider, amount_cents, succeeded, created_at)
SELECT
  1 + (g % 20000),
  CASE WHEN g % 3 = 0 THEN 'stripe' ELSE 'mercadopago' END,
  500 + (g % 25000),
  (g % 20 <> 0),
  NOW() - ((g % 5000) || ' minutes')::interval
FROM generate_series(1, 20000) AS g;

ANALYZE users;
ANALYZE orders;
ANALYZE transactions;

-- Generate realistic sequential scan and pg_stat_statements history
SELECT COUNT(*) FROM orders WHERE status = 'pending';
SELECT SUM(total_cents) FROM orders WHERE user_id = 42 AND status = 'paid';
SELECT COUNT(*) FROM transactions WHERE provider = 'stripe' AND succeeded = false;
