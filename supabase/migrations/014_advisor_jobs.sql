-- ============================================================================
-- Kontur Migration 014: Job-/Run-Historien der Edge Function investment-advisor.
-- Zwei Tabellen, alle Spalten strikt aus den Frontend-Zugriffen abgeleitet.
-- Zugriff ausschließlich über die Edge Function mit Service-Schlüssel
-- (Service-Only-Muster wie 001_base_schema.sql): RLS aktiv, keine Policies,
-- alle Rechte für public/anon/authenticated entzogen.
--
-- W2 (D3, 2026-11-19): advisor_runs an den führenden Live-Stand angeglichen —
-- status CHECK ohne 'queued' mit Default 'running' (Läufe werden direkt als
-- 'running' angelegt), strategy_key Default '' statt 'default', Idempotenz
-- über den partiellen Unique-Index advisor_runs_request_idx statt eines
-- Tabellen-Constraints. advisor_jobs ist unverändert (stimmt mit Live
-- überein).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- advisor_jobs: Betreuungsprotokoll der automatischen Modellbetreuung.
-- Fundstellen (managed-ui.js):
--   wealth-status/wealth-history liefern {jobs}; Zugriffe:
--     j.id, j.status ('completed'|'running'|'failed'), j.created_at,
--     j.finished_at, j.error, j.result.reason, j.result.aiWarning,
--     j.result.snapshot (Modellstand inkl. valueCents/recommendation/universe),
--     j.result.explanation.usage.cost/total_tokens (KI-Kosten-Protokoll),
--     j.result.transactions[] (model-deposit/model-trade), j.result.costAssumption,
--     j.result.coverage.checked/usable
--   Seitengröße 30 (Button „Ältere Ereignisse laden“ ab jobs.length>=30).
-- ----------------------------------------------------------------------------
create table if not exists public.advisor_jobs (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  strategy_key text not null,
  status       text not null default 'queued'
               check (status in ('queued','running','completed','failed')),
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists advisor_jobs_owner_strategy_idx
  on public.advisor_jobs (owner_id, strategy_key, created_at desc);

alter table public.advisor_jobs enable row level security;
revoke all on table public.advisor_jobs from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- advisor_runs: Läufe der KI-Empfehlungen (Portfolioanalyse und Pie-Vorschlag).
-- Fundstellen:
--   features-ui.js paint(): r.id, r.mode ('advisor'|'analysis'), r.created_at,
--     r.status, r.adopted_at, r.error; result(): r.result.model, r.result.asOf,
--     r.result.recommendation, r.result.changes, r.result.market, r.profile.universe
--   advisor-ui.js: r.status==='completed', r.mode==='advisor', r.result?.recommendation,
--     r.result.selection, r.result.coverage, r.result.decision, r.result.asOf,
--     r.finished_at, r.profile (risk/horizonYears/maxWeightBps/selection/universe),
--     r.adopted_at, r.created_at, r.error, r.id
--   plan-ui.js cloudPanel(): run.created_at, run.adopted_at, run.status, run.error,
--     run.result.coverage {total,eligible,checked,usable,brokerMatched},
--     run.result.strategicReview, run.result.decision, run.result.selection,
--     run.profile.goal, run.mode
--   request_id: Idempotenzschlüssel des Frontends (requestId beim 'run'-Aufruf).
-- ----------------------------------------------------------------------------
create table if not exists public.advisor_runs (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  strategy_key text not null default '',
  request_id   text,
  mode         text not null check (mode in ('analysis','advisor')),
  status       text not null default 'running'
               check (status in ('running','completed','failed')),
  profile      jsonb,
  result       jsonb,
  error        text,
  adopted_at   timestamptz,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists advisor_runs_owner_strategy_idx
  on public.advisor_runs (owner_id, strategy_key, created_at desc);

-- Idempotenz über request_id (Live-Stand: partieller Unique-Index statt
-- Tabellen-Constraint; mehrere Läufe ohne request_id bleiben erlaubt).
create unique index if not exists advisor_runs_request_idx
  on public.advisor_runs (owner_id, request_id) where request_id is not null;

alter table public.advisor_runs enable row level security;
revoke all on table public.advisor_runs from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- claim_advisor_profile(): nächstes fälliges Betreuungsmandat atomar sperren.
-- Fundstelle: managed-ui.js Betreuungsstatus (p.enabled, p.next_due) und der
--   Hinweis „erste Prüfung automatisch innerhalb des nächsten Betreuungszyklus
--   (bis zu 15 Minuten)". Der Cron-Endpunkt der Function (action 'dispatch')
--   ruft diese RPC; die Sperre schiebt next_due um 15 Minuten, die Function
--   setzt nach dem Lauf die echte nächste Fälligkeit.
-- Rückgabe: eine advisor_profiles-Zeile als jsonb oder null.
-- ----------------------------------------------------------------------------
create or replace function public.claim_advisor_profile()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare p public.advisor_profiles;
begin
  update public.advisor_profiles
  set next_due = now() + interval '15 minutes',
      updated_at = now()
  where (owner_id, strategy_key) = (
    select owner_id, strategy_key from public.advisor_profiles
    where enabled and next_due is not null and next_due <= now()
    order by next_due asc
    limit 1
    for update skip locked
  )
  returning * into p;
  if not found then
    return null;
  end if;
  return to_jsonb(p);
end;
$function$;

revoke all on function public.claim_advisor_profile() from public, anon, authenticated;
grant execute on function public.claim_advisor_profile() to service_role;
