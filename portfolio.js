import {holdingAt,checkHoldings} from './trading.js';
// Portfolio amounts and FX-adjusted cash flows use integer EUR cents.
// Holdings and quote prices remain separate from financial planning.
export const KINDS={stock:'Aktie',etf:'ETF',fund:'Fonds / NAO',bond:'Anleihe',pie:'Trading212-Pie',private:'Beteiligung',alternative:'Alternative Anlage',cash:'Investment-Cash'};
export const EVENT_TYPES={contribution:'Einzahlung / Kaufbetrag',withdrawal:'Auszahlung / Verkaufserlös',distribution:'Dividende / Ausschüttung',fee:'Zusätzlich gezahlte Gebühr',adjustment:'Bestandsabgleich'};
export const SOURCES={manual:'Manuell erfasst',statement:'Anbieter / Abrechnung',estimate:'Geschätzter Beteiligungswert'};
export const LIQUIDITY={month:'Innerhalb 1 Monat',year:'Innerhalb 1 Jahr',long:'Mehr als 1 Jahr'};
export const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const emptyPortfolio=()=>({version:1,assets:[],instruments:[],events:[],quotes:[],compositions:[],snapshots:[]});
const uuid=()=>crypto.randomUUID();
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0&&n<=1e14;
const date=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d+'T12:00:00Z').toISOString().slice(0,10)===d;
export const decimal=(v,scale=8)=>{if(!new RegExp('^\\d+(?:\\.\\d{1,'+scale+'})?$').test(String(v)))throw Error('Bitte eine nichtnegative Zahl mit maximal '+scale+' Nachkommastellen eingeben.');return Number(v);};
export const pct=n=>new Intl.NumberFormat('de-DE',{minimumFractionDigits:1,maximumFractionDigits:2}).format(n)+' %';
export function validatePortfolio(p,entries=[]){
 if(!p||p.version!==1)throw Error('Unbekanntes Investmentformat.');
 for(const key of ['assets','instruments','events','quotes','compositions','snapshots'])if(!Array.isArray(p[key])||p[key].length>20000)throw Error('Ungültige Investmentdaten: '+key);
 const ids=new Set(),ins=new Set(),links=new Set(),sources=new Set();const entryIds=new Set(entries.filter(e=>e.type==='investment').map(e=>e.id));
 for(const i of p.instruments){if(typeof i.id!=='string'||ins.has(i.id)||typeof i.name!=='string'||!i.name.trim()||!/^([A-Z]{3})$/.test(i.currency)||typeof i.identity!=='string'||!i.identity)throw Error('Ungültiges Wertpapier.');if(p.instruments.some(x=>x.id!==i.id&&x.identity===i.identity))throw Error('Dieses Wertpapier ist bereits vorhanden. Bitte den vorhandenen Eintrag wählen.');ins.add(i.id);}
 for(const a of p.assets){if(typeof a.id!=='string'||ids.has(a.id)||!Object.hasOwn(KINDS,a.kind)||typeof a.name!=='string'||!a.name.trim()||!['units','manual','children'].includes(a.valuationMode)||a.kind==='pie'&&a.valuationMode!=='children'||a.kind!=='pie'&&a.valuationMode==='children'||!Object.hasOwn(LIQUIDITY,a.liquidity)||!Array.isArray(a.planEntryIds)||!Number.isInteger(a.targetBps)||a.targetBps<0||a.targetBps>10000)throw Error('Ungültiges Investment: '+(a.name||'?'));
  if(a.valuationMode==='units'&&(!ins.has(a.instrumentId)||!Number.isFinite(decimal(a.quantity))||Number(a.quantity)>1e12))throw Error('Wertpapier und Stückzahl prüfen.');
  if(a.valuationMode!=='units'&&a.instrumentId)throw Error('Manuelle Werte dürfen kein Kurs-Wertpapier verknüpfen.');
  for(const id of a.planEntryIds){if(!entryIds.has(id)||links.has(id))throw Error('Ein Sparplaneintrag darf nur einem Investment zugeordnet sein.');links.add(id);}ids.add(a.id);
 }
 for(const a of p.assets){if(a.parentId){const parent=p.assets.find(x=>x.id===a.parentId);if(!parent||parent.kind!=='pie'||a.kind==='pie')throw Error('Pies können nur einzelne Positionen enthalten.');if(a.instrumentId&&p.assets.some(x=>x.id!==a.id&&x.parentId===a.parentId&&x.instrumentId===a.instrumentId))throw Error('Das Wertpapier ist in diesem Pie bereits vorhanden.');}}
 const unique=new Set();for(const e of p.events){if(typeof e.id!=='string'||unique.has(e.id)||!ids.has(e.assetId)||p.assets.find(a=>a.id===e.assetId).kind==='pie'||!Object.hasOwn(EVENT_TYPES,e.type)||!nonnegative(e.amount)||!date(e.date)||e.date>today())throw Error('Ungültige Investmentbuchung.');if(e.feeAmount!==undefined&&!nonnegative(e.feeAmount))throw Error('Ungültige Gebühr.');if(e.trade){const a=p.assets.find(a=>a.id===e.assetId);if(a.valuationMode!=='units'||a.openingQuantity===undefined||!['buy','sell','adjustment'].includes(e.trade)||!Number.isSafeInteger(e.quantityDelta)||e.quantityDelta===0||!nonnegative(e.feeAmount||0)||e.trade==='buy'&&(e.type!=='contribution'||e.quantityDelta<=0)||e.trade==='sell'&&(e.type!=='withdrawal'||e.quantityDelta>=0)||e.trade==='adjustment'&&(e.type!=='adjustment'||e.amount!==0||e.feeAmount!==0))throw Error('Ungültige Handelsbuchung.');if(e.trade!=='adjustment'&&(!Number.isSafeInteger(e.priceMicros)||e.priceMicros<=0||!Number.isSafeInteger(e.fxMicros)||e.fxMicros<=0))throw Error('Ausführungskurs prüfen.');if(e.trade!=='adjustment'&&Math.round(Math.abs(e.quantityDelta)/1e8*e.priceMicros/1e6*e.fxMicros/1e6*100)!==e.amount)throw Error('Handelsbetrag und Ausführungskurs stimmen nicht überein.');}else if(e.type==='adjustment')throw Error('Ungültiger Bestandsabgleich.');if(e.sourceKey){if(sources.has(e.sourceKey))throw Error('Diese Ist-Buchung wurde schon übernommen.');sources.add(e.sourceKey);}unique.add(e.id);}
 unique.clear();for(const q of p.quotes){if(typeof q.id!=='string'||unique.has(q.id)||!date(q.asOf)||q.asOf>today()||!Object.hasOwn(SOURCES,q.source)||!(!!q.assetId!==!!q.instrumentId)||q.assetId&&!ids.has(q.assetId)||q.instrumentId&&!ins.has(q.instrumentId)||!nonnegative(q.value)||!nonnegative(q.priceMicros)||!Number.isSafeInteger(q.fxMicros)||q.fxMicros<=0||q.fxMicros>1e12)throw Error('Ungültiger Wert oder Kursstand.');const a=p.assets.find(a=>a.id===q.assetId);if(a&&a.valuationMode!=='manual')throw Error('Diese Position benötigt einen Wertpapierkurs.');unique.add(q.id);}
 for(const h of p.compositions)if(!h||typeof h.pieId!=='string'||!Array.isArray(h.positions)||typeof h.createdAt!=='string')throw Error('Ungültige Pie-Historie.');
 unique.clear();for(const h of p.snapshots){if(!h||!date(h.date)||h.date>today()||unique.has(h.date)||!nonnegative(h.value)||!nonnegative(h.contribution)||!nonnegative(h.withdrawal)||!nonnegative(h.distribution)||!nonnegative(h.fee)||!nonnegative(h.benchmarkMicros))throw Error('Ungültiger Vermögensstand.');unique.add(h.date);}
 checkHoldings(p);return p;
}
export function instrumentIdentity(i){const isin=(i.isin||'').trim().toUpperCase(),symbol=(i.symbol||'').trim().toUpperCase(),exchange=(i.exchange||'').trim().toUpperCase();if(isin&&!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin))throw Error('Bitte eine ISIN mit 12 Zeichen eingeben.');if(!isin&&!(symbol&&exchange))throw Error('ISIN oder Symbol zusammen mit Börsenplatz angeben.');return (isin?'ISIN:'+isin:'TICKER:'+exchange+':'+symbol)+':'+i.currency;}
export function latestQuote(p,asset,asOf=today()){
 return p.quotes.filter(q=>q.asOf<=asOf&&(asset.valuationMode==='units'?q.instrumentId===asset.instrumentId:q.assetId===asset.id)).sort((a,b)=>b.asOf.localeCompare(a.asOf)||String(b.createdAt).localeCompare(String(a.createdAt)))[0]||null;
}
export function assetTotals(p,id,asOf=today()){
 const asset=p.assets.find(a=>a.id===id);if(!asset)throw Error('Investment nicht gefunden.');
 if(asset.kind==='pie'){
  const children=p.assets.filter(a=>a.parentId===id),items=children.map(a=>assetTotals(p,a.id,asOf));const known=items.length>0&&items.every(x=>x.known),sum=k=>items.reduce((n,x)=>n+x[k],0);
  return {asset,children:items,known,costKnown:items.length>0&&items.every(x=>x.costKnown),value:sum('value'),contribution:sum('contribution'),withdrawal:sum('withdrawal'),distribution:sum('distribution'),fee:sum('fee'),gain:known&&items.every(x=>x.costKnown)?sum('gain'):null,netInvested:sum('netInvested'),estimated:items.some(x=>x.estimated),stale:items.some(x=>x.stale),asOf:items.map(x=>x.asOf).filter(Boolean).sort()[0]||null,quote:null};
 }
 const events=p.events.filter(e=>e.assetId===id&&e.date<=asOf),sum=type=>events.filter(e=>e.type===type).reduce((n,e)=>n+e.amount,0);const contribution=sum('contribution'),withdrawal=sum('withdrawal'),distribution=sum('distribution'),fee=sum('fee')+events.reduce((n,e)=>n+(e.feeAmount||0),0);
 const quote=latestQuote(p,asset,asOf);const quantity=asset.valuationMode==='units'?holdingAt(p,asset,asOf):null;const zero=asset.valuationMode==='units'&&quantity===0;const known=asset.valuationMode==='units'?quantity!==null&&(!!quote||zero):!!quote;
 const costKnown=(asset.openingCostKnown!==false||events.some(e=>e.type==='contribution'&&e.costBasisConfirmed===true))&&events.some(e=>e.type==='contribution'&&e.trade!=='adjustment')&&!events.some(e=>e.trade==='adjustment');const value=zero?0:!quote||!known?0:asset.valuationMode==='units'?Math.round(quantity*(quote.priceMicros/1e6)*(quote.fxMicros/1e6)*100):quote.value;
 const days=quote?(Date.parse(asOf)-Date.parse(quote.asOf))/86400000:0;
 return {asset,known,costKnown,value,contribution,withdrawal,distribution,fee,netInvested:contribution+fee-withdrawal,gain:known&&costKnown?value+withdrawal+distribution-contribution-fee:null,estimated:quote?.source==='estimate',stale:!!quote&&days>(quote.source==='estimate'?120:7),asOf:quote?.asOf||null,quote};
}
export function portfolioSummary(p,asOf=today()){
 const roots=p.assets.filter(a=>!a.parentId).map(a=>assetTotals(p,a.id,asOf)),leaves=p.assets.filter(a=>a.kind!=='pie').map(a=>assetTotals(p,a.id,asOf));const sum=k=>leaves.reduce((n,x)=>n+x[k],0);const liquid=Object.fromEntries(Object.keys(LIQUIDITY).map(k=>[k,leaves.filter(x=>x.asset.liquidity===k&&x.known).reduce((n,x)=>n+x.value,0)]));
 const providers={};for(const a of leaves){const parent=p.assets.find(x=>x.id===a.asset.parentId);const label=parent?.provider||a.asset.provider||'Ohne Anbieter';providers[label]=(providers[label]||0)+(a.known?a.value:0);}
 return {roots,leaves,value:sum('value'),contribution:sum('contribution'),withdrawal:sum('withdrawal'),distribution:sum('distribution'),fee:sum('fee'),netInvested:sum('netInvested'),gain:leaves.filter(x=>x.known&&x.costKnown).reduce((n,x)=>n+x.gain,0),known:leaves.length>0&&leaves.every(x=>x.known)&&roots.every(x=>x.known),missingCosts:leaves.filter(x=>!x.costKnown).length,unvalued:leaves.filter(x=>!x.known).length+roots.filter(x=>x.asset.kind==='pie'&&!x.children.length).length,estimatedValue:leaves.filter(x=>x.estimated).reduce((n,x)=>n+x.value,0),stale:leaves.filter(x=>x.stale).length,liquid,providers};
}
export function exposures(p){
 const summary=portfolioSummary(p),groups=new Map();for(const x of summary.leaves){if(!x.asset.instrumentId)continue;const instrument=p.instruments.find(i=>i.id===x.asset.instrumentId);const identity=instrument.isin?'ISIN:'+instrument.isin:instrument.identity;const group=groups.get(identity)||{identity,name:instrument.name,positions:[],value:0,known:true};group.positions.push(x);group.value+=x.value;group.known&&=x.known;groups.set(identity,group);}
 return [...groups.values()].filter(g=>g.positions.length>1).sort((a,b)=>b.value-a.value).map(g=>({...g,weight:summary.value?g.value/summary.value*100:0}));
}
export function allocation(p,pieId,topup){
 if(!nonnegative(topup))throw Error('Ungültiger Einzahlungsbetrag.');const root=assetTotals(p,pieId);if(root.asset.kind!=='pie'||!root.children.length)throw Error('Zuerst Positionen zum Pie hinzufügen.');if(!root.known)throw Error('Bitte alle Positionswerte ergänzen.');
 if(root.children.reduce((n,x)=>n+x.asset.targetBps,0)!==10000)throw Error('Die Zielgewichtungen müssen zusammen 100 % ergeben.');
 const desired=root.children.map(x=>({id:x.asset.id,name:x.asset.name,value:x.value,target:x.asset.targetBps,need:Math.max(0,(root.value+topup)*x.asset.targetBps/10000-x.value)}));const totalNeed=desired.reduce((n,x)=>n+x.need,0);let left=topup;
 for(const x of desired){x.add=totalNeed?Math.floor(topup*x.need/totalNeed):0;x.fraction=totalNeed?topup*x.need/totalNeed-x.add:0;left-=x.add;}
 for(const x of [...desired].sort((a,b)=>b.fraction-a.fraction||a.id.localeCompare(b.id))){if(left<=0)break;x.add++;left--;}
 return desired.map(x=>({...x,newWeight:root.value+topup?(x.value+x.add)/(root.value+topup)*100:0}));
}
export function recordComposition(p,pieId){const pie=p.assets.find(a=>a.id===pieId&&a.kind==='pie');if(!pie)return;p.compositions.push({id:uuid(),pieId,createdAt:new Date().toISOString(),name:pie.name,positions:p.assets.filter(a=>a.parentId===pieId).map(a=>({assetId:a.id,name:a.name,instrumentId:a.instrumentId||'',quantity:a.quantity||'0',targetBps:a.targetBps}))});}
export function captureSnapshot(p,benchmarkName='',benchmarkLevel=0){const s=portfolioSummary(p);if(!s.known)throw Error('Zuerst alle Investments bewerten, bevor ein vollständiger Tagesstand gespeichert wird.');const snap={date:today(),createdAt:new Date().toISOString(),value:s.value,contribution:s.contribution,withdrawal:s.withdrawal,distribution:s.distribution,fee:s.fee,benchmarkName,costKnown:s.missingCosts===0,benchmarkMicros:Math.round(benchmarkLevel*1e6)};const existing=p.snapshots.findIndex(x=>x.date===snap.date);if(existing<0)p.snapshots.push(snap);else p.snapshots[existing]=snap;return snap;}
export function periodPerformance(p){
 const snapshots=[...p.snapshots].sort((a,b)=>a.date.localeCompare(b.date));if(snapshots.length<2)return null;const first=snapshots[0],last=snapshots.at(-1),duration=Date.parse(last.date)-Date.parse(first.date);if(!duration)return null;
 if(!first.costKnown||!last.costKnown)return {invalid:true,reason:'Für diesen Vergleich fehlen erfasste Einzahlungen.'};
 for(const snap of [first,last])for(const type of ['contribution','withdrawal','distribution','fee']){const actual=p.events.filter(e=>e.date<=snap.date).reduce((n,e)=>n+(e.type===type?e.amount:0)+(type==='fee'?(e.feeAmount||0):0),0);if(actual!==snap[type])return {invalid:true,reason:'Historische Buchungen wurden nach einem Tagesstand verändert. Der Zeitraumvergleich ist angehalten.'};}
 const flows=p.events.filter(e=>e.date>first.date&&e.date<=last.date);let net=0,weighted=0;for(const e of flows){const flow=(e.type==='adjustment'?0:e.amount*(['contribution','fee'].includes(e.type)?1:-1))+(e.feeAmount||0);const weight=(Date.parse(last.date)-Date.parse(e.date))/duration;net+=flow;weighted+=flow*weight;}
 const gain=last.value-first.value-net,denominator=first.value+weighted;
 const benchmark=first.benchmarkName&&first.benchmarkName===last.benchmarkName&&first.benchmarkMicros>0&&last.benchmarkMicros>0?(last.benchmarkMicros/first.benchmarkMicros-1)*100:null;
 return {from:first.date,to:last.date,gain,returnPct:denominator>0?gain/denominator*100:null,benchmark,benchmarkName:last.benchmarkName};
}
export function newAsset(initial={}){return {id:uuid(),kind:'stock',name:'',provider:'',parentId:'',valuationMode:'units',instrumentId:'',quantity:'0',targetBps:0,liquidity:'month',planEntryIds:[],strategy:'',note:'',contractType:'',ownershipPercent:'',entryCompanyValue:0,...initial};}
export function removeAsset(p,id){if(p.assets.some(a=>a.parentId===id))throw Error('Zuerst alle enthaltenen Positionen verschieben oder löschen.');p.assets=p.assets.filter(a=>a.id!==id);p.events=p.events.filter(e=>e.assetId!==id);p.quotes=p.quotes.filter(q=>q.assetId!==id);}
export function quoteRecord(asset,{value=0,price=0,fx=1,asOf=today(),source='manual',note=''}){return {id:uuid(),assetId:asset.valuationMode==='manual'?asset.id:'',instrumentId:asset.valuationMode==='units'?asset.instrumentId:'',value:Math.round(value*100),priceMicros:Math.round(price*1e6),fxMicros:Math.round(fx*1e6),asOf,source,note,createdAt:new Date().toISOString()};}
export function addDemoInvestments(state){const p=emptyPortfolio(),pie=newAsset({kind:'pie',name:'Mein Welt-Pie',provider:'Trading212',valuationMode:'children',strategy:'Breit gestreutes Beispielportfolio · fiktive Daten'});p.assets.push(pie);
 const specs=[['Welt-ETF','etf','IE00B4L5Y983','USD',12.5,95,0.92,6500,950],['Europa-ETF','etf','IE00B4K48X80','EUR',6,80,1,3500,450]];
 for(const [name,kind,isin,currency,quantity,price,fx,target,paid]of specs){const i={id:uuid(),name,isin,symbol:'',exchange:'',currency,sector:'Breit gestreut',region:'Global'};i.identity=instrumentIdentity(i);p.instruments.push(i);const a=newAsset({kind,name,parentId:pie.id,provider:'Trading212',instrumentId:i.id,quantity:String(quantity),targetBps:target});p.assets.push(a);p.quotes.push(quoteRecord(a,{price,fx,source:'manual'}));p.events.push({id:uuid(),assetId:a.id,type:'contribution',amount:paid*100,date:today(),note:'Fiktives Beispiel'});}
 const extra=newAsset({kind:'etf',name:'Welt-ETF separat',provider:'Anderes Depot',instrumentId:p.instruments[0].id,quantity:'3'});p.assets.push(extra);p.events.push({id:uuid(),assetId:extra.id,type:'contribution',amount:25000,date:today(),note:'Fiktives Beispiel'});
 const a=newAsset({kind:'private',name:'Beispiel Startup GmbH',provider:'Companisto',valuationMode:'manual',liquidity:'long',contractType:'Direkte Beteiligung',note:'Fiktiver Modellwert · kein tatsächliches Angebot'});p.assets.push(a);p.quotes.push(quoteRecord(a,{value:1150,source:'estimate'}));p.events.push({id:uuid(),assetId:a.id,type:'contribution',amount:100000,date:today(),note:'Fiktives Beispiel'});recordComposition(p,pie.id);state.portfolio=p;return state;}
