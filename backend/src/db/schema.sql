-- Reference data (loaded from resource/data/*.csv by seed.ts)

CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  persona_name TEXT, home_region TEXT, background TEXT, shopping_preferences TEXT,
  typical_spending TEXT, budget_style TEXT, travel_pattern TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  account_type TEXT, account_purpose TEXT, base_currency TEXT, status TEXT, opened_on TEXT,
  per_transaction_limit_chf REAL, monthly_limit_chf REAL
);

CREATE TABLE IF NOT EXISTS cards (
  card_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  card_type TEXT, card_purpose TEXT, status TEXT, first_used_on TEXT, expires_on TEXT,
  online_enabled TEXT, international_enabled TEXT, virtual_card TEXT
);

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id TEXT PRIMARY KEY,
  merchant_name TEXT, merchant_category TEXT, merchant_mcc TEXT, merchant_country TEXT,
  merchant_city TEXT, availability TEXT, recurring_capable TEXT
);

CREATE TABLE IF NOT EXISTS items (
  item_id TEXT PRIMARY KEY,
  item_name TEXT, item_category TEXT, item_description TEXT,
  unit_price_min_chf REAL, unit_price_typical_chf REAL, unit_price_max_chf REAL
);

CREATE TABLE IF NOT EXISTS fx_rates (
  from_currency TEXT PRIMARY KEY,
  to_currency TEXT, rate REAL, rate_date TEXT, source TEXT
);

CREATE TABLE IF NOT EXISTS authorization_history (
  authorization_id TEXT PRIMARY KEY,
  customer_id TEXT, account_id TEXT, card_id TEXT, initiator_type TEXT, timestamp TEXT,
  transaction_type TEXT, status TEXT, amount REAL, currency TEXT, billing_amount_chf REAL,
  merchant_id TEXT, merchant_name TEXT, merchant_category TEXT, merchant_mcc TEXT,
  merchant_country TEXT, merchant_city TEXT, channel TEXT, card_present TEXT, recurring TEXT,
  customer_device_id TEXT, description TEXT, related_transaction_id TEXT, account_type TEXT,
  account_purpose TEXT, base_currency TEXT, per_transaction_limit_chf REAL, monthly_limit_chf REAL,
  card_purpose TEXT, card_status TEXT, online_enabled TEXT, international_enabled TEXT,
  virtual_card TEXT, customer_home_region TEXT, customer_budget_style TEXT,
  customer_persona_name TEXT, approved_spend_before_chf REAL,
  approved_merchant_transaction_count_before INTEGER,
  approved_device_transaction_count_before INTEGER, last_approved_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_hist_card_merchant ON authorization_history(card_id, merchant_id);
CREATE INDEX IF NOT EXISTS ix_hist_card_device ON authorization_history(card_id, customer_device_id);

CREATE TABLE IF NOT EXISTS scenario_catalogue (
  scenario_id TEXT PRIMARY KEY,
  scenario_name TEXT, cardholder_instruction TEXT, control_question TEXT, control_theme TEXT,
  event_count INTEGER, short_rationale TEXT
);

CREATE TABLE IF NOT EXISTS scenario_authorities (
  authority_id TEXT PRIMARY KEY,
  customer_id TEXT, card_id TEXT, valid_from TEXT, valid_until TEXT, initial_status TEXT
);

CREATE TABLE IF NOT EXISTS purchase_attempts (
  authorization_id TEXT PRIMARY KEY,
  scenario_id TEXT, replay_order INTEGER, authority_id TEXT, card_id TEXT, merchant_id TEXT,
  timestamp TEXT, amount REAL, currency TEXT, billing_amount_chf REAL, items_subtotal REAL,
  delivery_fee REAL, channel TEXT, customer_device_id TEXT, authority_status TEXT,
  card_status_at_attempt TEXT, spend_in_period_before_chf REAL, recent_attempt_count_10m INTEGER,
  fulfillment_method TEXT, delivery_by TEXT, order_returnable TEXT, order_cancellable TEXT,
  related_authorization_id TEXT, related_authorization_status TEXT, purchase_description TEXT
);

CREATE TABLE IF NOT EXISTS purchase_attempt_items (
  authorization_id TEXT, line_no INTEGER, item_id TEXT, item_name TEXT, item_category TEXT,
  quantity INTEGER, unit_price REAL, currency TEXT, item_details TEXT,
  PRIMARY KEY (authorization_id, line_no)
);

-- Application state

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,               -- local id (LM...), or remote TM... once mirrored
  remote_draft_id TEXT,
  remote_mandate_id TEXT,
  status TEXT NOT NULL,              -- draft | active | revoked
  scenario_id TEXT,
  card_id TEXT,
  instruction TEXT NOT NULL,
  hard_rules TEXT NOT NULL,          -- JSON
  uncertainty_policy TEXT NOT NULL,
  guidance TEXT NOT NULL,            -- JSON
  open_questions TEXT NOT NULL,      -- JSON
  explanations TEXT NOT NULL,        -- JSON, UI-only rule explanations
  audit TEXT NOT NULL,               -- JSON list of {at, action, detail}
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                -- offline | live
  scenario_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  mandate_snapshot TEXT NOT NULL,    -- JSON (event-shaped mandate)
  remote_run_id TEXT,
  status TEXT NOT NULL,              -- running | completed | failed
  created_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  authorization_id TEXT PRIMARY KEY, -- live id (or synthetic offline id)
  run_id TEXT NOT NULL,
  source_authorization_id TEXT,
  replay_order INTEGER,
  sim_timestamp TEXT NOT NULL,
  card_id TEXT,
  merchant_id TEXT,
  merchant_name TEXT,
  customer_device_id TEXT,
  billing_amount_chf REAL NOT NULL,
  item_signature TEXT NOT NULL,      -- sorted item ids, for duplicate detection
  event TEXT NOT NULL,               -- JSON
  engine_decision TEXT NOT NULL,     -- approve | decline | step_up
  status TEXT NOT NULL,              -- approved | declined | pending | expired
  reason_codes TEXT NOT NULL,        -- JSON
  customer_message TEXT NOT NULL,
  checks TEXT NOT NULL,              -- JSON
  evidence TEXT NOT NULL,            -- JSON
  latency_ms REAL,
  remote_submitted INTEGER DEFAULT 0,
  remote_error TEXT,
  human_deadline_at TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_decisions_run ON decisions(run_id, sim_timestamp);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                -- JSON
);

-- One local record per hosted run, whoever sees it first (startRun or the worker).
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_remote ON runs(remote_run_id) WHERE remote_run_id IS NOT NULL;
