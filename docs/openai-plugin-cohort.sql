-- Internal read-only analysis only. Never connect the public MCP to a database.
-- Run with psql window_start/window_end variables after verifying live schema.
-- First-touch signup attribution is a cohort, not a causal per-research join.
-- This emits aggregate counts only, never keys, email addresses or internal IDs.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
WITH cohort AS (
  SELECT id, created_at, first_api_call_at,
    CASE WHEN utm_content IN ('crude_refined','natural_gas','futures','marine','drilling')
      THEN utm_content ELSE 'unknown' END AS initial_dataset
  FROM users
  WHERE utm_source = 'openai-plugin' AND utm_campaign = 'energy-markets'
    AND created_at >= :'window_start'::timestamptz
    AND created_at < :'window_end'::timestamptz
    AND NOT COALESCE(admin, false) AND NOT internal_service
    AND lower(email) NOT LIKE '%@oilpriceapi.com'
    AND lower(email) NOT LIKE '%@metirilabs.com'
    AND lower(email) NOT LIKE '%@example.com'
), activation AS (
  SELECT c.*, (SELECT MIN(k.created_at) FROM api_keys k WHERE k.user_id=c.id) AS first_key_created
  FROM cohort c
)
SELECT initial_dataset,
  COUNT(*) AS attributed_signups,
  COUNT(*) FILTER (WHERE first_key_created < :'window_end'::timestamptz) AS signups_with_key,
  COUNT(*) FILTER (WHERE first_api_call_at >= first_key_created
    AND first_api_call_at < :'window_end'::timestamptz) AS recorded_first_api_call_after_key
FROM activation
GROUP BY initial_dataset ORDER BY initial_dataset;
ROLLBACK;
-- Paid conversion and MRR must be reconciled with live Stripe paid invoice
-- receipts/subscriptions for this private cohort. Subscription-created and
-- checkout-completed events do not establish receipt of payment. Do not emit
-- Stripe customer IDs or account email into the plugin analytics stream.