export function positionCsv(p){const s=portfolioSummary(p),esc=v=>'"'+String(v??'').replaceAll('"','""')+'"';const rows=[['Investment','Anbieter','Pie','Art','ISIN','Stückzahl','Wert EUR','Netto investiert EUR','Ergebnis EUR','Wertquelle','Bewertungsdatum']];for(const x of s.leaves){const a=x.asset,i=p.instruments.find(i=>i.id===a.instrumentId),parent=p.assets.find(v=>v.id===a.parentId);rows.push([a.name,parent?.provider||a.provider,parent?.name||'',KINDS[a.kind],i?.isin||'',a.valuationMode==='units'?a.quantity:'',x.known?(x.value/100).toFixed(2):'',(x.netInvested/100).toFixed(2),x.gain!==null?(x.gain/100).toFixed(2):'',x.quote?SOURCES[x.quote.source]:'',x.asOf||'']);}return '\uFEFF'+rows.map(r=>r.map(v=>esc(/^[=+@-]/.test(String(v))?"'"+v:v)).join(';')).join('\r\n');}

export function relinkPlan(portfolio,oldEntries,newEntries){
 const next=structuredClone(portfolio),oldLinks=next.assets.map(a=>({id:a.id,entries:oldEntries.filter(e=>a.planEntryIds.includes(e.id))}));
 for(const a of next.assets)a.planEntryIds=[];
 for(const e of newEntries.filter(e=>e.type==='investment')){
  const candidates=oldLinks.filter(a=>a.entries.some(o=>o.id===e.id||o.name===e.name&&o.start<=(e.end||'9999-12')&&e.start<=(o.end||'9999-12')));
  if(candidates.length===1)next.assets.find(a=>a.id===candidates[0].id).planEntryIds.push(e.id);
 }
 return next;
}
