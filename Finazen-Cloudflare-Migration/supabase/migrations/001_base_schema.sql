-- ============================================================================
-- Kontur Basisschema (rekonstruiert, ersetzt die verlorenen Migrationen 001-011)
-- Tabellen, Constraints, Indizes und Row Level Security.
-- Rekonstruiert aus: supabase/functions/kontur-services.ts (Edge-Bundle),
-- cloud.js, integrations-ui.js, managed-ui.js, advisor-ui.js, app.js
-- sowie den Voraussetzungen der Migration 012_v12_1.sql.
-- Jede Tabelle ist mit ihrer Fundstelle kommentiert.
-- Migration 002_base_functions.sql legt die RPC-Funktionen an.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- finance_plans: persönlicher Finanzplan (ein Datensatz pro Konto).
-- Fundstellen:
--   cloud.js load():  GET /rest/v1/finance_plans?select=data,revision,updated_at&owner_id=eq.<uid>
--   cloud.js save():  RPC save_finance_plan (siehe 002), app.js sync() nutzt result.revision
--   012_v12_1.sql save_v12_binding: finance_plans f mit f.owner_id und f.data->'strategies'/'entries'
--   kontur-services.ts: own('finance_plans','select=data') im deep- und writePie-Pfad
-- ----------------------------------------------------------------------------
create table if not exists public.finance_plans (
  owner_id   uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  revision   integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.finance_plans enable row level security;

-- Das Frontend liest den eigenen Plan direkt via PostgREST (cloud.js load(),
-- angemeldet mit anon-Key + User-JWT). Schreibzugriffe laufen ausschließlich
-- über die RPC save_finance_plan (security definer, Revisionsprüfung).
revoke all on table public.finance_plans from public, anon;
grant select on table public.finance_plans to authenticated;

drop policy if exists finance_plans_select_own on public.finance_plans;
create policy finance_plans_select_own on public.finance_plans
  for select to authenticated
  using (owner_id = auth.uid());

-- ----------------------------------------------------------------------------
-- v12_preferences: Kontoeinstellungen der Kontur-Dienste.
-- Fundstellen:
--   kontur-services.ts work(): prefs?.broker_enabled (broker-account/-positions/-pies/-instruments)
--   kontur-services.ts test-ai: upsert {owner_id, connection} / enable-broker: {owner_id, broker_enabled}
--   012_v12_1.sql: ergänzt market_data_mode und broker_capabilities (hier bewusst noch NICHT enthalten)
-- ----------------------------------------------------------------------------
create table if not exists public.v12_preferences (
  owner_id       uuid primary key references auth.users(id) on delete cascade,
  broker_enabled boolean not null default false,
  connection     jsonb
);

alter table public.v12_preferences enable row level security;
revoke all on table public.v12_preferences from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- v12_broker_state: letzter bestätigter Trading212-Kontostand (ein Datensatz pro Konto).
-- Fundstellen:
--   kontur-services.ts mergeSnapshot(): upsert {owner_id, snapshot, updated_at} on_conflict=owner_id
--   kontur-services.ts screen(): (await db(own('v12_broker_state')))[0]?.snapshot?.positions
-- ----------------------------------------------------------------------------
create table if not exists public.v12_broker_state (
  owner_id   uuid primary key references auth.users(id) on delete cascade,
  snapshot   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.v12_broker_state enable row level security;
revoke all on table public.v12_broker_state from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- v12_broker_pies: aus Trading212 eingelesene Pies (Stand VOR Migration 012).
-- Fundstellen:
--   012_v12_1.sql: "alter column details drop not null" => details war zuvor NOT NULL;
--                  "detail_read_at=coalesce(detail_read_at, updated_at)" => updated_at existierte;
--                  summary/detail_status/detail_read_at/paused_at kommen erst mit 012 dazu.
--   kontur-services.ts: upsert on_conflict=owner_id,pie_id; Verknüpfung über pie_id (bigint, 012: pie bigint)
-- ----------------------------------------------------------------------------
create table if not exists public.v12_broker_pies (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  pie_id     bigint not null,
  details    jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, pie_id)
);

alter table public.v12_broker_pies enable row level security;
revoke all on table public.v12_broker_pies from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- v12_pie_bindings: Zuordnung Pie -> Advisor-Strategie / Wikifolio-Spiegelung / Manuell.
-- Fundstellen:
--   012_v12_1.sql save_v12_binding: INSERT (owner_id,pie_id,controller,strategy_id,plan_entry_id,
--     source_symbol,enabled,status,expected_hash) ON CONFLICT(owner_id,pie_id) DO UPDATE ...
--     pending_hash=null, pending_shares=null, last_error=null, updated_at=now();
--     b.write_until>now() => Fehler PIE_BUSY
--   kontur-services.ts writePie/pie-read: pending_hash, pending_shares, expected_hash, write_lease,
--     status in ('active','writing','paused','conflict'), last_error {code:'PIE_ABSENT'|'PIE_CONFLICT'}
--   integrations-ui.js label(): active/paused/writing/conflict; controllerLabel: advisor/mirror/manual
-- ----------------------------------------------------------------------------
create table if not exists public.v12_pie_bindings (
  owner_id      uuid not null references auth.users(id) on delete cascade,
  pie_id        bigint not null,
  controller    text not null default 'manual'
                check (controller in ('advisor','mirror','manual')),
  strategy_id   text,
  plan_entry_id text,
  source_symbol text,
  enabled       boolean not null default false,
  status        text not null default 'paused'
                check (status in ('active','paused','writing','conflict')),
  expected_hash text,
  pending_hash  text,
  pending_shares jsonb,
  write_lease   uuid,
  write_until   timestamptz,
  last_error    jsonb,
  updated_at    timestamptz not null default now(),
  primary key (owner_id, pie_id)
);

alter table public.v12_pie_bindings enable row level security;
revoke all on table public.v12_pie_bindings from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- v12_mirror_sources: Wikifolio-Spiegelquellen.
-- Fundstellen:
--   kontur-services.ts: upsert on_conflict=owner_id,symbol {owner_id,symbol,name};
--     sourceProbe PATCH {status:'verified',snapshot,fetched_at,verified_at,error:null};
--     Fehlerpfad PATCH {status:'error',error:diagnostics(e)}; delete-source DELETE
--   integrations-ui.js sourceCard: s.name, s.symbol, s.status, s.snapshot, s.fetched_at, s.error;
--     label(): unverified/verified/error
--   Hinweis: fetched_at wird erst mit 012_v12_1.sql ergänzt (hier bewusst noch NICHT enthalten).
-- ----------------------------------------------------------------------------
create table if not exists public.v12_mirror_sources (
  owner_id    uuid not null references auth.users(id) on delete cascade,
  symbol      text not null,
  name        text not null,
  status      text not null default 'unverified'
              check (status in ('unverified','verified','error')),
  snapshot    jsonb,
  verified_at timestamptz,
  error       jsonb,
  primary key (owner_id, symbol)
);

alter table public.v12_mirror_sources enable row level security;
revoke all on table public.v12_mirror_sources from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- v12_tasks: serverseitige Aufgabenwarteschlange (Cron-Dispatch der Edge Function).
-- Fundstellen:
--   kontur-services.ts: claim_v12_task/finish_v12_task/enqueue_v12_task (RPCs, siehe 002);
--     task.id, task.owner_id, task.kind, task.task_key, task.payload, task.priority, task.lease;
--     status in.(queued,running,blocked) / PATCH status='cancelled';
--     status-Filter 'pie-write' + payload->>'pieId' (012_v12_1.sql save_v12_binding)
--   integrations-ui.js label(): queued/running/blocked/done (+cancelled aus enable-broker-Pfad)
--   kind-Werte VOR 012 (work() im Bundle): broker, broker-account, broker-positions,
--     broker-pies, broker-instruments, pie-read, market-index, market-screen, market-deep, mirror.
--     012_v12_1.sql ersetzt diesen CHECK und ergänzt 'pie-write'.
-- ----------------------------------------------------------------------------
create table if not exists public.v12_tasks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  kind        text not null,
  task_key    text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  priority    integer not null default 0,
  status      text not null default 'queued'
              check (status in ('queued','running','blocked','cancelled','done')),
  next_due    timestamptz not null default now(),
  lease       uuid,
  last_error  jsonb,
  last_result jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner_id, kind, task_key)
);

