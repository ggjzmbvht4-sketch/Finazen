import { all, batch, bindValue, decodeRow, fail, first, json, now, plusSeconds, run, uuid } from './db';

async function one(env:any, table:string, sql:string, values:unknown[] = []) {
  const result = await all(env, sql, values);
  return result.length ? decodeRow(table, result[0]) : null;
}

function monthStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export async function budgetStatus(env:any, owner:string) {
  const row: any = await first(env,
    `SELECT
      COALESCE(SUM(CASE WHEN state IN ('reserved','uncertain','settled') THEN micros ELSE 0 END),0) AS used,
      COALESCE(SUM(CASE WHEN state IN ('reserved','uncertain','settled') AND bucket='data' THEN micros ELSE 0 END),0) AS data_used,
      COALESCE(SUM(CASE WHEN state IN ('reserved','uncertain','settled') AND bucket='ai' THEN micros ELSE 0 END),0) AS ai_used,
      COALESCE(SUM(CASE WHEN state='uncertain' THEN micros ELSE 0 END),0) AS uncertain
     FROM v12_cost_events WHERE owner_id=? AND created_at>=?`, [owner,monthStart()]);
  return { limitMicros:30000000, usedMicros:Number(row?.used||0), dataUsedMicros:Number(row?.data_used||0), aiUsedMicros:Number(row?.ai_used||0), uncertainMicros:Number(row?.uncertain||0) };
}

export async function saveFinancePlan(env:any, owner:string, payload:any, expectedRevision:number) {
  if (!owner) fail('AUTH_REQUIRED: Bitte anmelden.',401);
  const current:any = await first(env,'SELECT revision FROM finance_plans WHERE owner_id=?',[owner]);
  const expected = Number(expectedRevision||0), stamp = now();
  if (current) {
    if (Number(current.revision) !== expected) fail('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert. Cloud-Stand laden, bevor du weiterarbeitest.',409);
    const updated = await all(env,'UPDATE finance_plans SET data=?,revision=?,updated_at=? WHERE owner_id=? AND revision=? RETURNING revision', [payload,expected+1,stamp,owner,expected]);
    if (!updated.length) fail('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert. Cloud-Stand laden, bevor du weiterarbeitest.',409);
    return {revision:expected+1,updated_at:stamp};
  }
  if (expected !== 0) fail('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert. Cloud-Stand laden, bevor du weiterarbeitest.',409);
  await run(env,'INSERT INTO finance_plans(owner_id,data,revision,updated_at) VALUES(?,?,1,?)',[owner,payload,stamp]);
  return {revision:1,updated_at:stamp};
}

async function enqueue(env:any, p:any) {
  const reset = p.p_reset === true, id = uuid(), stamp = now();
  const sql = `INSERT INTO v12_tasks(id,owner_id,kind,task_key,payload,priority,status,next_due,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'queued',?,?,?)
    ON CONFLICT(owner_id,kind,task_key) DO UPDATE SET
      payload=CASE WHEN ?=1 THEN excluded.payload ELSE v12_tasks.payload END,
      priority=CASE WHEN ?=1 THEN excluded.priority ELSE v12_tasks.priority END,
      status=CASE WHEN ?=1 THEN 'queued' ELSE v12_tasks.status END,
      next_due=CASE WHEN ?=1 THEN excluded.next_due ELSE v12_tasks.next_due END,
      lease=CASE WHEN ?=1 THEN NULL ELSE v12_tasks.lease END,
      updated_at=excluded.updated_at RETURNING *`;
  return one(env,'v12_tasks',sql,[id,p.p_owner,p.p_kind,String(p.p_key||''),p.p_payload||{},Number(p.p_priority||0),stamp,stamp,stamp,reset?1:0,reset?1:0,reset?1:0,reset?1:0,reset?1:0]);
}

