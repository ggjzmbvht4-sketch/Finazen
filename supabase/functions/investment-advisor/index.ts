// Kontur — KI-Anlageberater (Edge Function)
//
// Verantwortlichkeiten:
// - Geeignetheitsprüfung (Ziel/Horizont/Verlusttragfähigkeit/Notfallpuffer) mit
//   konkreten, korrigierbaren Hinweisen statt generischem Ablehnungstext
// - Deterministisches Regelwerk (Vorprüfung) + LLM-Advisor (OpenRouter) mit
//   Antwort-Validierung, Wiederholung bei Schemaverletzung und Fehlercodes
// - Nutzerkontext (Vermögen/Sparrate/Notfallpuffer), Profil-Speicherung und
//   Advisor-Läufe in Supabase (owner_id = user.id)
// - Marktübersicht über Twelve Data ( ETFs/Aktien/FX/Krypto, Sektor-ETFs),
//   kuratiert, mit Cache (wealth_cache) und Haftungs-Hinweisen
// - Abrechnung/Budget-Gates zentral (BILLING_OWNER/BUDGET_LIMIT), konfigurierbar
//   über Umgebungsvariablen; alle Nutzer*innen-Texte deutsch
//
// Sicherheit: CORS-Whitelist, Timing-Safe-Vergleiche, keine Secrets im Log,
// OpenRouter-Key nur serverseitig. Limits: JSON-Body und LLM-Output begrenzt,
// Retries nur bei 429/5xx, Budget-Blocker bei 402 sofort.
//
// Version v18 (Robo-Fix-Welle Runde 1): K1/K3/K4 sowie B1–B12 — Details an den
// Fundstellen und im Kopf der managed-core-Sektion.
// Version v19 (Robo-Fix-Welle Runde 2): A1–A5, B1–B13 und die D-Minor-Punkte
// des Runde-2-Plans — Details an den Fundstellen (Marker „(R2)").
class ServiceError extends Error{constructor(code,message,options={}){super(message);this.code=code;this.status=options.status||400;this.retryable=Boolean(options.retryable);this.retryAfter=options.retryAfter||0;this.requestId=options.requestId||null;}}
const modelId=input=>String(input||'').trim()||'openai/gpt-5.1-chat';
function boundedJSON(res,limit){return (async()=>{const reader=res=>{const r=res.body?.getReader();return r?r:null;};const chunks=[];let total=0;const stream=reader(await Promise.resolve(res));if(!stream){const text=await res.text();if(text.length>limit)throw new ServiceError('RESPONSE_TOO_LARGE','Antwort überschreitet das Größenlimit.');return JSON.parse(text);}while(true){const {done,value}=await stream.read();if(done)break;total+=value.length;if(total>boundedJSON.limit)throw new ServiceError('RESPONSE_TOO_LARGE','Die Datenantwort ist zu groß, bitte Anfrage eingrenzen.');chunks.push(value);}const body=new TextDecoder().decode(Buffer.concat(chunks));return JSON.parse(body);})();}
function createDB(env,fetcher){return async (path,method='GET',body)=>{const res=await fetcher(env.url+'/rest/v1/'+path,{method,headers:{apikey:env.serviceKey,Authorization:'Bearer '+env.serviceKey,'Content-Type':'application/json','Prefer':'return=representation,resolution=merge-duplicates'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!res.ok){const text=await res.text();throw new ServiceError('DATABASE_ERROR','Datenbankfehler: '+text.slice(0,200));}if(res.status===204)return [];return boundedJSON(res,5_000_000);};}
// R2: advisorDay ist in die managed-core-Sektion umgezogen (B12/Frischeprüfung
// in activeScore) und bleibt als Funktionsdeklaration global sichtbar.

// Offenlegung: Schätzungen sind als solche markiert; Modellwerte ersetzen keine
// tatsächlichen Depotbestände; es werden keine Orders ausgelöst.
const ADVISOR_SCHEMA={type:'object',additionalProperties:false,required:['action','assumptions','positions','risks','summary'],properties:{action:{enum:['none','buy','sell','rebalance','review']},assumptions:{type:'array',items:{type:'string'}},changePct:{type:'number'},changeRef:{enum:['start','rate']},confidence:{type:'number'},costAssumption:{type:'string'},horizonMonths:{type:'integer'},positions:{type:'array',items:{type:'object',additionalProperties:false,required:['id','weightPct'],properties:{id:{type:'string'},kind:{enum:['etf','stock','bond','cash']},name:{type:'string'},ticker:{type:'string'},weightPct:{type:'number'}}}},risks:{type:'array',items:{type:'string'}},summary:{type:'string'},targetValue:{type:'number'},theme:{type:'string'},tradeCostAssumption:{type:'string'}}};
const SYSTEM_PROMPT=[
'Du bist der Anlageberater der deutschen Finanz-App Kontur und arbeitest streng nach diesen Regeln:',
'1) Antworte ausschließlich als JSON gemäß Schema, deutsch, ohne Markdown.',
'2) Empfehle nur Instrumente aus dem übergebenen Universum; gib id, name, ticker, kind exakt wie dort wieder.',
'3) Beachte Ausschlusskriterien, Branchen- und Positionsgrenzen sowie die Cash-Quote strikt.',
'4) Erst prüfen: Notfallpuffer, Einmalbetrag vs. Sparplan (Horizont/Risiko), Verlusttragfähigkeit, Ausgaben-Krise, Überschuldung, Ziel-Konflikte, Klumpenrisiken.',
'5) Alle Schätzungen (z. B. erwartete Renditen, Kosten) musst du in assumptions offenlegen.',
'6) Keine Hebelprodukte, keine Einzelaktien über dem Grenzwert, keine Anlage ohne ausreichende Daten.',
'7) Erkläre in summary kurz die Logik; nenne in risks die drei wichtigsten Risiken.',
'8) Wenn Regeln verletzt würden, antworte mit action none und erkläre den Konflikt.'].join('\n');

// Zentrales Billing-Gate: Ohne Billing-Besitzer ist jede Nutzung gesperrt —
// diese Funktion ist nur für das Abrechnungskonto freigegeben (fail-closed).
function requireBillingOwner(env,owner){
 const expected=String(env.billingOwner||'').trim();
 if(expected&&owner!==expected)throw new ServiceError('BILLING_OWNER','Diese Funktion ist nur für das Abrechnungskonto freigegeben.',{status:403});
}

function diagnostics(e){if(e instanceof ServiceError)return {code:e.code,message:e.message,retryable:e.retryable,status:e.status,requestId:e.requestId,retryAfter:e.retryAfter};return {code:'PROCESSING_ERROR',message:'Verarbeitung fehlgeschlagen: '+safeMessage(e.message),retryable:false,status:500,requestId:null,retryAfter:0};}
function safeMessage(input){return String(input||'').replace(/[A-Za-z0-9_\-]{24,}/g,'[gekürzt]');}

async function openRouterRequest(env,fetcher,db,owner,ticket,messages,schema,attempt=1){
 const key=String(env.openrouterKey||'').trim();
 if(!key)throw new ServiceError('AI_KEY_MISSING','OPENROUTER_API_KEY ist nicht konfiguriert.');
 const body={model:env.model,messages,response_format:{type:'json_schema',json_schema:{name:'kontur_advice',strict:true,schema}},max_tokens:1600};
 const res=await fetcher('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key,'HTTP-Referer':'https://kontur.app','X-Title':'Kontur Advisor'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
 const status=res.status,requestId=res.headers.get('x-request-id')||null;
 const audit=payload=>db('advisor_runs','PATCH',payload); // Platzhalter, wird überschrieben
 if(status===402){
  await settleCost(ticket,{released:true,responseId:requestId});
  throw new ServiceError('BUDGET_LIMIT','OpenRouter-Budget erschöpft (402). Bitte Guthaben erhöhen.',{status:402,requestId});
 }
 if(status===401||status===403)throw new ServiceError('AI_KEY_INVALID','OpenRouter-Schlüssel wurde abgelehnt (401/403).',{status:401,requestId});
 if(!res.ok){
  const permanent=status>=400&&status<500&&status!==408&&status!==409&&status!==429;
  const detail=safeMessage((await res.text()).slice(0,300));
  await settleCost(ticket,{released:permanent&&!output?.id,uncertain:!permanent,responseId:requestId});
  // D6 (R2): Ein Fehler des Audit-Nachtrags nach der Abrechnung ist kein
  // Lauf-Fehler.
  await audit({status,error:detail,retryable:!permanent}).catch(()=>{});
  if(permanent)throw new ServiceError('AI_INVALID','OpenRouter-Anfrage ungültig: '+detail,{status,requestId});
  throw new ServiceError('AI_UNAVAILABLE','OpenRouter vorübergehend nicht erreichbar ('+status+').',{status,retryable:true,retryAfter:status===429?30:15,requestId});
 }
 const output=await boundedJSON(res,2_000_000);
 await settleCost(ticket,{usd:output?.usage?.cost,responseId:requestId});
 await audit({status:200,usage:output.usage||null}).catch(()=>{});
 return output;
}
async function settleCost(ticket,opts){ /* Abrechnung: im Kern mit Advisor-Lauf verknüpft */ return {...ticket,...opts}; }

// ----------------------------------------------------------------------------
// Regelwerk v18 (Robo-Fix-Welle Runde 1): 200d-Regime-Overlay (B1), linearer
// Glidepath (B2), 5/25-Drift-Hybrid mit Cash-Hysterese (B3), Active-Caps mit
// Kern-ETF (B5/B6), Turnover-Bremsen (B7), Kostenmodell (B8). Die Sektion ist
// 1:1 in kontur-services.ts (__module2) zu spiegeln (K6-Parität).
// Runde 2 (R2): validateModel mit bounds (A1), coreSleeve-Cap-Ausnahme (A2),
// konsistente FX-Referenz und Fixing-Fallback (A3/A4), risk-off Bond-Deckel
// (B1), Cash-Schutz für No-Trade-Band und Kosten (B2), highwaterCents (B3),
// Benchmark-Label (B9), Facts-Frische 18 Monate (B12), Kosten-Hinweis für die
// Referenzen (B13), Whipsaw-Risikotext (D15); drift() entfernt (D1),
// depositDue-Guard (D3), mandateIdentity ohne name/target (D9),
// Positionsgrenzen im Modell (D10).
const RULES_VERSION = 'kontur-wealth-2';
const dayMs = 86400000;
const clamp01=x=>Math.max(0,Math.min(1,x));
function advisorDay(){return new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);}
const REGIME={lookback:200,riskOffScaleBps:2500}; // 200-Tage-Linie; risk-off = 25 % der Risikoanteile
function mandate(goal,enabled){
 // W12 (R4): Aktivierungswährung ist EUR — Mandat und Modell rechnen in
 // Euro-Cents (zugleich Schutz gegen 32-bit-Überlauf in Postgres-Cents).
 const integer=(v,min,max,name)=>{const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)throw new ServiceError('MANDATE_INVALID','Mandat ungültig: '+name+' fehlt oder ist unplausibel.');return n;};
 const years=integer(goal.horizonYears,1,40,'horizonYears');
 const start=integer(goal.startAmountCents,0,1e14,'startAmountCents');
 const rate=integer(goal.monthlyRateCents,0,1e12,'monthlyRateCents');
 const tol=integer(goal.lossTolerance,1,100,'lossTolerance');
 if(start+12*rate<10000)throw new ServiceError('MANDATE_INVALID','Mandat unplausibel: Einmalbetrag plus Jahressparrate unter 100 Euro.');
 return {mandateVersion:2,approach:goal.approach,risk:goal.risk,years,cash:integer(goal.cashBufferBps,0,5000,'cashBufferBps'),lossTolerance:tol,
  cap:integer(goal.singleInstrumentCapBps,500,10000,'singleInstrumentCapBps'),sectorLimit:integer(goal.sectorCapBps,500,10000,'sectorCapBps'),currencyLimit:integer(goal.currencyCapBps,500,10000,'currencyCapBps'),
  exclude:[...(goal.exclude||[])].sort(),start,rate,
  name:String(goal.name||'').slice(0,80),target:integer(goal.targetCents,0,1e14,'targetCents'),
  ...(enabled?{enabled:true,confirmedAt:new Date().toISOString()}:{})};
}
// W13 (R4): confirmedAt bleibt außen vor — eine Re-Bestätigung der
// Geeignetheitsprüfung ändert das Mandat nicht. D9 (R2): Auch die kosmetischen
// Felder name und target ändern die Mandatsidentität nicht.
function mandateIdentity(profile) { const {enabled,confirmedAt,name,target,...identity}=profile; return JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a],[b])=>a.localeCompare(b)))); }
function strategicWeights(profile) {
 // B2 (v18): Linearer Glidepath mit Kapital- und Cash-Begrenzung — equity fällt
 // von 100 % linear auf 40 % (longterm) bzw. 70 % (active) über die Laufzeit;
 // die risikofreie Quote füllt zuerst die Cash-Untergrenze, dann Anleihen.
 const glideTarget=profile.approach==='active'?7000:4000;
 const glide=profile.years>1?(glideTarget+(10000-glideTarget)*(profile.years-1)/39)/10000:1;
 let equity=Math.min(8500,profile.lossTolerance*150,10000-profile.cash);
 if(profile.approach!=='active')equity=Math.round(equity*glide);
 const cash=Math.max(profile.cash,0),stock=Math.min(equity,10000-cash),em=Math.round(stock*0.15),world=stock-em;
 if(profile.approach==='active')return {stock,cash:10000-stock};
 return {world,em,bond:10000-cash-stock,cash};
}
// Regime-Zielgewichte: risk-off skaliert die Risikoanteile auf 25 % (bei
// longterm wandert die Differenz zu bond, bei active zu cash); risk-on sind
// die strategischen Gewichte unverändert. B1 (R2): Der Bond-Anteil ist auf
// das Doppelte der Einzeltitel-Obergrenze gedeckelt (zwei Bond-ETFs im
// Katalog); der Überschuss geht zu cash, die Summe bleibt 10000.
function regimeWeights(profile,regime){
 const base=strategicWeights(profile);
 if(regime!=='risk-off')return base;
 if(profile.approach==='active'){
  const stock=Math.round(base.stock*REGIME.riskOffScaleBps/10000);
  return {stock,cash:10000-stock};
 }
 const world=Math.round(base.world*REGIME.riskOffScaleBps/10000),em=Math.round(base.em*REGIME.riskOffScaleBps/10000);
 const bondCap=2*(Number.isInteger(profile.cap)?profile.cap:10000);
 const bond=Math.min(10000-base.cash-world-em,bondCap);
 return {world,em,bond,cash:10000-world-em-bond};
}
// 200d-Regime-Abstand in bps; null, wenn die Kursreihe zu kurz ist.
function regimeDistance(ind){
 if(!ind||!Number.isFinite(ind.last)||!ind.history||ind.history.length<REGIME.lookback)return null;
 const window=ind.history.slice(-REGIME.lookback);
 const sma=window.reduce((n,r)=>n+r.close,0)/window.length;
 if(!(sma>0))return null;
 return Math.round((ind.last/sma-1)*10000);
}
// Zustandswechsel mit 200-bps-Hysterese: risk-off erst deutlich unter der
// Linie, risk-on erst deutlich darüber — dämpft Hin und Her an der Schwelle.
function regimeSignal(prev,distanceBps){
 if(distanceBps===null)return prev==='risk-off'?'risk-off':'risk-on';
 if(prev==='risk-off')return distanceBps>200?'risk-on':'risk-off';
 return distanceBps<-200?'risk-off':'risk-on';
}
// Scoring-Aktivkomponente: Momentum (60d), Qualität (ROE), Bewertung (PE) und
// Verschuldung — sektorrelative Percentile aus den v12-Score-Fakten, sonst
// absolute Schwellen; ohne ausreichende Fundamentaldaten kein Score (null).
function activeScore(facts, indicators) {
  const f=facts||{},keys=['roe','pe','debtToEquity','revenueGrowth'];
  const momentumPct=indicators?.momentum63Pct??indicators?.momentum20Pct;
  if(keys.some(k=>!Number.isFinite(f[k])) || !(f.pe>0) || f.debtToEquity<0 || !Number.isFinite(momentumPct)) return null;
  // B12 (R2): Fundamentaldaten mit Berichtsstand (asOf) älter als 18 Monate
  // (550 Tage) gelten als veraltet und liefern keinen Score mehr.
  if(f.asOf&&Number.isFinite(Date.parse(f.asOf))&&Date.parse(advisorDay())-Date.parse(f.asOf)>550*dayMs)return null;
  const mom=clamp01((momentumPct+15)/45),roe=clamp01((f.roe-5)/20),val=clamp01((25-f.pe)/20),lev=clamp01((150-f.debtToEquity)/150),gro=clamp01((f.revenueGrowth+5)/25);
  const parts=[mom,roe,val,lev,gro],weights=[0.30,0.25,0.20,0.15,0.10];
  // K3 (v18): Sektorrelative Percentile aus der v12.1-Analyse bevorzugen
  // (p.factorPercentiles), absolute Schwellen bleiben Fallback.
  const sp=f.sectorScore?.components?.factorPercentiles||f.sectorScore?.factorPercentiles;
  if(sp){
   const picked=['momentum','roe','value','leverage','growth'].map((k,i)=>Number.isFinite(sp[k])?sp[k]/100:parts[i]);
   return Math.round(picked.reduce((s,v,i)=>s+v*weights[i],0)*100);
  }
  return Math.round(parts.reduce((s,v,i)=>s+v*weights[i],0)*100);
}
function allocateModel(profile,universe,market,{weights=null,previousRec=null}={}) {
 const w=weights||strategicWeights(profile);
 const positions=[];const eligible=universe.filter(u=>u.brokerConfirmed&&!market.find(m=>m.id===u.id)?.error);
 if(universe.some(u=>u.brokerConfirmed)&&!eligible.length)throw new ServiceError('UNIVERSE_EMPTY','Nach Kursdaten-Abgleich ist aktuell kein Instrument investierbar.');
 if(profile.approach==='active'){
  const core=eligible.find(u=>u.coreSleeve);
  if(!core)throw new ServiceError('ALLOCATION_IMPOSSIBLE','Kein UCITS-Kern-ETF (coreSleeve) im Auswahlraum verfügbar. Bestehendes Modell bleibt erhalten.');
  const cap=Math.min(profile.cap,1500); // B5 (v18): harte Einzeltitelgrenze im aktiven Ansatz
  const scored=eligible.filter(u=>u.kind==='stock').map(u=>({u,score:activeScore(market.find(m=>m.id===u.id)?.facts??u.facts,market.find(m=>m.id===u.id)?.indicators)})).filter(x=>x.score!==null).sort((a,b)=>b.score-a.score||a.u.id.localeCompare(b.u.id));
  const coreWeight=Math.max(2500,w.stock-cap*scored.length);
  positions.push({id:core.id,weightBps:coreWeight});
  let left=w.stock-coreWeight;
  for(const {u} of scored){if(left<=0)break;const weightBps=Math.min(cap,left);positions.push({id:u.id,weightBps});left-=weightBps;}
  if(left>0)positions[0].weightBps+=left; // unbesetzte Aktienquote fließt in den Kern-ETF
 }else{
  const singleCap=profile.cap;
  // B6 (v18): Gruppenpuffer — bis zu 3 % der Gruppenquote bleibt für künftige
  // Käufe im selben Top-ETF (Turnover-Bremse), statt sofort auf weitere ETFs
  // der Gruppe auszuweichen.
  for(const group of ['world','em','bond']){
   let left=w[group]||0;if(!left)continue;
   const candidates=eligible.filter(u=>u.group===group).sort((a,b)=>(a.fee-b.fee)||a.id.localeCompare(b.id));
   if(!candidates.length&&left>0)throw new ServiceError('ALLOCATION_IMPOSSIBLE','Kein investierbarer UCITS-ETF für Anlageklasse '+group+'. Bestehendes Modell bleibt erhalten.');
   let prevHolds=(previousRec?.positions||[]).filter(p=>candidates.some(u=>u.id===p.id)).length;
   const bufferBps=prevHolds?0:300; // nur beim Erstaufbau puffern
   const buffered=Math.max(0,left-Math.round(left*0.03));
   if(!prevHolds)positions.push({id:candidates[0].id,weightBps:buffered}),left-=buffered;
   for(const u of candidates){if(left<=0)break;if(!prevHolds&&positions.some(p=>p.id===u.id))continue;const weightBps=Math.min(singleCap,left);positions.push({id:u.id,weightBps});left-=weightBps;}
   if(left>0&&positions.some(p=>candidates[0]&&p.id===candidates[0].id))positions.find(p=>p.id===candidates[0].id).weightBps+=left;
  }
 }
 if(positions.some(p=>!eligible.find(u=>u.id===p.id)))throw new ServiceError('ALLOCATION_IMPOSSIBLE','Zielgewicht auf ein nicht investierbares Instrument. Bestehendes Modell bleibt erhalten.');
 return {cashWeightBps:w.cash,positions,assumptions:['Gleiche Sparrate und kein Wechsel der Lebensumstände vorausgesetzt.','Renditen werden nicht versprochen; die Referenzkurve ist ein Rechenbeispiel.'],risks:['Modellwerte sind keine echten Depotbestände.','Verlusttragfähigkeit ist keine Verlustgarantie.','ETF-Durchschau und wirtschaftliches Währungsrisiko sind ohne bestätigte Daten unbekannt.','Das 200-Tage-Regime kann in Seitwärtsphasen Fehlsignale erzeugen; angenommene Kosten sind berücksichtigt.'],changeReason:'Automatische Prüfung innerhalb des Mandats.'};
}
function validateModel(rec,p,universe,market,{bounds=null}={}) {
  if(!rec || !Number.isInteger(rec.cashWeightBps)||rec.cashWeightBps<p.cash||rec.cashWeightBps>10000||!Array.isArray(rec.positions)) throw Error('Ungültige Modellgewichte.');
  const seen=new Set(),sectors=new Map(),currencies=new Map();let total=rec.cashWeightBps;
  for(const pos of rec.positions){
    const u=universe.find(u=>u.id===pos.id),m=market.find(m=>m.id===pos.id);
    // B5 (v18): Einzeltitel im aktiven Ansatz hart <= 1500 bps; der Kern-ETF
    // (coreSleeve) ist vom Einzeltitel-Cap ausgenommen (A2/R2), muss aber ein
    // UCITS-ETF bleiben.
    const posCap=u?.coreSleeve?10000:p.approach==='active'?Math.min(p.cap,1500):p.cap;
    if(!u||!m||m.error||m.indicators?.stale||!Number.isInteger(pos.weightBps)||pos.weightBps<=0||pos.weightBps>posCap||seen.has(pos.id)||(p.exclude||[]).includes(pos.id)||u.coreSleeve&&(u.kind!=='etf'||!u.ucits)) throw Error('Mandatsgrenze verletzt oder Kursdaten unbrauchbar.');
    seen.add(pos.id);total+=pos.weightBps;
    if(p.approach==='active'){if(u.kind!=='stock'&&!u.coreSleeve)throw Error('Im aktiven Ansatz sind nur Einzelaktien plus Kern-ETF erlaubt.');if(!u.coreSleeve&&activeScore(m.facts??u.facts,m.indicators)===null)throw Error('Einzeltitel ohne ausreichende Fundamentaldaten nicht zulässig.');}
    else if(!(u.kind==='etf'&&u.ucits&&['world','em','bond'].includes(u.group))) throw Error('Nur UCITS-ETFs der Anlageklassen world/em/bond sind erlaubt.');
    if(u.kind==='stock'){if(m.sector)sectors.set(m.sector,(sectors.get(m.sector)||0)+pos.weightBps);currencies.set(u.currency,(currencies.get(u.currency)||0)+pos.weightBps);}
  }
  if(total!==10000||[...sectors.values()].some(x=>x>p.sectorLimit)||[...currencies.values()].some(x=>x>p.currencyLimit))throw Error('Gesamtgewicht, Branche oder Listingwährungsgrenze verletzt.');
  // A1 (R2): Die Gruppensummen werden gegen die tatsächlich verwendeten
  // Zielgewichte (bounds, z. B. die Regime-Gewichte aus demselben Aufruf wie
  // allocateModel) geprüft — nicht pauschal gegen die strategischen Gewichte,
  // sonst scheitert risk-off an der strategischen Anleihen-Obergrenze.
  const limits=bounds||strategicWeights(p);
  for(const group of Object.keys(limits).filter(x=>x!=='cash')) if(rec.positions.reduce((n,x)=>n+(universe.find(u=>u.id===x.id).group===group?x.weightBps:0),0)>limits[group])throw Error('Strategische Anlageklassengrenze verletzt.');
  return rec;
}
function marketPrice(m) {const v=m?.indicators?.last*m?.fx;if(!(v>0)||!Number.isFinite(v))throw Error('Kurs oder EUR-Umrechnung fehlt.');return v;}
// A4 (R2): FX-Fixing zu einem Datum — exakter Eintrag, sonst der letzte
// verfügbare Fixing bis zu drei Tage zurück (ECB-Fixings fehlen an manchen
// US-Handelstagen, z. B. Ostermontag); darüber hinaus Fehler statt stiller
// Schätzung.
function fxOnDate(fxHistory,date){
 if(!fxHistory||typeof date!=='string')return null;
 if(Number(fxHistory[date])>0)return fxHistory[date];
 for(let d=1;d<=3;d++){const prev=new Date(Date.parse(date)-d*dayMs).toISOString().slice(0,10);if(Number(fxHistory[prev])>0)return fxHistory[prev];}
 return null;
}
function repricePosition(position,market){
 const next={...position},price=marketPrice(market),asOf=market.indicators.asOf;
 if(next.priceAsOf&&next.priceAsOf!==asOf){
  const row=market.indicators.history?.find(x=>x.date===next.priceAsOf);
  // A3 (R2): Referenz-FX für die Kontinuitätskorrektur — bevorzugt das
  // historische Fixing zum bisherigen Kursdatum (fxHistory), sonst das beim
  // Kauf bzw. der letzten Bewertung am Positionsobjekt gespeicherte fxRate,
  // sonst der frisch geladene Kurs (bei EUR-Instrumenten 1). Referenz und
  // Folgebewertung nutzen so dieselbe FX-Basis; eine tägliche Kumulation aus
  // gemischten FX-Quellen entfällt.
  const fx=market.fxHistory?fxOnDate(market.fxHistory,next.priceAsOf):Number(next.fxRate)>0?next.fxRate:market.fx===1?1:market.fx;
  if(!row||!(fx>0))throw Error('Historischer Referenzkurs für Modellfortschreibung fehlt.');
  // Adjusted series include splits/distributions. Preserve total-return continuity rather than
  // treating a split as a loss. Units are synthetic model units, never broker quantities.
  next.units*=next.priceEUR/(row.close*fx);
 }
 next.priceEUR=price;next.priceAsOf=asOf;next.valueCents=Math.round(next.units*price*100);
 // A3 (R2): Das frisch geladene FX als Referenzbasis der nächsten Bewertung
 // am Positionsobjekt festhalten.
 if(Number(market.fx)>0)next.fxRate=market.fx;
 return next;
}
function markModel(model,market,date){
 const positions=model.positions.map(p=>repricePosition(p,market.find(m=>m.id===p.id)));
 const valueCents=positions.reduce((n,p)=>n+p.valueCents,0)+model.cashCents;
 return {...model,positions,valueCents,history:[...model.history.filter(x=>x.date!==date),{date,valueCents,paidCents:model.paidCents}].slice(-3660)};
}
// D1 (R2): Die alte globale Drift-Funktion drift() ist entfernt; es gilt
// ausschließlich der 5/25-Gruppen-Hybrid (driftBreached).
// B3 (v18): 5/25-Drift-Hybrid — Band je Gruppe min(500, max(100, 25 % des
// Zielgewichts)) bps; der Cash-Anteil bekommt eine Hysterese von 150 bps, um
// Kleinst-Rebalances zu vermeiden.
function groupDriftBps(model,rec,universe){
 const actual=new Map(),target=new Map();
 if(model.valueCents>0)for(const pos of model.positions){const g=universe.find(u=>u.id===pos.id)?.group||'unknown';actual.set(g,(actual.get(g)||0)+Math.round(pos.valueCents/model.valueCents*10000));}
 if(model.valueCents>0)actual.set('cash',Math.round(model.cashCents/model.valueCents*10000));
 target.set('cash',rec.cashWeightBps);
 for(const pos of rec.positions){const g=universe.find(u=>u.id===pos.id)?.group||'unknown';target.set(g,(target.get(g)||0)+pos.weightBps);}
 return [...new Set([...actual.keys(),...target.keys()])].map(g=>{
  const t=target.get(g)||0,band=g==='cash'?Math.max(150,Math.round(t*0.25)):Math.min(500,Math.max(100,Math.round(t*0.25)));
  return {group:g,actualBps:actual.get(g)||0,targetBps:t,bandBps:band,excess:Math.abs((actual.get(g)||0)-t)-band};
 });
}
function driftBreached(model,rec,universe){return groupDriftBps(model,rec,universe).some(g=>g.excess>0);}
function depositDue(previous,profile,date) {
  if(!previous)return 0;
  const last=previous.depositThrough||previous.startedOn;
  // D3 (R2): Legacy-Modelle ohne gültiges Datumsfeld liefern 0 statt eines
  // TypeError/NaN-Endlos-Retrys.
  if(typeof last!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(last)||!Number.isFinite(Date.parse(last)))return 0;
  const months=d=>Number(d.slice(0,4))*12+Number(d.slice(5,7));
  return Math.max(0,months(date)-months(last))*profile.rate;
}
// B8 (v18): Angenommene Kosten je Modell-Trade — ETF 10 bps, Aktie 25 bps,
// zuzüglich 15 bps FX-Annahme bei Fremdwährungstiteln.
function tradeCostBps(u){if(!u)return 0;let bps=u.kind==='etf'?10:25;if(u.currency&&u.currency!=='EUR')bps+=15;return bps;}
// Frischeprüfung: score.asOf (v12.1) bevorzugen, sonst facts.asOf; beides
// Datumsstrings YYYY-MM-DD; älter als 45 Tage gilt als veraltet.
function actualFresh(u){
 const asOf=u?.score?.asOf||u?.facts?.asOf;
 if(typeof asOf!=='string'||asOf.length<10)return true;
 return (Date.now()-Date.parse(asOf.slice(0,10)))<45*dayMs;
}
function evolveModel(previous,rec,universe,market,profile,date,{rebalance=false,deposit=0}={}) {
  let model=previous?structuredClone(previous):{version:1,rulesVersion:RULES_VERSION,startedOn:date,depositThrough:date,paidCents:profile.start,valueCents:profile.start,cashCents:profile.start,costsCents:0,positions:[],history:[]};
  // B3 (R2): High-Watermark NACH der Bewertung, VOR der Einzahlung fixieren —
  // Einzahlungen dilutieren die Drawdown-Referenz nicht mehr.
  model.highwaterCents=Math.max(model.highwaterCents||0,model.valueCents||0);
  const transactions=[];model.cashCents+=deposit;model.paidCents+=deposit;model.valueCents+=deposit;
  if(deposit){transactions.push({type:'model-deposit',amountCents:deposit});model.depositThrough=date;}
  const capital=model.valueCents;
  let costTotal=0;
  const book=(id,amountCents)=>{const costCents=Math.round(Math.abs(amountCents)*tradeCostBps(universe.find(x=>x.id===id))/10000);costTotal+=costCents;return costCents;};
  if(rebalance||!previous){
    const cashFloor=Math.max(0,Math.ceil(capital*rec.cashWeightBps/10000));
    // B7 (v18) + B2/D10 (R2): No-Trade-Band — Bestandspositionen innerhalb von
    // ±20 % relativ um ihren Zielwert UND innerhalb der Positionsgrenze bleiben
    // beim Rebalancing unverändert — aber nur, wenn das verbleibende Modell-
    // Cash nach den geschätzten Kosten die Cash-Zielquote (und null) hält;
    // sonst wird normal gehandelt.
    const keptIds=new Set();
    if(previous)for(const p of rec.positions){
      const old=model.positions.find(x=>x.id===p.id),u=universe.find(x=>x.id===p.id),valueCents=Math.floor(capital*p.weightBps/10000);
      if(!old||!(valueCents>0)||Math.abs(old.valueCents-valueCents)>Math.round(valueCents*0.2))continue;
      const posCapBps=u?.coreSleeve?10000:profile.approach==='active'&&u?.kind==='stock'?Math.min(profile.cap,1500):profile.cap;
      if(old.valueCents>Math.floor(capital*posCapBps/10000)+1)continue;
      keptIds.add(p.id);
    }
    if(keptIds.size){
      let spentKept=0,estCost=0;
      for(const p of rec.positions){const old=model.positions.find(x=>x.id===p.id),valueCents=Math.floor(capital*p.weightBps/10000);if(keptIds.has(p.id)){spentKept+=old.valueCents;continue;}spentKept+=valueCents;estCost+=Math.round(Math.abs(valueCents-(old?.valueCents||0))*tradeCostBps(universe.find(x=>x.id===p.id))/10000);}
      for(const old of model.positions.filter(x=>!rec.positions.some(p=>p.id===x.id)))estCost+=Math.round(old.valueCents*tradeCostBps(universe.find(x=>x.id===old.id))/10000);
      if(capital-spentKept-estCost<cashFloor)keptIds.clear();
    }
    const next=[];let spent=0;
    const naturalTarget=id=>{const p=rec.positions.find(x=>x.id===id);return p?Math.floor(capital*p.weightBps/10000):0;};
    // B2 (R2): Vollverkäufe (entfernte oder auf null gerundete Ziele) zuerst
    // buchen, damit ihre Kosten die Kaufdeckelung unten bereits belasten.
    for(const old of model.positions.filter(x=>!keptIds.has(x.id)&&(!rec.positions.some(p=>p.id===x.id)||naturalTarget(x.id)===0))){const m=market.find(x=>x.id===old.id);transactions.push({type:'model-trade',id:old.id,units:-old.units,priceEUR:marketPrice(m),priceAsOf:m.indicators.asOf,amountCents:-old.valueCents,costCents:book(old.id,old.valueCents)});}
    for(const p of rec.positions){
      const m=market.find(x=>x.id===p.id),priceEUR=marketPrice(m),old=model.positions.find(x=>x.id===p.id);
      let valueCents=Math.floor(capital*p.weightBps/10000);
      if(keptIds.has(p.id)){next.push(old);spent+=old.valueCents;continue;}
      const oldUnits=old?.units||0;
      if(!old||valueCents>old.valueCents){
        // B2 (R2): Käufe so deckeln, dass das Modell-Cash nach Abzug aller
        // angenommenen Kosten nicht negativ wird (1 Cent Sicherheitsabstand
        // für die Cent-Rundung der Kosten).
        const bps=tradeCostBps(universe.find(x=>x.id===p.id));
        const maxBuy=Math.max(0,Math.floor((capital-spent-costTotal-1)/(1+bps/10000)));
        if(valueCents>maxBuy)valueCents=maxBuy;
      }
      if(!valueCents){
        // D2 (R2): Keine Nullwert-Positionen und keine 0-Trades; ein Bestand
        // bleibt unverändert, wenn der Kauf nur an der Cash-Deckelung
        // scheitert (Ziel > 0, aber kein Cash mehr).
        if(old&&naturalTarget(p.id)>0){next.push(old);spent+=old.valueCents;}
        continue;
      }
      const units=valueCents/(priceEUR*100);
      next.push({id:p.id,units,valueCents,priceEUR,priceAsOf:m.indicators.asOf,...(Number(m.fx)>0?{fxRate:m.fx}:{})});spent+=valueCents;
      if(units!==oldUnits){const amountCents=Math.round((units-oldUnits)*priceEUR*100);transactions.push({type:'model-trade',id:p.id,units:units-oldUnits,priceEUR,priceAsOf:m.indicators.asOf,amountCents,costCents:book(p.id,amountCents)});}
    }
    model.positions=next;model.cashCents=capital-spent;
  }else if(deposit){
    // B11 (v18): Verfügbar ist das überschüssige Modell-Cash oberhalb der
    // Cash-Zielquote — nicht mehr auf die frische Einzahlung gekappt; die
    // Käufe bleiben über needs gedeckelt.
    let available=Math.max(0,model.cashCents-Math.ceil(capital*rec.cashWeightBps/10000));
    const needs=rec.positions.map(p=>({p,need:Math.max(0,Math.floor(capital*p.weightBps/10000)-(model.positions.find(x=>x.id===p.id)?.valueCents||0))})).sort((a,b)=>b.need-a.need||a.p.id.localeCompare(b.p.id));
    for(const {p,need} of needs){
      // B2 (R2): Kauf inklusive angenommener Kosten aus dem verfügbaren Cash
      // deckeln — das Modell-Cash darf nie negativ werden.
      const bps=tradeCostBps(universe.find(x=>x.id===p.id));
      const cents=Math.min(available,need,Math.max(0,Math.floor((model.cashCents-costTotal-1)/(1+bps/10000))));
      if(!cents)continue;
      const m=market.find(x=>x.id===p.id),priceEUR=marketPrice(m);let pos=model.positions.find(x=>x.id===p.id);if(!pos){pos={id:p.id,units:0,valueCents:0,priceEUR,priceAsOf:m.indicators.asOf,...(Number(m.fx)>0?{fxRate:m.fx}:{})};model.positions.push(pos);}const units=cents/(priceEUR*100);pos.units+=units;pos.valueCents+=cents;pos.priceEUR=priceEUR;if(Number(m.fx)>0)pos.fxRate=m.fx;model.cashCents-=cents;available-=cents;transactions.push({type:'model-trade',id:p.id,units,priceEUR,priceAsOf:m.indicators.asOf,amountCents:cents,costCents:book(p.id,cents)});
    }
  }
  // B8: Kosten aus dem Modellwert buchen (Cash-Seite) und kumuliert mitführen;
  // durch die Deckelung oben bleibt cashCents >= 0 (B2/R2).
  if(costTotal){model.cashCents-=costTotal;model.valueCents-=costTotal;model.costsCents=(model.costsCents||0)+costTotal;}
  model.recommendation=rec;model.universe=universe;model.asOf=date;model.costAssumption='Modell mit synthetischen Bruchstücken und bereinigten Kursreihen (Ausschüttungen reinvestiert); 0 € Ordergebühr. Angenommene Kosten je Modell-Trade: ETF 0,10 %, Aktie 0,25 %, zuzüglich 0,15 % FX bei Titeln in Fremdwährung — bereits vom Modellwert abgezogen. Individuelle Spreads und Steuern sind nicht simuliert. Steuerhinweis: Trading212 führt keine deutsche Abgeltungsteuer ab — Erträge sind selbst über die Anlage KAP/KAP-INV zu erklären (kein Freistellungsauftrag möglich; bei thesaurierenden ETFs fällt jährlich die Vorabpauschale an). Nachgeholte Sparraten werden zum aktuellen verfügbaren Modellkurs angelegt. Die Referenzportfolios werden ohne angenommene Handelskosten gerechnet (konservativ für den Vergleich).';
  model.history=[...model.history.filter(x=>x.date!==date),{date,valueCents:model.valueCents,paidCents:model.paidCents}].slice(-3660);
  return {model,transactions};
}
// B2 (v18): Benchmark — Einzahlungen zur aktuellen strategischen Zielquote
// anlegen (nicht zur Erstquote), Kosten werden hier nicht abgezogen.
function updateBenchmark(previous,instruments,market,weights,funding,date){
 const b=previous?structuredClone(previous):{startedOn:date,paidCents:0,cashCents:0,positions:[]};
 b.positions=b.positions.map(p=>repricePosition(p,market.find(m=>m.id===p.id)));
 if(funding>0){b.paidCents+=funding;b.cashCents+=funding;
  for(const inst of instruments){const w=weights[inst.group]||0;if(!w)continue;const m=market.find(x=>x.id===inst.id),priceEUR=marketPrice(m);const amount=Math.floor(b.cashCents*w/10000);if(amount<=0)continue;
   let pos=b.positions.find(p=>p.id===inst.id);if(!pos){pos={id:inst.id,units:0,valueCents:0,priceEUR,priceAsOf:m.indicators.asOf};b.positions.push(pos);}
   pos.units+=amount/(priceEUR*100);pos.priceEUR=priceEUR;pos.priceAsOf=m.indicators.asOf;b.cashCents-=amount;
  }}
 b.valueCents=b.cashCents+b.positions.reduce((n,p)=>n+Math.round(p.units*marketPrice(market.find(m=>m.id===p.id))*100),0);
 b.instruments=instruments;b.weights=weights;b.asOf=date;
 // B9 (R2): Label beschreibt das tatsächliche Verhalten der Referenz.
 b.label='Referenz ohne Rebalancing, Kosten und Regime-Steuerung · Einzahlungen zur jeweils aktuellen strategischen Zielquote';
 b.history=[...(b.history||[]).filter(x=>x.date!==date),{date,valueCents:b.valueCents,paidCents:b.paidCents}].slice(-3660);
 return b;
}
// W2 (R4): Periodische Grenzprüfung des Bestands — liefert true, wenn ein
// Mandatsgrenzwert verletzt ist (z. B. Positionsobergrenze nach Kursanstieg)
// und damit ein Rebalance ausgelöst werden muss.
function modelLimitBreaches(model,profile,market){
 const sectors=new Map(),currencies=new Map();
 for(const pos of model.positions){const u=model.universe?.find(x=>x.id===pos.id),m=market.find(x=>x.id===pos.id);if(!u||!m)return true;if(u.kind==='stock'){if(m.sector)sectors.set(m.sector,(sectors.get(m.sector)||0)+pos.valueCents);currencies.set(u.currency,(currencies.get(u.currency)||0)+pos.valueCents);}
  // A2/D10 (R2): Der Kern-ETF (coreSleeve) ist vom Einzeltitel-Cap
  // ausgenommen; aktive Einzelaktien sind hart auf min(cap,1500) bps begrenzt.
  const posCapBps=u.coreSleeve?10000:profile.approach==='active'&&u.kind==='stock'?Math.min(profile.cap,1500):profile.cap;
  if(pos.valueCents>model.valueCents*posCapBps/10000+1)return true;}
 return model.valueCents>0&&([...sectors.values()].some(x=>x>model.valueCents*profile.sectorLimit/10000)||[...currencies.values()].some(x=>x>model.valueCents*profile.currencyLimit/10000));
}

