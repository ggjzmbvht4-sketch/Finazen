import {money,project,monthAdd,monthIndex,cents} from './engine.js';
import {assetTotals,portfolioSummary,today} from './portfolio.js';
import {historicalPortfolio} from './history.js';
import {brokerRows,importBroker} from './broker-import.js';
import {isDate} from './report-core.js';
export function workbench(ctx){
 const {state,month,esc,modal,close,commit,toast,cloud}=ctx;
 let pending=[],importBase='';
 const btn=(id,name)=>`<button class="btn" data-work="${id}">${name}</button>`;
 const opts=rows=>rows.map(([id,n])=>`<option value="${esc(id)}">${esc(n)}</option>`).join('');
 const pick=(name,title,rows)=>`<label>${title}<select required name="${name}">${opts(rows)}</select></label>`;
 const input=(name,title,type='number',attrs='min="0" step="0.01"')=>`<label>${title}<input required name="${name}" type="${type}" ${attrs}></label>`;
 const line=(n,v)=>`<div class="reserve-detail"><span>${esc(n)}</span><strong>${esc(v)}</strong></div>`;
 const form=(id,title,body,submit)=>modal(title,`<form id="work-${id}">${body}<button class="btn primary">${submit}</button></form>`,true);
 const holdings=()=>state().portfolio.assets.filter(a=>a.valuationMode==='units').map(a=>[a.id,a.name+' · '+(state().portfolio.assets.find(x=>x.id===a.parentId)?.name||a.provider)]);
 function toolsFor(view){
  const links={reserves:[['accounts','Konten abgleichen'],['goals','Sparziele vergleichen']],investments:[['broker','Trading212-Import'],['div','Dividendenkalender'],['swap','Positionstausch prüfen'],['band','Bewertungsband']],wealth:[['market','Markt durchsuchen']],home:[['week','Wochenbericht']]}[view]||[];
  return links.length?`<section class="work-links">${links.map(([k,v])=>btn(k,v)).join('')}</section>`:'';
 }
 function goalEstimate(s,id,balance,delta){
  const reserve=s.reserves.find(x=>x.id===id);if(!reserve?.target)return 'Kein Zielbetrag';
  if(balance>=reserve.target)return 'Ziel bereits erreicht';
  const draft=structuredClone(s),m=month();let remaining=Math.abs(delta);
  if(delta<0){for(const e of draft.entries.filter(e=>e.type==='reserve'&&e.reserveId===id&&e.interval===1&&!e.pending&&e.start<=m&&(!e.end||e.end>=m))){const change=Math.min(e.amount,remaining);e.amount-=change;remaining-=change;}if(remaining)throw Error('Die Verschiebung übersteigt die laufende Rate.');}
  if(delta>0)draft.entries.push({id:crypto.randomUUID(),name:'Vergleich',type:'reserve',amount:delta,reserveId:id,start:monthAdd(m,1),end:'',interval:1,day:1});
  // Anchor the comparison at the selected month-end to preserve earlier transfers.
  draft.anchor=monthAdd(m,1);draft.reserves=draft.reserves.map(r=>({...r,opening:r.id===id?balance:0}));
  return project(draft,monthAdd(m,120)).find(r=>r.balances[id]>=reserve.target)?.month||'In 10 Jahren nicht erreicht';
 }
 function totals(){
  const s=state(),p=portfolioSummary(s.portfolio),actual=project(s,month(),'actual').at(-1);
  const bands=s.portfolio.assets.filter(a=>a.kind==='private'&&a.band);
  const known=bands;
  const central=p.value+(actual?.cash??s.openingCash);
  const range=key=>central+known.reduce((n,a)=>n+a.band[key]-assetTotals(s.portfolio,a.id).value,0);
  return {p,central:range('base'),range,bands:known};
 }
 function dashboard(){
  const {p,central,range,bands}=totals(),s=state(),f=project(s,month()).at(-1);
  const history=s.portfolio.snapshots.slice(-12);
  return `<section class="ledger-hero"><p>Vermögen · gebuchtes Geld im gewählten Monat + Depot heute</p><h1>${money(central)}</h1><small>${p.unvalued?p.unvalued+' Positionen ohne Bewertung':'Erfasste Bestände'}${bands.length?' · mit Modellband '+money(range('low'))+' bis '+money(range('high')):''}</small><div>${line('Frei am Monatsende · Prognose',money(f?.free||0))}${line('Für Rücklagen reserviert',money(f?.earmarked||0))}</div></section>`+(history.length>1?`<details><summary>Gespeicherte Depotwerte</summary>${history.map(x=>line(x.date,money(x.value))).join('')}</details>`:'');
 }
 async function open(id){
  const s=state(),r=project(s,month(),'actual').at(-1),targets=s.reserves.map(r=>[r.id,r.name]);
  if(id==='quick'){modal('Hinzufügen',btn('expense','Ausgabe')+btn('income','Einnahme')+'<button class="btn" data-pf="trade-choose">Investmentkauf</button>'+btn('reserve','Rücklagenbewegung'));return;}
  if(id==='expense'&&state().entries.some(e=>e.type==='budget')){modal('Ausgabe erfassen','<button class="btn primary" data-work="budget-buy">Aus einem Budget buchen</button><button class="btn" data-work="expense-rule">Andere Ausgabe planen</button>');return;}
  if(id==='budget-buy'){ctx.purchase();return;}if(id==='expense-rule'){ctx.entryForm(null,{type:'expense'});return;}
  if(['expense','income','reserve'].includes(id)){ctx.entryForm(null,{type:id});return;}
  if(id==='market')form('market','Aktien und ETFs suchen',input('q','Name, Ticker oder ISIN','search','minlength="2" maxlength="100"'),'Suchen');
  if(id==='assign-import'){
   const selects=document.querySelectorAll('select[data-suggest]');let count=0;
   for(const sel of selects){if(sel.dataset.suggest&&!sel.value){sel.value=sel.dataset.suggest;count++;}}
   toast(count+' eindeutige Zuordnungen vorgemerkt.');return;
  }
  if(id==='broker')form('broker','Trading212-Verlauf importieren','<p>Englischen CSV-Verlauf mit EUR-Gesamtbeträgen auswählen. Die Vorschau zeigt Käufe, Verkäufe, Dividenden und Gebühren.</p>'+input('file','CSV-Datei','file','accept=".csv,text/csv"'),'Vorschau');
  if(id==='accounts'){
   const names=[...new Set(s.reserves.map(r=>r.account?.trim()).filter(Boolean))];
   if(!names.length)throw Error('Zuerst bei einer Rücklage das tatsächliche Konto eintragen.');
   form('accounts','Rücklagen mit Kontostand abgleichen',names.map(name=>{
    const pots=s.reserves.filter(r=>r.account?.trim()===name),sum=pots.reduce((n,p)=>n+(r.balances[p.id]||0),0),last=s.accountChecks?.find(x=>x.name===name&&x.month===month());
    return '<h3>'+esc(name)+'</h3>'+pots.map(p=>line(p.name,money(r.balances[p.id]||0))).join('')+line('Reserviert',money(sum))+(last?line('Überdeckung (+) / Fehlbetrag (−)',money(last.amount-sum)):'');
   }).join('')+pick('account','Konto',names.map(n=>[n,n]))+input('amount','Tatsächlicher Saldo zum Monatsende (€)','number','step="0.01"'),'Saldo speichern');
  }
  if(id==='goals'){if(targets.length<2)throw Error('Für einen Vergleich zwei Rücklagen mit Zielbetrag anlegen.');form('goals','Sparraten vergleichen',pick('from','Monatliche Rate verringern bei',targets)+pick('to','Monatliche Rate erhöhen bei',targets)+input('amount','Monatlich verschieben (€)'),'Zieltermine vergleichen');}
  if(id==='div'){
   const dates=(s.dividends||[]).filter(x=>x.date.startsWith(month())).sort((a,b)=>a.date.localeCompare(b.date));
   const booked=s.portfolio.events.filter(x=>x.type==='distribution'&&x.date.startsWith(month()));
   const name=id=>s.portfolio.assets.find(x=>x.id===id)?.name||'Archivierte Position';
   modal('Dividenden · '+month(),line('Erwartet',money(dates.reduce((n,x)=>n+x.amount,0)))+line('Gebucht',money(booked.reduce((n,x)=>n+x.amount,0)))+line('Differenz zum Plan',money(booked.reduce((n,x)=>n+x.amount,0)-dates.reduce((n,x)=>n+x.amount,0)))+dates.map(x=>line(x.date+' · '+name(x.assetId),'Erwartet '+money(x.amount))).join('')+booked.map(x=>line(x.date+' · '+name(x.assetId),'Eingang '+money(x.amount))).join('')+btn('div-add','Erwartung eintragen')+btn('div-paid','Eingang buchen'));return;
  }
  if(id==='div-add'||id==='div-paid'){if(!holdings().length)throw Error('Zuerst eine Wertpapierposition anlegen.');form(id,'Dividende '+(id==='div-add'?'planen':'buchen'),pick('asset','Wertpapier',holdings())+input('date','Zahlungstag','date','value="'+today()+'"')+input('amount','Betrag in EUR'),'Speichern');}
  if(id==='swap'){if(holdings().length<2)throw Error('Für den Vergleich zwei Wertpapierpositionen anlegen. Eine Zielposition darf null Stück enthalten.');form('swap','Positionstausch simulieren',pick('from','Verkauf aus',holdings())+pick('to','Kauf von',holdings())+input('amount','Umschichten (€)')+input('feeA','Laufende Kosten bisher (% p. a.)','number','min="0" max="100" step="0.001"')+input('feeB','Laufende Kosten neu (% p. a.)','number','min="0" max="100" step="0.001"'),'Auswirkung berechnen');}
  if(id==='band'){const assets=s.portfolio.assets.filter(a=>a.kind==='private');if(!assets.length)throw Error('Zuerst eine private Beteiligung anlegen.');form('band','Bewertungsband der Beteiligung',assets.filter(a=>a.band).map(a=>line(a.name+' · '+a.band.date,[a.band.low,a.band.base,a.band.high].map(money).join(' / '))).join('')+pick('asset','Beteiligung',assets.map(a=>[a.id,a.name]))+input('low','Vorsichtig (€)')+input('base','Mittlerer Schätzwert (€)')+input('high','Optimistisch (€)')+input('date','Bewertungsstichtag','date','value="'+today()+'"')+input('source','Grundlage / Bericht','text','maxlength="180"'),'Modellband speichern');}
  if(id==='week'){
   const end=today(),start=new Date(Date.parse(end)-6*86400000).toISOString().slice(0,10),hist=historicalPortfolio(s.portfolio,8),events=s.portfolio.events.filter(e=>e.date>=start&&e.date<=end);
   const items=Object.entries(s.actuals).flatMap(([k,a])=>a.items?a.items.filter(i=>!i.pending).map(i=>({...i,type:'budget'})):[{...a,type:s.entries.find(e=>k.startsWith(e.id+':'))?.type}]).filter(i=>i.date?.slice(0,10)>=start&&i.date?.slice(0,10)<=end);
   const sumType=type=>items.filter(x=>x.type===type).reduce((n,x)=>n+x.amount,0);
   modal('Deine Woche · '+start+' bis '+end,line('Gebuchter Geldfluss',money(sumType('income')-sumType('expense')-sumType('budget')-sumType('investment')))+line('Depotwertänderung inkl. Einzahlungen',hist[0].known&&hist.at(-1).known?money(hist.at(-1).value-hist[0].value):'Historische Bewertung unvollständig')+['income','expense','budget','reserve','investment'].map((type,i)=>line(['Gebuchte Einnahmen','Fixkosten','Budgetausgaben','Rücklagenraten','Investitionsraten'][i],money(items.filter(x=>x.type===type).reduce((n,x)=>n+x.amount,0)))).join('')+events.map(e=>line(e.date+' · '+(s.portfolio.assets.find(a=>a.id===e.assetId)?.name||'Position'),money(e.amount))).join('')+s.portfolio.quotes.filter(q=>q.source==='estimate'&&q.asOf>=start&&q.asOf<=end).map(q=>line('Beteiligungsbewertung · '+q.asOf,money(q.value))).join('')+'<button class="btn" data-work="to-plan">Planung öffnen</button><button class="btn" data-work="to-pf">Portfolio öffnen</button>',true);
  }
  if(id==='to-plan'||id==='to-pf'){close();ctx.go(id==='to-plan'?'reserves':'investments');}
 }
 async function submit(f){
  const id=f.id.slice(5),d=new FormData(f),get=k=>String(d.get(k)||''),s=structuredClone(state()),amount=cents(get('amount')),m=month();
  if(id==='market'){const res=await cloud.request('/functions/v1/investment-advisor',{method:'POST',auth:true,body:{action:'search-market',query:get('q')}});modal('Marktsuche',line('Titel im Verzeichnis',res.count)+res.items.map(x=>line(x.name,[x.symbol,x.exchange,x.currency,x.isin].filter(Boolean).join(' · '))).join('')+(res.items.length?'':'<p>Kein Treffer.</p>')+btn('market','Andere Suche'));return;}
  if(id==='broker'){const file=d.get('file');if(file.size>3000000)throw Error('CSV auf maximal 3 MB aufteilen.');pending=brokerRows(await file.text());if(pending.length>1500)throw Error('CSV auf höchstens 1500 Zeilen aufteilen.');importBase=JSON.stringify(s);
   const pies=s.portfolio.assets.filter(x=>x.kind==='pie').map(x=>[x.id,x.name]),seen=new Set(s.portfolio.events.map(e=>e.brokerKey));
   form('apply-import','Import prüfen',btn('assign-import','Eindeutige Bestandspositionen zuordnen')+pending.map(r=>{const candidates=s.portfolio.assets.filter(a=>s.portfolio.instruments.some(i=>i.id===a.instrumentId&&i.isin===r.isin&&(r.side==='dividend'||r.currency===i.currency))&&/trading\s*212/i.test(a.provider));
    const suggested=candidates.length===1?(candidates[0].parentId||'root'):'';const why=r.reason||(seen.has(r.key)?'Duplikat':'');seen.add(r.key);return '<div class="import-row">'+line(r.date+' · '+r.name,(r.side||'Sonstiges')+' · '+money(r.amount))+(why?esc(why):pick('dest'+r.index,'Zuordnung',[['','Überspringen'],['root','Trading212 · außerhalb eines Pies'],...pies]).replace(' required',' data-suggest="'+esc(suggested)+'"')+(r.feeAmount?line('Enthaltene Gebühr',money(r.feeAmount)):'')+(r.side==='buy'?pick('kind'+r.index,'Art bei Neuanlage',[['stock','Aktie'],['etf','ETF']]):''))+'</div>';}).join(''),'Gewählte Zeilen einbuchen');return;}
  if(id==='apply-import'){if(importBase!==JSON.stringify(state()))throw Error('Portfolio geändert. Vorschau neu öffnen.');const choices={};for(const r of pending){choices[r.index]=get('dest'+r.index);r.kind=get('kind'+r.index);}if(!Object.values(choices).some(Boolean))throw Error('Mindestens eine Zuordnung wählen.');commit(importBroker(s,pending,choices));pending=[];importBase='';close();return;}
  if(id==='accounts'){s.accountChecks=(s.accountChecks||[]).filter(x=>x.name!==get('account')||x.month!==m);s.accountChecks.push({month:m,name:get('account'),amount});commit(s);await open('accounts');return;}
  if(id==='goals'){const a=get('from'),b=get('to'),r=project(s,m).at(-1);if(a===b||amount<=0)throw Error('Zwei verschiedene Ziele und positiven Betrag wählen.');modal('Zieltermine im Vergleich',[[a,-amount],[b,amount]].map(([key,delta])=>line(s.reserves.find(x=>x.id===key).name,goalEstimate(s,key,r.balances[key],0)+' → '+goalEstimate(s,key,r.balances[key],delta))).join('')+btn('goals','Betrag ändern'));return;}
  if(id==='div-add'||id==='div-paid'){const date=get('date'),assetId=get('asset');if(!isDate(date)||amount<=0||id==='div-paid'&&date>today())throw Error('Betrag und Zahlungstag prüfen.');if(id==='div-paid')s.portfolio.events.push({id:crypto.randomUUID(),type:'distribution',assetId,date,amount,note:'Dividendeneingang'});else(s.dividends||=[]).push({id:crypto.randomUUID(),assetId,date,amount});}
  if(id==='band'){const [low,base,high]=['low','base','high'].map(k=>cents(get(k)));if(low>base||base>high)throw Error('Werte aufsteigend angeben.');s.portfolio.assets.find(x=>x.id===get('asset')).band={low,base,high,date:get('date'),source:get('source')};}
  if(id==='swap'){const p=s.portfolio,a=assetTotals(p,get('from')),b=assetTotals(p,get('to')),summary=portfolioSummary(p);if(a.asset.id===b.asset.id||!summary.known||!a.known||amount<=0||amount>a.value)throw Error('Verschiedene Positionen, vollständig bewertetes Depot und verfügbaren Betrag prüfen.');const inst=x=>p.instruments.find(i=>i.id===x.asset.instrumentId),pct=n=>(100*n/summary.value).toFixed(2)+' %';let out='';
   for(const [key,label] of [['sector','Branche'],['currency','Handelswährung']])for(const v of new Set([inst(a)[key],inst(b)[key]])){const before=summary.leaves.filter(x=>p.instruments.find(i=>i.id===x.asset.instrumentId)?.[key]===v).reduce((n,x)=>n+x.value,0);out+=line(label+' · '+(v||'Unbekannt'),pct(before)+' → '+pct(before+(inst(b)[key]===v?amount:0)-(inst(a)[key]===v?amount:0)));}
   modal('Auswirkung des Tauschs',out+line('Änderung laufender Kosten pro Jahr',money(Math.round(amount*(Number(get('feeB'))-Number(get('feeA')))/100)))+btn('swap','Vergleich ändern'));return;}
  commit(s);close();toast('Gespeichert.');
 }
 return {open,submit,toolsFor,dashboard};
}