export async function rpc(env:any, name:string, p:any): Promise<Response> {
  try {
    let result: any;
    switch (name) {
      case 'claim_v12_broker_rate': {
        const seconds = Math.max(Number(p.p_seconds||1),1), stamp=now(), expiry=plusSeconds(seconds);
        result = await one(env,'wealth_cache',
          `INSERT INTO wealth_cache(owner_id,cache_key,payload,expires_at,retrieved_at) VALUES(?,?,?,?,?)
           ON CONFLICT(owner_id,cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,retrieved_at=excluded.retrieved_at
           WHERE wealth_cache.expires_at<=? OR wealth_cache.expires_at IS NULL RETURNING *`,
          [p.p_owner,'broker-rate:'+p.p_endpoint,{at:stamp},expiry,stamp,stamp]);
        if (!result) fail(`BROKER_RATE_LIMIT: Trading212-Abrufgrenze für ${p.p_endpoint}. Nächster Abruf frühestens nach ${seconds} Sekunden.`,409);
        result = {granted:true,endpoint:p.p_endpoint,seconds};
        break;
      }
      case 'claim_v12_task': {
        result = await one(env,'v12_tasks',
          `UPDATE v12_tasks SET status='running',lease=?,updated_at=? WHERE id=(
             SELECT id FROM v12_tasks WHERE status='queued' AND next_due<=? ORDER BY priority DESC,next_due ASC,created_at ASC LIMIT 1
           ) RETURNING *`,[uuid(),now(),now()]);
        break;
      }
      case 'finish_v12_task': {
        const task:any = await first(env,'SELECT * FROM v12_tasks WHERE id=? AND owner_id=? AND lease=? AND status=\'running\'',[p.p_id,p.p_owner,p.p_lease]);
        if (!task) fail(`TASK_LEASE: Aufgabe ${p.p_id} ist nicht mehr dieser Verarbeitung zugeordnet.`,409);
        if (p.p_error == null && p.p_delay_seconds == null) {
          await run(env,'DELETE FROM v12_tasks WHERE id=? AND lease=?',[p.p_id,p.p_lease]); result=null; break;
        }
        const retry = p.p_error != null && p.p_retryable===true;
        const delay = p.p_error == null ? Math.max(Number(p.p_delay_seconds),0) : Math.max(Number(p.p_delay_seconds||60),0);
        result = await one(env,'v12_tasks',
          `UPDATE v12_tasks SET status=?,next_due=?,last_result=?,last_error=?,lease=NULL,updated_at=? WHERE id=? AND lease=? RETURNING *`,
          [p.p_error==null?'queued':retry?'queued':'blocked',retry||p.p_error==null?plusSeconds(delay):task.next_due,p.p_result??null,p.p_error??null,now(),p.p_id,p.p_lease]);
        break;
      }
      case 'enqueue_v12_task': result=await enqueue(env,p); break;
      case 'enqueue_v12_deep': result=await enqueue(env,{p_owner:p.p_owner,p_kind:'market-deep',p_key:`deep:${p.p_cycle}:${p.p_isin}`,p_payload:{cycle:p.p_cycle,isin:p.p_isin,held:p.p_held===true},p_priority:10,p_reset:false}); break;
      case 'enqueue_v12_screens': {
        const instruments = await all(env,'SELECT isin FROM v12_instruments WHERE owner_id=? AND active=1 AND provider_ticker IS NOT NULL ORDER BY isin',[p.p_owner]);
        let queued=0;
        for (let offset=0;offset<instruments.length;offset+=25) {
          const index=offset/25, stamp=now();
          const meta = await run(env,
            `INSERT INTO v12_tasks(id,owner_id,kind,task_key,payload,priority,status,next_due,created_at,updated_at)
             VALUES(?,?,'market-screen',?,?,20,'queued',?,?,?) ON CONFLICT(owner_id,kind,task_key) DO NOTHING`,
            [uuid(),p.p_owner,`screen:${p.p_cycle}:${index}`,{cycle:p.p_cycle,isins:instruments.slice(offset,offset+25).map((x:any)=>x.isin)},stamp,stamp,stamp]);
          queued += Number(meta.meta?.changes||0);
        }
        result={queued}; break;
      }
      case 'v12_budget_status': result=await budgetStatus(env,p.p_owner); break;
      case 'v12_coverage': {
        const r:any=await first(env,`SELECT COUNT(*) total,
          SUM(CASE WHEN status='mapped' THEN 1 ELSE 0 END) mapped,
          SUM(CASE WHEN status='analysed' THEN 1 ELSE 0 END) analysed,
          SUM(CASE WHEN deep_analysis IS NOT NULL THEN 1 ELSE 0 END) deep,
          SUM(CASE WHEN status='incomplete' THEN 1 ELSE 0 END) incomplete,
          SUM(CASE WHEN status='unmapped' THEN 1 ELSE 0 END) unmapped
          FROM v12_instruments WHERE owner_id=? AND active=1`,[p.p_owner]);
        result={total:Number(r.total||0),mapped:Number(r.mapped||0),analysed:Number(r.analysed||0),deep:Number(r.deep||0),incomplete:Number(r.incomplete||0),unmapped:Number(r.unmapped||0)}; break;
      }
      case 'reserve_v12_cost': {
        if (!['ai','data'].includes(p.p_bucket)) fail(`BUDGET_BUCKET: Unbekannte Kostenstelle ${p.p_bucket}.`);
        const micros=Math.max(Number(p.p_micros||0),0), bucketLimit=p.p_bucket==='ai'?5000000:25000000;
        const inserted = await run(env,
          `INSERT INTO v12_cost_events(id,owner_id,bucket,state,micros,meta,created_at)
           SELECT ?,?,?,'reserved',?,?,? WHERE
             (SELECT COALESCE(SUM(micros),0) FROM v12_cost_events WHERE owner_id=? AND created_at>=? AND state IN ('reserved','uncertain','settled')) + ? <= 30000000
             AND (SELECT COALESCE(SUM(micros),0) FROM v12_cost_events WHERE owner_id=? AND created_at>=? AND bucket=? AND state IN ('reserved','uncertain','settled')) + ? <= ?`,
          [p.p_id,p.p_owner,p.p_bucket,micros,p.p_meta||{},now(),p.p_owner,monthStart(),micros,p.p_owner,monthStart(),p.p_bucket,micros,bucketLimit]);
        if (!Number(inserted.meta?.changes||0)) {
          const b=await budgetStatus(env,p.p_owner);
          if (b.usedMicros+micros>30000000) fail('BUDGET_LIMIT: Das Monatsbudget von 30 Euro ist erreicht. Der nächste Monat setzt das Budget zurück.',409);
          fail(p.p_bucket==='ai'?'BUDGET_LIMIT: Das monatliche KI-Budget von 5 Euro ist erreicht.':'BUDGET_LIMIT: Das monatliche Marktdatenbudget von 25 Euro ist erreicht.',409);
        }
        result={id:p.p_id,state:'reserved',micros}; break;
      }
      case 'settle_v12_cost': {
        if (!['settled','released','uncertain'].includes(p.p_state)) fail(`COST_STATE: Unbekannter Abrechnungsstand ${p.p_state}.`);
        result=await one(env,'v12_cost_events',
          `UPDATE v12_cost_events SET state=?,micros=CASE WHEN ? IS NULL THEN micros ELSE MAX(?,0) END,response_id=COALESCE(?,response_id) WHERE id=? AND owner_id=? RETURNING *`,
          [p.p_state,p.p_micros,p.p_micros,p.p_response_id,p.p_id,p.p_owner]);
        if (!result) fail(`COST_MISSING: Kostenreservierung ${p.p_id} ist nicht vorhanden.`,404); break;
      }
      case 'rank_v12_market': {
        const source = await all(env,'SELECT isin,facts,sector,as_of FROM v12_instruments WHERE owner_id=? AND active=1',[p.p_owner]);
        const eligible = source.map((r:any)=>({...r,facts:decodeRow('v12_instruments',r).facts})).filter((r:any)=>{
          const f=r.facts; return f&&typeof f==='object'&&['return_on_equity','pe_ratio','debt_to_equity','revenue_growth','momentum'].every((k)=>typeof f[k]==='number'&&Number.isFinite(f[k]));
        });
        const percentile=(value:number,values:number[],reverse=false)=>{
          const rank=values.filter((v)=>reverse?v>value:v<value).length;
          return Math.round(rank*100/(values.length-1));
        };
        let analysed=0,incomplete=0,stale=0;
        for (const row of eligible) {
          const sector=row.facts.sector||row.sector||'unknown';
          const peers=eligible.filter((x:any)=>(x.facts.sector||x.sector||'unknown')===sector);
          const old=row.as_of&&Date.parse(row.as_of)<Date.now()-550*86400000;
          const status=old?'stale':peers.length<5?'incomplete':'analysed';
          let score:any=null,reason:any=null;
          if (old) reason='Datenstand ist für eine belastbare Rangposition zu alt.';
          else if (peers.length<5) reason='Bewertung erfordert ausreichend Branchenvergleiche.';
          else {
            const components={
              quality:percentile(row.facts.return_on_equity,peers.map((x:any)=>x.facts.return_on_equity)),
              valuation:percentile(row.facts.pe_ratio,peers.map((x:any)=>x.facts.pe_ratio),true),
              debt:percentile(row.facts.debt_to_equity,peers.map((x:any)=>x.facts.debt_to_equity),true),
              growth:percentile(row.facts.revenue_growth,peers.map((x:any)=>x.facts.revenue_growth)),
              momentum:percentile(row.facts.momentum,peers.map((x:any)=>x.facts.momentum)),
            };
            score={version:'sector-percentiles-v12.1',components,total:Object.values(components).reduce((a:number,b:any)=>a+b,0)/5};
          }
          await run(env,'UPDATE v12_instruments SET status=?,score=?,reason=?,updated_at=? WHERE owner_id=? AND isin=?',[status,score,reason,now(),p.p_owner,row.isin]);
          if (status==='analysed') analysed++; else if (status==='stale') stale++; else incomplete++;
        }
        result={analysed,incomplete,stale}; break;
      }
      case 'begin_v12_pie_write': {
        const b:any=await first(env,'SELECT * FROM v12_pie_bindings WHERE owner_id=? AND pie_id=?',[p.p_owner,p.p_pie]);
        if (!b) fail('PIE_INVALID: Zuerst Advisor, Wikifolio oder Manuell speichern.',404);
        if (b.write_until&&Date.parse(b.write_until)>Date.now()&&b.write_lease!==p.p_task) fail('PIE_BUSY: Zieländerung wird gerade bestätigt. Bitte kurz warten.',409);
        if (b.expected_hash!==p.p_expected) fail('PIE_STALE: Pie zuerst aus Trading212 laden',409);
        result=await one(env,'v12_pie_bindings',
          `UPDATE v12_pie_bindings SET status='writing',pending_hash=?,pending_shares=?,write_lease=?,write_until=?,updated_at=? WHERE owner_id=? AND pie_id=? AND expected_hash IS ? RETURNING *`,
          [p.p_desired,p.p_shares,p.p_task,plusSeconds(900),now(),p.p_owner,p.p_pie,p.p_expected]);
        if (!result) fail('PIE_STALE: Pie zuerst aus Trading212 laden',409); break;
      }
      case 'finish_v12_pie_write': {
        const b:any=await first(env,'SELECT write_lease,pending_hash FROM v12_pie_bindings WHERE owner_id=? AND pie_id=?',[p.p_owner,p.p_pie]);
        if (!b) fail('PIE_INVALID: Zuerst Advisor, Wikifolio oder Manuell speichern.',404);
        if (b.write_lease!==p.p_task||b.pending_hash!==p.p_hash) fail('PIE_STALE: Der Schreibauftrag ist nicht mehr aktuell. Pie erneut prüfen.',409);
        result=await one(env,'v12_pie_bindings',
          `UPDATE v12_pie_bindings SET status='active',expected_hash=?,pending_hash=NULL,pending_shares=NULL,write_lease=NULL,write_until=NULL,last_error=NULL,updated_at=? WHERE owner_id=? AND pie_id=? AND write_lease IS ? AND pending_hash IS ? RETURNING *`,
          [p.p_hash,now(),p.p_owner,p.p_pie,p.p_task,p.p_hash]); break;
      }
      case 'remove_v12_control': {
        const b:any=await first(env,'SELECT write_until FROM v12_pie_bindings WHERE owner_id=? AND pie_id=?',[p.p_owner,p.p_pie]);
        if (!b) {result={deleted:false};break;}
        if (b.write_until&&Date.parse(b.write_until)>Date.now()) fail('PIE_BUSY: Zieländerung wird gerade bestätigt. Bitte kurz warten.',409);
        await batch(env,[
          {sql:`UPDATE v12_tasks SET status='cancelled',updated_at=? WHERE owner_id=? AND kind='pie-write' AND json_extract(payload,'$.pieId')=? AND status<>'running'`,values:[now(),p.p_owner,Number(p.p_pie)]},
          {sql:'DELETE FROM v12_pie_bindings WHERE owner_id=? AND pie_id=?',values:[p.p_owner,p.p_pie]},
        ]); result={deleted:true}; break;
      }
      case 'delete_v12_strategy': {
        const row:any=await first(env,'SELECT data,revision FROM finance_plans WHERE owner_id=?',[p.p_owner]);
        if (!row) fail('PLAN_MISSING: Kein Finanzplan vorhanden.',404);
        if (Number(row.revision)!==Number(p.p_revision)) fail('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.',409);
        const plan=JSON.parse(row.data), strategies=Array.isArray(plan.strategies)?plan.strategies:[];
        if (!strategies.some((g:any)=>g.id===p.p_strategy)) fail('Anlageziel fehlt',404);
        plan.strategies=strategies.filter((g:any)=>g.id!==p.p_strategy);
        const nextRevision=Number(row.revision)+1, stamp=now();
        const outcomes=await batch(env,[
          {sql:'UPDATE finance_plans SET data=?,revision=?,updated_at=? WHERE owner_id=? AND revision=?',values:[plan,nextRevision,stamp,p.p_owner,p.p_revision]},
          {sql:`UPDATE v12_tasks SET status='cancelled',updated_at=? WHERE owner_id=? AND kind='pie-write' AND status<>'running' AND json_extract(payload,'$.pieId') IN (SELECT pie_id FROM v12_pie_bindings WHERE owner_id=? AND strategy_id=?) AND EXISTS(SELECT 1 FROM finance_plans fp WHERE fp.owner_id=v12_tasks.owner_id AND fp.revision=?)`,values:[stamp,p.p_owner,p.p_owner,p.p_strategy,nextRevision]},
          {sql:`DELETE FROM v12_pie_bindings WHERE owner_id=? AND strategy_id=? AND EXISTS(SELECT 1 FROM finance_plans fp WHERE fp.owner_id=v12_pie_bindings.owner_id AND fp.revision=?)`,values:[p.p_owner,p.p_strategy,nextRevision]},
          {sql:`DELETE FROM advisor_profiles WHERE owner_id=? AND strategy_key=? AND EXISTS(SELECT 1 FROM finance_plans fp WHERE fp.owner_id=advisor_profiles.owner_id AND fp.revision=?)`,values:[p.p_owner,p.p_strategy,nextRevision]},
          {sql:`DELETE FROM wealth_models WHERE owner_id=? AND strategy_key=? AND EXISTS(SELECT 1 FROM finance_plans fp WHERE fp.owner_id=wealth_models.owner_id AND fp.revision=?)`,values:[p.p_owner,p.p_strategy,nextRevision]},
        ]);
        if (!Number(outcomes[0]?.meta?.changes||0)) fail('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.',409);
        result={deleted:true,revision:nextRevision}; break;
      }
      case 'save_v12_binding': {
        const input=p.p_binding||{}, pie=Number(input.pie_id), controller=input.controller, enabled=input.enabled===true;
        const user=await first(env,'SELECT id FROM auth_users WHERE id=?',[p.p_owner]);
        if (!user) fail('ACCOUNT_NOT_READY: Persönliches Konto ist nicht eingerichtet.',409);
        const existing:any=await first(env,'SELECT write_until FROM v12_pie_bindings WHERE owner_id=? AND pie_id=?',[p.p_owner,pie]);
        if (existing?.write_until&&Date.parse(existing.write_until)>Date.now()) fail('PIE_BUSY: Zieländerung wird gerade bestätigt. Bitte kurz warten.',409);
        const fresh=await first(env,'SELECT pie_id FROM v12_broker_pies WHERE owner_id=? AND pie_id=? AND updated_at>?',[p.p_owner,pie,new Date(Date.now()-86400000).toISOString()]);
        if (!fresh) fail('PIE_STALE: Pie zuerst aus Trading212 laden',409);
        if (!['advisor','mirror','manual'].includes(controller)) fail('PIE_INVALID: Advisor, Wikifolio oder Manuell wählen');
        if (controller==='manual'&&enabled) fail('PIE_MANUAL: Manuelle Pies werden nur gelesen');
        const planRow:any=await first(env,'SELECT data FROM finance_plans WHERE owner_id=?',[p.p_owner]);
        const plan=planRow?JSON.parse(planRow.data):{};
        if (controller==='advisor'&&!(plan.strategies||[]).some((g:any)=>g.id===input.strategy_id)) fail('Anlageziel fehlt');
        if (controller==='advisor'&&!(plan.entries||[]).some((e:any)=>e.id===input.plan_entry_id&&e.type==='investment')) fail('Investment-Planzeile fehlt');
        if (controller==='mirror') {
          const source=await first(env,`SELECT symbol FROM v12_mirror_sources WHERE owner_id=? AND symbol=? AND status='verified' AND verified_at>?`,[p.p_owner,String(input.source_symbol||'').toUpperCase(),new Date(Date.now()-86400000).toISOString()]);
          if (!source) fail('Wikifolio-Zugang zuerst vollständig prüfen');
        }
        const stamp=now();
        await batch(env,[
          {sql:`INSERT INTO v12_pie_bindings(owner_id,pie_id,controller,strategy_id,plan_entry_id,source_symbol,enabled,status,expected_hash,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,pie_id) DO UPDATE SET controller=excluded.controller,strategy_id=excluded.strategy_id,plan_entry_id=excluded.plan_entry_id,source_symbol=excluded.source_symbol,enabled=excluded.enabled,status=excluded.status,expected_hash=excluded.expected_hash,pending_hash=NULL,pending_shares=NULL,last_error=NULL,updated_at=excluded.updated_at`,
            values:[p.p_owner,pie,controller,controller==='advisor'?input.strategy_id||null:null,controller==='advisor'?input.plan_entry_id||null:null,controller==='mirror'?String(input.source_symbol||'').toUpperCase():null,enabled,enabled?'active':'paused',input.expected_hash||null,stamp]},
          {sql:`UPDATE v12_tasks SET status='cancelled',updated_at=? WHERE owner_id=? AND kind='pie-write' AND json_extract(payload,'$.pieId')=? AND status<>'running'`,values:[stamp,p.p_owner,pie]},
        ]);
        result=decodeRow('v12_pie_bindings',await first(env,'SELECT * FROM v12_pie_bindings WHERE owner_id=? AND pie_id=?',[p.p_owner,pie])); break;
      }
      case 'claim_advisor_profile': {
        result=await one(env,'advisor_profiles',
          `UPDATE advisor_profiles SET next_due=?,updated_at=? WHERE (owner_id,strategy_key) IN (
             SELECT owner_id,strategy_key FROM advisor_profiles WHERE enabled=1 AND next_due IS NOT NULL AND next_due<=? ORDER BY next_due ASC LIMIT 1
           ) RETURNING *`,[plusSeconds(900),now(),now()]); break;
      }
      default: fail('Unbekannte Datenbankfunktion: '+name,404);
    }
    return json(result);
  } catch (error:any) {
    return json({message:String(error?.message||'Datenbankfehler.').replace(/[\r\n]+/g,' ').slice(0,600),code:'DATABASE_ERROR'},Number(error?.status)||400);
  }
}