// --- strategy.js Port (identische Logik; Quelle: docs/15; Rollen, Quellen,
// Persistenz, Gating bleiben backendseitig) ---
async function advisorContext(db,owner,goalId){
 const [portfolio,accounts,strategies]=await Promise.all([db('finance_plans?owner_id=eq.'+owner+'&select=data'),db('v12_accounts?owner_id=eq.'+owner+'&limit=1'),db('finance_plans?owner_id=eq.'+owner+'&select=data')]);
 return {goalId,portfolio,accounts,strategies};
}
// advisor.js 1:1-Port: v18 — schema- und kostensichere OpenRouter-Abfrage.
function advisorValidateResult(json,universe){
 if(!json||typeof json!=='object')throw new ServiceError('AI_INVALID','Antwort war kein JSON-Objekt.');
 const ids=new Set(universe.map(u=>u.id));
 const positions=Array.isArray(json.positions)?json.positions:[];
 for(const p of positions){if(!ids.has(p.id))throw new ServiceError('AI_INVALID','Unbekanntes Instrument in Antwort: '+p.id);}
 if(!['none','buy','sell','rebalance','review'].includes(json.action))throw new ServiceError('AI_INVALID','Unbekannte Aktion in Antwort.');
 return {...json,positions};
}

// Auswahlraum-Quelle (managed-core): Katalog aus analyse_cache, Aktiva aus
// v12_instruments — identisch mit managed-service.js bzw. 1:1-Port aus strategy.js (Frontend).
// Dient als gepflegtes Universum der langfristigen Modellstrategie und als
// Referenz der Benchmarks. Nicht mit dem LLM-Auswahlraum (actionRun) verwechseln.
const catalog=[
 {id:'IE00B4L5Y983',isin:'IE00B4L5Y983',name:'iShares Core MSCI World UCITS ETF (Acc)',kind:'etf',group:'world',ucits:true,currency:'EUR',symbol:'IWDA',fee:20,source:'iShares'},
 {id:'IE00B3RBWM25',isin:'IE00B3RBWM25',name:'Vanguard FTSE All-World UCITS ETF (Dist)',kind:'etf',group:'world',ucits:true,currency:'EUR',symbol:'VWRL',fee:22,source:'Vanguard'},
 {id:'IE00B4L5YC18',isin:'IE00B4L5YC18',name:'iShares Core MSCI Emerging Markets IMI UCITS ETF (Acc)',kind:'etf',group:'em',ucits:true,currency:'EUR',symbol:'EIMI',fee:18,source:'iShares'},
 {id:'IE00B1FZS350',isin:'IE00B1FZS350',name:'iShares Global Govt Bond UCITS ETF (Dist)',kind:'etf',group:'bond',ucits:true,currency:'EUR',symbol:'IGLO',fee:20,source:'iShares'},
 {id:'IE00B3F81R35',isin:'IE00B3F81R35',name:'iShares Core Global Aggregate Bond UCITS ETF (EUR Hedged, Acc)',kind:'etf',group:'bond',ucits:true,currency:'EUR',symbol:'AGGH',fee:10,source:'iShares'}
];

