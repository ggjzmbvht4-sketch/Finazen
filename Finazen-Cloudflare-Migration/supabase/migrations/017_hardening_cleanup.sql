-- ============================================================================
-- 017_hardening_cleanup.sql — Härtung und Aufräumarbeiten (Verbesserungsplan
-- Runde 1). Alle Schritte sind idempotent bzw. guarded.
--
-- K1 (D1/S5): finance_plans — authenticated hat nur noch SELECT
--             (Vollrechte inkl. TRUNCATE wurden entzogen; RLS deckt TRUNCATE
--             nicht ab; Schreibzugriffe laufen ausschließlich über die Edge
--             Functions mit service_role).
-- W1 (B2/D2/R8): Task-Reaper — hängengebliebene Läufe zurücksetzen
-- W2 (D3):     advisor_runs Live↔Repo-Drift: Live ist führend (status CHECK
--              ohne 'queued', Default 'running', strategy_key Default '');
--              die Repo-Datei 014_advisor_jobs.sql wurde daran angeglichen.
--              Diese Migration ändert advisor_runs NICHT, sie dokumentiert
--              den Stand nur.
-- W3 (D4):     Migrationshistorie-Eintrag für 015_cron_jobs
-- W4 (D5):     reserve_v12_cost — TOCTOU über Transaktions-Advisory-Lock
-- W5 (D6):     Retention-Cron (Löschfristen)
-- D7:          doppelte Indizes entfernen, Fälligkeitsindex für den
--              Advisor-Dispatch anlegen
-- ============================================================================

-- ----------------------------------------------------------------------------
-- K1: Grants finance_plans härten
-- ----------------------------------------------------------------------------
revoke all on table public.finance_plans from authenticated;
grant select on table public.finance_plans to authenticated;

-- ----------------------------------------------------------------------------
-- W1: Task-Reaper (pg_cron, alle 10 Minuten)
-- v12_tasks:   running > 20 min -> zurück auf queued (Lease freigeben)
-- advisor_jobs: running > 30 min -> failed mit Timeout-Vermerk
-- ----------------------------------------------------------------------------
do $guard$
begin
  perform cron.unschedule('kontur-task-reaper');
exception when others then
  null;
end
$guard$;

select cron.schedule('kontur-task-reaper', '*/10 * * * *', $job$
  update public.v12_tasks
  set status = 'queued', lease = null, next_due = now(), updated_at = now()
  where status = 'running' and updated_at < now() - interval '20 minutes';

  update public.advisor_jobs
  set status = 'failed', finished_at = now(), error = 'Lauf abgebrochen (Timeout)'
  where status = 'running' and created_at < now() - interval '30 minutes';
$job$);

-- ----------------------------------------------------------------------------
-- W2: Dokumentation des advisor_runs Live-Standes (kein Schema-Eingriff).
-- Live-Stand (führend, verifiziert 2026-11-19):
--   status       text not null default 'running'
--                check (status in ('running','completed','failed'))
--   strategy_key text not null default ''
--   Idempotenz über unique index advisor_runs_request_idx
--                on (owner_id, request_id) where request_id is not null
-- ----------------------------------------------------------------------------
comment on table public.advisor_runs is
  'Läufe der KI-Empfehlungen. Live-Schema weicht von der ursprünglichen Migration 014 ab (status ohne queued, Default running, strategy_key Default leer, partiale Unique-Idempotenz auf request_id); Repo-Datei 014_advisor_jobs.sql wurde daran angeglichen (W2).';

