// Trades are investment records, never broker orders. Money is integer EUR cents.
import {today,quoteRecord,validatePortfolio,recordComposition,instrumentIdentity,newAsset} from './portfolio.js';
const scale=100000000;
export function units(value){const s=String(value).trim().replace(',','.');if(!/^\d+(?:\.\d{1,8})?$/.test(s))throw Error('Stückzahl mit höchstens 8 Nachkommastellen eingeben.');const n=Math.round(Number(s)*scale);if(!Number.isSafeInteger(n)||n<0)throw Error('Stückzahl ist zu groß.');return n;}
export const quantityString=n=>(n/scale).toFixed(8).replace(/\.?0+$/,'')||'0';
export function holdingAt(p,a,asOf=today()){
 if(a.openingQuantity===undefined)return Number(a.quantity||0);
 if(asOf<a.openingDate)return null;
 const delta=p.events.filter(e=>e.assetId===a.id&&e.trade&&e.date<=asOf).reduce((n,e)=>n+e.quantityDelta,0);
 return (units(a.openingQuantity)+delta)/scale;
}
export function checkHoldings(p){
 for(const a of p.assets.filter(a=>a.openingQuantity!==undefined)){
  let balance=units(a.openingQuantity);if(a.valuationMode!=='units'||!/^\d{4}-\d{2}-\d{2}$/.test(a.openingDate)||Number.isNaN(Date.parse(a.openingDate))||new Date(a.openingDate+'T12:00:00Z').toISOString().slice(0,10)!==a.openingDate||a.openingDate>today())throw Error('Ungültiges Datum des Anfangsbestands.');
  const trades=p.events.filter(e=>e.assetId===a.id&&e.trade).sort((x,y)=>x.date.localeCompare(y.date)||String(x.createdAt).localeCompare(String(y.createdAt))||x.id.localeCompare(y.id));
  for(const e of trades){if(e.date<a.openingDate)throw Error('Buchungsdatum liegt vor dem übernommenen Anfangsbestand ('+a.openingDate+').');balance+=e.quantityDelta;if(!Number.isSafeInteger(balance)||balance<0)throw Error('Verkauf übersteigt den verfügbaren Bestand bei '+a.name+' am '+e.date+'.');}
  if(units(a.quantity)!==balance)throw Error('Stückzahl und Buchungen stimmen nicht überein. Bitte den Bestand abgleichen.');
 }
}
function initialize(p,a){if(a.openingQuantity!==undefined)return;a.openingQuantity=String(a.quantity||0);a.openingCostKnown=units(a.openingQuantity)===0||p.events.some(e=>e.assetId===a.id&&e.type==='contribution');a.openingDate=units(a.openingQuantity)>0?today():'1900-01-01';}
function refresh(p,a){a.quantity=quantityString(units(a.openingQuantity)+p.events.filter(e=>e.assetId===a.id&&e.trade).reduce((n,e)=>n+e.quantityDelta,0));}
export function executionAmount(quantity,price,fx=1){const q=units(quantity)/scale,n=Number(String(price).replace(',','.')),f=Number(String(fx).replace(',','.'));if(!Number.isFinite(n)||n<=0||!Number.isFinite(f)||f<=0)throw Error('Ausführungskurs und EUR-Umrechnung müssen größer als 0 sein.');const cents=Math.round(q*n*f*100);if(!Number.isSafeInteger(cents)||cents<=0||cents>1e14)throw Error('Kauf-/Verkaufsbetrag muss mindestens 0,01 € betragen.');return cents;}
// Work on a clone: even a rejected batch never changes the caller's portfolio.
export function saveTrades(portfolio,inputs,entries=[]){
 if(!inputs.length)throw Error('Mindestens einen Kauf oder Verkauf eingeben.');const p=structuredClone(portfolio),parents=new Set();
 for(const input of inputs){
  const a=p.assets.find(a=>a.id===input.assetId);if(!a||a.valuationMode!=='units')throw Error('Bitte eine Wertpapierposition auswählen.');initialize(p,a);
  const old=input.id?p.events.find(e=>e.id===input.id):null;if(old&&(!old.trade||old.assetId!==a.id))throw Error('Diese Buchung ist kein bearbeitbarer Wertpapierhandel.');
  if(!['buy','sell'].includes(input.side))throw Error('Kauf oder Verkauf auswählen.');const qty=units(input.quantity);if(qty<=0)throw Error('Stückzahl muss größer als 0 sein.');
  const instrument=p.instruments.find(i=>i.id===a.instrumentId),fx=instrument.currency==='EUR'?1:Math.round(Number(input.fx)*1e6)/1e6,price=Math.round(Number(input.price)*1e6)/1e6,amount=executionAmount(input.quantity,price,fx),feeAmount=Number(input.feeAmount||0);
  if(!Number.isSafeInteger(feeAmount)||feeAmount<0||feeAmount>1e14)throw Error('Gebühr prüfen.');
  const e={id:old?.id||crypto.randomUUID(),assetId:a.id,type:input.side==='buy'?'contribution':'withdrawal',trade:input.side,quantityDelta:qty*(input.side==='buy'?1:-1),priceMicros:Math.round(price*1e6),fxMicros:Math.round(fx*1e6),feeAmount,amount,date:input.date,note:String(input.note||''),createdAt:old?.createdAt||new Date().toISOString()};
  if(input.sourceKey||old?.sourceKey){if(input.side!=='buy')throw Error('Eine zugeordnete Sparrate muss ein Kauf bleiben.');e.sourceKey=input.sourceKey||old.sourceKey;}
  if(old)p.events=p.events.filter(x=>x.id!==old.id);p.events.push(e);p.quotes=p.quotes.filter(q=>q.tradeId!==e.id);
  if(input.recordQuote){const q=quoteRecord(a,{price,fx,asOf:e.date,source:'statement',note:'Ausführungskurs · '+(input.side==='buy'?'Kauf':'Verkauf')});q.tradeId=e.id;p.quotes.push(q);}refresh(p,a);parents.add(a.parentId);
 }
 checkHoldings(p);validatePortfolio(p,entries);for(const id of parents)if(id)recordComposition(p,id);return p;
}
export function deleteTrade(portfolio,id,entries=[]){const p=structuredClone(portfolio),e=p.events.find(e=>e.id===id);if(!e?.trade)throw Error('Handelsbuchung nicht gefunden.');const a=p.assets.find(a=>a.id===e.assetId);p.events=p.events.filter(x=>x.id!==id);p.quotes=p.quotes.filter(q=>q.tradeId!==id);refresh(p,a);checkHoldings(p);validatePortfolio(p,entries);if(a.parentId)recordComposition(p,a.parentId);return p;}
export function reconcileHoldings(portfolio,rows,date=today(),entries=[]){
 const p=structuredClone(portfolio),parents=new Set();for(const row of rows){const a=p.assets.find(a=>a.id===row.assetId);if(!a||a.valuationMode!=='units')throw Error('Wertpapierposition fehlt.');initialize(p,a);const old=holdingAt(p,a,date);if(old===null)throw Error('Abgleich liegt vor dem Anfangsbestand.');const change=units(row.quantity)-Math.round(old*scale);if(!change)continue;
  p.events.push({id:crypto.randomUUID(),assetId:a.id,type:'adjustment',trade:'adjustment',quantityDelta:change,amount:0,feeAmount:0,date,note:'Bestandsabgleich · keine Kauf- oder Verkaufskosten bekannt',createdAt:new Date().toISOString()});refresh(p,a);parents.add(a.parentId);
 }checkHoldings(p);validatePortfolio(p,entries);for(const id of parents)if(id)recordComposition(p,id);return p;
}
export function setTargets(portfolio,pieId,rows,entries=[]){const p=structuredClone(portfolio),children=p.assets.filter(a=>a.parentId===pieId);if(!p.assets.some(a=>a.id===pieId&&a.kind==='pie')||children.length!==rows.length||new Set(rows.map(r=>r.assetId)).size!==children.length)throw Error('Alle Pie-Positionen genau einmal angeben.');let total=0;for(const a of children){const r=rows.find(r=>r.assetId===a.id),n=Number(r?.target);if(!Number.isFinite(n)||n<0||n>100)throw Error('Zielgewicht zwischen 0 und 100 % eingeben.');a.targetBps=Math.round(n*100);total+=a.targetBps;}if(total!==10000)throw Error('Die Zielgewichte müssen zusammen 100 % ergeben. Aktuell: '+total/100+' %.');validatePortfolio(p,entries);recordComposition(p,pieId);return p;}
export function createSecurityPosition(portfolio,{name,isin='',symbol='',exchange='',currency='EUR',kind='stock',provider='',parentId='',quantity='0',paid=null,price=null,fx=1,date=today(),mode='buy',feeAmount=0},entries=[]){
 let p=structuredClone(portfolio);const instrument={id:crypto.randomUUID(),name:String(name).trim(),isin:String(isin).trim().toUpperCase(),symbol:String(symbol).trim().toUpperCase(),exchange:String(exchange).trim().toUpperCase(),currency,sector:'',region:''};instrument.identity=instrumentIdentity(instrument);const existing=p.instruments.find(i=>i.identity===instrument.identity);if(!existing)p.instruments.push(instrument);const i=existing||instrument;
 if(p.assets.some(a=>a.instrumentId===i.id&&(a.parentId||'')===parentId&&(parentId||a.provider===provider)))throw Error('Diese Position ist bereits vorhanden. Dort einen Kauf hinzufügen.');
 const a=newAsset({name:instrument.name,kind,instrumentId:i.id,provider,parentId,quantity:mode==='opening'?quantity:'0',openingQuantity:mode==='opening'?quantity:'0',openingDate:mode==='opening'?date:'1900-01-01',openingCostKnown:mode!=='opening'||units(quantity)===0||paid!==null});p.assets.push(a);
 if(mode==='buy')p=saveTrades(p,[{assetId:a.id,side:'buy',quantity,price,fx,date,feeAmount,recordQuote:true}],entries);
 else {units(quantity);if(paid!==null)p.events.push({id:crypto.randomUUID(),assetId:a.id,type:'contribution',amount:paid,date,note:'Übernommene Einzahlungen · Anfangsbestand'});if(price!==null)p.quotes.push(quoteRecord(a,{price:Number(price),fx:currency==='EUR'?1:Number(fx),asOf:date}));validatePortfolio(p,entries);if(parentId)recordComposition(p,parentId);}
 return {portfolio:p,assetId:a.id};
}
