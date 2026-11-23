-- Bluvu license server: customers, licenses, the machines they're activated on, trials, an audit log.
-- Times are unix seconds (UTC).

CREATE TABLE customers (
  id TEXT PRIMARY KEY,                -- cus_...
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',      -- the business
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX customers_email ON customers (lower(email));

CREATE TABLE licenses (
  id TEXT PRIMARY KEY,                -- lic_...
  key TEXT NOT NULL UNIQUE,           -- BLUVU-XXXXX-XXXXX-XXXXX-XXXXX, what the customer types
  customer_id TEXT NOT NULL REFERENCES customers (id),
  plan TEXT NOT NULL,                 -- starter | venue | enterprise | comp | trial
  max_screens INTEGER NOT NULL,       -- -1 = unlimited
  features TEXT NOT NULL DEFAULT '[]',-- JSON array: multiCanvas, audio, capture
  expires INTEGER,                    -- NULL = never (comp)
  grace_days INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  trial INTEGER NOT NULL DEFAULT 0,
  subscription_id TEXT,               -- the payment provider's subscription (phase 4)
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX licenses_customer ON licenses (customer_id);

-- A license is active on one machine at a time; released rows are the move history.
CREATE TABLE machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT NOT NULL REFERENCES licenses (id),
  machine_guid TEXT NOT NULL DEFAULT '',  -- hashes, as the engine sends them
  smbios_uuid TEXT NOT NULL DEFAULT '',
  system_disk TEXT NOT NULL DEFAULT '',
  activated_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  released_at INTEGER,                    -- NULL = the active one
  engine TEXT NOT NULL DEFAULT ''
);
CREATE INDEX machines_license ON machines (license_id);

-- One trial per machine (matched like a license: any 2 of 3 identifiers).
CREATE TABLE trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT NOT NULL REFERENCES licenses (id),
  machine_guid TEXT NOT NULL DEFAULT '',
  smbios_uuid TEXT NOT NULL DEFAULT '',
  system_disk TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT,
  kind TEXT NOT NULL,                 -- created | activated | refreshed | moved | released | revoked | ...
  detail TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',     -- engine | admin:<email> | webhook | website
  at INTEGER NOT NULL
);
CREATE INDEX events_license ON events (license_id, at);
