-- ============================================================================
-- Kontur Basisschema (rekonstruiert, Teil 2): RPC-Funktionen.
-- Alle Funktionen: security definer + set search_path = '' (Muster aus 012_v12_1.sql).
-- Signaturen und Verhalten sind aus den Aufrufstellen in
-- supabase/functions/kontur-services.ts und cloud.js/app.js rekonstruiert.
-- Aufruf erfolgt serverseitig mit Service-Role (PostgREST rpc/<name>);
-- einzige Ausnahme: save_finance_plan wird vom Frontend mit User-JWT gerufen.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- assert_account_ready(p_owner): Grundprüfung des Kontos.
-- Fundstelle: 012_v12_1.sql save_v12_binding ruft perform public.assert_account_ready(p_owner).
-- (Der genaue Inhalt der verlorenen Funktion ist nicht im Code sichtbar;
--  rekonstruiert als Existenzprüfung des Kontos.)
-- ----------------------------------------------------------------------------
create or replace function public.assert_account_ready(p_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_owner is null or not exists (select 1 from auth.users u where u.id = p_owner) then
    raise exception 'ACCOUNT_NOT_READY: Persönliches Konto ist nicht eingerichtet.';
  end if;
end;
$function$;

-- ----------------------------------------------------------------------------
-- claim_v12_broker_rate(p_owner, p_endpoint, p_seconds): Abrufbegrenzung Trading212.
-- Fundstelle: kontur-services.ts broker.js brokerClient():
--   db('rpc/claim_v12_broker_rate','POST',{p_owner, p_endpoint: method+path, p_seconds});
--   Fehlertext enthält 'BROKER_RATE_LIMIT', wenn das Intervall nicht eingehalten wird.
-- Zustand wird in wealth_cache unter cache_key 'broker-rate:<endpoint>' gehalten
-- (wealth_cache ist die einzige im Code referenzierte Schlüssel/Wert-Ablage).
-- ----------------------------------------------------------------------------
create or replace function public.claim_v12_broker_rate(p_owner uuid, p_endpoint text, p_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.wealth_cache (owner_id, cache_key, payload, expires_at, retrieved_at)
  values (
    p_owner,
    'broker-rate:' || p_endpoint,
    jsonb_build_object('at', now()),
    now() + make_interval(secs => greatest(coalesce(p_seconds, 1), 1)),
    now()
  )
  on conflict (owner_id, cache_key) do update
    set payload = excluded.payload,
        expires_at = excluded.expires_at,
        retrieved_at = excluded.retrieved_at
    where public.wealth_cache.expires_at <= now();
  if not found then
    raise exception 'BROKER_RATE_LIMIT: Trading212-Abrufgrenze für %. Nächster Abruf frühestens nach %s Sekunden.', p_endpoint, p_seconds;
  end if;
  return jsonb_build_object('granted', true, 'endpoint', p_endpoint, 'seconds', p_seconds);
end;
$function$;

-- ----------------------------------------------------------------------------
-- claim_v12_task(): nächste fällige Aufgabe atomar sperren.
-- Fundstelle: kontur-services.ts dispatch: db('rpc/claim_v12_task','POST',{});
--   Rückgabe: einzelnes Aufgabenobjekt mit task.id/owner_id/kind/task_key/payload/priority/lease
--   oder null, wenn nichts fällig ist (if(!task) return {processed:0}).
-- ----------------------------------------------------------------------------
create or replace function public.claim_v12_task()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare t public.v12_tasks;
begin
  update public.v12_tasks
  set status = 'running',
      lease = gen_random_uuid(),
      updated_at = now()
  where id = (
    select id from public.v12_tasks
    where status = 'queued' and next_due <= now()
    order by priority desc, next_due asc, created_at asc
    limit 1
    for update skip locked
  )
  returning * into t;
  if not found then
    return null;
  end if;
  return to_jsonb(t);
end;
$function$;

-- ----------------------------------------------------------------------------
-- finish_v12_task(...): Aufgabe abschließen oder fehlerhaft verbuchen.
-- Fundstelle: kontur-services.ts dispatch:
--   Erfolg:  {p_owner,p_id,p_lease,p_result,p_error:null,p_retryable:false,p_delay_seconds:out.delay??null}
--   Fehler:  {p_owner,p_id,p_lease,p_result:null,p_error:diagnostic,p_retryable,p_delay_seconds:retryAfter||null}
-- Verhalten: Erfolg ohne Verzögerung => einmalige Aufgabe wird gelöscht (screen/deep/pie-write
--   liefern kein delay); Erfolg mit Verzögerung => erneut einreihen (broker-*, mirror, pie-read,
--   market-index liefern delay-Sekunden). Fehler: retryable => queued mit Aufschub,
--   sonst blocked (UI-Label 'Einrichtung prüfen', retry-task kann erneut einreihen).
-- ----------------------------------------------------------------------------
create or replace function public.finish_v12_task(
  p_owner uuid,
  p_id uuid,
  p_lease uuid,
  p_result jsonb,
  p_error jsonb,
  p_retryable boolean,
  p_delay_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare t public.v12_tasks;
begin
  select * into t from public.v12_tasks
  where id = p_id and owner_id = p_owner and lease = p_lease and status = 'running'
  for update;
  if not found then
    raise exception 'TASK_LEASE: Aufgabe % ist nicht mehr dieser Verarbeitung zugeordnet.', p_id;
  end if;
  if p_error is null then
    if p_delay_seconds is null then
      delete from public.v12_tasks where id = t.id;
      return null;
    end if;
    update public.v12_tasks
    set status = 'queued',
        next_due = now() + make_interval(secs => greatest(p_delay_seconds, 0)),
        last_result = p_result,
        last_error = null,
        lease = null,
        updated_at = now()
    where id = t.id
    returning * into t;
    return to_jsonb(t);
  end if;
  update public.v12_tasks
  set status = case when coalesce(p_retryable, false) then 'queued' else 'blocked' end,
      next_due = case when coalesce(p_retryable, false)
                      then now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 60), 0))
                      else next_due end,
      last_error = p_error,
      last_result = p_result,
      lease = null,
      updated_at = now()
  where id = t.id
  returning * into t;
  return to_jsonb(t);