-- ----------------------------------------------------------------------------
-- W3: fehlenden Historieneintrag für 015_cron_jobs setzen
-- ----------------------------------------------------------------------------
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('015', '015_cron_jobs', null)
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- W4: reserve_v12_cost — TOCTOU schließen. Der Live-Body (pg_proc) wird
-- unverändert übernommen; einzige Änderung: transaktionsgebundener Advisory
-- Lock je Owner am Funktionsanfang, damit parallele Reservierungen
-- desselben Kontos die Budgetprüfung nicht gleichzeitig lesen.
-- ----------------------------------------------------------------------------
create or replace function public.reserve_v12_cost(p_owner uuid, p_id uuid, p_bucket text, p_micros bigint, p_meta jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  c_total_limit constant bigint := 30000000; -- 30 EUR in Mikroeinheiten (integrations-ui.js)
  c_ai_limit    constant bigint := 5000000;  --  5 EUR OpenRouter
  c_data_limit  constant bigint := 25000000; -- 25 EUR Marktdaten
  used_total bigint;
  used_bucket bigint;
begin
  -- W4 (D5): TOCTOU — Budgetlesen und Reservieren je Owner serialisieren.
  perform pg_advisory_xact_lock(hashtext(p_owner::text));
  if p_bucket not in ('ai', 'data') then
    raise exception 'BUDGET_BUCKET: Unbekannte Kostenstelle %.', p_bucket;
  end if;
  select coalesce(sum(e.micros) filter (where e.state in ('reserved','uncertain','settled')), 0),
         coalesce(sum(e.micros) filter (where e.state in ('reserved','uncertain','settled') and e.bucket = p_bucket), 0)
  into used_total, used_bucket
  from public.v12_cost_events e
  where e.owner_id = p_owner and e.created_at >= date_trunc('month', now());
  if used_total + coalesce(p_micros, 0) > c_total_limit then
    raise exception 'BUDGET_LIMIT: Das Monatsbudget von 30 Euro ist erreicht. Der nächste Monat setzt das Budget zurück.';
  end if;
  if p_bucket = 'ai' and used_bucket + coalesce(p_micros, 0) > c_ai_limit then
    raise exception 'BUDGET_LIMIT: Das monatliche KI-Budget von 5 Euro ist erreicht.';
  end if;
  if p_bucket = 'data' and used_bucket + coalesce(p_micros, 0) > c_data_limit then
    raise exception 'BUDGET_LIMIT: Das monatliche Marktdatenbudget von 25 Euro ist erreicht.';
  end if;
  insert into public.v12_cost_events (id, owner_id, bucket, state, micros, meta)
  values (p_id, p_owner, p_bucket, 'reserved', greatest(coalesce(p_micros, 0), 0), coalesce(p_meta, '{}'::jsonb));
  return jsonb_build_object('id', p_id, 'state', 'reserved', 'micros', greatest(coalesce(p_micros, 0), 0));
end;
$function$;

-- ----------------------------------------------------------------------------
-- W5: Retention-Cron (täglich 03:17)
--   advisor_runs     älter 12 Monate
--   advisor_jobs     älter 24 Monate, nur abgeschlossene/fehlgeschlagene
--   v12_cost_events  älter 13 Monate (Abrechnungsjahreswechsel + Monat)
--   wealth_cache     abgelaufene Einträge
-- ----------------------------------------------------------------------------
do $guard$
begin
  perform cron.unschedule('kontur-retention');
exception when others then
  null;
end
$guard$;

select cron.schedule('kontur-retention', '17 3 * * *', $job$
  delete from public.advisor_runs where created_at < now() - interval '12 months';
  delete from public.advisor_jobs where created_at < now() - interval '24 months' and status in ('completed','failed');
  delete from public.v12_cost_events where created_at < now() - interval '13 months';
  delete from public.wealth_cache where expires_at < now();
$job$);

-- ----------------------------------------------------------------------------
-- D7: doppelte Indizes entfernen, Fälligkeitsindex für den Advisor-Dispatch
-- ----------------------------------------------------------------------------
drop index if exists public.advisor_jobs_strategy_idx;
drop index if exists public.advisor_runs_strategy_idx;
create index if not exists advisor_profiles_due_idx
  on public.advisor_profiles (next_due) where enabled;