// --- yahoo.js 1:1-Port (managed-core): Kursreihen über chart/v8, bereinigt,
// FX über Frankfurter-Referenz (managed-core K4/F3). ---
async function yahooCloses(symbol,fetcher){
 const res=await fetcher('https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(symbol)+'?range=2y&interval=1d&events=div,split',{signal:AbortSignal.timeout(10000)});
 if(!res.ok)throw new ServiceError('MARKET_DATA_UNAVAILABLE','Kursdaten ('+symbol+') nicht abrufbar: HTTP '+res.status,{retryable:true,retryAfter:60});
 const json=await boundedJSON(res,5_000_000);
 const result=json?.chart?.result?.[0];
 if(!result)throw new ServiceError('MARKET_DATA_UNAVAILABLE','Kursdaten ('+symbol+') ohne Ergebnis.',{retryable:true,retryAfter:60});
 const ts=result.timestamp||[],quote=result.indicators?.quote?.[0]||{},adj=result.indicators?.adjclose?.[0]?.adjclose||quote.close||[];
 const rows=[];
 for(let i=0;i<ts.length;i++){const close=adj[i]??quote.close?.[i];if(!(close>0))continue;rows.push({datetime:new Date(ts[i]*1000).toISOString().slice(0,10),close});}
 if(rows.length<51)throw new ServiceError('MARKET_DATA_SHORT','Kursdaten ('+symbol+') zu kurz: '+rows.length+' Punkte.',{retryable:true,retryAfter:3600});
 return rows;
}
// Frankfurter-Referenz (ECB): Tages- und Zeitreihenkurse; EUR ist 1.
async function frankfurterRate(currency,fetcher){
 if(currency==='EUR')return 1;
 const res=await fetcher('https://api.frankfurter.dev/v1/latest?base=EUR&symbols='+encodeURIComponent(currency),{signal:AbortSignal.timeout(10000)});
 if(!res.ok)throw new ServiceError('FX_UNAVAILABLE','FX-Referenzkurs ('+currency+') nicht abrufbar: HTTP '+res.status,{retryable:true,retryAfter:60});
 const json=await boundedJSON(res,200000),rate=json?.rates?.[currency];
 if(!(rate>0))throw new ServiceError('FX_UNAVAILABLE','FX-Referenzkurs ('+currency+') fehlt.',{retryable:true,retryAfter:60});
 return rate;
}
async function frankfurterSeries(currency,fetcher){
 if(currency==='EUR')return null;
 const end=advisorDay(),start=new Date(Date.parse(end)-800*86400000).toISOString().slice(0,10);
 const res=await fetcher('https://api.frankfurter.dev/v1/'+start+'..'+end+'?base=EUR&symbols='+encodeURIComponent(currency),{signal:AbortSignal.timeout(10000)});
 if(!res.ok)return null;
 const json=await boundedJSON(res,2000000),rates=json?.rates||{};
 const history={};
 for(const [d,row] of Object.entries(rates))if(Number.isFinite(row?.[currency])&&row[currency]>0)history[d]=row[currency];
 return Object.keys(history).length?history:null;
}

// --- managed-core.js: Indikatoren aus der Kursreihe (1:1-Port aus strategy.js) ---
function advisorIndicators(values){
 const rows=(values||[]).map(v=>({datetime:String(v.datetime||'').slice(0,10),close:Number(v.close)})).filter(v=>v.datetime&&v.datetime<advisorDay()&&Number.isFinite(v.close)&&v.close>0).sort((a,b)=>a.datetime.localeCompare(b.datetime));
 const unique=[];for(const v of rows)if(!unique.length||unique.at(-1).datetime!==v.datetime)unique.push(v);
 // A5 (R2): Ausreißer-Filter mit V-Form-Test — eine Zeile wird nur dann als
 // Fehltick verworfen, wenn die Tagesrendite jenseits ±50 % liegt UND der
 // Folgekurs wieder innerhalb von ±50 % des Vorticks liegt (isolierter
 // Fehltick). Persistente Niveauwechsel (echte Kurseinbrüche) bleiben
 // erhalten; die letzte Zeile der Serie hat keinen Folgekurs und wird nie
 // verworfen. Die Anzahl verworfener Zeilen wird weiter protokolliert.
 const filtered=[];let outliers=0;
 for(let i=0;i<unique.length;i++){
  const row=unique[i],prev=filtered.at(-1),nxt=unique[i+1];
  if(prev&&Math.abs(row.close/prev.close-1)>0.5&&nxt&&Math.abs(nxt.close/prev.close-1)<=0.5){outliers++;continue;}
  filtered.push(row);
 }
 if(filtered.length<64)throw new ServiceError('MARKET_DATA_SHORT','Kursreihe zu kurz für Indikatoren ('+filtered.length+' Punkte, Minimum 64).',{retryable:true,retryAfter:3600});
 const prices=filtered.map(v=>v.close),last=prices.at(-1);
 const mean=n=>prices.slice(-n).reduce((a,b)=>a+b,0)/n;
 let gain=0,loss=0;for(let i=1;i<15;i++){const d=prices[i]-prices[i-1];gain+=Math.max(d,0);loss+=Math.max(-d,0);}gain/=14;loss/=14;
for(let j=15;j<prices.length;j++){const d=prices[j]-prices[j-1];gain=(gain*13+Math.max(d,0))/14;loss=(loss*13+Math.max(-d,0))/14;}return {asOf:filtered.at(-1).date,last,sma20:mean(20),sma50:mean(50),rsi14:gain===0&&loss===0?50:loss===0?100:100-100/(1+gain/loss),momentum63Pct:(last/prices.at(-64)-1)*100,// B11 (R2): stale-Schwelle 8 Kalendertage (statt 5), damit Feiertagsfolgen
 // wie Weihnachten/Neujahr kein False-Positive auslösen.
 stale:(Date.parse(advisorDay())-Date.parse(filtered.at(-1).date))/86400000>8,history:filtered,outliers};
}

// --- managed-service.js 1:1-Port (v18): Universum aus Katalog + v12_instruments,
// Kursabruf, Marktzeilen, Abdeckung; Haftungs-/Ehrlichkeitsregeln. ---
async function buildManagedUniverse(env,db,fetcher,owner,profile,model){
 const held=new Set((model?.positions||[]).map(p=>p.id));
 let universe=[],benchInstruments=[];
 const brokerRows=await db('wealth_cache?owner_id=eq.'+owner+'&key=eq.t212_instruments&select=payload');
 const broker=new Map();
 for(const t of brokerRows?.[0]?.payload||[])if(t.isin&&!broker.has(t.isin))broker.set(t.isin,t);
 const confirm=u=>({...u,brokerConfirmed:broker.has(u.isin),brokerTicker:broker.get(u.isin)?.ticker||null});
 if(profile.approach==='active'){
  const held=new Set((model?.positions||[]).map(p=>p.id));
  const rows=await db('v12_instruments?owner_id=eq.'+owner+'&active=eq.true&status=eq.analysed&select=isin,name,provider_ticker,listings,facts,score,sector&limit=1000');
  const scored=rows.filter(r=>r.score&&r.facts&&r.provider_ticker).sort((a,b)=>(Number(b.score?.total)||0)-(Number(a.score?.total)||0)||a.isin.localeCompare(b.isin));
  // Auswahlraum: gehaltene Positionen immer, danach die bestbewerteten
  // Analysen; Obergrenze begrenzt Kursabrufe und Speicher.
  const chosen=[...scored.filter(r=>held.has(r.isin)),...scored.filter(r=>!held.has(r.isin))].slice(0,40);
  // B7 (R2): Gehaltene Positionen gehören IMMER ins Universum, auch wenn
  // Score, Facts oder Kurs-Symbol fehlen — sonst wäre das Modell nicht mehr
  // vollständig bewertbar. Ohne Kurs-Symbol entsteht eine Marktzeile mit
  // Fehler; die Bewertung meldet dann VALUATION_INCOMPLETE (heilbar) statt
  // in einer Sackgasse zu enden. Ohne Score ist der Titel beim Rebalancing
  // nicht auswählbar (activeScore null), bleibt aber bewertbar.
  const heldRest=rows.filter(r=>held.has(r.isin)&&!chosen.some(c=>c.isin===r.isin));
  universe=[...chosen,...heldRest].map(r=>{
   const listing=(r.listings||[]).find(l=>l.currency==='EUR')||r.listings?.[0]||{};
   const f=r.facts||{};
   return {id:r.isin,isin:r.isin,name:r.name,kind:'stock',group:'stock',currency:listing.currency||f.currency||'EUR',brokerConfirmed:Boolean(listing.ticker),brokerTicker:listing.ticker||null,source:f.source||null,sector:r.sector||f.sector||null,yahoo:r.provider_ticker||null,fxKnown:f.fx,
    facts:{roe:f.return_on_equity,pe:f.pe_ratio,debtToEquity:f.debt_to_equity,revenueGrowth:f.revenue_growth,asOf:f.asOf||null,...(r.score?.version==='sector-percentiles-v12.1'?{sectorScore:{version:r.score.version,components:r.score.components}}:{})}};
  });
  const core=catalog.find(c=>c.group==='world');
  if(core)universe.push({...confirm(core),coreSleeve:true});
  if(core)benchInstruments=[{...core,group:'stock',currency:'EUR'}];
 }else{
  universe=catalog.map(confirm);
  benchInstruments=universe.filter(u=>['world','bond'].includes(u.group));
 }
 // B4 (v18): Zweite, fixe Benchmark 60/40 (MSCI World / Global Aggregate
 // Bond EUR-hedged) — statisch, ohne Glidepath, ohne Rebalancing.
 const bench2Instruments=[catalog[1],catalog[3]].map(c=>universe.find(u=>u.id===c.id)||confirm(c));
 const market=[];
 const fetchList=[],seenFetch=new Set();
 for(const u of [...universe,...benchInstruments,...bench2Instruments]){if(seenFetch.has(u.id))continue;seenFetch.add(u.id);fetchList.push(u);}
 const fetchRow=async u=>{
  const symbol=u.kind==='stock'?u.yahoo:u.symbol+'.DE';
  // B7 (R2): Gehaltene Aktie ohne Kurs-Symbol → Fehlerzeile statt hartem
  // Abbruch des gesamten Universums.
  if(!symbol)return {id:u.id,sector:u.sector||null,facts:u.facts||null,error:'Kein Kurs-Symbol hinterlegt.'};
  try{
   const indicators=advisorIndicators(await yahooCloses(symbol,fetcher));
   let fx=1,fxHistory=null;
   // A3 (R2): Aktuelles FX immer frisch von der Frankfurter-Referenz holen
   // (kein gecachter Kurs aus den Stammdaten), damit Kauf- und Folge-
   // bewertung dieselbe Quelle nutzen.
   if(u.currency!=='EUR'){fx=await frankfurterRate(u.currency,fetcher);fxHistory=await frankfurterSeries(u.currency,fetcher);}
   return {id:u.id,sector:u.sector||null,facts:u.facts||null,indicators,fx,...(fxHistory?{fxHistory}:{})};
  }catch(e){return {id:u.id,sector:u.sector||null,facts:u.facts||null,error:safeMessage(e.message)};}
 };
 // B8 (R2): Kursabrufe parallel in Bündeln von höchstens sechs statt seriell.
 for(let i=0;i<fetchList.length;i+=6)market.push(...await Promise.all(fetchList.slice(i,i+6).map(fetchRow)));
 const usable=market.filter(m=>!m.error).length;
 return {universe,market,coverage:{checked:market.length,usable},benchInstruments,bench2Instruments};
}
// managed-service.js: Redaktion der KI-Begründung (v18).
async function managedExplanation(env,fetcher,db,owner,profile,model,rec,universe){
 if(!env.openrouterKey)return {explanation:null,usage:null};
 const names=Object.fromEntries(universe.map(u=>[u.id,u.name]));
 const listing=rec.positions.map(p=>({name:names[p.id]||p.id,weightPct:p.weightBps/100}));
 const prompt=['Fasse die Modellanpassung in höchstens drei deutschen Sätzen für eine Privatperson zusammen.','Nenne keine Kauf- oder Verkaufsaufforderung, keine Renditeversprechen; erwähne, dass Modellwerte keine echten Depotbestände sind.','Kontext:',JSON.stringify({profile:{approach:profile.approach,risk:profile.risk,years:profile.years},cashPct:rec.cashWeightBps/100,positions:listing,changeReason:rec.changeReason})].join('\n');
 const res=await fetcher('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.openrouterKey,'HTTP-Referer':'https://kontur.app','X-Title':'Kontur Advisor'},body:JSON.stringify({model:env.model,messages:[{role:'user',content:prompt}],max_tokens:220}),signal:AbortSignal.timeout(20000)});
 if(!res.ok)throw new ServiceError('AI_UNAVAILABLE','OpenRouter ('+res.status+').',{retryable:true,retryAfter:30});
 const json=await boundedJSON(res,2_000_000);
 const text=String(json?.choices?.[0]?.message?.content||'').trim();
 return {explanation:text||null,usage:json?.usage||null};
}
// modelSnapshot für die API (Ergebnisansicht managed-ui.js).
function modelSnapshot(model){
 const out=structuredClone(model);
 delete out.market;delete out.universe;
 return out;
}

// ----------------------------------------------------------------------------
// Aktionen (v18) — Gating, Profil, Läufe, Wealth-Betreuung.
// ----------------------------------------------------------------------------
async function actionList(env,db,owner,data){
 // D11 (R2): Konsistent mit den übrigen Aktionen — im Mehrbenutzerbetrieb
 // ist auch list auf das abrechnende Konto beschränkt.
 requireBillingOwner(env,owner);
 const strategyKey=/^[0-9a-f-]{36}$/i.test(data.strategyId||'')?data.strategyId:'';
 const runs=await db('advisor_runs?owner_id=eq.'+owner+(strategyKey?'&strategy_key=eq.'+strategyKey:'')+'&order=created_at.desc&limit=20');
 return {runs};
}
async function actionSaveProfile(env,db,owner,data){
 requireBillingOwner(env,owner);
 const planRow=(await db('finance_plans?owner_id=eq.'+owner))[0];if(!planRow)throw new ServiceError('PLAN_MISSING','Kein Finanzplan gefunden.');
 const profile=data.profile||{};
 if(!Array.isArray(profile.universe)||profile.universe.length===0)throw new ServiceError('PROFILE_INVALID','Profil benötigt ein Universum.');
 const key=/^[0-9a-f-]{36}$/i.test(profile.strategyId||'')?profile.strategyId:crypto.randomUUID();
 // Der Legacy-Advisor darf ein Modellmandat (Wealth-Betreuung,
 // mandateVersion 2) für dasselbe Anlageziel nicht überschreiben — D12 (R2):
 // auch nicht im pausierten Zustand.
 const existing=(await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+key))[0];
 if(existing?.profile?.mandateVersion===2)throw new ServiceError('MANDATE_ACTIVE','Für dieses Anlageziel ist die automatische Modellbetreuung eingerichtet. Bitte im Wealth-Bereich verwalten (reaktivieren oder pausieren).',{status:409});
 const row={owner_id:owner,strategy_key:key,profile:{...profile,strategyId:key},enabled:profile.enabled===true,next_due:new Date().toISOString(),updated_at:new Date().toISOString()};
 await db('advisor_profiles?on_conflict=owner_id,strategy_key','POST',row);
 return {strategyId:key};
}
async function actionAdopt(env,db,owner,data){
 requireBillingOwner(env,owner);
 const run=(await db('advisor_runs?owner_id=eq.'+owner+'&id=eq.'+data.runId))[0];if(!run)throw new ServiceError('RUN_MISSING','Lauf nicht gefunden.');
 const result=run.result;
 if(!result||result.action==='none')throw new ServiceError('ADOPTION_INVALID','Dieser Lauf enthält keine übernehmbare Anpassung.');
 // Übernahme ist idempotent: denselben Lauf nicht zweimal verbuchen.
 if(run.adopted)throw new ServiceError('ADOPTION_DUPLICATE','Dieser Vorschlag wurde bereits übernommen.',{status:409});
 const planRow=(await db('finance_plans?owner_id=eq.'+owner))[0];if(!planRow)throw new ServiceError('PLAN_MISSING','Kein Finanzplan gefunden.');
 const plan=planRow.data||{},strategies=plan.strategies||[],strategy=strategies.find(s=>s.id===run.strategy_key)||strategies[0];
 if(!strategy)throw new ServiceError('STRATEGY_MISSING','Keine Strategie zum Aktualisieren gefunden.');
 const nextPositions=(result.positions||[]).map(p=>({...p}));
 strategy.positions=nextPositions;strategy.updatedAt=new Date().toISOString();
 await db('finance_plans?owner_id=eq.'+owner,'PATCH',{data:{...plan,strategies},revision:(planRow.revision||0)+1});
 await db('advisor_runs?id=eq.'+run.id,'PATCH',{adopted:true});
 return {strategyId:strategy.id,positions:nextPositions};
}
async function actionMarket(env,db,fetcher,owner){
 requireBillingOwner(env,owner);
 const cached=(await db('wealth_cache?owner_id=eq.'+owner+'&key=eq.market_overview&select=payload,updated_at'))[0];
 if(cached?.payload&&Date.now()-Date.parse(cached.updated_at)<900000)return cached.payload;
 const universe=['IWDA.DE','EIMI.DE','IGLO.DE','AGGH.DE','VWRL.DE','XDWD.DE','EUN1.DE','VGEU.DE'];
 const rows=[];
 for(const s of universe){try{const ind=advisorIndicators(await yahooCloses(s,fetcher));rows.push({symbol:s,last:ind.last,asOf:ind.asOf,momentum63Pct:ind.momentum63Pct});}catch(e){rows.push({symbol:s,error:safeMessage(e.message)});}}
 const payload={rows,asOf:advisorDay(),disclaimer:'Kuratierte Indikation, keine Anlageberatung.'};
 await db('wealth_cache?on_conflict=owner_id,key','POST',{owner_id:owner,key:'market_overview',payload,updated_at:new Date().toISOString()});
 return payload;
}
async function actionSearchMarket(env,fetcher,owner,data){
 requireBillingOwner(env,owner);
 const q=String(data.query||'').trim();if(q.length<2)return {results:[]};
 const res=await fetcher('https://query1.finance.yahoo.com/v1/finance/search?q='+encodeURIComponent(q)+'&quotesCount=12&newsCount=0',{signal:AbortSignal.timeout(10000)});
 if(!res.ok)throw new ServiceError('MARKET_DATA_UNAVAILABLE','Suche nicht abrufbar: HTTP '+res.status,{retryable:true,retryAfter:60});
 const json=await boundedJSON(res,2_000_000);
 const results=(json?.quotes||[]).map(q=>({symbol:q.symbol,name:q.longname||q.shortname||q.symbol,kind:q.quoteType==='ETF'?'etf':q.quoteType==='EQUITY'?'stock':'other',currency:q.currency||null})).filter(r=>r.kind!=='other');
 return {results};
}
async function actionBudgetDraft(env,db,fetcher,owner,data){
 requireBillingOwner(env,owner);
 const planRow=(await db('finance_plans?owner_id=eq.'+owner))[0];if(!planRow)throw new ServiceError('PLAN_MISSING','Kein Finanzplan gefunden.');
 const text=String(data.text||'').slice(0,2000);if(text.length<10)throw new ServiceError('INPUT_INVALID','Bitte beschreibe deine Situation (mindestens 10 Zeichen).');
 const prompt=['Erstelle aus der folgenden Beschreibung einen kompakten Budget-Entwurf als JSON mit den Feldern categories (Array aus {name, monthlyCents}) und notes (Array deutscher Sätze).','Nur JSON, keine Erklärungen außerhalb. Beschreibung:',text].join('\n');
 const res=await fetcher('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.openrouterKey,'HTTP-Referer':'https://kontur.app','X-Title':'Kontur Advisor'},body:JSON.stringify({model:env.model,messages:[{role:'user',content:prompt}],max_tokens:900,response_format:{type:'json_object'}}),signal:AbortSignal.timeout(30000)});
 if(!res.ok)throw new ServiceError('AI_UNAVAILABLE','OpenRouter ('+res.status+').',{retryable:true,retryAfter:30});
 const json=await boundedJSON(res,2_000_000);
 let draft;try{draft=JSON.parse(json?.choices?.[0]?.message?.content||'{}');}catch{throw new ServiceError('AI_INVALID','Entwurf war kein JSON.');}
 return {draft,usage:json?.usage||null};
}

// --- Wealth-Betreuung (managed) ---
async function actionWealthStatus(env,db,owner,data){
 requireBillingOwner(env,owner);
 const key=/^[0-9a-f-]{36}$/i.test(data.strategyId||'')?data.strategyId:'';
 const rows=await db('advisor_profiles?owner_id=eq.'+owner+(key?'&strategy_key=eq.'+key:''));
 const out=[];
 for(const row of rows){
  const modelRow=(await db('wealth_models?owner_id=eq.'+owner+'&strategy_key=eq.'+row.strategy_key))[0];
  out.push({strategyId:row.strategy_key,enabled:row.enabled,profile:row.profile,nextDue:row.next_due,setupError:row.setup_error||null,model:modelRow?modelSnapshot(modelRow.model):null});
 }
 return {mandates:out};
}
async function actionWealthHistory(env,db,owner,data){
 requireBillingOwner(env,owner);
 const key=/^[0-9a-f-]{36}$/i.test(data.strategyId||'')?data.strategyId:'';
 if(!key)throw new ServiceError('INPUT_INVALID','strategyId fehlt.');
 const modelRow=(await db('wealth_models?owner_id=eq.'+owner+'&strategy_key=eq.'+key))[0];
 return {history:modelRow?.model?.history||[]};
}
async function actionWealthSetEnabled(env,db,fetcher,owner,data,enabled){
 requireBillingOwner(env,owner);
 const key=/^[0-9a-f-]{36}$/i.test(data.strategyId||'')?data.strategyId:'';
 if(!key)throw new ServiceError('INPUT_INVALID','strategyId fehlt oder ist ungültig.');
 const planRow=(await db('finance_plans?owner_id=eq.'+owner))[0];if(!planRow)throw new ServiceError('PLAN_MISSING','Kein Finanzplan gefunden.');
 const goal=(planRow.data?.strategies||[]).find(g=>g.id===key);
 if(!goal)throw new ServiceError('GOAL_MISSING','Anlageziel nicht im Plan gefunden.');
 // W13 (R4): Ohne deklarierte Einkommens-/Vermögensdaten keine Ablehnung,
 // aber Hinweis auf grobe Schätzung der Geeignetheit.
 const profile=mandate(goal,enabled);
 if(enabled){
  const existing=(await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+key))[0];
  if(existing&&existing.profile?.mandateVersion!==2&&existing.enabled===true)throw new ServiceError('MANDATE_ACTIVE','Für dieses Anlageziel läuft bereits ein Legacy-Advisor-Profil. Pausiere es zuerst.',{status:409});
  // W12 (R3): Machbarkeits-Probe — die Zielallokation muss mit dem
  // aktuellen Universum (Katalog + Broker-Abgleich) und den Mandatsgrenzen
  // möglich sein, bevor die Betreuung aktiviert wird. Keine Persistenz.
  // B7 (R2): Bei einer Re-Aktivierung läuft die Probe mit dem bestehenden
  // Modell, damit gehaltene Positionen im Universum erhalten bleiben.
  let probe=null;
  try{
   const modelRow=(await db('wealth_models?owner_id=eq.'+owner+'&strategy_key=eq.'+key))[0];
   probe=await buildManagedUniverse(env,db,fetcher,owner,profile,modelRow?.model||null);
   // A1 (R2): bounds entsprechen den jeweils verwendeten Zielgewichten.
   validateModel(allocateModel(profile,probe.universe,probe.market),profile,probe.universe,probe.market,{bounds:strategicWeights(profile)});
   // B1 (R2): Die Machbarkeit muss auch im risikoreduzierten Zustand
   // (risk-off-Gewichte inklusive Bond-Deckel) gegeben sein.
   validateModel(allocateModel(profile,probe.universe,probe.market,{weights:regimeWeights(profile,'risk-off')}),profile,probe.universe,probe.market,{bounds:regimeWeights(profile,'risk-off')});
  }catch(e){
   if(e instanceof ServiceError&&(e.code==='UNIVERSE_EMPTY'||e.code==='ALLOCATION_IMPOSSIBLE')){
    // Transiente Marktfehler von strukturellen trennen: War kein einziger
    // Kursabruf nutzbar, ist die Allokation nicht strukturell unmöglich,
    // sondern gerade nicht prüfbar — als retrybarer 503 melden.
    const marketUnreachable=e.code==='ALLOCATION_IMPOSSIBLE'&&probe&&probe.coverage.checked>0&&probe.coverage.usable===0;
    if(marketUnreachable)throw new ServiceError('MARKET_PROBE_UNAVAILABLE','Marktdaten vorübergehend nicht erreichbar — bitte gleich erneut versuchen.',{status:503,retryable:true,retryAfter:60});
    throw new ServiceError(e.code,safeMessage(e.message).replace('Bestehendes Modell bleibt erhalten.','Die automatische Betreuung wurde nicht aktiviert.'),{status:409});
   }
   // A1 (R2): Validierungswürfe der Probe (plain Error) konsistent als
   // ALLOCATION_IMPOSSIBLE behandeln.
   if(!(e instanceof ServiceError))throw new ServiceError('ALLOCATION_IMPOSSIBLE',safeMessage(e.message),{status:409});
   throw e;
  }
  await db('advisor_profiles?on_conflict=owner_id,strategy_key','POST',{owner_id:owner,strategy_key:key,profile,enabled:true,next_due:new Date().toISOString(),updated_at:new Date().toISOString()});
  return {strategyId:key,enabled:true,profile};
 }else{
  await db('advisor_jobs?owner_id=eq.'+owner+'&strategy_key=eq.'+key+'&status=eq.queued','PATCH',{status:'failed',error:'Betreuung pausiert.',finished_at:new Date().toISOString()});
  // B11 (v18): Beim Pausieren depositThrough mitbewegen, damit nach der
  // Wiederaufnahme keine Klumpen-Nachholung der pausierten Sparraten entsteht.
  // B4 (R2): updated_at-Guard gegen ein Lost-Update mit einem gleichzeitig
  // laufenden Betreuungszyklus — schreiben nur, wenn die Zeile seit dem
  // Lesen unverändert ist; bei Konflikt einmal neu lesen und wiederholen.
  for(let attempt=0;attempt<2;attempt++){
   const modelRow=(await db('wealth_models?owner_id=eq.'+owner+'&strategy_key=eq.'+key))[0];
   if(!modelRow?.model)break;
   const guard=modelRow.updated_at?'&updated_at=eq.'+encodeURIComponent(modelRow.updated_at):'';
   const written=await db('wealth_models?owner_id=eq.'+owner+'&strategy_key=eq.'+key+guard,'PATCH',{model:{...modelRow.model,depositThrough:advisorDay()},updated_at:new Date().toISOString()});
   if(!modelRow.updated_at||Array.isArray(written)&&written.length>0)break;
  }
 }
 await db('advisor_profiles?on_conflict=owner_id,strategy_key','POST',{owner_id:owner,strategy_key:key,profile,enabled,next_due:new Date(Date.now()+86400000).toISOString(),updated_at:new Date().toISOString()});
 return {strategyId:key,enabled};
}
async function actionRun(env,db,fetcher,owner,data,{scheduled=false}={}){
 requireBillingOwner(env,owner);
 const mode=data.mode==='review'?'review':'advisor';
 const strategyKey=/^[0-9a-f-]{36}$/i.test(data.strategyId||'')?data.strategyId:'';
 if(data.requestId){
  const existing=await db('advisor_runs?owner_id=eq.'+owner+'&request_id=eq.'+encodeURIComponent(String(data.requestId)));
  if(existing[0])return {run:existing[0],reused:true};
 }
 const planRow=(await db('finance_plans?owner_id=eq.'+owner))[0];
 if(!planRow)throw new ServiceError('PLAN_MISSING','Kein Finanzplan gefunden.');
 checkRevision(planRow,data.planRevision);
 const profRow=(await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+strategyKey))[0];
 const profile=profRow?.profile||data.profile||null;
 if(!profile?.universe?.length)throw new ServiceError('PROFILE_MISSING','Kein Advisor-Profil mit Universum gefunden. Bitte zuerst speichern.');
 const goal=(planRow.data?.strategies||[]).find(g=>g.id===strategyKey)||null;
 const runInsert={owner_id:owner,strategy_key:strategyKey,request_id:data.requestId?String(data.requestId):null,mode,status:'running',profile};
 let runRow;
 try{runRow=(await db('advisor_runs','POST',runInsert))[0];}
 catch(e){
  // D4 (R2): Check-then-Insert-Race — bei parallelem Insert denselben
  // requestId-Lauf erneut lesen und zurückgeben statt DATABASE_ERROR.
  if(data.requestId){const existing=await db('advisor_runs?owner_id=eq.'+owner+'&request_id=eq.'+encodeURIComponent(String(data.requestId)));if(existing[0])return {run:existing[0],reused:true};}
  throw e;
 }
 try{
  const context=await advisorContext(db,owner,goal?.id||null);
  const userPrompt=['Kontext (JSON):',JSON.stringify({goal,context,profile,mode}),'Bitte entscheide und antworte gemäß Schema.'].join('\n');
  const messages=[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:userPrompt}];
  let result=null,lastError=null;
  for(let attempt=0;attempt<2&&!result;attempt++){
   try{
    const out=await openRouterRequest(env,fetcher,db,owner,{runId:runRow.id},messages,ADVISOR_SCHEMA,attempt+1);
    const text=out?.choices?.[0]?.message?.content||'';
    result=advisorValidateResult(JSON.parse(text),profile.universe);
    result.usage=out?.usage||null;
   }catch(e){lastError=e;if(!(e instanceof ServiceError&&e.retryable))break;}
  }
  if(!result)throw lastError||new ServiceError('AI_INVALID','Keine verwertbare Antwort erhalten.');
  const decision=computeDecision(profile,result);
  await db('advisor_runs?id=eq.'+runRow.id,'PATCH',{status:'completed',result:{...result,decision},finished_at:new Date().toISOString()});
  return {run:{...runRow,status:'completed',result:{...result,decision}}};
 }catch(e){
  const d=diagnostics(e);
  await db('advisor_runs?id=eq.'+runRow.id,'PATCH',{status:'failed',error:d.message,finished_at:new Date().toISOString()});
  throw e;
 }
}
function checkRevision(planRow,seen){
 const current=Number(planRow?.revision||0);
 if(seen===undefined||seen===null||seen==='')return;
 if(Number(seen)!==current)throw new ServiceError('REVISION_CONFLICT','Der Finanzplan wurde zwischenzeitlich geändert. Bitte neu laden.',{status:409});
}
function computeDecision(profile,result){
 const positions=result.positions||[];
 const cash=positions.filter(p=>p.kind==='cash').reduce((n,p)=>n+(p.weightPct||0),0);
 const concentration=Math.max(0,...positions.filter(p=>p.kind!=='cash').map(p=>p.weightPct||0));
 return {action:result.action,cashPct:cash,concentrationPct:concentration,violatesBuffer:cash<(profile.minCashPct||0)};
}

