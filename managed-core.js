// Shared, deterministic model rules. EUR amounts are cents; weights are basis points.
export const RULES_VERSION = 'kontur-wealth-1';
const dayMs = 86400000;
export function mandate(goal, enabled = true) {
  const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
  if (!goal || !/^[\da-f-]{36}$/i.test(goal.id) || typeof goal.name !== 'string' || !goal.name.trim() || goal.name.length > 100 || !['conservative','balanced','growth'].includes(goal.risk) || !integer(goal.years,1,50) || ![goal.start,goal.rate,goal.target].every(v=>integer(v,0,1e14)) || !integer(goal.cash,0,10000) || !integer(goal.cap,500,10000)) throw Error('Anlageziel und Risikoprofil prüfen.');
  if (!['longterm','active'].includes(goal.approach) || !['none','basic','experienced'].includes(goal.experience) || !['needed','covered'].includes(goal.emergencyFund) || !integer(goal.liquidityYears,0,50) || !integer(goal.lossTolerance,1,80)) throw Error('Erfahrung, Liquiditätsbedarf und Verlusttragfähigkeit ergänzen.');
  if (goal.emergencyFund !== 'covered') throw Error('Zuerst einen verfügbaren Notgroschen außerhalb dieser Strategie einplanen.');
  if (goal.approach === 'active' && (goal.experience !== 'experienced' || goal.years < 5 || goal.lossTolerance < 30 || goal.liquidityYears > 0 && goal.liquidityYears < 5)) throw Error('Aktive Aktienstrategien benötigen Erfahrung, mindestens fünf Jahre verfügbares Kapital und mindestens 30 % Verlusttragfähigkeit.');
  if (goal.liquidityYears > 0 && goal.liquidityYears < goal.years) throw Error('Anlagehorizont an den früheren Liquiditätsbedarf anpassen.');
  for (const key of ['sectorLimit','currencyLimit']) if (!integer(goal[key],100,10000)) throw Error('Branchen- und Listingwährungsgrenzen prüfen.');
  if (!Array.isArray(goal.exclude) || goal.exclude.length > 200 || goal.exclude.some(x=>typeof x!=='string')) throw Error('Ausschlüsse prüfen.');
  return {mandateVersion:2,rulesVersion:RULES_VERSION,strategyId:goal.id,name:goal.name.trim(),approach:goal.approach,risk:goal.risk,years:goal.years,start:goal.start,rate:goal.rate,target:goal.target,cash:goal.cash,cap:goal.cap,sectorLimit:goal.sectorLimit,currencyLimit:goal.currencyLimit,lossTolerance:goal.lossTolerance,liquidityYears:goal.liquidityYears,experience:goal.experience,emergencyFund:goal.emergencyFund,exclude:[...new Set(goal.exclude)].sort(),enabled:enabled===true,consent:true,intervalDays:1,reviewDays:goal.approach==='active'?7:30,driftBps:500};
}
export function mandateIdentity(profile) { const {enabled,...identity}=profile; return JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a],[b])=>a.localeCompare(b)))); }
export function strategicWeights(p) {
  if(p.approach==='active'){const stock=Math.min({conservative:3000,balanced:6000,growth:8500}[p.risk],p.lossTolerance*150,10000-p.cash);return {stock,cash:10000-stock};}
  const equity=Math.min({conservative:3000,balanced:6000,growth:8500}[p.risk],p.years<3?0:p.years<5?3000:10000,p.lossTolerance*150,10000-p.cash);
  const cash=Math.max(p.cash,p.years<3?8000:0);
  const stock=Math.min(equity,10000-cash),em=Math.round(stock*.15);
  return {world:stock-em,em,bond:10000-cash-stock,cash};
}
export function activeScore(facts, indicators) {
  const f=facts||{},keys=['roe','pe','debtToEquity','revenueGrowth'];
  if(keys.some(k=>!Number.isFinite(f[k])) || !(f.pe>0) || f.debtToEquity<0 || !Number.isFinite(indicators?.momentum20Pct)) return null;
  const clamp=x=>Math.max(0,Math.min(100,x));
  const components={quality:clamp(f.roe*250),valuation:clamp(100-f.pe*2),debt:clamp(100-f.debtToEquity*50),growth:clamp(50+f.revenueGrowth*200),momentum:clamp(50+indicators.momentum20Pct*2)};
  return {version:RULES_VERSION,value:Object.values(components).reduce((n,x)=>n+x,0)/5,components};
}
export function allocateModel(profile, candidates, market) {
  const target=strategicWeights(profile),positions=[],sectors=new Map(),currencies=new Map();
  for(const [group,budget] of Object.entries(target)) {
    if(group==='cash'||!budget) continue;
    let left=budget;
    const eligible=candidates.filter(u=>u.group===group && u.brokerConfirmed && !profile.exclude.includes(u.isin) && market.some(m=>m.id===u.id&&!m.error&&!m.indicators?.stale) && (profile.approach!=='active'||activeScore(market.find(m=>m.id===u.id)?.facts,market.find(m=>m.id===u.id)?.indicators)))
      .sort((a,b)=>profile.approach==='active'?(activeScore(market.find(m=>m.id===b.id).facts,market.find(m=>m.id===b.id).indicators).value-activeScore(market.find(m=>m.id===a.id).facts,market.find(m=>m.id===a.id).indicators).value||a.id.localeCompare(b.id)):(a.fee-b.fee||a.id.localeCompare(b.id)));
    for(const u of eligible) {
      const m=market.find(m=>m.id===u.id),sector=m.sector||'unknown';
      const weightBps=Math.max(0,Math.min(left,profile.cap,profile.sectorLimit-(sectors.get(sector)||0),profile.currencyLimit-(currencies.get(u.currency)||0)));
      if(!weightBps) continue;
      const score=profile.approach==='active'?activeScore(m.facts,m.indicators):null;
      const alternative=eligible.find(x=>x.id!==u.id);
      const reason=score?'Bewertung '+score.value.toFixed(1)+'/100 (je 20 %): '+Object.entries(score.components).map(([k,v])=>({quality:'Qualität',valuation:'Bewertung',debt:'Verschuldung',growth:'Wachstum',momentum:'Momentum'})[k]+' '+v.toFixed(0)).join(', ')+'. Berichtsstand '+m.facts.asOf+'.':
        'Strategischer '+({world:'Industrieländer',em:'Schwellenländer',bond:'Anleihen'})[group]+'-Baustein; Produktkosten laut gepflegtem Katalog '+(u.fee/100).toFixed(2)+' % p. a.'+(alternative?' Vergleich: '+alternative.name+' ('+(alternative.fee/100).toFixed(2)+' %).':' Kein weiterer bestätigter Baustein dieser Klasse mit ausreichenden Daten.');
      positions.push({id:u.id,weightBps,reason});
      sectors.set(sector,(sectors.get(sector)||0)+weightBps);currencies.set(u.currency,(currencies.get(u.currency)||0)+weightBps);left-=weightBps;
      if(!left) break;
    }
    if(left) throw Error('Keine belastbare Zusammensetzung: Für '+group+' fehlen bestätigte Produkte, Daten oder Spielraum innerhalb deiner Grenzen. Bestehendes Modell bleibt erhalten.');
  }
  return {summary:profile.name,positions,cashWeightBps:target.cash,action:'hold',changeReason:'Regelbasierte Zielaufteilung '+RULES_VERSION,portfolioAssessment:'Modellstrategie; tatsächliche Bestände werden separat gepflegt.',optimizations:[],risks:['Modellwerte sind keine echten Depotbestände.','Verlusttragfähigkeit ist keine Verlustgarantie.','ETF-Durchschau und wirtschaftliches Währungsrisiko sind ohne bestätigte Daten unbekannt.'],sources:[...new Set(candidates.filter(u=>positions.some(x=>x.id===u.id)).map(u=>u.source).filter(Boolean))]};
}
export function validateModel(rec,p,universe,market) {
  if(!rec || !Number.isInteger(rec.cashWeightBps)||rec.cashWeightBps<p.cash||rec.cashWeightBps>10000||!Array.isArray(rec.positions)) throw Error('Ungültige Modellgewichte.');
  const seen=new Set(),sectors=new Map(),currencies=new Map();let total=rec.cashWeightBps;
  for(const pos of rec.positions){
    const u=universe.find(u=>u.id===pos.id),m=market.find(m=>m.id===pos.id);
    if(!u?.brokerConfirmed||seen.has(pos.id)||p.exclude.includes(u.isin)||!Number.isInteger(pos.weightBps)||pos.weightBps<=0||pos.weightBps>p.cap||!m||m.error||m.indicators?.stale)throw Error('Instrument, Kursstand oder Positionsgrenze ungültig.');
    if(p.approach==='longterm'&&(u.kind!=='etf'||!u.ucits||!['world','em','bond'].includes(u.group)))throw Error('Nur klassifizierte UCITS-ETFs sind im langfristigen Modell zulässig.');
    if(p.approach==='active'&&(u.kind!=='stock'||!activeScore(m.facts,m.indicators)))throw Error('Aktienbewertung unvollständig.');
    const sector=m.sector||'unknown';sectors.set(sector,(sectors.get(sector)||0)+pos.weightBps);currencies.set(u.currency,(currencies.get(u.currency)||0)+pos.weightBps);seen.add(pos.id);total+=pos.weightBps;
  }
  if(total!==10000||[...sectors.values()].some(x=>x>p.sectorLimit)||[...currencies.values()].some(x=>x>p.currencyLimit))throw Error('Gesamtgewicht, Branche oder Listingwährungsgrenze verletzt.');
  const bounds=strategicWeights(p);
  for(const group of Object.keys(bounds).filter(x=>x!=='cash')) if(rec.positions.reduce((n,x)=>n+(universe.find(u=>u.id===x.id).group===group?x.weightBps:0),0)>bounds[group])throw Error('Strategische Anlageklassengrenze verletzt.');
  return rec;
}
export function marketPrice(m) {const v=m?.indicators?.last*m?.fx;if(!(v>0)||!Number.isFinite(v))throw Error('Kurs oder EUR-Umrechnung fehlt.');return v;}
export function repricePosition(position,market){
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
export function markModel(previous,market,asOf) {
  if(!previous)return null;
  const next=structuredClone(previous);let value=next.cashCents;
  for(const pos of next.positions){const m=market.find(m=>m.id===pos.id);if(!m||m.error||m.indicators?.stale)throw Error('Modellbewertung unvollständig; letzter gültiger Stand bleibt erhalten.');Object.assign(pos,repricePosition(pos,m));value+=pos.valueCents;}
  next.valueCents=value;next.asOf=asOf;
  next.history=[...(next.history||[]).filter(x=>x.date!==asOf),{date:asOf,valueCents:value,paidCents:next.paidCents}].slice(-3660);
  return next;
}
export function drift(model,rec,universe) {
  if(!model?.valueCents)return Infinity;
  const actual=new Map(),target=new Map();
  for(const pos of model.positions){const g=universe.find(u=>u.id===pos.id)?.group||'unknown';actual.set(g,(actual.get(g)||0)+pos.valueCents/model.valueCents*10000);}
  actual.set('cash',model.cashCents/model.valueCents*10000);target.set('cash',rec.cashWeightBps);
  for(const pos of rec.positions){const g=universe.find(u=>u.id===pos.id)?.group||'unknown';target.set(g,(target.get(g)||0)+pos.weightBps);}
  return Math.max(...new Set([...actual.keys(),...target.keys()].map(g=>Math.abs((actual.get(g)||0)-(target.get(g)||0)))));
}
export function depositDue(previous,profile,date) {
  if(!previous)return 0;
  const last=previous.depositThrough||previous.startedOn;
  const months=d=>Number(d.slice(0,4))*12+Number(d.slice(5,7));
  return Math.max(0,months(date)-months(last))*profile.rate;
}
export function evolveModel(previous,rec,universe,market,profile,date,{rebalance=false,deposit=0}={}) {
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
export function actualFresh(portfolio,date) {const gap=(Date.parse(date)-Date.parse(portfolio?.lastReconciledAt))/dayMs;return Number.isFinite(gap)&&gap>=-1&&gap<=7;}
// Buy-and-hold reference, funded on the exact same model dates; no retrospective prices.
export function updateBenchmark(previous,instruments,market,weights,start,deposit,date){
 const b=previous?structuredClone(previous):{startedOn:date,paidCents:0,cashCents:0,positions:[],history:[]};
 for(const pos of b.positions){const m=market.find(x=>x.id===pos.id);if(!m||m.error||m.indicators?.stale)throw Error('Benchmark-Kurs fehlt.');Object.assign(pos,repricePosition(pos,m));}
 const funding=(previous?0:start)+deposit;b.paidCents+=funding;b.cashCents+=funding;
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
export function modelLimitBreaches(model,profile,market){
 const sectors=new Map(),currencies=new Map();
 for(const pos of model.positions){const u=model.universe?.find(x=>x.id===pos.id),m=market.find(x=>x.id===pos.id);if(!u||!m)return true;const sector=m.sector||'unknown';sectors.set(sector,(sectors.get(sector)||0)+pos.valueCents);currencies.set(u.currency,(currencies.get(u.currency)||0)+pos.valueCents);if(pos.valueCents>model.valueCents*profile.cap/10000+1)return true;}
 return model.cashCents+1<model.valueCents*profile.cash/10000||[...sectors.values()].some(v=>v>model.valueCents*profile.sectorLimit/10000+1)||[...currencies.values()].some(v=>v>model.valueCents*profile.currencyLimit/10000+1);
}