alter table public.v12_tasks
  add constraint v12_tasks_kind_check check (kind = any (array[
    'broker','broker-account','broker-positions','broker-pies','broker-instruments',
    'pie-read','market-index','market-screen','market-deep','mirror'
  ]));

-- Dispatch: fällige Aufgaben nach Priorität (claim_v12_task, siehe 002)
create index if not exists v12_tasks_due_idx on public.v12_tasks (status, next_due, priority desc);

alter table public.v12_tasks enable row level security;
revoke all on table public.v12_tasks from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- v12_instruments: Aktienuniversum aus dem Trading212-Katalog mit Bewertungsstand.
-- Fundstellen:
--   kontur-services.ts marketService index(): upsert on_conflict=owner_id,isin mit
--     {isin,name,listings,provider_ticker,provider_market,status,reason,owner_id,cycle_id,active};
--     PATCH active=false fuer cycle_id <> aktueller Zyklus
--   kontur-services.ts screen(): PATCH {facts,sector,status:'incomplete',score,reason,as_of,updated_at};
--     status-Werte im UI-Filter (research): mapped/analysed/incomplete/unmapped/stale
--   kontur-services.ts deep(): PATCH {deep_analysis}
--   integrations-ui.js research: select=isin,name,status,reason,provider_ticker,sector,score,as_of,deep_analysis
-- ----------------------------------------------------------------------------
create table if not exists public.v12_instruments (
  owner_id        uuid not null references auth.users(id) on delete cascade,
  isin            text not null,
  name            text,
  listings        jsonb,
  provider_ticker text,
  provider_market text,
  status          text not null default 'unmapped'
                  check (status in ('mapped','unmapped','incomplete','analysed','stale')),
  reason          text,
  facts           jsonb,
  score           jsonb,
  deep_analysis   jsonb,
  sector          text,
  as_of           date,
  cycle_id        uuid,
  active          boolean not null default true,
  updated_at      timestamptz not null default now(),
  primary key (owner_id, isin)
);