export async function reapAndRetain(env:any, daily=false) {
  const statements=[
    {sql:"UPDATE v12_tasks SET status='queued',lease=NULL,next_due=?,updated_at=? WHERE status='running' AND updated_at<?",values:[now(),now(),new Date(Date.now()-1200000).toISOString()]},
    {sql:"UPDATE advisor_jobs SET status='failed',finished_at=?,error='Lauf abgebrochen (Timeout)' WHERE status='running' AND created_at<?",values:[now(),new Date(Date.now()-1800000).toISOString()]},
  ];
  if (daily) statements.push(
    {sql:'DELETE FROM advisor_runs WHERE created_at<?',values:[new Date(Date.now()-366*86400000).toISOString()]},
    {sql:"DELETE FROM advisor_jobs WHERE created_at<? AND status IN ('completed','failed')",values:[new Date(Date.now()-731*86400000).toISOString()]},
    {sql:'DELETE FROM v12_cost_events WHERE created_at<?',values:[new Date(Date.now()-396*86400000).toISOString()]},
    {sql:'DELETE FROM wealth_cache WHERE expires_at<?',values:[now()]},
    {sql:'DELETE FROM auth_sessions WHERE refresh_expires_at<?',values:[now()]},
    {sql:'DELETE FROM auth_verification_tokens WHERE expires_at<?',values:[new Date(Date.now()-86400000).toISOString()]},
  );
  await batch(env,statements);
}