end;
$function$;

-- ----------------------------------------------------------------------------
-- enqueue_v12_task(...): Aufgabe einreihen bzw. zurücksetzen.
-- Fundstelle: kontur-services.ts handler.js:
--   enqueue=(owner,kind,key,payload={},priority=0,reset=false)=>
--     db('rpc/enqueue_v12_task','POST',{p_owner,p_kind,p_key:String(key),p_payload,p_priority,p_reset})
--   p_reset=true erzwingt einen Neustart (retry-task, enable-broker, pie-write nach Spiegelung);
--   p_reset=false stört eine vorhandene Aufgabe nicht (schedulePieReads, ensureMirrorTasks).
-- ----------------------------------------------------------------------------
create or replace function public.enqueue_v12_task(
  p_owner uuid,
  p_kind text,
  p_key text,
  p_payload jsonb,
  p_priority integer,
  p_reset boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare t public.v12_tasks;
begin
  insert into public.v12_tasks (owner_id, kind, task_key, payload, priority, status, next_due)
  values (p_owner, p_kind, coalesce(p_key, ''), coalesce(p_payload, '{}'::jsonb),
          coalesce(p_priority, 0), 'queued', now())
  on conflict (owner_id, kind, task_key) do update
    set payload = case when p_reset then excluded.payload else public.v12_tasks.payload end,
        priority = case when p_reset then excluded.priority else public.v12_tasks.priority end,
        status = case when p_reset then 'queued' else public.v12_tasks.status end,
        next_due = case when p_reset then now() else public.v12_tasks.next_due end,
        lease = case when p_reset then null else public.v12_tasks.lease end,
        updated_at = now()
  returning * into t;
  return to_jsonb(t);
end;
$function$;

-- ----------------------------------------------------------------------------
-- enqueue_v12_screens(p_owner, p_cycle): Analysepakete (je max. 25 ISINs) einreihen.
-- Fundstelle: kontur-services.ts market.js index():
--   db('rpc/enqueue_v12_screens','POST',{p_owner,p_cycle:cycle}) nach dem Katalog-Upsert;
--   screen() verlangt 1..25 ISINs (sonst BATCH_INVALID) und braucht row.provider_ticker.
-- ----------------------------------------------------------------------------
create or replace function public.enqueue_v12_screens(p_owner uuid, p_cycle uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare queued integer := 0;
begin
  with rows as (
    select i.isin, ((row_number() over (order by i.isin) - 1) / 25) as batch
    from public.v12_instruments i
    where i.owner_id = p_owner and i.active and i.provider_ticker is not null
  ),
  batches as (
    select batch, jsonb_agg(isin order by isin) as isins
    from rows group by batch
  ),
  ins as (
    insert into public.v12_tasks (owner_id, kind, task_key, payload, priority, status, next_due)
    select p_owner, 'market-screen', 'screen:' || p_cycle::text || ':' || batch::text,
           jsonb_build_object('cycle', p_cycle, 'isins', isins),
           20, 'queued', now()
    from batches
    on conflict (owner_id, kind, task_key) do nothing
    returning 1
  )
  select count(*) into queued from ins;
  return jsonb_build_object('queued', queued);
end;
$function$;

-- ----------------------------------------------------------------------------
-- enqueue_v12_deep(p_owner, p_cycle, p_isin, p_held): Vertiefungsanalyse einreihen.
-- Fundstelle: kontur-services.ts market.js screen():
--   db('rpc/enqueue_v12_deep','POST',{p_owner,p_cycle:task.payload.cycle,p_isin,p_held});
--   deep() liest task.payload.isin.
-- ----------------------------------------------------------------------------
create or replace function public.enqueue_v12_deep(p_owner uuid, p_cycle uuid, p_isin text, p_held boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return public.enqueue_v12_task(
    p_owner,
    'market-deep',
    'deep:' || p_cycle::text || ':' || p_isin,
    jsonb_build_object('cycle', p_cycle, 'isin', p_isin, 'held', coalesce(p_held, false)),
    10,
    false
  );
end;
$function$;

-- ----------------------------------------------------------------------------
-- rank_v12_market(p_owner): Branchen-Perzentil-Bewertung des Aktienuniversums.
-- Fundstelle: kontur-services.ts market.js screen() ruft nach jedem Paket rank_v12_market;
--   die Bewertungslogik ist core.js scoreFacts() (version 'sector-percentiles-v12.1',
--   Komponenten quality/valuation/debt/growth/momentum als Perzentile 0..100,
--   total = Mittelwert; < 5 Vergleichswerte je Branche => keine Rangposition).
--   screen() fragt danach status='analysed' sortiert nach score->total ab.
-- ----------------------------------------------------------------------------
create or replace function public.rank_v12_market(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare result jsonb;
begin
  with eligible as (
    select i.isin,
           coalesce(i.facts->>'sector', i.sector, 'unknown') as sector_name,
           i.as_of,
           (i.facts->>'return_on_equity')::float8 as roe,
           (i.facts->>'pe_ratio')::float8 as pe,
           (i.facts->>'debt_to_equity')::float8 as dte,
           (i.facts->>'revenue_growth')::float8 as rg,
           (i.facts->>'momentum')::float8 as mom
    from public.v12_instruments i
    where i.owner_id = p_owner and i.active
      and jsonb_typeof(i.facts) = 'object'
      and jsonb_typeof(i.facts->'return_on_equity') = 'number'
      and jsonb_typeof(i.facts->'pe_ratio') = 'number'
      and jsonb_typeof(i.facts->'debt_to_equity') = 'number'
      and jsonb_typeof(i.facts->'revenue_growth') = 'number'
      and jsonb_typeof(i.facts->'momentum') = 'number'
  ),
  peers as (
    select sector_name, count(*) as cnt
    from eligible group by sector_name
  ),
  scored as (
    select e.isin, e.as_of, p.cnt,
           (select count(*) from eligible x where x.sector_name = e.sector_name and x.roe < e.roe) as roe_rank,
           (select count(*) from eligible x where x.sector_name = e.sector_name and x.pe > e.pe) as pe_rank,
           (select count(*) from eligible x where x.sector_name = e.sector_name and x.dte > e.dte) as dte_rank,
           (select count(*) from eligible x where x.sector_name = e.sector_name and x.rg < e.rg) as rg_rank,
           (select count(*) from eligible x where x.sector_name = e.sector_name and x.mom < e.mom) as mom_rank
    from eligible e join peers p on p.sector_name = e.sector_name
  ),
  ranked as (
    select s.isin,
           case
             when s.as_of is not null and s.as_of < current_date - 550 then 'stale'
             when s.cnt < 5 then 'incomplete'
             else 'analysed'
           end as new_status,
           case
             when s.as_of is not null and s.as_of < current_date - 550 then null
             when s.cnt < 5 then null
             else jsonb_build_object(
               'version', 'sector-percentiles-v12.1',
               'components', jsonb_build_object(
                 'quality',   round(s.roe_rank * 100.0 / (s.cnt - 1)),
                 'valuation', round(s.pe_rank * 100.0 / (s.cnt - 1)),
                 'debt',      round(s.dte_rank * 100.0 / (s.cnt - 1)),
                 'growth',    round(s.rg_rank * 100.0 / (s.cnt - 1)),
                 'momentum',  round(s.mom_rank * 100.0 / (s.cnt - 1))),
               'total', (round(s.roe_rank * 100.0 / (s.cnt - 1))
                       + round(s.pe_rank * 100.0 / (s.cnt - 1))
                       + round(s.dte_rank * 100.0 / (s.cnt - 1))
                       + round(s.rg_rank * 100.0 / (s.cnt - 1))
                       + round(s.mom_rank * 100.0 / (s.cnt - 1))) / 5.0)
           end as new_score,
           case
             when s.as_of is not null and s.as_of < current_date - 550
               then 'Datenstand ist für eine belastbare Rangposition zu alt.'
             when s.cnt < 5
               then 'Bewertung erfordert ausreichend Branchenvergleiche.'
             else null
           end as new_reason
    from scored s
  ),
  upd as (
    update public.v12_instruments i
    set status = r.new_status,
        score = r.new_score,
        reason = r.new_reason,
        updated_at = now()
    from ranked r
    where i.owner_id = p_owner and i.isin = r.isin
    returning i.status
  )
  select jsonb_build_object(
    'analysed', count(*) filter (where status = 'analysed'),
    'incomplete', count(*) filter (where status = 'incomplete'),
    'stale', count(*) filter (where status = 'stale'))
  into result from upd;
  return coalesce(result, jsonb_build_object('analysed', 0, 'incomplete', 0, 'stale', 0));
end;
$function$;

-- ----------------------------------------------------------------------------
-- reserve_v12_cost(...) / settle_v12_cost(...): Kostenbudget (EUR-Mikroeinheiten).
-- Fundstellen:
--   kontur-services.ts billing.js: reserveCost ruft rpc/reserve_v12_cost
--     {p_owner,p_id,p_bucket,p_micros,p_meta}; createDB bildet eine Fehlermeldung mit
--     Präfix 'BUDGET_LIMIT' auf den Code BUDGET_LIMIT ab.
--   settleCost ruft rpc/settle_v12_cost {p_owner,p_id,p_micros,p_state,p_response_id};
--     released => p_micros 0; uncertain => p_micros null (Reservierung bleibt gebunden).
--   Limits aus integrations-ui.js overview(): 30 € gesamt, 25 € Marktdaten, 5 € OpenRouter
--     (money(x/10000): Mikroeinheiten/10000 = Cent; 30 € = 30.000.000 Mikro).
-- ----------------------------------------------------------------------------
create or replace function public.reserve_v12_cost(
  p_owner uuid,
  p_id uuid,
  p_bucket text,
  p_micros bigint,
  p_meta jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  c_total_limit constant bigint := 30000000; -- 30 EUR in Mikroeinheiten (integrations-ui.js)
  c_ai_limit    constant bigint := 5000000;  --  5 EUR OpenRouter
  c_data_limit  constant bigint := 25000000; -- 25 EUR Marktdaten
  used_total bigint;
  used_bucket bigint;
begin
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

create or replace function public.settle_v12_cost(
  p_owner uuid,
  p_id uuid,
  p_micros bigint,
  p_state text,
  p_response_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare e public.v12_cost_events;
begin
  if p_state not in ('settled', 'released', 'uncertain') then
    raise exception 'COST_STATE: Unbekannter Abrechnungsstand %.', p_state;
  end if;
  update public.v12_cost_events
  set state = p_state,
      -- released => 0 (freigegeben), uncertain => null (Reservierung bleibt gebunden),
      -- settled => tatsächliche Kosten (billing.js settleCost)
      micros = case when p_micros is null then micros else greatest(p_micros, 0) end,
      response_id = coalesce(p_response_id, response_id)
  where id = p_id and owner_id = p_owner
  returning * into e;
  if not found then
    raise exception 'COST_MISSING: Kostenreservierung % ist nicht vorhanden.', p_id;
  end if;
  return to_jsonb(e);
end;
$function$;

-- ----------------------------------------------------------------------------
-- v12_budget_status(p_owner): Monatsverbrauch inklusive Reservierungen.
-- Fundstelle: kontur-services.ts status-Aktion + integrations-ui.js overview():
--   b.usedMicros, b.limitMicros, b.dataUsedMicros, b.aiUsedMicros, b.uncertainMicros
-- ----------------------------------------------------------------------------
create or replace function public.v12_budget_status(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  used_total bigint;
  used_data bigint;
  used_ai bigint;
  uncertain bigint;
begin
  select coalesce(sum(e.micros) filter (where e.state in ('reserved','uncertain','settled')), 0),
         coalesce(sum(e.micros) filter (where e.state in ('reserved','uncertain','settled') and e.bucket = 'data'), 0),
         coalesce(sum(e.micros) filter (where e.state in ('reserved','uncertain','settled') and e.bucket = 'ai'), 0),
         coalesce(sum(e.micros) filter (where e.state = 'uncertain'), 0)
  into used_total, used_data, used_ai, uncertain
  from public.v12_cost_events e
  where e.owner_id = p_owner and e.created_at >= date_trunc('month', now());
  return jsonb_build_object(
    'limitMicros', 30000000,
    'usedMicros', used_total,
    'dataUsedMicros', used_data,
    'aiUsedMicros', used_ai,
    'uncertainMicros', uncertain
  );
end;
$function$;

-- ----------------------------------------------------------------------------
-- v12_coverage(p_owner): Abdeckung des Aktienuniversums.
-- Fundstelle: kontur-services.ts status-Aktion + integrations-ui.js overview():
--   c.total, c.mapped, c.analysed, c.deep, c.incomplete, c.unmapped
-- ----------------------------------------------------------------------------
create or replace function public.v12_coverage(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return (
    select jsonb_build_object(
      'total', count(*),
      'mapped', count(*) filter (where i.status = 'mapped'),
      'analysed', count(*) filter (where i.status = 'analysed'),
      'deep', count(*) filter (where i.deep_analysis is not null),
      'incomplete', count(*) filter (where i.status = 'incomplete'),
      'unmapped', count(*) filter (where i.status = 'unmapped'))
    from public.v12_instruments i
    where i.owner_id = p_owner and i.active
  );
end;
$function$;

-- ----------------------------------------------------------------------------
-- begin_v12_pie_write(...) / finish_v12_pie_write(...): Pie-Schreibauftrag mit Sperre.
-- Fundstelle: kontur-services.ts writePie():
--   begin: {p_owner,p_pie,p_expected:currentHash,p_desired:hash,p_shares:desired,p_task:task.id}
--     vor dem Broker-POST; Fehlercodes laut Aufgabenbeschreibung/Bundle: PIE_BUSY, PIE_STALE.
--   finish: {p_owner,p_pie,p_task:binding.write_lease,p_hash:currentHash,p_reason}
--     nach bestätigtem Rücklesen; erwartet binding.pending_hash === p_hash.
--   012_v12_1.sql save_v12_binding prüft b.write_until > now() => PIE_BUSY.
-- ----------------------------------------------------------------------------
create or replace function public.begin_v12_pie_write(
  p_owner uuid,
  p_pie bigint,
  p_expected text,
  p_desired text,
  p_shares jsonb,
  p_task uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare b public.v12_pie_bindings;
begin
  select * into b from public.v12_pie_bindings
  where owner_id = p_owner and pie_id = p_pie
  for update;
  if not found then
    raise exception 'PIE_INVALID: Zuerst Advisor, Wikifolio oder Manuell speichern.';
  end if;
  if b.write_until is not null and b.write_until > now() and b.write_lease is distinct from p_task then
    raise exception 'PIE_BUSY: Zieländerung wird gerade bestätigt. Bitte kurz warten.';
  end if;
  if b.expected_hash is distinct from p_expected then
    raise exception 'PIE_STALE: Pie zuerst aus Trading212 laden';
  end if;
  update public.v12_pie_bindings
  set status = 'writing',
      pending_hash = p_desired,
      pending_shares = p_shares,
      write_lease = p_task,
      -- Bestätigungsfenster: Rücklesen erfolgt in einer separaten Verarbeitung (delay 60s)
      write_until = now() + interval '15 minutes',
      updated_at = now()
  where owner_id = p_owner and pie_id = p_pie
  returning * into b;
  return to_jsonb(b);
end;
$function$;

create or replace function public.finish_v12_pie_write(
  p_owner uuid,
  p_pie bigint,
  p_task uuid,
  p_hash text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare b public.v12_pie_bindings;
begin
  select * into b from public.v12_pie_bindings
  where owner_id = p_owner and pie_id = p_pie
  for update;
  if not found then
    raise exception 'PIE_INVALID: Zuerst Advisor, Wikifolio oder Manuell speichern.';
  end if;
  if b.write_lease is distinct from p_task or b.pending_hash is distinct from p_hash then
    raise exception 'PIE_STALE: Der Schreibauftrag ist nicht mehr aktuell. Pie erneut prüfen.';
  end if;
  update public.v12_pie_bindings
  set status = 'active',
      expected_hash = p_hash,
      pending_hash = null,
      pending_shares = null,
      write_lease = null,
      write_until = null,
      last_error = null,
      updated_at = now()
  where owner_id = p_owner and pie_id = p_pie
  returning * into b;
  return to_jsonb(b);
end;
$function$;

-- ----------------------------------------------------------------------------
-- remove_v12_control(p_owner, p_pie): Pie-Zuordnung entfernen.
-- Fundstelle: kontur-services.ts remove-control: db('rpc/remove_v12_control','POST',{p_owner,p_pie});
--   offene Schreibaufträge werden wie in 012_v12_1.sql save_v12_binding storniert.
-- ----------------------------------------------------------------------------
create or replace function public.remove_v12_control(p_owner uuid, p_pie bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare b public.v12_pie_bindings;
begin
  select * into b from public.v12_pie_bindings
  where owner_id = p_owner and pie_id = p_pie
  for update;
  if not found then
    return jsonb_build_object('deleted', false);
  end if;
  if b.write_until is not null and b.write_until > now() then
    raise exception 'PIE_BUSY: Zieländerung wird gerade bestätigt. Bitte kurz warten.';
  end if;
  update public.v12_tasks set status = 'cancelled', updated_at = now()
  where owner_id = p_owner and kind = 'pie-write' and payload->>'pieId' = p_pie::text and status <> 'running';
  delete from public.v12_pie_bindings where owner_id = p_owner and pie_id = p_pie;
  return jsonb_build_object('deleted', true);
end;
$function$;

-- ----------------------------------------------------------------------------
-- delete_v12_strategy(p_owner, p_strategy, p_revision): Anlagestrategie löschen.
-- Fundstelle: kontur-services.ts delete-strategy:
--   db('rpc/delete_v12_strategy','POST',{p_owner,p_strategy:data.strategyId,p_revision:data.planRevision})
--   Rückgabe wird 1:1 an das Frontend weitergereicht.
--   Revisionsprüfung analog save_finance_plan (SYNC_CONFLICT, app.js sync()).
-- ----------------------------------------------------------------------------
create or replace function public.delete_v12_strategy(p_owner uuid, p_strategy text, p_revision integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  f public.finance_plans;
  next_data jsonb;
  next_revision integer;
begin
  perform public.assert_account_ready(p_owner);
  select * into f from public.finance_plans where owner_id = p_owner for update;
  if not found then
    raise exception 'PLAN_MISSING: Kein Finanzplan vorhanden.';
  end if;
  if f.revision <> coalesce(p_revision, -1) then
    raise exception 'SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(coalesce(f.data->'strategies', '[]'::jsonb)) g
    where g->>'id' = p_strategy
  ) then
    raise exception 'Anlageziel fehlt';
  end if;
  next_data = jsonb_set(
    f.data,
    '{strategies}',
    coalesce((
      select jsonb_agg(g) from jsonb_array_elements(coalesce(f.data->'strategies', '[]'::jsonb)) g
      where g->>'id' <> p_strategy
    ), '[]'::jsonb)
  );
  -- Zugeordnete Pies freigeben und offene Schreibaufträge stornieren
  update public.v12_tasks set status = 'cancelled', updated_at = now()
  where owner_id = p_owner and kind = 'pie-write' and status <> 'running'
    and payload->>'pieId' in (
      select b.pie_id::text from public.v12_pie_bindings b
      where b.owner_id = p_owner and b.strategy_id = p_strategy
    );
  delete from public.v12_pie_bindings where owner_id = p_owner and strategy_id = p_strategy;
  delete from public.advisor_profiles where owner_id = p_owner and strategy_key = p_strategy;
  delete from public.wealth_models where owner_id = p_owner and strategy_key = p_strategy;
  next_revision = f.revision + 1;
  update public.finance_plans
  set data = next_data, revision = next_revision, updated_at = now()
  where owner_id = p_owner;
  return jsonb_build_object('deleted', true, 'revision', next_revision);
end;
$function$;

-- ----------------------------------------------------------------------------
-- save_finance_plan(payload, expected_revision): optimistische Plan-Synchronisation.
-- Fundstelle: cloud.js save(): POST /rest/v1/rpc/save_finance_plan
--   {payload, expected_revision}; app.js sync(): meta.revision = result.revision;
--   Konflikt wird an der Fehlermeldung 'SYNC_CONFLICT' erkannt.
--   Erster Upload erfolgt mit expected_revision = 0 (app.js loadLocal: meta={revision:0,...}).
-- Aufruf: angemeldetes Konto (authenticated), Konto ergibt sich aus auth.uid().
-- ----------------------------------------------------------------------------
create or replace function public.save_finance_plan(payload jsonb, expected_revision integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  uid uuid := auth.uid();
  f public.finance_plans;
  next_revision integer;
  stamp timestamptz;
begin
  if uid is null then
    raise exception 'AUTH_REQUIRED: Bitte anmelden.';
  end if;
  select * into f from public.finance_plans where owner_id = uid for update;
  if found then
    if f.revision <> coalesce(expected_revision, 0) then
      raise exception 'SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert. Cloud-Stand laden, bevor du weiterarbeitest.';
    end if;
    next_revision = f.revision + 1;
    update public.finance_plans
    set data = payload, revision = next_revision, updated_at = now()
    where owner_id = uid
    returning updated_at into stamp;
  else
    if coalesce(expected_revision, 0) <> 0 then
      raise exception 'SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert. Cloud-Stand laden, bevor du weiterarbeitest.';
    end if;
    next_revision = 1;
    insert into public.finance_plans (owner_id, data, revision, updated_at)
    values (uid, payload, next_revision, now())
    returning updated_at into stamp;
  end if;
  return jsonb_build_object('revision', next_revision, 'updated_at', stamp);
end;
$function$;

-- ----------------------------------------------------------------------------
-- Ausführungsrechte:
-- Serverseitige RPCs nur für die Service-Rolle (Edge Function nutzt den
-- Service-Schlüssel, createDB in kontur-services.ts shared/http.js).
-- save_finance_plan ist die einzige RPC für angemeldete Konten (cloud.js).
-- ----------------------------------------------------------------------------
revoke all on function public.assert_account_ready(uuid) from public, anon, authenticated;
revoke all on function public.claim_v12_broker_rate(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.claim_v12_task() from public, anon, authenticated;
revoke all on function public.finish_v12_task(uuid, uuid, uuid, jsonb, jsonb, boolean, integer) from public, anon, authenticated;
revoke all on function public.enqueue_v12_task(uuid, text, text, jsonb, integer, boolean) from public, anon, authenticated;
revoke all on function public.enqueue_v12_screens(uuid, uuid) from public, anon, authenticated;
revoke all on function public.enqueue_v12_deep(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.rank_v12_market(uuid) from public, anon, authenticated;
revoke all on function public.reserve_v12_cost(uuid, uuid, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.settle_v12_cost(uuid, uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.v12_budget_status(uuid) from public, anon, authenticated;
revoke all on function public.v12_coverage(uuid) from public, anon, authenticated;
revoke all on function public.begin_v12_pie_write(uuid, bigint, text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.finish_v12_pie_write(uuid, bigint, uuid, text, text) from public, anon, authenticated;
revoke all on function public.remove_v12_control(uuid, bigint) from public, anon, authenticated;
revoke all on function public.delete_v12_strategy(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.save_finance_plan(jsonb, integer) from public, anon;

grant execute on function public.assert_account_ready(uuid) to service_role;
grant execute on function public.claim_v12_broker_rate(uuid, text, integer) to service_role;
grant execute on function public.claim_v12_task() to service_role;
grant execute on function public.finish_v12_task(uuid, uuid, uuid, jsonb, jsonb, boolean, integer) to service_role;
grant execute on function public.enqueue_v12_task(uuid, text, text, jsonb, integer, boolean) to service_role;
grant execute on function public.enqueue_v12_screens(uuid, uuid) to service_role;
grant execute on function public.enqueue_v12_deep(uuid, uuid, text, boolean) to service_role;
grant execute on function public.rank_v12_market(uuid) to service_role;
grant execute on function public.reserve_v12_cost(uuid, uuid, text, bigint, jsonb) to service_role;
grant execute on function public.settle_v12_cost(uuid, uuid, bigint, text, text) to service_role;
grant execute on function public.v12_budget_status(uuid) to service_role;
grant execute on function public.v12_coverage(uuid) to service_role;
grant execute on function public.begin_v12_pie_write(uuid, bigint, text, text, jsonb, uuid) to service_role;
grant execute on function public.finish_v12_pie_write(uuid, bigint, uuid, text, text) to service_role;
grant execute on function public.remove_v12_control(uuid, bigint) to service_role;
grant execute on function public.delete_v12_strategy(uuid, text, integer) to service_role;
grant execute on function public.save_finance_plan(jsonb, integer) to authenticated;
grant execute on function public.save_finance_plan(jsonb, integer) to service_role;
