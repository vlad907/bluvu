-- Payments through Paddle (phase 4): subscriptions create and renew licenses; emails go through an outbox.

ALTER TABLE customers ADD COLUMN paddle_customer_id TEXT;     -- ctm_...
CREATE UNIQUE INDEX customers_paddle ON customers (paddle_customer_id) WHERE paddle_customer_id IS NOT NULL;

-- One license per subscription (two webhooks racing can't make two).
CREATE UNIQUE INDEX licenses_subscription ON licenses (subscription_id) WHERE subscription_id IS NOT NULL;
ALTER TABLE licenses ADD COLUMN checkout_txn TEXT;           -- the checkout's transaction (txn_...), for the success page
ALTER TABLE licenses ADD COLUMN billing_status TEXT NOT NULL DEFAULT '';  -- active | canceling | past_due | paused | canceled
ALTER TABLE licenses ADD COLUMN paddle_at INTEGER NOT NULL DEFAULT 0;     -- occurred_at of the last subscription event applied
CREATE INDEX licenses_checkout ON licenses (checkout_txn);

-- Each Paddle event once (Paddle retries, and may deliver twice).
CREATE TABLE paddle_events (
  id TEXT PRIMARY KEY,                -- evt_...
  type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

-- Paddle's customers as its webhooks describe them (they can arrive after the subscription).
CREATE TABLE paddle_customers (
  id TEXT PRIMARY KEY,                -- ctm_...
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- Every email the server sends (or would have sent with no email service set up).
CREATE TABLE emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT,
  to_addr TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- key | billing-link | upgrade-link
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,                    -- NULL = not sent (see error)
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX emails_license ON emails (license_id, created_at);
