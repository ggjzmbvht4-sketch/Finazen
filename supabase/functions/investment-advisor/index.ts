// Kontur Wealth — verwaltete Anlagestrategien
// Offenlegung: Keine Anlageberatung nach WpHG. Regelbasierte Modelle. Keine
// Garantie. Keine Orders. Modelleinheiten sind synthetisch, nie Broker-Stücke.
class ServiceError extends Error {
 constructor(code,message,{status=400,retryable=false,retryAfter=0,requestId=null}={}){super(message);Object.assign(this,{name:'ServiceError',code,status,retryable,retryAfter,requestId});}
}
function safeMessage(value,secrets=[]){
 let text=String(value||'Unbekannter Fehler').slice(0,1800);
 for(const secret of secrets.filter(x=>typeof x==='string'&&x.length>3))text=text.split(secret).join('[entfernt]');
 return text.replace(/Bearer\s+\S+/gi,'Bearer [entfernt]').replace(/(?:sk-or-v1-|sk-ant-|sb_secret_)[\w-]+/g,'[entfernt]').replace(/((?:apikey|api_key|token|password|secret)=)[^&\s"']+/gi,'$1[entfernt]').replace(/[\r\n]+/g,' ').slice(0,600);
}
async function boundedJSON(response,maxBytes=4*1024*1024){
 const declared=Number(response.headers?.get('content-length'));if(declared>maxBytes){await response.body?.cancel();throw new ServiceError('RESPONSE_TOO_LARGE','Die Datenantwort ist zu groß. Die Aufgabe wird in kleinere Abschnitte geteilt.');}
 if(!response.body){return null;}
 const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,text='';
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes)throw new ServiceError('RESPONSE_TOO_LARGE','Datenantwort überschreitet die erlaubte Größe.');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return text?JSON.parse(text):null;}
 catch(e){await reader.cancel().catch(()=>{});if(e instanceof ServiceError)throw e;throw new ServiceError('INVALID_RESPONSE','Der Dienst hat keine gültige Datenantwort geliefert.',{retryable:true});}
}
function diagnostics(e){return {code:e.code||'PROCESSING_ERROR',message:safeMessage(e.message),retryable:e.retryable!==false,status:e.status||null,requestId:e.requestId||null,retryAfter:e.retryAfter||0};}
function createDB(env,fetcher=fetch){return async(path,method='GET',body)=>{
 const response=await fetcher(env.url+'/rest/v1/'+path,{method,headers:{apikey:env.serviceKey,Authorization:'Bearer '+env.serviceKey,'Content-Type':'application/json',Prefer:'return=representation,resolution=merge-duplicates'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const data=await boundedJSON(response,8*1024*1024);if(!response.ok)throw new ServiceError('DATABASE_ERROR',safeMessage(data?.message||'Datenbank nicht erreichbar. Migrationen prüfen.'),{retryable:response.status>=500,status:response.status});return data;
};}
// --- managed-core.js (shared, deterministic model rules; EUR cents, basis points) ---
const RULES_VERSION = 'kontur-wealth-1';
const dayMs = 86400000;
function mandate(goal, enabled = true) {
  const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
  if (!goal || !/^[\da-f-]{36}$/i.test(goal.id) || typeof goal.name !== 'string' || !goal.name.trim() || goal.name.length > 100 || !['conservative','balanced','growth'].includes(goal.risk) || !integer(goal.years,1,50) || ![goal.start,goal.rate,goal.target].every(v=>integer(v,0,1e14)) || !integer(goal.cash,0,10000) || !integer(goal.cap,500,10000)) throw Error('Anlageziel und Risikoprofil prüfen.');
  if (!['longterm','active'].includes(goal.approach) || !['none','basic','experienced'].includes(goal.experience) || !['needed','covered'].includes(goal.emergencyFund) || !integer(goal.liquidityYears,0,50) || !integer(goal.lossTolerance,1,80)) throw Error('Erfahrung, Liquiditätsbedarf und Verlusttragfähigkeit ergänzen.');
  if (goal.emergencyFund !== 'covered') throw Error('Zuerst einen verfügbaren Notgroschen außerhalb dieser Strategie einplanen.');
  if (goal.approach === 'active' && (goal.experience !== 'experienced' || goal.years < 5 || goal.lossTolerance < 30 || goal.liquidityYears > 0 && goal.liquidityYears < 5)) throw Error('Aktive Aktienstrategien benötigen Erfahrung, mindestens fünf Jahre verfügbares Kapital und mindestens 30 % Verlusttragfähigkeit.');
  if (goal.liquidityYears > 0 && goal.liquidityYears < goal.years) throw Error('Anlagehorizont an den früheren Liquiditätsbedarf anpassen.');
  // W10 (R1): Mindestanlage — Startkapital plus sechs monatliche Sparraten
  // müssen zusammen mindestens 100 Euro ergeben.
  if (goal.start + goal.rate * 6 < 10000) throw Error('Mindestanlage nicht erreicht: Startkapital plus sechs monatliche Sparraten müssen zusammen mindestens 100 Euro ergeben.');
  // W13 (R4): Optionale Einkommens-/Vermögensangaben und Plausibilität der
  // Sparrate gegen das deklarierte monatliche Einkommen.
  const optCents = v => v === undefined || v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 1e14);
  if (!optCents(goal.monthlyIncomeCents) || !optCents(goal.liquidAssetsCents)) throw Error('Angaben zu Einkommen und verfügbarem Vermögen prüfen.');
  if (Number.isSafeInteger(goal.monthlyIncomeCents) && goal.rate > goal.monthlyIncomeCents) throw Error('Die monatliche Sparrate übersteigt das deklarierte monatliche Einkommen. Bitte Sparrate oder Angaben anpassen.');
  for (const key of ['sectorLimit','currencyLimit']) if (!integer(goal[key],100,10000)) throw Error('Branchen- und Listingwährungsgrenzen prüfen.');
  if (!Array.isArray(goal.exclude) || goal.exclude.length > 200 || goal.exclude.some(x=>typeof x!=='string')) throw Error('Ausschlüsse prüfen.');
  return {mandateVersion:2,rulesVersion:RULES_VERSION,strategyId:goal.id,name:goal.name.trim(),approach:goal.approach,risk:goal.risk,years:goal.years,start:goal.start,rate:goal.rate,target:goal.target,cash:goal.cash,cap:goal.cap,sectorLimit:goal.sectorLimit,currencyLimit:goal.currencyLimit,lossTolerance:goal.lossTolerance,liquidityYears:goal.liquidityYears,experience:goal.experience,emergencyFund:goal.emergencyFund,exclude:[...new Set(goal.exclude)].sort(),...(Number.isSafeInteger(goal.monthlyIncomeCents)?{monthlyIncomeCents:goal.monthlyIncomeCents}:{}),...(Number.isSafeInteger(goal.liquidAssetsCents)?{liquidAssetsCents:goal.liquidAssetsCents}:{}),enabled:enabled===true,consent:true,intervalDays:1,reviewDays:goal.approach==='active'?7:30,driftBps:500};
}
// W13 (R4): confirmedAt bleibt außen vor — eine Re-Bestätigung der
// Geeignetheitsprüfung ändert das Mandat nicht.
function mandateIdentity(profile) { const {enabled,confirmedAt,...identity}=profile; return JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a],[b])=>a.localeCompare(b)))); }
function strategicWeights(p) {
  if(p.approach==='active'){const stock=Math.min({conservative:3000,balanced:6000,growth:8500}[p.risk],p.lossTolerance*150,10000-p.cash);return {stock,cash:10000-stock};}
  const equity=Math.min({conservative:3000,balanced:6000,growth:8500}[p.risk],p.years<3?0:p.years<5?3000:10000,p.lossTolerance*150,10000-p.cash);
  const cash=Math.max(p.cash,p.years<3?8000:0);
  const stock=Math.min(equity,10000-cash),em=Math.round(stock*.15);
  return {world:stock-em,em,bond:10000-cash-stock,cash};
}
// Vertrag (B12): indicators.momentum20Pct = Momentum über 63 Handelstage, wie es
// yahooChart im Advisor liefert (63er-Lookback); der Feldname bleibt aus
// Kompatibilitätsgründen unverändert.
function activeScore(facts, indicators) {
  const f=facts||{},keys=['roe','pe','debtToEquity','revenueGrowth'];
  const momentumPct=indicators?.momentum20Pct;
  if(keys.some(k=>!Number.isFinite(f[k])) || !(f.pe>0) || f.debtToEquity<0 || !Number.isFinite(momentumPct)) return null;
  const relative=f.sectorScore;if(relative?.version==='sector-percentiles-v12.1'&&Object.keys(relative.components||{}).length===5&&['quality','valuation','debt','growth','momentum'].every(k=>Number.isFinite(relative.components?.[k])&&relative.components[k]>=0&&relative.components[k]<=100))return {version:relative.version,value:Object.values(relative.components).reduce((a,b)=>a+b,0)/5,components:relative.components};
  const clamp=x=>Math.max(0,Math.min(100,x));
  const components={quality:clamp(f.roe*250),valuation:clamp(100-f.pe*2),debt:clamp(100-f.debtToEquity*50),growth:clamp(50+f.revenueGrowth*200),momentum:clamp(50+momentumPct*2)};
  return {version:RULES_VERSION,value:Object.values(components).reduce((n,x)=>n+x,0)/5,components};
}
function allocateModel(profile, candidates, market) {
  const target=strategicWeights(profile),positions=[],sectors=new Map(),currencies=new Map();
  if(candidates.some(u=>u.brokerConfirmed&&!market.some(m=>m.id===u.id&&!m.error)))throw new ServiceError('UNIVERSE_EMPTY','Kein verwaltbares Universum: bestätigte Instrumente haben keine belastbaren Marktdaten.');
  for(const [group,budget] of Object.entries(target)) {
    if(group==='cash'||!budget) continue;
    let left=budget;
    const eligible=candidates.filter(u=>u.group===group && u.brokerConfirmed && !profile.exclude.includes(u.isin) && market.some(m=>m.id===u.id&&!m.error&&!m.indicators?.stale) && (profile.approach!=='active'||activeScore(market.find(m=>m.id===u.id)?.facts,market.find(m=>m.id===u.id)?.indicators)))
      .sort((a,b)=>profile.approach==='active'?(activeScore(market.find(m=>m.id===b.id).facts,market.find(m=>m.id===b.id).indicators).value-activeScore(market.find(m=>m.id===a.id).facts,market.find(m=>m.id===a.id).indicators).value||a.id.localeCompare(b.id)):(a.fee-b.fee||a.id.localeCompare(b.id)));
    for(const u of eligible) {
      // W12 (R3): Branchen- und Währungsgrenzen gelten nur für Einzelaktien;
      // ETF-/Katalogpositionen ohne sector-Feld werden nicht als 'unknown'
      // gegen die Branchenkappe aggregiert.
      const m=market.find(m=>m.id===u.id),sector=m.sector||null,stock=u.kind==='stock';
      const weightBps=Math.max(0,Math.min(left,profile.cap,
        ...(stock&&sector?[profile.sectorLimit-(sectors.get(sector)||0)]:[]),
        ...(stock?[profile.currencyLimit-(currencies.get(u.currency)||0)]:[])));
      if(!weightBps) continue;
      const score=profile.approach==='active'?activeScore(m.facts,m.indicators):null;
      const alternative=eligible.find(x=>x.id!==u.id);
      const reason=score?'Bewertung '+score.value.toFixed(1)+'/100 (je 20 %): '+Object.entries(score.components).map(([k,v])=>({quality:'Qualität',valuation:'Bewertung',debt:'Verschuldung',growth:'Wachstum',momentum:'Momentum'})[k]+' '+v.toFixed(0)).join(', ')+'. Berichtsstand '+m.facts.asOf+'.':
        'Strategischer '+({world:'Industrieländer',em:'Schwellenländer',bond:'Anleihen'})[group]+'-Baustein; Produktkosten laut gepflegtem Katalog '+(u.fee/100).toFixed(2)+' % p. a.'+(alternative?' Vergleich: '+alternative.name+' ('+(alternative.fee/100).toFixed(2)+' %).':' Kein weiterer bestätigter Baustein dieser Klasse mit ausreichenden Daten.');
      positions.push({id:u.id,weightBps,reason});
      if(stock&&sector)sectors.set(sector,(sectors.get(sector)||0)+weightBps);
      if(stock)currencies.set(u.currency,(currencies.get(u.currency)||0)+weightBps);
      left-=weightBps;
      if(!left) break;
    }
    if(left) throw new ServiceError('ALLOCATION_IMPOSSIBLE','Keine belastbare Zusammensetzung: Für '+group+' fehlen bestätigte Produkte, Daten oder Spielraum innerhalb deiner Grenzen. Bestehendes Modell bleibt erhalten.');
  }
  return {summary:profile.name,positions,cashWeightBps:target.cash,action:'hold',changeReason:'Regelbasierte Zielaufteilung '+RULES_VERSION,portfolioAssessment:'Modellstrategie; tatsächliche Bestände werden separat gepflegt.',optimizations:[],risks:['Modellwerte sind keine echten Depotbestände.','Verlusttragfähigkeit ist keine Verlustgarantie.','ETF-Durchschau und wirtschaftliches Währungsrisiko sind ohne bestätigte Daten unbekannt.'],sources:[...new Set(candidates.filter(u=>positions.some(x=>x.id===u.id)).map(u=>u.source).filter(Boolean))]};
}
function validateModel(rec,p,universe,market) {
  if(!rec || !Number.isInteger(rec.cashWeightBps)||rec.cashWeightBps<p.cash||rec.cashWeightBps>10000||!Array.isArray(rec.positions)) throw Error('Ungültige Modellgewichte.');
  const seen=new Set(),sectors=new Map(),currencies=new Map();let total=rec.cashWeightBps;
  for(const pos of rec.positions){
    const u=universe.find(u=>u.id===pos.id),m=market.find(m=>m.id===pos.id);
    if(!u?.brokerConfirmed||seen.has(pos.id)||p.exclude.includes(u.isin)||!Number.isInteger(pos.weightBps)||pos.weightBps<=0||pos.weightBps>p.cap||!m||m.error||m.indicators?.stale)throw Error('Instrument, Kursstand oder Positionsgrenze ungültig.');
    if(p.approach==='longterm'&&(u.kind!=='etf'||!u.ucits||!['world','em','bond'].includes(u.group)))throw Error('Nur klassifizierte UCITS-ETFs sind im langfristigen Modell zulässig.');
    if(p.approach==='active'&&(u.kind!=='stock'||!activeScore(m.facts,m.indicators)))throw Error('Aktienbewertung unvollständig.');
    // W12 (R3): Grenzen nur für Einzelaktien aggregieren; ETF-/Katalog-
    // positionen ohne sector-Feld zählen nicht als 'unknown'-Branche.
    if(u.kind==='stock'){if(m.sector)sectors.set(m.sector,(sectors.get(m.sector)||0)+pos.weightBps);currencies.set(u.currency,(currencies.get(u.currency)||0)+pos.weightBps);}
    seen.add(pos.id);total+=pos.weightBps;
  }
  if(total!==10000||[...sectors.values()].some(x=>x>p.sectorLimit)||[...currencies.values()].some(x=>x>p.currencyLimit))throw Error('Gesamtgewicht, Branche oder Listingwährungsgrenze verletzt.');
  const bounds=strategicWeights(p);
  for(const group of Object.keys(bounds).filter(x=>x!=='cash')) if(rec.positions.reduce((n,x)=>n+(universe.find(u=>u.id===x.id).group===group?x.weightBps:0),0)>bounds[group])throw Error('Strategische Anlageklassengrenze verletzt.');
  return rec;
}
function marketPrice(m) {const v=m?.indicators?.last*m?.fx;if(!(v>0)||!Number.isFinite(v))throw Error('Kurs oder EUR-Umrechnung fehlt.');return v;}
function repricePosition(position,market){
 const next={...position},price=marketPrice(market),asOf=market.indicators.asOf;
 if(next.priceAsOf&&next.priceAsOf!==asOf){
  const row=market.indicators.history?.find(x=>x.date===next.priceAsOf),fx=market.fxHistory?market.fxHistory[next.priceAsOf]:market.fx===1?1:null;
  if(!row||!(fx>0))throw Error('Historischer Referenzkurs für Modellfortschreibung fehlt.');
  // Adjusted series include splits/distributions. Preserve total-return continuity rather than
  // treating a split as a loss. Units are synthetic model units, never broker quantities.
  next.units*=next.priceEUR/(row.close*fx);
 }
 next.priceEUR=price;next.priceAsOf=asOf;next.valueCents=Math.round(next.units*price*100);return next;
}
function markModel(previous,market,asOf) {
  if(!previous)return null;
  const next=structuredClone(previous);let value=next.cashCents;
  for(const pos of next.positions){const m=market.find(m=>m.id===pos.id);if(!m||m.error||m.indicators?.stale)throw Error('Modellbewertung unvollständig; letzter gültiger Stand bleibt erhalten.');Object.assign(pos,repricePosition(pos,m));value+=pos.valueCents;}
  next.valueCents=value;next.asOf=asOf;
  next.history=[...(next.history||[]).filter(x=>x.date!==asOf),{date:asOf,valueCents:value,paidCents:next.paidCents}].slice(-3660);
  return next;
}
function drift(model,rec,universe) {
  if(!model?.valueCents)return Infinity;
  const actual=new Map(),target=new Map();
  for(const pos of model.positions){const g=universe.find(u=>u.id===pos.id)?.group||'unknown';actual.set(g,(actual.get(g)||0)+pos.valueCents/model.valueCents*10000);}
  actual.set('cash',model.cashCents/model.valueCents*10000);target.set('cash',rec.cashWeightBps);
  for(const pos of rec.positions){const g=universe.find(u=>u.id===pos.id)?.group||'unknown';target.set(g,(target.get(g)||0)+pos.weightBps);}
  return Math.max(...new Set([...actual.keys(),...target.keys()].map(g=>Math.abs((actual.get(g)||0)-(target.get(g)||0)))));
}
function depositDue(previous,profile,date) {
  if(!previous)return 0;
  const last=previous.depositThrough||previous.startedOn;
  const months=d=>Number(d.slice(0,4))*12+Number(d.slice(5,7));
  return Math.max(0,months(date)-months(last))*profile.rate;
}
function evolveModel(previous,rec,universe,market,profile,date,{rebalance=false,deposit=0}={}) {
  let model=previous?structuredClone(previous):{version:1,rulesVersion:RULES_VERSION,startedOn:date,depositThrough:date,paidCents:profile.start,valueCents:profile.start,cashCents:profile.start,positions:[],history:[]};
  const transactions=[];model.cashCents+=deposit;model.paidCents+=deposit;model.valueCents+=deposit;
  if(deposit){transactions.push({type:'model-deposit',amountCents:deposit});model.depositThrough=date;}
  const capital=model.valueCents;
  if(rebalance||!previous){
    const next=[];let spent=0;
    for(const p of rec.positions){const m=market.find(x=>x.id===p.id),priceEUR=marketPrice(m),valueCents=Math.floor(capital*p.weightBps/10000),units=valueCents/(priceEUR*100),old=model.positions.find(x=>x.id===p.id)?.units||0;next.push({id:p.id,units,valueCents,priceEUR,priceAsOf:m.indicators.asOf});spent+=valueCents;if(units!==old)transactions.push({type:'model-trade',id:p.id,units:units-old,priceEUR,priceAsOf:m.indicators.asOf,amountCents:Math.round((units-old)*priceEUR*100)});}
    for(const old of model.positions.filter(x=>!rec.positions.some(p=>p.id===x.id))){const m=market.find(x=>x.id===old.id);transactions.push({type:'model-trade',id:old.id,units:-old.units,priceEUR:marketPrice(m),priceAsOf:m.indicators.asOf,amountCents:-old.valueCents});}
    model.positions=next;model.cashCents=capital-spent;
  }else if(deposit){
    let available=Math.min(deposit,Math.max(0,model.cashCents-Math.ceil(capital*rec.cashWeightBps/10000)));
    const needs=rec.positions.map(p=>({p,need:Math.max(0,Math.floor(capital*p.weightBps/10000)-(model.positions.find(x=>x.id===p.id)?.valueCents||0))})).sort((a,b)=>b.need-a.need||a.p.id.localeCompare(b.p.id));
    for(const {p,need} of needs){const cents=Math.min(available,need);if(!cents)continue;const m=market.find(x=>x.id===p.id),priceEUR=marketPrice(m);let pos=model.positions.find(x=>x.id===p.id);if(!pos){pos={id:p.id,units:0,valueCents:0,priceEUR,priceAsOf:m.indicators.asOf};model.positions.push(pos);}const units=cents/(priceEUR*100);pos.units+=units;pos.valueCents+=cents;pos.priceEUR=priceEUR;model.cashCents-=cents;available-=cents;transactions.push({type:'model-trade',id:p.id,units,priceEUR,priceAsOf:m.indicators.asOf,amountCents:cents});}
  }
  model.recommendation=rec;model.universe=universe;model.asOf=date;model.costAssumption='Modell mit synthetischen Bruchstücken und bereinigten Kursreihen (Ausschüttungen reinvestiert); 0 € Ordergebühr. Spreads, individuelle Steuern und FX-Gebühren nicht simuliert. Nachgeholte Sparraten werden zum aktuellen verfügbaren Modellkurs angelegt.';
  model.history=[...model.history.filter(x=>x.date!==date),{date,valueCents:model.valueCents,paidCents:model.paidCents}].slice(-3660);
  return {model,transactions};
}
function actualFresh(portfolio,date) {const gap=(Date.parse(date)-Date.parse(portfolio?.lastReconciledAt))/dayMs;return Number.isFinite(gap)&&gap>=-1&&gap<=7;}
// Buy-and-hold-Referenz, finanziert an denselben Modelldaten; keine rückblickenden Kurse.
// W11 (R2): Die Finanzierung folgt dauerhaft dem Modell — der Aufrufer
// übergibt das Delta von model.paidCents gegenüber benchmark.paidCents
// (Nachbuchung), nicht die fällige Sparrate.
function updateBenchmark(previous,instruments,market,weights,funding,date){
 const b=previous?structuredClone(previous):{startedOn:date,paidCents:0,cashCents:0,positions:[],history:[]};
 for(const pos of b.positions){const m=market.find(x=>x.id===pos.id);if(!m||m.error||m.indicators?.stale)throw Error('Benchmark-Kurs fehlt.');Object.assign(pos,repricePosition(pos,m));}
 b.paidCents+=funding;b.cashCents+=funding;
 for(const [group,bps]of Object.entries(weights)){
  if(group==='cash'||!bps)continue;
  const u=instruments.find(u=>u.group===group);if(!u)throw Error('Benchmark-Instrument fehlt.');
  const m=market.find(m=>m.id===u.id);if(!m||m.error||m.indicators?.stale)throw Error('Benchmark-Kurs fehlt.');
  const price=marketPrice(m),amount=Math.floor(funding*bps/10000);let pos=b.positions.find(x=>x.id===u.id);
  if(!pos){pos={id:u.id,units:0,priceEUR:price,priceAsOf:m.indicators.asOf};b.positions.push(pos);}pos.units+=amount/(price*100);b.cashCents-=amount;
 }
 b.valueCents=b.cashCents;
 for(const pos of b.positions){const m=market.find(m=>m.id===pos.id);if(!m||m.error||m.indicators?.stale)throw Error('Benchmark-Bewertung unvollständig.');b.valueCents+=Math.round(pos.units*marketPrice(m)*100);}
 b.instruments=instruments;b.weights=weights;b.asOf=date;b.label='Unverändertes Referenzportfolio · gleiche Modell-Einzahlungen';
 b.history=[...b.history.filter(x=>x.date!==date),{date,valueCents:b.valueCents,paidCents:b.paidCents}].slice(-3660);return b;
}
function modelLimitBreaches(model,profile,market){
 const sectors=new Map(),currencies=new Map();
 for(const pos of model.positions){const u=model.universe?.find(x=>x.id===pos.id),m=market.find(x=>x.id===pos.id);if(!u||!m)return true;if(u.kind==='stock'){if(m.sector)sectors.set(m.sector,(sectors.get(m.sector)||0)+pos.valueCents);currencies.set(u.currency,(currencies.get(u.currency)||0)+pos.valueCents);}if(pos.valueCents>model.valueCents*profile.cap/10000+1)return true;}
 return model.cashCents+1<model.valueCents*profile.cash/10000||[...sectors.values()].some(v=>v>model.valueCents*profile.sectorLimit/10000+1)||[...currencies.values()].some(v=>v>model.valueCents*profile.currencyLimit/10000+1);
}

