-- Kontur V12.1: pie status, broker capabilities, free market data, encrypted Wikifolio sessions.
-- Existing rows are kept. No delete functions are executed.

alter table public.v12_preferences
  add column if not exists market_data_mode text not null default 'free_only',
  add column if not exists broker_capabilities jsonb not null default jsonb_build_object(
    'piesWrite', jsonb_build_object(
      'state','unchecked',
      'scope','pies:write',
      'message','pies:write ist noch nicht geprüft. Ein zerstörungsfreier Test ist nicht verfügbar.'
    )
  );

alter table public.v12_preferences drop constraint if exists v12_preferences_market_mode_check;
alter table public.v12_preferences
  add constraint v12_preferences_market_mode_check check (market_data_mode in ('free_only','free_then_paid'));

alter table public.v12_broker_pies alter column details drop not null;
alter table public.v12_broker_pies
  add column if not exists summary jsonb,
  add column if not exists detail_status text not null default 'pending',
  add column if not exists detail_read_at timestamptz,
  add column if not exists paused_at timestamptz;

alter table public.v12_broker_pies drop constraint if exists v12_broker_pies_detail_status_check;
alter table public.v12_broker_pies
  add constraint v12_broker_pies_detail_status_check
  check (detail_status in ('pending','loaded','missing_scope','error','paused'));

update public.v12_broker_pies
set detail_status='loaded', detail_read_at=coalesce(detail_read_at, updated_at)
where details is not null and detail_status='pending';

alter table public.v12_mirror_sources
  add column if not exists fetched_at timestamptz;

alter table public.v12_tasks drop constraint if exists v12_tasks_kind_check;
alter table public.v12_tasks
  add constraint v12_tasks_kind_check check (kind = any (array[
    'broker','broker-account','broker-positions','broker-pies','broker-instruments',
    'pie-read','market-index','market-screen','market-deep','mirror','pie-write'
  ]));

create table if not exists public.v12_wikifolio_sessions (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  ciphertext text not null,
  nonce text not null,
  updated_at timestamptz not null default now()
);

alter table public.v12_wikifolio_sessions enable row level security;
revoke all on table public.v12_wikifolio_sessions from public, anon, authenticated;

create or replace function public.save_v12_binding(p_owner uuid, p_binding jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare b public.v12_pie_bindings; pie bigint:=(p_binding->>'pie_id')::bigint; controller text:=p_binding->>'controller'; enabled boolean:=coalesce((p_binding->>'enabled')::boolean,false);
begin
  perform public.assert_account_ready(p_owner);
  select * into b from public.v12_pie_bindings where owner_id=p_owner and pie_id=pie for update;
  if b.write_until>now() then raise exception 'PIE_BUSY: Zieländerung wird gerade bestätigt. Bitte kurz warten.'; end if;
  if not exists(select 1 from public.v12_broker_pies where owner_id=p_owner and pie_id=pie and updated_at>now()-interval '1 day') then
    raise exception 'PIE_STALE: Pie zuerst aus Trading212 laden';
  end if;
  if controller not in ('advisor','mirror','manual') then raise exception 'PIE_INVALID: Advisor, Wikifolio oder Manuell wählen'; end if;
  if controller='manual' and enabled then raise exception 'PIE_MANUAL: Manuelle Pies werden nur gelesen'; end if;
  if controller='advisor' and not exists(select 1 from public.finance_plans f, jsonb_array_elements(coalesce(f.data->'strategies','[]')) g where f.owner_id=p_owner and g->>'id'=p_binding->>'strategy_id') then
    raise exception 'Anlageziel fehlt';
  end if;
  if controller='advisor' and not exists(select 1 from public.finance_plans f, jsonb_array_elements(f.data->'entries') e where f.owner_id=p_owner and e->>'id'=p_binding->>'plan_entry_id' and e->>'type'='investment') then
    raise exception 'Investment-Planzeile fehlt';
  end if;
  if controller='mirror' and not exists(select 1 from public.v12_mirror_sources where owner_id=p_owner and symbol=p_binding->>'source_symbol' and status='verified' and verified_at>now()-interval '1 day') then
    raise exception 'Wikifolio-Zugang zuerst vollständig prüfen';
  end if;
  insert into public.v12_pie_bindings(owner_id,pie_id,controller,strategy_id,plan_entry_id,source_symbol,enabled,status,expected_hash)
  values(
    p_owner,pie,controller,
    case when controller='advisor' then p_binding->>'strategy_id' end,
    case when controller='advisor' then p_binding->>'plan_entry_id' end,
    case when controller='mirror' then p_binding->>'source_symbol' end,
    enabled,
    case when enabled then 'active' else 'paused' end,
    p_binding->>'expected_hash'
  )
  on conflict(owner_id,pie_id) do update set
    controller=excluded.controller,
    strategy_id=excluded.strategy_id,
    plan_entry_id=excluded.plan_entry_id,
    source_symbol=excluded.source_symbol,
    enabled=excluded.enabled,
    status=excluded.status,
    expected_hash=excluded.expected_hash,
    pending_hash=null,
    pending_shares=null,
    last_error=null,
    updated_at=now()
  returning * into b;
  update public.v12_tasks set status='cancelled'
  where owner_id=p_owner and kind='pie-write' and payload->>'pieId'=pie::text and status<>'running';
  return to_jsonb(b);
end;
$function$;