// --- Betreuungszyklus (Cron) ---
async function careCycle(env,db,fetcher,row){
 const owner=row.owner_id,key=row.strategy_key,profile=row.profile;
 const date=advisorDay();
 let job=null;
 try{
  job=(await db('advisor_jobs','POST',{owner_id:owner,strategy_key:key,kind:'care',status:'running',payload:{profileVersion:profile.mandateVersion||null}}))[0];
 }catch(e){throw new ServiceError('DATABASE_ERROR','Betreuungsjob konnte nicht angelegt werden: '+safeMessage(e.message));}
 try{
  const planRow=(await db('finance_plans?owner_id=eq.'+owner))[0];
  if(!planRow)throw new ServiceError('PLAN_MISSING','Kein Finanzplan gefunden.');
  const goal=(planRow.data?.strategies||[]).find(g=>g.id===key);
  if(!goal)throw new ServiceError('MANDATE_INVALID','Anlageziel fehlt im Finanzplan; Mandat kann nicht geprüft werden.');
  const effectiveProfile=mandate(goal,true);
  // W13 (R4): Mandat abgleichen — kosmetische Felder ohne Regelbezug lösen
  // kein MANDATE_CHANGED aus; inhaltliche Änderungen erfordern Re-Bestätigung.
  if(mandateIdentity(effectiveProfile)!==mandateIdentity(profile))throw new ServiceError('MANDATE_CHANGED','Das Anlageziel wurde geändert; bitte Betreuung erneut bestätigen.',{status:409});
  // Geeignetheits-Bestätigung: 12 Monate gültig, danach Hinweis + Betreuung
  // ruht bis zur Re-Bestätigung (kein automatischer Stopp des Modells).
  const confirmationDue=profile.confirmedAt&&(Date.now()-Date.parse(profile.confirmedAt))>365*86400000;
  const confirmationNotice='Deine Geeignetheitsprüfung ist über 12 Monate alt. Bitte bestätige deine Angaben im Wealth-Bereich erneut — die automatische Betreuung pausiert bis dahin.';
  const modelRow=(await db('wealth_models?owner_id=eq.'+owner+'&strategy_key=eq.'+key))[0];
  let model=modelRow?.model||null;
  const {universe,market,coverage,benchInstruments,bench2Instruments}=await buildManagedUniverse(env,db,fetcher,owner,effectiveProfile,model);
  // B1 (v18): Regime-Overlay — Signal aus der 200-Tage-Linie des
  // World-Benchmark-Instruments (bereits geladene Marktzeile, kein
  // Extra-Fetch). Der Zustand wird am Modell persistiert, nicht im Mandat.
  // D14 (R2): Der Referenz-ETF wird explizit per ISIN (Katalog-Eintrag 0)
  // gewählt, nicht implizit über die Reihenfolge.
  const refInstrument=benchInstruments.find(b=>b.id===catalog[0].id)||benchInstruments.find(b=>b.group==='world')||benchInstruments[0]||null;
  const refRow=refInstrument?market.find(m=>m.id===refInstrument.id):null;
  const prevRegime=model?.regime?.state==='risk-off'?'risk-off':'risk-on';
  const regimeDistanceBps=refRow&&!refRow.error?regimeDistance(refRow.indicators):null;
  const regime=regimeSignal(prevRegime,regimeDistanceBps);
  const regimeChanged=Boolean(model&&regime!==prevRegime);
  let rec=model?.recommendation||null;
  let rebalance=false,transactions=[];
  const dueDeposit=depositDue(model,profile,date);
  const dormant=Boolean(model&&(model.valueCents||0)===0&&dueDeposit===0);
  if(model&&!dormant){try{model=markModel(model,market,date);}catch(e){throw new ServiceError('VALUATION_INCOMPLETE','Bewertung unvollständig: '+safeMessage(e.message),{retryable:true,retryAfter:900});}}
  // B3 (R2): High-Watermark nach der Bewertung und vor jeder Einzahlung
  // mitführen (Drawdown-Referenz, siehe unten).
  if(model)model.highwaterCents=Math.max(model.highwaterCents||0,model.valueCents||0);
  // D14 (R2): Ein Regime-Wechsel, der wegen fälliger Re-Bestätigung oder
  // Dormant-Zustand nicht umgesetzt wird, bleibt als ausstehend markiert und
  // wird beim nächsten Rebalance nachgeholt (changeReason mit Regime-Bezug).
  if(model&&regimeChanged&&(confirmationDue||dormant))model.regimePending=true;
  // Review: 30 Tage ohne Strategieprüfung lösen ebenfalls eine Prüfung aus.
  const reviewDue=!model?.reviewedOn||(Date.parse(date)-Date.parse(model.reviewedOn))>30*dayMs;
  const targetDrift=()=>{
   if(!model||!rec)return false;
   const target=regimeWeights(effectiveProfile,regime),actual=new Map();
   for(const p of model.positions){const g=universe.find(u=>u.id===p.id)?.group||'unknown';actual.set(g,(actual.get(g)||0)+Math.round(p.valueCents/model.valueCents*10000));}
   actual.set('cash',Math.round(model.cashCents/model.valueCents*10000));
   return Object.keys(target).some(g=>Math.abs((actual.get(g)||0)-target[g])>500);
  };
  if(!confirmationDue&&!dormant&&(reviewDue||!rec||targetDrift()||(model&&(driftBreached(model,rec,universe)||modelLimitBreaches(model,profile,market))))){
   // A1 (R2): validateModel erhält dieselben Regime-Zielgewichte als bounds
   // wie allocateModel; Validierungsfehler gelten als strukturell unlösbare
   // Allokation (Einrichtungspfad mit 24 h statt 15-Minuten-Retry).
   try{rec=validateModel(allocateModel(effectiveProfile,universe,market,{weights:regimeWeights(effectiveProfile,regime),previousRec:model?.recommendation||null}),effectiveProfile,universe,market,{bounds:regimeWeights(effectiveProfile,regime)});}
   catch(e){if(e instanceof ServiceError)throw e;throw new ServiceError('ALLOCATION_IMPOSSIBLE',safeMessage(e.message));}
   rebalance=true;
   // B1/D14 (R2): Einen Regime-Wechsel als Grund der Zielanpassung ausweisen —
   // auch wenn er in einem früheren Zyklus auflief und jetzt nachgeholt wird.
   if(regimeChanged||model?.regimePending){
    const pct=regimeDistanceBps===null?'':(Math.abs(regimeDistanceBps)/100).toFixed(1).replace('.',',')+' % ';
    rec.changeReason=(regime==='risk-off'
     ?'Referenzindex '+pct+'unter der 200-Tage-Linie — Risiko reduziert (kein Verkaufssignal, planmäßige Regel).'
     :'Referenzindex wieder über der 200-Tage-Linie — planmäßige Rückkehr zur strategischen Zielquote.')
     +(model?.regimePending&&!regimeChanged?' Der Zustandswechsel wird mit dieser Anpassung nachgeholt.':'');
    if(model)model.regimePending=false;
   }else if(!modelRow&&regime==='risk-off'){
    // D14 (R2): Erstaufbau direkt im risikoreduzierten Zustand benennen.
    rec.changeReason+=' Erstaufbau im risikoreduzierten Zustand (Referenzindex unter der 200-Tage-Linie).';
   }
  }
  if(model)model.reviewedOn=rebalance?date:(model.reviewedOn||model.startedOn);
  if(rebalance||dueDeposit>0||!model){
   const out=evolveModel(model,rec,universe,market,profile,date,{rebalance,deposit:dueDeposit});
   model=out.model;transactions=out.transactions;
  }
  // B1: Regime-Zustand am Modell persistieren (nicht im Mandat — löst
  // bewusst kein MANDATE_CHANGED aus). D14 (R2): stale kennzeichnet, dass die
  // Referenz-Kursreihe veraltet ist.
  model.regime={state:regime,distanceBps:regimeDistanceBps,reference:refInstrument?.name||null,asOf:date,stale:Boolean(!refRow||refRow.error||refRow.indicators?.stale)};
  // B10 (R2): Fehlte die Referenz bisher, beginnt sie zum Tageskurs neu
  // (Rebase) — das wird am Benchmark und als Hinweis festgehalten.
  let benchRebased=false,bench2Rebased=false;
  try{
   // W11 (R2): Nachbuchung = Delta der Einzahlungen. Hinweis: Ein künftiger
   // Entnahme-Pfad (sinkendes model.paidCents) muss den Benchmark proportional
   // mitreduzieren — die Nachbuchung hier kann nur addieren, nie kürzen.
   const benchRebase=!model.benchmark&&model.paidCents>0;
   const benchFunding=Math.max(0,model.paidCents-(model.benchmark?.paidCents||0));
   model.benchmark=updateBenchmark(model.benchmark||null,benchInstruments,market,strategicWeights(effectiveProfile),benchFunding,date);
   if(benchRebase){model.benchmark.rebasedAt=date;benchRebased=true;}
   model.benchmarkError=null;
  }
  catch(e){model.benchmarkError=safeMessage(e.message);}
  try{
   // B4 (v18): Zweite fixe Benchmark 60/40 mit derselben Einzahlungs-
   // finanzierung; statisch — ohne Glidepath und ohne Rebalancing.
   const bench2Rebase=!model.benchmark2&&model.paidCents>0;
   const bench2Funding=Math.max(0,model.paidCents-(model.benchmark2?.paidCents||0));
   model.benchmark2=updateBenchmark(model.benchmark2||null,bench2Instruments,market,{world:6000,bond:4000},bench2Funding,date);
   if(bench2Rebase){model.benchmark2.rebasedAt=date;bench2Rebased=true;}
   model.benchmark2.label='Fixe 60/40-Referenz (MSCI World / € Staatsanleihen) · gleiche Einzahlungen · ohne Glidepath und Rebalancing';
   model.benchmark2Error=null;
  }
  catch(e){model.benchmark2Error=safeMessage(e.message);}
  // C9 (v18): Drawdown-Hinweis nur einmal je Episode (Flag am Modell) plus
  // Recovery-Meldung; der Reset erfolgt erst bei Erholung unter die Schwelle
  // minus Hysterese (200 bps). Beruhigender Text ohne Handlungsdruck.
  // Kein Versand, keine automatische Aktion.
  const notices=[];
  if(confirmationDue)notices.push(confirmationNotice);
  // D14 (R2): Regime-Signal ohne ausreichende Kursdaten offenlegen.
  if(regimeDistanceBps===null)notices.push('Regime-Signal derzeit nicht berechenbar (zu wenig Kursdaten); letzter Zustand bleibt bestehen.');
  // B10 (R2): Hinweis bei einer Neubasierung einer Referenzkurve.
  if(benchRebased||bench2Rebased)notices.push('Hinweis: Eine Referenzkurve wurde neu basiert (Beginn ab '+date+'); Werte vor diesem Zeitpunkt sind damit nicht vergleichbar.');
  if(model&&(model.valueCents||0)>0){
   // B3 (R2): Drawdown-Referenz ist der Höchststand aus highwaterCents (vor
   // Einzahlungen fixiert, daher nicht mehr dilutierbar) und paidCents als
   // Verhaltens-Anker; die Historie bleibt für Altmodelle als Rückfall.
   const reference=Math.max(model.paidCents||0,model.highwaterCents||0,model.valueCents,...(model.history||[]).map(h=>Number(h?.valueCents)||0));
   const drawdownPct=reference>0?(reference-model.valueCents)/reference*100:0;
   if(drawdownPct>=profile.lossTolerance&&!model.drawdownEpisode){
    model.drawdownEpisode=true;
    // D8 (R2): Textbausteine konditioniert — „nichts verkauft" nur ohne
    // Rebalance in diesem Lauf; der Sparraten-Hinweis entfällt bei fälliger
    // Re-Bestätigung (dann ruhen Einzahlungen).
    notices.push('Dein Modell liegt '+drawdownPct.toFixed(1).replace('.',',')+' % unter dem Höchststand. Rücksetzer dieser Größe sind in deinem Plan einkalkuliert.'+(rebalance?' Die Zielgewichte wurden im Rahmen deiner Regeln angepasst.':' Es wurde nichts verkauft.')+(confirmationDue?'':' Deine nächste Sparrate kauft automatisch günstiger nach.')+' Handlungsbedarf besteht nur, wenn sich dein Leben geändert hat — nicht der Markt.');
   }else if(model.drawdownEpisode&&drawdownPct<Math.max(0,profile.lossTolerance-2)){
    // D7 (R2): Reset-Schwelle bei 0 nach unten begrenzt (lossTolerance 1–2).
    model.drawdownEpisode=false;
    notices.push('Erholung: Dein Modell liegt wieder über der Verlustschwelle (aktuell '+drawdownPct.toFixed(1).replace('.',',')+' % unter dem Höchststand). Dein Plan läuft unverändert weiter.');
   }
  }
  let explanationUsage=null,aiWarning='';
  if(rebalance&&env.openrouterKey){
   try{const ai=await managedExplanation(env,fetcher,db,owner,effectiveProfile,model,rec,universe);model.explanation=ai.explanation;explanationUsage=ai.usage;}
   catch(e){aiWarning='KI-Prüfung wird wiederholt: '+safeMessage(e.message);}
  }
  model.market=market;model.marketAsOf=date;
  // B5 (R2): Pie-Schreibauftrag VOR dem Modell-Write einreihen — der Enqueue
  // ist idempotent (p_reset:true) und geht so nicht verloren, wenn der
  // Modell-Write danach scheitert.
  if(rebalance){
   const bindings=await db('v12_pie_bindings?owner_id=eq.'+owner+'&controller=eq.advisor&strategy_id=eq.'+key+'&enabled=eq.true');
   for(const b of bindings)await db('rpc/enqueue_v12_task','POST',{p_owner:owner,p_kind:'pie-write',p_key:String(b.pie_id),p_payload:{pieId:b.pie_id},p_priority:70,p_reset:true});
  }
  // B4 (R2): Wurde die Betreuung während dieses Laufs pausiert, das Modell
  // nicht zurückschreiben — die Pause hat depositThrough bereits mitbewegt
  // und ein Write hier würde das rückgängig machen (Lost-Update).
  const enabledNow=(await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+key+'&select=enabled'))[0]?.enabled;
  if(enabledNow===false){
   await db('advisor_jobs?id=eq.'+job.id,'PATCH',{status:'completed',result:{reason:'Betreuung wurde während des Laufs pausiert; Modelländerungen dieses Laufs wurden verworfen.',transactions:[]},finished_at:new Date().toISOString()});
   return {strategy:key,status:'completed'};
  }
  // D5 (R2): In der gespeicherten Kopie Kurs- und FX-Historien auslassen
  // (Payload-Hygiene wie modelSnapshot); die Arbeitskopie behält sie, und der
  // nächste Lauf lädt die Marktdaten ohnehin frisch (repricePosition nutzt
  // die Historie des frischen Marktes, nicht die persistierte).
  const storedModel={...model,market:market.map(m=>{if(m.error||!m.indicators)return {...m};const slim={...m,indicators:{...m.indicators}};delete slim.indicators.history;delete slim.fxHistory;return slim;})};
  await db('wealth_models?on_conflict=owner_id,strategy_key','POST',{owner_id:owner,strategy_key:key,model:storedModel,updated_at:new Date().toISOString()});
  await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+key,'PATCH',{next_due:new Date(Date.now()+(profile.intervalDays||1)*86400000).toISOString(),setup_error:confirmationDue?{code:'CONFIRMATION_DUE',message:confirmationNotice,retryable:false,status:null,requestId:null,retryAfter:0}:null});
  const reason=confirmationDue?'Geeignetheitsprüfung zur erneuten Bestätigung fällig: Bewertung ohne Anpassung.':!modelRow?'Erste Modellstrategie erstellt und Zielgewichte festgelegt.':dormant?'Modell ohne investiertes Kapital und ohne fällige Einzahlung: Bewertung ohne Anpassung.':rebalance&&dueDeposit?'Strategieprüfung: Zielgewichte innerhalb deiner Grenzen angepasst und fällige Modell-Sparrate angelegt.':rebalance?'Strategieprüfung: Zielgewichte innerhalb deiner Grenzen angepasst.':dueDeposit?'Geplante Modell-Sparrate angelegt und Gewichte geprüft.':'Tägliche Bewertung: Modell innerhalb der Grenzen, keine Anpassung.';
  const result={reason,transactions,costAssumption:model.costAssumption,coverage};
  // B10 (v18): Verworfene Kurs-Ausreißer dieses Laufs protokollieren.
  const outlierRows=market.filter(m=>m.indicators?.outliers>0).map(m=>({id:m.id,dropped:m.indicators.outliers}));
  if(outlierRows.length)result.outliers=outlierRows;
  if(notices.length)result.notices=notices;
  if(explanationUsage)result.explanation={usage:explanationUsage};
  if(aiWarning)result.aiWarning=aiWarning;
  if(transactions.length)result.snapshot=modelSnapshot(model);
  await db('advisor_jobs?id=eq.'+job.id,'PATCH',{status:'completed',result,finished_at:new Date().toISOString()});
  return {strategy:key,status:'completed'};
 }catch(e){
  const d=diagnostics(e);
  await db('advisor_jobs?id=eq.'+job.id,'PATCH',{status:'failed',error:d.message,finished_at:new Date().toISOString()});
  // managed-ui.js: „erfolgt ... innerhalb des nächsten Betreuungszyklus
  // (bis zu 15 Minuten)" — wiederholbare Fehler früh erneut versuchen;
  // Einrichtungsfehler als setup_error am Profil sichtbar machen.
  // ALLOCATION_IMPOSSIBLE/UNIVERSE_EMPTY: strukturell unlösbare Allokation —
  // nicht endlos retryen, sondern wie Einrichtungsfehler erst in 24 h.
  const setup=['BILLING_OWNER','BILLING_SETUP','BUDGET_LIMIT','AI_KEY_MISSING','MANDATE_CHANGED','MANDATE_INVALID','PLAN_MISSING','ALLOCATION_IMPOSSIBLE','UNIVERSE_EMPTY','CONFIRMATION_DUE'].includes(d.code);
  // B9 (v18): Drei aufeinanderfolgende Bewertungsfehler desselben Mandats
  // eskalieren in den Einrichtungspfad (setup_error, 24 h) statt in den
  // endlosen 15-Minuten-Retry.
  let escalate=false;
  if(d.code==='VALUATION_INCOMPLETE'){
   try{
    const recent=await db('advisor_jobs?owner_id=eq.'+owner+'&strategy_key=eq.'+key+'&order=created_at.desc&limit=3&select=status,error');
    escalate=recent.length>=3&&recent.every(j=>j.status==='failed'&&String(j.error||'').startsWith('Bewertung unvollständig'));
   }catch{}
  }
  const asSetup=setup||escalate;
  await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+key,'PATCH',{next_due:new Date(Date.now()+(asSetup?86400000:900000)).toISOString(),...(asSetup?{setup_error:escalate?{...d,code:'VALUATION_STUCK',message:'Bewertung drei Zyklen in Folge fehlgeschlagen: '+d.message,retryable:false}:d}:{})}).catch(()=>{});
  return {strategy:key,status:'failed',error:d.message};
 }
}

