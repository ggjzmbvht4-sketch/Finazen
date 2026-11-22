CREATE TABLE auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  email_confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE auth_sessions (
  access_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_refresh_idx ON auth_sessions(refresh_hash, refresh_expires_at);

CREATE TABLE auth_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('confirmation','recovery')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX auth_verification_lookup_idx ON auth_verification_tokens(token_hash, kind, used_at, expires_at);

CREATE TABLE finance_plans (
  owner_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE v12_preferences (
  owner_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  broker_enabled INTEGER NOT NULL DEFAULT 0 CHECK(broker_enabled IN (0,1)),
  connection TEXT,
  market_data_mode TEXT NOT NULL DEFAULT 'free_only' CHECK(market_data_mode IN ('free_only','free_then_paid')),
  broker_capabilities TEXT NOT NULL DEFAULT '{"piesWrite":{"state":"unchecked","scope":"pies:write","message":"pies:write ist noch nicht geprüft. Ein zerstörungsfreier Test ist nicht verfügbar."}}',
  sync_interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK(sync_interval_minutes IN (5,10,15,60,1440))
);

CREATE TABLE v12_broker_state (
  owner_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE v12_broker_pies (
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  pie_id INTEGER NOT NULL,
  details TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  summary TEXT,
  detail_status TEXT NOT NULL DEFAULT 'pending' CHECK(detail_status IN ('pending','loaded','missing_scope','error','paused')),
  detail_read_at TEXT,
  paused_at TEXT,
  PRIMARY KEY(owner_id,pie_id)
);

CREATE TABLE v12_pie_bindings (
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  pie_id INTEGER NOT NULL,
  controller TEXT NOT NULL DEFAULT 'manual' CHECK(controller IN ('advisor','mirror','manual')),
  strategy_id TEXT,
  plan_entry_id TEXT,
  source_symbol TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  status TEXT NOT NULL DEFAULT 'paused' CHECK(status IN ('active','paused','writing','conflict')),
  expected_hash TEXT,
  pending_hash TEXT,
  pending_shares TEXT,
  write_lease TEXT,
  write_until TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_id,pie_id)
);

CREATE TABLE v12_mirror_sources (
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','verified','error')),
  snapshot TEXT,
  verified_at TEXT,
  error TEXT,
  fetched_at TEXT,
  PRIMARY KEY(owner_id,symbol)
);

CREATE TABLE v12_tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('broker','broker-account','broker-positions','broker-pies','broker-instruments','pie-read','market-index','market-screen','market-deep','mirror','pie-write')),
  task_key TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','blocked','cancelled','done')),
  next_due TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  lease TEXT,
  last_error TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_id,kind,task_key)
);
CREATE INDEX v12_tasks_due_idx ON v12_tasks(status,next_due,priority DESC);

CREATE TABLE v12_instruments (
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  isin TEXT NOT NULL,
  name TEXT,
  listings TEXT,
  provider_ticker TEXT,
  provider_market TEXT,
  status TEXT NOT NULL DEFAULT 'unmapped' CHECK(status IN ('mapped','unmapped','incomplete','analysed','stale')),
  reason TEXT,
  facts TEXT,
  score TEXT,
  deep_analysis TEXT,
  sector TEXT,
  as_of TEXT,
  cycle_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_id,isin)
);
CREATE INDEX v12_instruments_active_idx ON v12_instruments(owner_id,active,status);

CREATE TABLE v12_broker_days (
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value_cents INTEGER NOT NULL,
  PRIMARY KEY(owner_id,date)
);

CREATE TABLE v12_cost_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL CHECK(bucket IN ('ai','data')),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released','uncertain')),
  micros INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  response_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX v12_cost_events_month_idx ON v12_cost_events(owner_id,created_at);

CREATE TABLE wealth_cache (
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  payload TEXT,
  expires_at TEXT,
  retrieved_at TEXT,
  PRIMARY KEY(owner_id,cache_key)
);

CREATE TABLE wealth_models (
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  strategy_key TEXT NOT NULL,
  model TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_id,strategy_key)
);

CREATE TABLE advisor_profiles (
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  strategy_key TEXT NOT NULL,
  profile TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  next_due TEXT,
  setup_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_id,strategy_key)
);
CREATE INDEX advisor_profiles_due_idx ON advisor_profiles(next_due) WHERE enabled=1;

CREATE TABLE v12_wikifolio_sessions (
  owner_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE advisor_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  strategy_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX advisor_jobs_owner_strategy_idx ON advisor_jobs(owner_id,strategy_key,created_at DESC);

CREATE TABLE advisor_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  strategy_key TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('analysis','advisor')),
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
  profile TEXT,
  result TEXT,
  error TEXT,
  adopted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX advisor_runs_owner_strategy_idx ON advisor_runs(owner_id,strategy_key,created_at DESC);
CREATE UNIQUE INDEX advisor_runs_request_idx ON advisor_runs(owner_id,request_id) WHERE request_id IS NOT NULL;

CREATE TABLE v12_integration_secrets (
  owner_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE report_documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  report_date TEXT,
  category TEXT NOT NULL DEFAULT 'report' CHECK(category IN ('report','financial','contract','other')),
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('pending','ready','error')),
  storage_key TEXT NOT NULL UNIQUE,
  extracted_text TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_id,asset_id,sha256)
);
CREATE INDEX report_documents_owner_idx ON report_documents(owner_id,created_at DESC);

CREATE TABLE report_analyses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  request_id TEXT,
  asset_id TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  basis_hash TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
  result TEXT,
  basis TEXT,
  error TEXT,
  model TEXT,
  document_ids TEXT NOT NULL DEFAULT '[]',
  adopted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  UNIQUE(owner_id,request_id)
);
CREATE INDEX report_analyses_owner_idx ON report_analyses(owner_id,created_at DESC);