// --- catalog.js: kuratierter longterm-Katalog, nie dynamisch gescraped ---
const CATALOG=[
 {id:'IE00B4L5Y983',isin:'IE00B4L5Y983',kind:'etf',ucits:true,group:'world',name:'iShares Core MSCI World',fee:20,currency:'USD',source:'https://www.ishares.com/de/privatanleger/de/produkte/251882/ishares-msci-world-ucits-etf-acc-fund',verifiedAt:'2026-01-15',active:true},
 {id:'IE00BJ0KDQ92',isin:'IE00BJ0KDQ92',kind:'etf',ucits:true,group:'world',name:'Xtrackers MSCI World',fee:12,currency:'USD',source:'https://etf.dws.com/de-de/IE00BJ0KDQ92-msci-world-ucits-etf-1c/',verifiedAt:'2026-01-15',active:true},
 {id:'IE00B4L5YX21',isin:'IE00B4L5YX21',kind:'etf',ucits:true,group:'em',name:'iShares Core MSCI Emerging Markets IMI',fee:18,currency:'USD',source:'https://www.ishares.com/de/privatanleger/de/produkte/264659/ishares-msci-emerging-markets-imi-ucits-etf',verifiedAt:'2026-01-15',active:true},
 {id:'IE00BKM4GZ66',isin:'IE00BKM4GZ66',kind:'etf',ucits:true,group:'em',name:'iShares Core MSCI Emerging Markets IMI (A2PKTG-äquivalent dokumentiert)',fee:18,currency:'USD',source:'https://www.ishares.com/de/privatanleger/de/produkte/264659/ishares-msci-emerging-markets-imi-ucits-etf',verifiedAt:'2026-01-15',active:true},
 {id:'IE00BDBRDM35',isin:'IE00BDBRDM35',kind:'etf',ucits:true,group:'bond',name:'Xtrackers Global Aggregate Bond EUR Hedged',fee:25,currency:'EUR',source:'https://etf.dws.com/de-de/IE00BDBRDM35-xtrackers-global-aggregate-bond-ucits-etf-1c-eur-hedged/',verifiedAt:'2026-01-15',active:true},
 {id:'IE00B3F81R35',isin:'IE00B3F81R35',kind:'etf',ucits:true,group:'bond',name:'iShares Core Global Aggregate Bond EUR Hedged',fee:10,currency:'EUR',source:'https://www.ishares.com/de/privatanleger/de/produkte/291778/ishares-core-global-aggregate-bond-ucits-etf',verifiedAt:'2026-01-15',active:true},
 {id:'IE00B4WXJJ64',isin:'IE00B4WXJJ64',kind:'etf',ucits:true,group:'bond',name:'iShares Core Global Aggregate Bond (EUNH-Klasse dokumentiert)',fee:10,currency:'EUR',source:'https://www.ishares.com/de/privatanleger/de/produkte/291778/ishares-core-global-aggregate-bond-ucits-etf',verifiedAt:'2026-01-15',active:true}
];
// Symbol nur für Marktpreise; Katalog-Felder ersetzen fehlende Providerdaten nie.
const BENCHMARKS=[
 {id:'IE00BJ0KDQ92',symbol:'EUN1.DE',group:'world'},
 {id:'IE00BKM4GZ66',symbol:'EUNM.DE',group:'em'},
 {id:'IE00B4WXJJ64',symbol:'EUNH.DE',group:'bond'}
];