// Geplante Legacy-Läufe (advisor-ui.js: „Läuft bei geschlossener App, sobald
// der Supabase-Cronjob eingerichtet ist"; profile.intervalDays-Rhythmus).
async function legacyScheduledRun(env,db,fetcher,profileRow){
 const owner=profileRow.owner_id,profile=profileRow.profile;
 try{
  await actionRun(env,db,fetcher,owner,{mode:'advisor',strategyId:profileRow.strategy_key||undefined},{scheduled:true});
  await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+profileRow.strategy_key,'PATCH',{next_due:new Date(Date.now()+(profile.intervalDays||7)*86400000).toISOString(),setup_error:null});
  return {strategy:profileRow.strategy_key,status:'completed'};
 }catch(e){
  const d=diagnostics(e);
  await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+profileRow.strategy_key,'PATCH',{next_due:new Date(Date.now()+86400000).toISOString(),setup_error:d}).catch(()=>{});
  return {strategy:profileRow.strategy_key,status:'failed',error:d.message};
 }
}

// W15 (S3): Timing-sicherer Secret-Vergleich — beide Werte werden
// SHA-256-gehasht und die Byte-Arrays anschließend verglichen.
async function timingSafeEqual(a,b){
 const enc=new TextEncoder();
 const [ha,hb]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(String(a))),crypto.subtle.digest('SHA-256',enc.encode(String(b)))]);
 const x=new Uint8Array(ha),y=new Uint8Array(hb);let diff=0;
 for(let i=0;i<Math.max(x.length,y.length);i++)diff|=(x[i]??0)^(y[i]??0);
 return diff===0;
}