create index if not exists v12_instruments_active_idx
  on public.v12_instruments (owner_id, active, status);

alter table public.v12_instruments enable row level security;
revoke all on table public.v12_instruments from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- v12_broker_days: taegliche Depot-Tagesstaende (EUR).
-- Fundstellen:
--   kontur-services.ts syncAccount(): upsert on_conflict=owner_id,date
--     {owner_id, date, value_cents} wenn summary.currency='EUR'
-- ----------------------------------------------------------------------------
create table if not exists public.v12_broker_days (
  owner_id    uuid not null references auth.users(id) on delete cascade,
  date        date not null,
  value_cents bigint not null,
  primary key (owner_id, date)
);

alter table public.v12_broker_days enable row level security;
revoke all on table public.v12_broker_days from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- v12_cost_events: Kostenreservierung und -abrechnung (OpenRouter / Financial Datasets).
-- Fundstellen:
--   kontur-services.ts billing.js: reserve_v12_cost {p_owner,p_id,p_bucket,p_micros,p_meta};
--     settle_v12_cost {p_owner,p_id,p_micros,p_state,p_response_id} mit
--     p_state in ('released','uncertain','settled'); bucket in ('ai','data')
--   kontur-services.ts openrouter.js Audit-PATCH: v12_cost_events?id=eq.&owner_id=eq. {meta:{...}}
-- ----------------------------------------------------------------------------
create table if not exists public.v12_cost_events (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  bucket      text not null check (bucket in ('ai','data')),
  state       text not null default 'reserved'
              check (state in ('reserved','settled','released','uncertain')),
  micros      bigint not null default 0,
  meta        jsonb not null default '{}'::jsonb,
  response_id text,
  created_at  timestamptz not null default now()
);

create index if not exists v12_cost_events_month_idx
  on public.v12_cost_events (owner_id, created_at);

alter table public.v12_cost_events enable row level security;
revoke all on table public.v12_cost_events from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- wealth_cache: serverseitiger Zwischenspeicher (Instrumentenkatalog, SEC-Verzeichnis,
-- Rate-Limit-Zeitstempel der Broker-Abrufe).
-- Fundstellen:
--   kontur-services.ts: upsert on_conflict=owner_id,cache_key
--     {owner_id,cache_key,payload,expires_at,retrieved_at}
--     cache_key in ('trading212-instruments','sec-company-tickers');
--     claim_v12_broker_rate (002) nutzt cache_key 'broker-rate:<endpoint>'
-- ----------------------------------------------------------------------------
create table if not exists public.wealth_cache (
  owner_id     uuid not null references auth.users(id) on delete cascade,
  cache_key    text not null,
  payload      jsonb,
  expires_at   timestamptz,
  retrieved_at timestamptz,
  primary key (owner_id, cache_key)
);

alter table public.wealth_cache enable row level security;
revoke all on table public.wealth_cache from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- wealth_models: bestaetigtes Modellportfolio je Anlagestrategie.
-- Fundstellen:
--   kontur-services.ts writePie/preview-pie: own('wealth_models','strategy_key=eq.<id>'),
--     models[0]?.model mit model.marketAsOf, model.recommendation, model.universe, model.market
--   managed-ui.js: data?.model?.model (Modell-JSON mit model.benchmark, model.marketAsOf)
-- ----------------------------------------------------------------------------
create table if not exists public.wealth_models (
  owner_id     uuid not null references auth.users(id) on delete cascade,
  strategy_key text not null,
  model        jsonb,
  updated_at   timestamptz not null default now(),
  primary key (owner_id, strategy_key)
);

alter table public.wealth_models enable row level security;
revoke all on table public.wealth_models from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- advisor_profiles: bestaetigtes Anlageprofil (Mandat) je Anlagestrategie.
-- Fundstellen:
--   kontur-services.ts writePie/preview-pie: own('advisor_profiles','strategy_key=eq.<id>'),
--     profiles[0]?.profile (Mandat mit enabled, approach, ...)
--   kontur-services.ts test-ai: PATCH advisor_profiles setup_error=not.is.null
--     {setup_error:null, next_due:now()}
--   managed-ui.js: p?.profile, p?.enabled, p?.next_due, p?.setup_error
-- ----------------------------------------------------------------------------
create table if not exists public.advisor_profiles (
  owner_id     uuid not null references auth.users(id) on delete cascade,
  strategy_key text not null,
  profile      jsonb,
  enabled      boolean not null default false,
  next_due     timestamptz,
  setup_error  jsonb,
  updated_at   timestamptz not null default now(),
  primary key (owner_id, strategy_key)
);

alter table public.advisor_profiles enable row level security;
revoke all on table public.advisor_profiles from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Hinweis: public.v12_wikifolio_sessions wird von 012_v12_1.sql selbst angelegt
-- (create table if not exists ... enable row level security ... revoke all),
-- gehoert also bewusst NICHT in dieses Basisschema.
-- ----------------------------------------------------------------------------