// --- shared/http.js (Kontur-Brokerfassade für Zielgewichte, niemals Orders) ---
function createBroker(env,fetcher){return async(path,method='GET',body)=>{
 if(!env.brokerKey||!env.brokerSecret)throw new ServiceError('BROKER_SETUP','Trading212-Live-Schlüssel und Secret in Supabase einrichten. Demo-Zugänge werden nicht ausprobiert.');
 if(!/^\/equity\/(pies(?:\/\d+)?|metadata\/instruments)$/.test(path)||!['GET','POST'].includes(method)||method==='POST'&&!/^\/equity\/pies\/\d+$/.test(path))throw new ServiceError('BROKER_OPERATION','Diese Broker-Operation ist nicht freigegeben.');
 if(method==='POST'&&(Object.keys(body||{}).some(k=>k!=='instrumentShares')||!body?.instrumentShares||Object.values(body.instrumentShares).some(v=>typeof v!=='number')))throw new ServiceError('BROKER_OPERATION','Automatische Pflege schreibt nur Zielgewichte der Titel. Es werden keine Orders ausgelöst.');
 let r;try{r=await fetcher('https://live.trading212.com/api/v0'+path,{method,headers:{Authorization:'Basic '+btoa(env.brokerKey+':'+env.brokerSecret),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});}
 catch{throw new ServiceError('BROKER_UPSTREAM','Trading212 ist vorübergehend nicht erreichbar. Der letzte Stand bleibt erhalten.',{retryable:true,retryAfter:300});}
 if(!r.ok){const detail=await r.text().catch(()=> '');if(r.status===401)throw new ServiceError('BROKER_INVALID_CREDENTIALS','Trading212-Schlüssel oder Secret ist ungültig. Es wird nur die Live-API verwendet.');if(r.status===404)throw new ServiceError('BROKER_PIE_MISSING','Der verknüpfte Pie ist beim Broker nicht (mehr) sichtbar.',{status:404});if(r.status===429)throw new ServiceError('BROKER_RATE_LIMIT','Trading212-Abrufgrenze. Der letzte Stand bleibt erhalten.',{retryable:true,retryAfter:Number(r.headers.get('x-ratelimit-reset'))||120,status:429});throw new ServiceError('BROKER_UPSTREAM','Trading212-Fehler '+r.status+' '+safeMessage(detail).slice(0,180),{retryable:r.status>=500,retryAfter:300,status:r.status});}
 if(r.status===204)return {};return boundedJSON(r,12*1024*1024);
};}
function normalizeShares(rows){
 const totals=new Map();for(const r of rows){if(!/^[A-Za-z0-9_.-]{1,80}$/.test(r.ticker)||!Number.isFinite(r.weight)||r.weight<=0)throw new ServiceError('INVALID_WEIGHTS','Ungültige Pie-Zielgewichte.');totals.set(r.ticker,(totals.get(r.ticker)||0)+r.weight);}
 if(!totals.size||totals.size>100)throw new ServiceError('EMPTY_PIE','Keine vollständige, handelbare Zielverteilung verfügbar.');
 const sum=[...totals.values()].reduce((a,b)=>a+b,0),parts=[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([ticker,w])=>({ticker,bps:Math.floor(w/sum*10000),rest:w/sum*10000%1}));
 let remaining=10000-parts.reduce((n,p)=>n+p.bps,0);for(const p of [...parts].sort((a,b)=>b.rest-a.rest||a.ticker.localeCompare(b.ticker))){if(remaining-->0)p.bps++;}
 if(parts.some(p=>p.bps===0))throw new ServiceError('TINY_WEIGHT','Zielgewicht ist kleiner als die unterstützte Genauigkeit.');
 return Object.fromEntries(parts.map(p=>[p.ticker,p.bps/10000]));
}

// --- market.js: Marktdaten in zwei Schichten; Zähler werden nie vermischt ---
async function yahooCloses(symbol,fetcher){
 let r;try{r=await fetcher('https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(symbol)+'?range=1y&interval=1d&events=div%2Csplit',{headers:{'User-Agent':'Kontur/12.1'},signal:AbortSignal.timeout(12000)});}
 catch(e){throw new ServiceError('MARKET_DATA','Kursdaten sind vorübergehend nicht erreichbar.',{retryable:true,retryAfter:300});}
 if(!r.ok)throw new ServiceError('MARKET_DATA','Kursreihe '+symbol+' nicht erreichbar (HTTP '+r.status+').',{retryable:r.status===429||r.status>=500,retryAfter:300,status:r.status});
 const body=await boundedJSON(r,5*1024*1024),chart=body?.chart?.result?.[0];
 const ts=chart?.timestamp||[],quote=chart?.indicators?.quote?.[0]||{},adj=chart?.indicators?.adjclose?.[0]?.adjclose||[],volume=quote.volume||[];
 const rows=ts.map((t,i)=>({date:new Date(t*1000).toISOString().slice(0,10),close:adj[i],volume:volume[i]})).filter(x=>Number.isFinite(x.close)&&x.close>0).filter((x,i,a)=>x.date!==a[i-1]?.date).slice(-250);
 // W14 (R5): Tageshöchstwerte; der letzte Schlusskurs kommt aus derselben
 // bereinigten Zeitreihe (AdjClose), damit Historie und Bewertung identisch skalieren.
 return {rows,high:Math.max(...rows.map(x=>x.close)),last:rows.at(-1)?.close,asOf:rows.at(-1)?.date,momentum20Pct:rows.length>63?(rows.at(-1).close/rows.at(-63).close-1)*100:null};
}
async function frankfurterRate(currency,fetcher){
 if(currency==='EUR')return {rate:1,source:'EUR'};
 let r;try{r=await fetcher('https://api.frankfurter.app/latest?from='+encodeURIComponent(currency)+'&to=EUR',{signal:AbortSignal.timeout(12000)});}catch{throw new ServiceError('FX_UNAVAILABLE','Wechselkurs nicht erreichbar.',{retryable:true,retryAfter:3600});}
 if(!r.ok)throw new ServiceError('FX_UNAVAILABLE','Wechselkurs nicht erreichbar (HTTP '+r.status+').',{retryable:true,retryAfter:3600});
 const body=await boundedJSON(r,200000),rate=Number(body?.rates?.EUR);if(!(rate>0))throw new ServiceError('FX_UNAVAILABLE','Wechselkurs fehlt.');
 return {rate,source:'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html'};
}
async function buildManagedUniverse(env,db,fetcher,owner,profile,existing){
 const catalog=CATALOG.filter(u=>u.active&&(!u.allowedApproaches||u.allowedApproaches.includes(profile.approach)));
 const activeStocks=(await db('v12_instruments?owner_id=eq.'+owner+'&active=eq.true&status=eq.analysed&select=isin,name,provider_ticker,sector,score,facts,as_of,updated_at')).map(row=>({id:row.isin,isin:row.isin,kind:'stock',ucits:null,group:'stock',name:row.name,fee:null,currency:row.facts?.fxSource==='EUR'?'EUR':'USD',source:row.facts?.source||null,verifiedAt:row.updated_at,providerTicker:row.provider_ticker,sector:row.sector,facts:row.facts,factsAsOf:row.as_of}));
 const confirmed=profile.approach==='active'?activeStocks:catalog;
 const universe=confirmed.filter(u=>!(existing?.universe||[]).some(x=>x.id===u.id)||existing.universe.find(x=>x.id===u.id).brokerConfirmed).map(u=>{
  const old=(existing?.universe||[]).find(x=>x.id===u.id);
  return {...u,brokerConfirmed:old?.brokerConfirmed??null,brokerTicker:old?.brokerTicker??null};
 });
 const products=await db('v12_broker_products?owner_id=eq.'+owner+'&isin=in.('+[...new Set([...universe.map(u=>u.isin),...BENCHMARKS.map(b=>b.id)])].join(',')+')');
 const seen=new Set(),conflicts=new Set();
 for(const p of products){if(seen.has(p.isin))conflicts.add(p.isin);seen.add(p.isin);}
 for(const u of universe){const match=products.find(p=>p.isin===u.isin);if(conflicts.has(u.isin))u.brokerTicker=null;else if(match)u.brokerTicker=match.broker_ticker;u.brokerConfirmed=Boolean(u.brokerTicker);}
 if(confirmed.length>1&&!universe.some(u=>u.brokerConfirmed))throw new ServiceError('UNIVERSE_EMPTY','Kein verwaltbares Universum: Der Broker bestätigt kein Instrument aus dem Katalog.');
 const market=[];
 for(const u of [...universe,...BENCHMARKS.map(b=>({id:b.id,symbol:b.symbol,currency:'EUR'}))]){
  try{
   const symbol=u.kind==='stock'?u.providerTicker:u.symbol;
   if(!symbol)throw new ServiceError('MARKET_DATA','Kein bestätigtes Kurssymbol verfügbar.');
   const closes=await yahooCloses(symbol,fetcher);
   if(closes.rows.length<20||Date.now()-Date.parse(closes.asOf)>14*dayMs)throw new ServiceError('MARKET_DATA','Kursreihe zu kurz oder nicht aktuell.');
   const fx=u.currency?await frankfurterRate(u.currency,fetcher):{rate:1};
   const history=closes.rows.map(x=>({date:x.date,close:x.close}));
   market.push({id:u.id,fx:fx.rate,fxSource:fx.source,fxHistory:Object.fromEntries(history.map(x=>[x.date,fx.rate])),sector:u.sector||null,facts:u.facts?{roe:u.facts.roe,pe:u.facts.pe,debtToEquity:u.facts.debtToEquity,revenueGrowth:u.facts.revenueGrowth,sectorScore:u.facts.sectorScore,asOf:u.facts.asOf}:null,indicators:{last:closes.last,momentum20Pct:closes.momentum20Pct,high52w:closes.high,asOf:closes.asOf,source:'https://finance.yahoo.com/quote/'+encodeURIComponent(symbol)+'/history/',history,stale:false}});
  }catch(e){market.push({id:u.id,error:e instanceof ServiceError?e.message:'Marktdaten fehlen',source:u.source||null});}
 }
 const usable=universe.filter(u=>u.brokerConfirmed&&!market.find(m=>m.id===u.id)?.error).length;
 return {universe,market,coverage:{catalog:catalog.length,confirmed:confirmed.length,brokerConfirmed:universe.filter(u=>u.brokerConfirmed).length,usable,checked:universe.length}};
}
// --- handler.js: Actions und Job-Dispatcher ---
function createAdvisorHandler(input,fetcher=fetch){
 const env={...input},db=createDB(env,fetcher),broker=createBroker(env,fetcher);
 const own=(t,owner,q='')=>t+'?owner_id=eq.'+owner+(q?'&'+q:'');
 async function actionWealthSetEnabled(data,owner){
  const plans=(await db(own('finance_plans',owner)))[0],goal=plans?.data?.strategies?.find(x=>x.id===data.strategyId);
  if(!plans||!goal)throw new ServiceError('PLAN_MISSING','Das Anlageziel ist nicht mehr im Finanzplan vorhanden. Zuerst den Plan speichern.');
  const enabled=data.enabled!==false;
  const profile=mandate(goal,enabled),key=goal.id;
  // W13 (R4): Bei Aktivierung werden optionale Einkommens-/Vermögensangaben
  // in das Mandat übernommen (goal.monthlyIncomeCents / goal.liquidAssetsCents);
  // fehlen beide, bleibt der Hinweis bestehen.
  const warnings=[];
  if(enabled&&(!Number.isSafeInteger(goal.monthlyIncomeCents)||!Number.isSafeInteger(goal.liquidAssetsCents))){
   const missing=[!Number.isSafeInteger(goal.monthlyIncomeCents)?'Einkommen':null,!Number.isSafeInteger(goal.liquidAssetsCents)?'verfügbares Vermögen':null].filter(Boolean).join(' und ');
   const basis=Number.isSafeInteger(goal.monthlyIncomeCents)?'gegen das deklarierte monatliche Einkommen':'nur anhand von Verlusttragfähigkeit und Liquiditätsbedarf';
   warnings.push('Hinweis zur Geeignetheitsprüfung: '+missing+' wurden nicht angegeben; die Plausibilität der Sparrate wurde '+basis+' geprüft.');
  }
  const existing=(await db(own('advisor_profiles',owner,'strategy_key=eq.'+key)))[0];
  // Bei Reaktivierung desselben Mandats bleibt das ursprüngliche Bestätigungsdatum
  // bestehen; ein geändertes Mandat (oder Löschung über die Bestätigungsliste)
  // setzt confirmedAt neu.
  const reactivation=existing&&mandateIdentity(existing)===mandateIdentity(profile);
  profile.confirmedAt=reactivation?existing.confirmedAt:new Date().toISOString();
  if(enabled){
   // W9 (R2): Probe-Allokation — Aktivierung verweigern, wenn das Universum
   // nicht allokierbar ist, statt erst im nächsten careCycle zu scheitern.
   let probe=null;
   try{
    probe=await buildManagedUniverse(env,db,fetcher,owner,profile,null);
    validateModel(allocateModel(profile,probe.universe,probe.market),profile,probe.universe,probe.market);
   }catch(e){
    if(e instanceof ServiceError&&(e.code==='UNIVERSE_EMPTY'||e.code==='ALLOCATION_IMPOSSIBLE')){
     // Transiente Marktfehler von strukturellen trennen: Sind alle Kursabrufe
     // fehlgeschlagen/veraltet (keine einzige nutzbare Marktzeile), ist die
     // Allokation nicht strukturell unmöglich, sondern gerade nicht prüfbar.
     const marketUnreachable=e.code==='ALLOCATION_IMPOSSIBLE'&&probe&&probe.coverage.checked>0&&probe.coverage.usable===0;
     if(marketUnreachable)throw new ServiceError('MARKET_PROBE_UNAVAILABLE','Marktdaten vorübergehend nicht erreichbar — bitte gleich erneut versuchen.',{status:503,retryable:true,retryAfter:60});
     throw new ServiceError(e.code,safeMessage(e.message).replace('Bestehendes Modell bleibt erhalten.','Die automatische Betreuung wurde nicht aktiviert.'),{status:409});
    }
    throw e;
   }
  }
  await db('advisor_profiles?on_conflict=owner_id,strategy_key','POST',{owner_id:owner,strategy_key:key,profile,next_due:new Date(Date.now()+60000).toISOString(),setup_error:null});
  await db(own('v12_tasks',owner,'kind=eq.advisor-care&task_key=eq.'+key+'&status=in.(queued,blocked)'),'PATCH',{status:'cancelled'});
  if(enabled)await enqueueCare(owner,key,100);
  return {saved:true,profile,warnings};
 }
 async function enqueueCare(owner,key,priority=10){await db('rpc/enqueue_v12_task','POST',{p_owner:owner,p_kind:'advisor-care',p_key:key,p_payload:{},p_priority:priority,p_reset:true});}
 async function careCycle(task){
  const owner=task.owner_id,key=task.task_key,date=new Date().toISOString().slice(0,10);
  const jobId=crypto.randomUUID();let result=null,diagnostic=null;
  try{
   const [planRow,profileRow]=await Promise.all([db(own('finance_plans',owner)),db(own('advisor_profiles',owner,'strategy_key=eq.'+key))]);
   const plan=planRow[0],goal=plan?.data?.strategies?.find(x=>x.id===key),profile=profileRow[0]?.profile;
   if(!plan||!goal||!profile||profile.enabled!==true)throw new ServiceError('MANDATE_MISSING','Mandat oder Anlageziel fehlt. Betreuung zuerst im Anlageziel bestätigen.');
   // W13 (R4): Jährliche Re-Bestätigung der Geeignetheitsprüfung. Überfällig
   // heißt nicht mehr „alles pausiert": Bewertung und Historie laufen weiter
   // (keine Lücken), nur Anpassungen (Rebalance, Einzahlungen, Pie-Ziele)
   // ruhen bis zur erneuten Bestätigung; der Hinweis bleibt als setup_error
   // am Profil sichtbar.
   const confirmationDue=Boolean(profile.confirmedAt&&Date.now()-Date.parse(profile.confirmedAt)>365.25*dayMs);
   const confirmationNotice='Bitte die Geeignetheitsprüfung erneut bestätigen: Die Angaben sind älter als zwölf Monate. Bewertung und Historie laufen weiter; Anpassungen der Zielgewichte sind bis zur erneuten Bestätigung pausiert.';
   // Fix: Ein nachträglich regelwidrig editiertes Ziel darf hier keinen
   // plain Error (PROCESSING_ERROR, 15-Min-Endlos-Retry) auslösen —
   // als MANDATE_INVALID in den Einrichtungspfad (24 h + setup_error) mappen.
   let currentMandate;
   try{currentMandate=mandate(goal,profile.enabled);}catch(e){throw new ServiceError('MANDATE_INVALID',safeMessage(e.message));}
   if(mandateIdentity(currentMandate)!==mandateIdentity(profile))throw new ServiceError('MANDATE_CHANGED','Mandat wurde geändert; Betreuung im Anlageziel erneut bestätigen.');
   const modelRow=(await db(own('wealth_models',owner,'strategy_key=eq.'+key)))[0];
   let model=modelRow?.model||null;
   // Ohne Modell gibt es keine fortzuschreibende Bewertung; die Betreuung
   // startet erst nach der erneuten Bestätigung (klassischer setup_error-Pfad).
   if(confirmationDue&&!model)throw new ServiceError('CONFIRMATION_DUE',confirmationNotice);
   const {universe,market}=await buildManagedUniverse(env,db,fetcher,owner,profile,model);
   let rec=model?.recommendation||null;
   const staleRec=!rec||!model||rec.positions.some(p=>!universe.find(u=>u.id===p.id)?.brokerConfirmed||market.find(m=>m.id===p.id)?.error||market.find(m=>m.id===p.id)?.indicators?.stale);
   const reviewDue=Date.now()-Date.parse(model?.reviewedOn||0)>(profile.reviewDays||30)*dayMs;
   const targetDrift=()=>rec&&Object.entries(strategicWeights(profile)).filter(([g])=>g!=='cash').some(([g,bps])=>Math.abs(rec.positions.filter(p=>universe.find(u=>u.id===p.id)?.group===g).reduce((n,p)=>n+p.weightBps,0)-bps)>1);
   let rebalance=false;
   // W10 (R1): Bestandsschutz — gespeicherte Profile unterhalb der Mindestanlage
   // dürfen weiterlaufen (kein erzwungenes MANDATE_INVALID), aber nicht mehr rebalancen.
   const dormant=(model?.paidCents??0)<10000;
   // W12 (R3): Drift oder Verletzung der Branchen-/Währungsgrenzen löst
   // ebenfalls ein Rebalance aus.
   if(!confirmationDue&&!dormant&&(reviewDue||!rec||targetDrift()||(model&&(drift(model,rec,universe)>=(profile.driftBps??500)||modelLimitBreaches(model,profile,market))))){
    rec=validateModel(allocateModel(profile,universe,market),profile,universe,market);rebalance=true;
   }
   let transactions=[];
   const dueDeposit=depositDue(model,profile,date);
   // W11 (R2): Einzahlung und Rebalance in einem evolveModel-Lauf, damit das
   // Kapitalgewicht exakt bleibt; Sparraten werden nicht zusätzlich verplant.
   if(!confirmationDue&&(rebalance||dueDeposit>0||!model)){const out=evolveModel(model,rec,universe,market,profile,date,{rebalance,deposit:dueDeposit});model=out.model;transactions=out.transactions;}
   else if(model){model=markModel(model,market,date);}
   model.reviewedOn=rebalance?date:(model.reviewedOn||model.startedOn);
   model.market=market;model.marketAsOf=date;
   // Benchmark: identische Modellfinanzierung, keine rückblickenden Kurse.
   try{
    // W11 (R2): Nachbuchung = Delta der Einzahlungen. Hinweis: Ein künftiger
    // Entnahme-Pfad (sinkendes model.paidCents) muss den Benchmark proportional
    // mitreduzieren — die Nachbuchung hier kann nur addieren, nie kürzen.
    const benchFunding=Math.max(0,model.paidCents-(model.benchmark?.paidCents||0));
    const benchMarket=market.filter(m=>BENCHMARKS.some(b=>b.id===m.id));
    model.benchmark=updateBenchmark(model.benchmark||null,BENCHMARKS,benchMarket,strategicWeights(profile),benchFunding,date);
   }catch(e){model.benchmarkError=safeMessage(e.message);}
   const notices=[];
   if(confirmationDue)notices.push(confirmationNotice);
   if(model&&(model.valueCents||0)>0){
    const peak=Math.max(...(model.history||[]).map(x=>x.valueCents||0),model.paidCents||0,model.valueCents);
    const reference=Math.max(peak,model.paidCents);
    const drawdownPct=(1-model.valueCents/reference)*100;
    if(drawdownPct>=profile.lossTolerance)notices.push('Verlustschwelle erreicht: Der Modellwert liegt '+drawdownPct.toFixed(1).replace('.',',')+' % unter der Vergleichsbasis ('+(reference/100).toFixed(2).replace('.',',')+' €; Referenz ist der jeweils höhere Wert aus eingezahlter Summe und bisherigem Höchststand der Modellhistorie) und erreicht damit die deklarierte Verlusttragfähigkeit von '+profile.lossTolerance+' %. Es wird nichts automatisch verkauft — bitte Anlageziel und Risikoprofil prüfen.');
   }
   if(model)await db('wealth_models?on_conflict=owner_id,strategy_key','POST',{owner_id:owner,strategy_key:key,model,updated_at:new Date().toISOString()});
   await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+key,'PATCH',{next_due:new Date(Date.now()+(profile.intervalDays||1)*86400000).toISOString(),setup_error:confirmationDue?{code:'CONFIRMATION_DUE',message:confirmationNotice,retryable:false,status:null,requestId:null,retryAfter:0}:null});
   if(rebalance){
    // Pie-Zielgewichte nur als getrennte, nachvollziehbare Aufgabe; niemals Orders.
    const bindings=await db(own('v12_pie_bindings',owner,'strategy_id=eq.'+key+'&controller=eq.advisor&enabled=eq.true&status=in.(active,writing)'));
    for(const b of bindings)await db('rpc/enqueue_v12_task','POST',{p_owner:owner,p_kind:'pie-write',p_key:String(b.pie_id),p_payload:{pieId:b.pie_id},p_priority:70,p_reset:true});
   }
   result={strategyKey:key,rebalance,transactions:transactions.length,notices,explanation:null,runId:jobId};
   if(rebalance){
    // Erläuterung nur bei Änderung; kostenlos, kurz, ohne erfundene Daten.
    try{result.explanation=await explainRebalance(env,fetcher,profile,rec,transactions);}catch{result.explanation=null;}
   }
   const reason=confirmationDue?'Geeignetheitsprüfung zur erneuten Bestätigung fällig: Bewertung ohne Anpassung.':!modelRow?'Erste Modellstrategie erstellt und Zielgewichte festgelegt.':rebalance?transactions.length?'Zielgewichte aktualisiert: '+rec.changeReason+' ('+transactions.length+' Buchungen).':rec.changeReason:dueDeposit>0?'Sparrate von '+(dueDeposit/100).toFixed(2).replace('.',',')+' € zum verfügbaren Modellkurs angelegt.':'Bewertung ohne Änderung.';
   result.snapshot=transactions.length?{valueCents:model.valueCents,paidCents:model.paidCents,asOf:date,reason}:null;
  }catch(e){diagnostic=diagnostics(e);}
  await db('advisor_jobs','POST',{id:jobId,owner_id:owner,strategy_key:key,status:diagnostic?'failed':'completed',result,diagnostic,started_at:new Date().toISOString(),finished_at:new Date().toISOString()});
  if(diagnostic){
   const setup=['MANDATE_MISSING','MANDATE_CHANGED','MANDATE_INVALID','UNIVERSE_EMPTY','ALLOCATION_IMPOSSIBLE','BROKER_SETUP','BROKER_INVALID_CREDENTIALS','BROKER_PIE_MISSING','CONFIRMATION_DUE'];
   const code=diagnostic.code;
   if(setup.includes(code))await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+key,'PATCH',{setup_error:diagnostic,next_due:new Date(Date.now()+86400000).toISOString()});
   else if(diagnostic.retryable===false)await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+key,'PATCH',{setup_error:diagnostic,next_due:new Date(Date.now()+86400000).toISOString()});
   else await db('advisor_profiles?owner_id=eq.'+owner+'&strategy_key=eq.'+key,'PATCH',{next_due:new Date(Date.now()+900000).toISOString()});
  }
  return diagnostic?{failed:true,code:diagnostic.code}:{ok:true};
 }
 async function explainRebalance(env,fetcher,profile,rec,transactions){
  if(!env.openrouterKey)return null;
  const body={model:env.model||'anthropic/claude-haiku-5.5',max_tokens:700,messages:[{role:'user',content:'Fasse diese regelbasierte Umschichtung in drei deutschen Sätzen zusammen. Keine neuen Zahlen, keine Empfehlung, keine Prognose. Daten: '+JSON.stringify({name:profile.name,positionen:rec.positions.map(p=>({id:p.id,bps:p.weightBps})),cashBps:rec.cashWeightBps,buchungen:transactions.length})}],response_format:{type:'json_schema',json_schema:{name:'rebalance_note',strict:true,schema:{type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string'}}}}}};
  let r;try{r=await fetcher('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+env.openrouterKey,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}catch{return null;}
  if(!r.ok)return null;const out=await boundedJSON(r,1024*1024);try{const text=JSON.parse(r&&out?.choices?.[0]?.message?.content||'').text;return typeof text==='string'&&text.length<1200?text:null;}catch{return null;}
 }
 async function actionDispatch(){
  const tasks=[];
  for(let i=0;i<4;i++){const task=await db('rpc/claim_advisor_task','POST',{});if(!task)break;tasks.push(task);}
  let processed=0;
  for(const task of tasks){const out=await careCycle(task);if(!out.failed)processed++;}
  return {claimed:tasks.length,processed};
 }
 return async req=>{
  const origin=req.headers.get('Origin')||'',allowed=env.allowedOrigins?.includes(origin),cors={'Access-Control-Allow-Origin':allowed?origin:'null','Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS',Vary:'Origin','Cache-Control':'no-store'};
  const json=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{...cors,'Content-Type':'application/json'}});
  if(req.method==='OPTIONS')return new Response(null,{status:allowed?204:403,headers:cors});if(req.method!=='POST')return json({error:'Nur POST'},405);
  try{
   const data=await boundedJSON(req,32000);
   if(data.action==='dispatch'){
    // W15/S3: Timing-sicherer Vergleich über SHA-256-Hashes beider Werte.
    const digest=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value))));
    const [expected,provided]=await Promise.all([digest(env.cronSecret||''),digest(req.headers.get('X-Kontur-Cron')||'')]);
    const equal=expected.length===provided.length&&expected.every((byte,index)=>byte===provided[index]);
    if(!env.cronSecret||env.cronSecret.length<32||!equal)return json({error:'Nicht autorisiert'},401);
    return json(await actionDispatch());
   }
   if(!allowed)return json({error:'ALLOWED_ORIGINS prüfen.'},403);
   const auth=req.headers.get('Authorization')||'';if(!/^Bearer \S+$/.test(auth))return json({error:'Bitte anmelden.'},401);
   const r=await fetcher(env.url+'/auth/v1/user',{headers:{apikey:env.serviceKey,Authorization:auth},signal:AbortSignal.timeout(10000)});if(!r.ok)return json({error:'Bitte erneut anmelden.'},401);
   const user=await boundedJSON(r,16000),owner=user.id;if(!/^[0-9a-f-]{36}$/i.test(owner||''))return json({error:'Ungültige Anmeldung'},401);
   if(data.action==='wealth-set-enabled')return json(await actionWealthSetEnabled(data,owner));
   if(data.action==='wealth-status'){
    const [profiles,models,jobs]=await Promise.all([db(own('advisor_profiles',owner)),db(own('wealth_models',owner)),db(own('advisor_jobs',owner,'order=started_at.desc&limit=10'))]);
    return json({profiles,models,jobs});
   }
   if(data.action==='wealth-care'){if(!/^[0-9a-f-]{36}$/i.test(data.strategyKey||''))throw new ServiceError('MANDATE_MISSING','Strategie fehlt.');await enqueueCare(owner,data.strategyKey,100);return json({queued:true});}
   if(data.action==='products-confirm'){
    const products=Array.isArray(data.products)?data.products:[];
    if(products.length>500||products.some(p=>!/^[A-Z]{2}[A-Z0-9]{10}$/.test(p.isin||'')||!/^[A-Za-z0-9_.-]{1,80}$/.test(p.brokerTicker||'')))throw new ServiceError('PRODUCT_INVALID','Produktbestätigungen prüfen.');
    for(const p of products)await db('v12_broker_products?on_conflict=owner_id,isin','POST',{owner_id:owner,isin:p.isin,broker_ticker:p.brokerTicker,confirmed_at:new Date().toISOString()});
    return json({saved:products.length});
   }
   throw new ServiceError('ACTION_UNKNOWN','Unbekannte Aktion.');
  }catch(e){const d=diagnostics(e);return json({error:d.message,diagnostic:d},e.status>=400&&e.status<500?e.status:400);}
 };
}
const allowedOrigins=(Deno.env.get('ALLOWED_ORIGINS')||'https://ggjzmbvht4-sketch.github.io').split(',').map(x=>x.trim()).filter(Boolean);
Deno.serve(createAdvisorHandler({
 url:Deno.env.get('SUPABASE_URL')||'',
 serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',
 allowedOrigins,
 cronSecret:Deno.env.get('ADVISOR_CRON_SECRET'),
 brokerKey:Deno.env.get('TRADING212_API_KEY'),
 brokerSecret:Deno.env.get('TRADING212_API_SECRET'),
 openrouterKey:Deno.env.get('OPENROUTER_API_KEY'),
 model:Deno.env.get('OPENROUTER_ADVISOR_MODEL')||Deno.env.get('OPENROUTER_MODEL')||'anthropic/claude-haiku-5.5'
}));