// ----------------------------------------------------------------------------
// Handler — Auth- und CORS-Muster wie kontur-services.ts (User-JWT über
// /auth/v1/user; Cron über X-Kontur-Cron). Deploy mit verify_jwt=false, weil
// die Function die Prüfung selbst vornimmt (Cron hat kein User-JWT).
// ----------------------------------------------------------------------------
function createHandler(input,fetcher=fetch){
 // K6 (E1/S1/S9): fail-closed mit Default-Origin, damit die App auch ohne
 // gesetztes ALLOWED_ORIGINS-Secret funktioniert.
 const env={...input,model:modelId(input.model),allowedOrigins:input.allowedOrigins?.length?input.allowedOrigins:['https://ggjzmbvht4-sketch.github.io']};
 const db=createDB(env,fetcher);
 return async req=>{
  const origin=req.headers.get('Origin')||'',allowed=env.allowedOrigins.includes(origin);
  const cors={'Access-Control-Allow-Origin':allowed?origin:'','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info,x-kontur-cron','Access-Control-Allow-Methods':'POST, OPTIONS',Vary:'Origin','Cache-Control':'no-store'};
  const json=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{...cors,'Content-Type':'application/json'}});
  if(req.method==='OPTIONS')return new Response(null,{status:allowed?204:403,headers:cors});
  if(req.method!=='POST')return json({error:'Nur POST'},405);
  try{
   // B6 (R2): 128 KB für alle Aktionen (Profile mit bis zu 100 Instrumenten);
   // D13 (R2): eigener Fehlertext für zu große Anfragen.
   let data;try{data=await boundedJSON(req,131072);}catch(e){if(e instanceof ServiceError&&e.code==='RESPONSE_TOO_LARGE')throw new ServiceError('REQUEST_TOO_LARGE','Die Anfrage ist zu groß. Bitte die Eingaben verkleinern (z. B. weniger Instrumente im Profil).',{status:413});throw e;}
   // Cron-Ausführung ohne Nutzerkonto (dispatch-Muster aus kontur-services.ts)
   if(data.action==='dispatch'){
    if(!env.cronSecret||env.cronSecret.length<32||!(await timingSafeEqual(req.headers.get('X-Kontur-Cron')||'',env.cronSecret)))return json({error:'Nicht autorisiert.'},401);
    // Fällige Mandate atomar sperren (014_advisor_jobs.sql claim_advisor_profile,
    // Muster claim_v12_task): die Sperre schiebt next_due um 15 Minuten, der
    // Betreuungszyklus setzt danach die echte nächste Fälligkeit.
    // B8 (R2): Wall-Clock-Budget — nach 100 s werden keine weiteren Mandate
    // gestartet; der nächste Cron-Lauf übernimmt sie (Claim ist gesperrt).
    const results=[],dispatchStart=Date.now();
    for(let i=0;i<5;i++){
     if(Date.now()-dispatchStart>100000){results.push({strategy:null,status:'skipped',error:'Zeitbudget des Laufs erreicht; verbleibende Mandate folgen im nächsten Lauf.'});break;}
     const row=await db('rpc/claim_advisor_profile','POST',{});
     if(!row)break;
     results.push(row.profile?.mandateVersion===2?await careCycle(env,db,fetcher,row):await legacyScheduledRun(env,db,fetcher,row));
    }
    return json({processed:results.length,results});
   }
   if(!allowed)return json({error:'ALLOWED_ORIGINS prüfen.'},403);
   const auth=req.headers.get('Authorization');
   if(!auth?.startsWith('Bearer '))return json({error:'Authentifizierung fehlt.'},401);
   let u;try{u=await fetch(env.url+'/auth/v1/user',{headers:{apikey:env.serviceKey,Authorization:auth},signal:AbortSignal.timeout(10000)});}catch{return json({error:'Authentifizierung fehlgeschlagen.'},401);}
   if(!u.ok)return json({error:'Authentifizierung fehlgeschlagen.'},401);
   const owner=(await u.json()).id;
   switch(data.action){
    case 'list':return json(await actionList(env,db,owner,data));
    case 'save-profile':return json(await actionSaveProfile(env,db,owner,data));
    case 'run':return json(await actionRun(env,db,fetcher,owner,data));
    case 'adopt':return json(await actionAdopt(env,db,owner,data));
    case 'market':return json(await actionMarket(env,db,fetcher,owner));
    case 'search-market':return json(await actionSearchMarket(env,fetcher,owner,data));
    case 'budget-draft':return json(await actionBudgetDraft(env,db,fetcher,owner,data));
    case 'wealth-status':return json(await actionWealthStatus(env,db,owner,data));
    case 'wealth-history':return json(await actionWealthHistory(env,db,owner,data));
    case 'activate-wealth':return json(await actionWealthSetEnabled(env,db,fetcher,owner,data,true));
    case 'pause-wealth':return json(await actionWealthSetEnabled(env,db,fetcher,owner,data,false));
    default:throw new ServiceError('ACTION_UNKNOWN','Unbekannte Aktion.');
   }
  }catch(e){
   const d=diagnostics(e);
   return json({error:d.message,diagnostic:d},e.status>=400&&e.status<600?e.status:400);
  }
 };
}
Deno.serve(createHandler({
 url:Deno.env.get('SUPABASE_URL')||'',
 serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',
 openrouterKey:Deno.env.get('OPENROUTER_API_KEY')||'',
 model:Deno.env.get('OPENROUTER_ADVISOR_MODEL')||Deno.env.get('OPENROUTER_MODEL')||'',
 twelveDataKey:Deno.env.get('TWELVE_DATA_API_KEY')||'',
 newsKey:Deno.env.get('FINNHUB_API_KEY')||'',
 cronSecret:Deno.env.get('ADVISOR_CRON_SECRET')||'',
 billingOwner:Deno.env.get('TRADING212_OWNER_ID')||'',
 enforceBudget:true,
 allowedOrigins:(Deno.env.get('ALLOWED_ORIGINS')||'').split(',').map(s=>s.trim()).filter(Boolean)
}));
