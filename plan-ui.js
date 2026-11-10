import {money,cents,uid,project,yearRows,monthIndex,dayDate,due} from './engine.js';
import {appendItem,distribute,payments} from './planning.js';
import {today,assetTotals,allocation} from './portfolio.js';
import {advisorApply} from './advisor-core.js';
import {catalog,proposal} from './strategy.js';

export function createPlanUI({getState,getMonth,commit,render,modal,close,esc,period,entryForm,reservesPage,cloud,ensureCloud,getRevision,applyCloud,getScope,toast}){
 let tab='budgets',cloudCache=null;
 const cloudPost=body=>cloud.request('/functions/v1/investment-advisor',{method:'POST',auth:true,body});
 const state=getState,month=getMonth;
 const button=(action,label,id='',primary=false)=>`<button type="button" class="btn ${primary?'primary':''}" data-plan="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
 const field=(name,label,value='',attr='')=>`<label>${esc(label)}<input name="${name}" value="${esc(value)}" ${attr}></label>`;
 const euros=(name,label,value='',required=true)=>field(name,label,value,`type="number" min="0" step="0.01" max="1000000000" inputmode="decimal" ${required?'required':''}`);
 const options=(pairs,selected)=>pairs.map(([id,name])=>`<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(name)}</option>`).join('');
 const select=(name,label,pairs,selected)=>`<label>${esc(label)}<select name="${name}">${options(pairs,selected)}</select></label>`;
 const row=(label,value)=>`<div class="reserve-detail"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
 const panel=(title,body)=>`<section class="card planning-card"><h2>${esc(title)}</h2>${body}</section>`;
 const form=(id,title,body,save,data='')=>modal(title,`<form id="v6-${id}" data-id="${esc(data)}">${body}<div class="actions"><button class="btn primary">${esc(save)}</button></div></form>`);
 const forecast=()=>project(state(),month()).at(-1);
 
 const targetName=(r,s=state())=>(r.kind==='reserve'?s.reserves:s.portfolio.assets).find(x=>x.id===r.target)?.name;
 const eligible=(s,m)=>s.entries.filter(e=>e.type==='budget'&&due(e,m)).map(e=>[e.id,e.name]);
 const mainTabs=[['budgets','Budgets'],['reserves','Rücklagen & Ziele'],['allocate','Geld verteilen'],['review','Monatsabschluss']];
 function page(){
  const body=tab==='reserves'?reservesPage().split('<div class="reserve-grid">').pop():null;
  const actions=tab==='reserves'?'<button class="btn primary" data-action="reserve-add">Rücklage anlegen</button>':tab==='budgets'?button('category','Budget anlegen','',true):'';
  return `<div class="page-heading"><div><h1>Geld planen</h1><p class="subtitle">Deine Ausgaben, Rücklagen und nächsten Sparraten.</p></div>${actions}</div><div class="section-toolbar">${period()}</div><div class="chips plan-tabs">${mainTabs.map(([k,v])=>`<button class="chip ${tab===k?'active':''}" data-plan="tab" data-id="${k}">${v}</button>`).join('')}</div>`+
   (tab==='reserves'?'<div class="reserve-grid">'+body:tab==='budgets'?budgets():tab==='allocate'?allocationPage():review());
 }
 function budgets(){
  const r=forecast();
  return `<div class="reserve-grid">${r.tx.filter(x=>x.type==='budget').map(t=>{
   const b=r.envelopes[t.id],a=state().actuals[t.id+':'+month()];
   return panel(t.name,`<div class="reserve-amount ${b.available<0?'negative':''}">${money(b.available)}</div><p>${b.available<0?'Budget überschritten':'Nach Buchungen und Vormerkungen verfügbar'}</p>${row('Monatsbudget',money(b.planned))}${b.carry?row('Übertrag',money(b.carry)):''}${row('Ausgegeben',money(b.spent))}${row('Vorgemerkt',money(b.pending))}<div class="actions">${button('purchase','Ausgabe erfassen',t.id,true)}${button('budget-edit','Budget bearbeiten',t.id)}</div><details><summary>Buchungen und Übertrag</summary>${(a?.items||[]).map(x=>row(x.date+' · '+x.name+(x.sub?' / '+x.sub:''),money(x.amount))+button('item-remove','Entfernen',x.id)+(x.pending?button('item-post','Als bezahlt buchen',x.id):'')).join('')||'<p>Keine Einzelbuchungen.</p>'}${a&&!a.items?row('Übernommener Monatsbetrag',money(a.amount)):''}${button('roll',t.rollover?'Rest übertragen ✓':'Rest in Folgemonat übertragen',t.id)}${button('move','Rest einer Rücklage zuweisen',t.id)}</details>`);
  }).join('')||panel('Dein erstes Budget','<p>Lege zum Beispiel ein monatliches Budget für Lebensmittel an.</p>')}</div>`;
 }
 function purchase(id){
  const list=eligible(state(),month());if(!list.length)throw Error('Zuerst ein Budget für diesen Monat anlegen.');
  if(state().closedMonths?.[month()])throw Error('Monat zuerst wieder öffnen.');
  form('purchase','Ausgabe erfassen',field('name','Wofür?', '', 'required maxlength="100"')+field('date','Datum',today().startsWith(month())?today():month()+'-01',`type="date" required min="${month()}-01" max="${dayDate({day:31},month())}"`)+select('category','Budget',list,id)+euros('total','Gesamtbetrag in €')+field('sub','Unterkategorie (optional)','','maxlength="80"')+`<details><summary>Auf zwei Budgets aufteilen</summary>${select('second','Zweites Budget',[['','Keine Aufteilung'],...list])}${euros('part','Davon im zweiten Budget (€)','',false)}</details><label class="checkbox"><input type="checkbox" name="pending">Nur vormerken</label>`,'Speichern');
 }
 function allocationPage(){
  const r=forecast(),s=state(),rules=s.rules||[],pending=rules.filter(x=>targetName(x)&&!s.entries.some(e=>e.ruleId===x.id&&e.start===month()));
  const draft=distribute(pending,r.free);const after=r.free-draft.reduce((n,x)=>n+x.amount,0);
  return panel('Verfügbar zur Verteilung',`<div class="reserve-amount">${money(r.free)}</div><p>Prognose zum Monatsende nach Budgets, Rücklagen und bereits geplanten Investments.</p>${button('rule','Verteilregel anlegen')}${button('aidraft','KI-Entwurf anfordern')}</p>`)+panel('Reihenfolge und Monatsvorschau',rules.map((x,i)=>{
   const d=draft.find(d=>d.id===x.id);return row((i+1)+'. '+(targetName(x)||'Ziel entfernt'),x.percent?(x.amount/100)+' % vom Rest':money(x.amount))+row('Diesen Monat',d?money(d.amount)+(d.shortfall?' · fehlen '+money(d.shortfall):''):'Bereits eingeplant oder Ziel entfernt')+button('up','Höher priorisieren',x.id)+button('rule-remove','Regel entfernen',x.id);
  }).join('')+row('Frei nach Übernahme',money(after))+`<div class="actions">${button('apply','Vorschau in Monatsplan übernehmen','',true)}</div>`);
 }
 function review(){
  const s=state(),r=forecast(),actual=project(s,month(),'actual').at(-1);
  const bills=yearRows(s,month().slice(0,4)).flatMap(r=>r.tx).filter(t=>t.type==='expense'&&t.interval>=3);
  return panel('Monat prüfen',row('Gebuchter Kontostand',money(actual.cash))+row('Prognose am Monatsende',money(r.cash))+r.tx.filter(x=>x.type!=='budget'&&!x.booked).map(x=>row('Buchung offen · '+x.name,money(x.planned))).join('')+Object.entries(r.envelopes).filter(([,v])=>v.available<0||v.pending).map(([id,v])=>row(s.entries.find(e=>e.id===id).name,v.available<0?'Überschritten um '+money(-v.available):'Vorgemerkt '+money(v.pending))).join('')+r.tx.filter(x=>x.booked&&x.actual!==x.planned).map(x=>row(x.name+' · Ist minus Plan',money(x.actual-x.planned))).join('')+(payments(r).some(x=>x.balance<0)?'<p class="negative">Die Liquidität fällt im Monatsverlauf unter null. Prüfe die Zahlungstage.</p>':'')+button('close-month',s.closedMonths?.[month()]?'Budgetmonat wieder öffnen':'Budgets abschließen'))+
  panel('Liquidität nach Zahlungstag',payments(r).map(x=>row(x.date+' · '+x.name,money(x.balance))).join('')||'<p>Keine Zahlungen geplant.</p>')+
  panel('Rechnungskalender '+month().slice(0,4),bills.map(x=>row(x.date+' · '+x.name,money(x.amount))).join('')||'<p>Keine wiederkehrenden Quartals- oder Jahresrechnungen.</p>');
 }
 function strategyForm(g={}){
  form('strategy',g.id?'Strategie bearbeiten':'Anlageziel anlegen',field('name','Anlageziel',g.name||'','required maxlength="100"')+select('selection','Auswahl der KI',[['free','Aktien und ETFs'],['etf','Nur ETFs'],['core','ETF-Kern · maximal 30 % Einzelaktien']],g.selection||'free')+field('sector','Höchstanteil einer Branche (%)',(g.sectorLimit||10000)/100,'type="number" min="1" max="100" required')+field('currencyLimit','Höchstanteil einer Handelswährung (%)',(g.currencyLimit||10000)/100,'type="number" min="1" max="100" required')+field('loss','Tolerierter zeitweiliger Verlust (%)',g.lossTolerance||20,'type="number" min="1" max="100" required')+select('risk','Risikoneigung',[['conservative','Vorsichtig'],['balanced','Ausgewogen'],['growth','Wachstumsorientiert']],g.risk||'balanced')+field('years','Horizont in Jahren',g.years||10,'type="number" required min="1" max="50"')+euros('start','Geplantes Startkapital (€)',(g.start||0)/100)+euros('rate','Monatliche Sparrate (€)',(g.rate||0)/100)+euros('target','Zielvermögen (€)',(g.target||0)/100)+field('cash','Mindestanteil Cash (%)',(g.cash??1000)/100,'required type="number" min="0" max="100"')+field('cap','Maximaler Anteil je Titel (%)',(g.cap||6000)/100,'required type="number" min="5" max="100"')+select('interval','Prüfrhythmus',[[1,'Täglich'],[7,'Wöchentlich'],[30,'Monatlich']],g.interval||7)+`<label class="checkbox"><input type="checkbox" name="noEm" ${g.noEm?'checked':''}>Schwellenländer im Offline-Modell ausschließen</label><details><summary>Einzelne Produkte ausschließen</summary>${catalog.map(c=>`<label class="checkbox"><input type="checkbox" name="exclude" value="${c.isin}" ${g.exclude?.includes(c.isin)?'checked':''}>${esc(c.name)}</label>`).join('')}</details>`,'Anlageziel speichern',g.id);
 }
 function wealth(){
  const s=state();
  return `<div class="page-heading"><div><button class="text-btn" data-view="investments">‹ Investments</button><h1>Robo-Advisor</h1><p class="subtitle">Anlageziele, Strategie und tatsächlicher Bestand.</p></div>${button('goal','Anlageziel anlegen','',true)}</div>`+(s.strategies||[]).map(g=>{
   if(g.selection){
    const root=s.portfolio.assets.find(x=>x.id===g.pieId),holding=root?assetTotals(s.portfolio,root.id):null;
    return panel(g.name,row('Strategie',{free:'Aktien und ETFs',core:'ETF-Kern mit Einzelaktien',etf:'ETF-Portfolio'}[g.selection])+row('Ziel / Sparrate',money(g.target)+' / '+money(g.rate))+row('Depotwert',holding?.known?money(holding.value):'Noch kein bewerteter Pie')+row('Zuletzt übernommene Empfehlung',g.lastAdvice?.asOf||'Erste Analyse offen')+
    (g.lastAdvice?.positions||[]).map(pos=>{const u=g.lastAdvice.universe.find(x=>x.id===pos.id),a=s.portfolio.assets.find(x=>x.parentId===g.pieId&&s.portfolio.instruments.some(i=>i.id===x.instrumentId&&((u.isin&&i.isin===u.isin)||i.symbol===u.symbol&&i.exchange.toUpperCase()===u.exchange.toUpperCase())&&i.currency===u.currency));return row(u.name,pos.weightBps/100+' % · '+(a?money(assetTotals(s.portfolio,a.id).value):'offen'))+(a?button('buy','Kauf eintragen',a.id):'');}).join('')+
    '<div class="actions">'+button('connect-goal','KI einrichten',g.id)+button('cloud-status','Prüfverlauf öffnen',g.id,true)+button('edit-goal','Profil bearbeiten',g.id)+'</div>'+cloudPanel(g)+
    '<details><summary>Einzahlungen und Offline-Modell</summary>'+button('capital','Startkapital einplanen',g.id)+button('savings','Sparrate einplanen',g.id)+(g.lastAdvice?'':button('adopt','Regelbasiertes ETF-Modell vormerken',g.id))+'</details>');
   }
   const products=g.lastAdvice?.universe||catalog,rec=g.lastAdvice?{...g.lastAdvice,feeBps:null}:proposal(g),pie=s.portfolio.assets.find(a=>a.id===g.pieId),root=pie?assetTotals(s.portfolio,pie.id):null;
   const checked=g.checked||'',overdue=!checked||Date.parse(today())-Date.parse(checked)>=g.interval*86400000;
   const rows=[...rec.positions];
   for(const child of root?.children||[]){
    const instrument=s.portfolio.instruments.find(i=>i.id===child.asset.instrumentId);
    if(instrument&&products.some(c=>c.id===instrument.isin)&&!rows.some(x=>x.id===instrument.isin))
      rows.push({id:instrument.isin,weightBps:0,reason:'Position im bestehenden Pie'});
   }
   let topup=[];if(pie&&root?.known)try{topup=allocation(s.portfolio,pie.id,g.rate);}catch{}
   return panel(g.name,row('Zielvermögen',money(g.target))+row('Depotwert',root?.known?money(root.value):'Noch kein vollständig bewerteter Bestand')+(root?.known&&g.target?row('Ziel erreicht',(root.value/g.target*100).toFixed(1)+' %'):'')+row('Geplanter Start / Monat',money(g.start)+' / '+money(g.rate))+row('Prüfung',checked+(overdue?' · fällig':' · aktuell'))+row('Gewichtete Fondskosten p. a.',rec.feeBps===null?'Daten unvollständig':(rec.feeBps/100).toLocaleString('de-DE',{maximumFractionDigits:3})+' %')+`<h3>${g.lastAdvice?'Übernommener KI-Vorschlag':'Offline-Modell · fünf ETFs'}</h3>`+rows.map(pos=>{
    const c=products.find(c=>c.id===pos.id),inst=s.portfolio.instruments.find(i=>(c.isin?i.isin===c.isin:i.symbol===c.symbol&&i.exchange.toUpperCase()===c.exchange.toUpperCase())&&i.currency===c.currency),a=pie&&inst&&s.portfolio.assets.find(a=>a.parentId===pie.id&&a.instrumentId===inst.id),v=a?assetTotals(s.portfolio,a.id):null;
    const verified=g.brokerChecks?.[c.isin];
    const add=topup.find(x=>x.id===a?.id)?.add;
    return `<div class="strategy-line"><strong>${esc(c.name)}</strong><small>${esc(c.isin||c.symbol)} · ${esc(pos.reason)} · Kosten ${c.fee===undefined?'offen':c.fee/100+' %'}</small>${row('Vorschlag / Pie-Ziel / Ist',pos.weightBps/100+' % / '+(a?a.targetBps/100+' %':'–')+' / '+(root?.known&&root.value&&v?.known?(100*v.value/root.value).toFixed(1)+' %':'–'))}${row('Nächste Rate',add!==undefined?money(add):!root?.value?money(Math.round(g.rate*pos.weightBps/10000)):'Bewertung ergänzen')}${row('Bei Trading212',verified?'Von dir bestätigt · '+verified:'Verfügbarkeit offen')}${button('broker-check',verified?'Bestätigung entfernen':'Verfügbarkeit bestätigen',g.id+'|'+c.isin)}${a?row('Ausgeführt',s.portfolio.events.filter(e=>e.assetId===a.id&&e.trade==='buy').length+' Kaufbuchungen'):''}${a?button('buy','Ausgeführten Kauf eintragen',a.id):''}</div>`;
   }).join('')+row('Cash · Vorschlag / Pie-Ziel',rec.cashWeightBps/100+' % / '+(pie?(root.children.find(x=>x.asset.kind==='cash')?.asset.targetBps||0)/100+' %':'–'))+`<p>Trading212-Verfügbarkeit vor der Ausführung im eigenen Konto prüfen.</p><div class="actions">${button('edit-goal','Profil bearbeiten',g.id)}${button('refresh-goal','Strategie prüfen',g.id)}${!g.lastAdvice?button('adopt','Offline-Modell vormerken',g.id):''}${g.start?button('capital','Startkapital einplanen',g.id):''}${button('savings','Sparrate im Monatsplan anlegen',g.id)}${button('connect-goal','KI-Strategie einrichten',g.id)}${button('cloud-status','KI-Empfehlungen öffnen',g.id)}</div>`+(pie?row('Vorgemerkter Pie',pie.name):'')+cloudPanel(g));
  }).join('')+panel('Offline-Modell',`<p>Ohne Cloud kannst du für ein Ziel die regelbasierte Auswahl aus fünf ETFs nutzen. Grenzen, Horizont und ausgeschlossene Produkte bestimmen die Gewichte. Katalogstand 09.11.2026.</p><details><summary>Alle fünf Kandidaten vergleichen</summary>${catalog.map(c=>row(c.name,c.fee/100+' %')+`<a href="${c.source}" target="_blank" rel="noopener">Produktdaten · ${c.isin}</a>`).join('')}</details>`)+panel('Analysen und Marktdaten','<button class="btn" data-feature="advisor">Cloud-Analysen und Prüfverlauf öffnen</button>');
 }
 function cloudPanel(g){
  if(cloudCache?.scope!==getScope()||cloudCache.goalId!==g.id)return '';
  const data=cloudCache.data,profile=data.profile?.profile;
  if(!profile||profile.goal!==goalKey(g))return '<p>Für dieses Anlageziel ist aktuell keine Cloud-Prüfung eingerichtet.</p>';
  return '<h3>Marktprüfungen</h3>'+row('Intervall',profile.enabled?'Alle '+profile.intervalDays+' Tage':'Auf Anfrage')+button('cloud-run','Jetzt mit Marktdaten prüfen',g.id)+data.runs.filter(x=>x.profile?.goal===profile.goal&&x.mode==='advisor').slice(0,5).map(run=>{
   const rec=run.result?.recommendation;
   return '<details><summary>'+esc(String(run.created_at).slice(0,10)+' · '+(run.adopted_at?'Vorgemerkt':rec?'Empfohlen':run.status))+'</summary>'+(run.result?.coverage?row('Katalog / zugelassen / geprüft / mit Daten',[run.result.coverage.total,run.result.coverage.eligible,run.result.coverage.checked,run.result.coverage.usable].join(' / '))+row('Brokerabgleich',run.result.coverage.brokerMatched?'Trading212-Katalog geprüft':'Verfügbarkeit beim Broker offen'):'')+(rec?row('Prüfung',run.result.strategicReview?'Monatliche Strategieprüfung':'Marktprüfung')+'<p>'+esc(rec.summary)+'</p>'+rec.positions.map(p=>reviewPosition(g,run,p)+'<p>'+esc(p.reason)+'</p>').join('')+(g.pieId?state().portfolio.assets.filter(a=>a.parentId===g.pieId&&a.kind!=='cash'&&a.targetBps>0&&!rec.positions.some(p=>{const u=(run.result.selection||run.profile.universe).find(u=>u.id===p.id),i=state().portfolio.instruments.find(i=>i.id===a.instrumentId);return i&&u&&((i.isin&&i.isin===u.isin)||(i.symbol===u.symbol&&i.exchange.toUpperCase()===u.exchange.toUpperCase()))&&i.currency===u.currency;})).map(a=>row(a.name+' · Ziel entfällt',a.targetBps/100+' % → 0 %')).join(''):'')+row('Cash',rec.cashWeightBps/100+' %')+rec.risks.map(x=>'<p>'+esc(x)+'</p>').join('')+(!run.adopted_at?button('cloud-adopt','Geprüfte Zielgewichte vormerken',run.id):''):esc(run.error||''))+'</details>';
  }).join('');
 }
 function reviewPosition(g,run,pos){
  const u=(run.result.selection||run.profile.universe).find(x=>x.id===pos.id);if(!u)return '';
  const s=state(),pie=s.portfolio.assets.find(a=>a.id===g.pieId),total=pie?assetTotals(s.portfolio,pie.id):null;
  const asset=pie&&s.portfolio.assets.find(a=>a.parentId===pie.id&&s.portfolio.instruments.some(i=>i.id===a.instrumentId&&i.currency===u.currency&&((i.isin&&i.isin===u.isin)||(i.symbol===u.symbol&&i.exchange.toUpperCase()===u.exchange.toUpperCase()))));
  const current=asset?assetTotals(s.portfolio,asset.id).value:0,base=pie?total.value:g.start,change=Math.round(base*pos.weightBps/10000)-current;
  return row(u.name,(total?.known&&base?(100*current/base).toFixed(1):'0')+' % → '+pos.weightBps/100+' %')+row('Differenz auf '+money(base),pie&&!total.known?'Bewertung offen':money(change));
 }
 const goalKey=g=>g.name;
 async function loadRuns(goalId){
  const scope=getScope(),data=await cloudPost({action:'list',strategyId:goalId});
  if(getScope()!==scope)return;
  cloudCache={scope,goalId,data};render();
 }
 function targets(){return [...state().reserves.map(r=>['reserve:'+r.id,'Rücklage · '+r.name]),...state().portfolio.assets.map(a=>['investment:'+a.id,(a.provider||'Depot')+' · '+a.name])];}
 const basicEntry=(type,name,amount,m,extra={})=>({id:uid(),type,name,amount,start:m,end:'',day:1,interval:0,reserveId:'',note:'',...extra});
 function ruleForm(){const list=targets();if(!list.length)throw Error('Zuerst eine Rücklage oder ein Investment anlegen.');form('rule','Geld verteilen',select('target','Ziel',list)+select('unit','Betragsart',[['eur','Fester Betrag in €'],['percent','Prozent vom verbleibenden Geld']])+euros('amount','Betrag oder Prozentwert'),'Regel hinzufügen');}
 async function click(t){
  const action=t.dataset.plan,id=t.dataset.id,s=structuredClone(state()),m=month();
  const g=s.strategies?.find(g=>g.id===id);
  if(action==='tab'){tab=id;render();return;}
  if(action==='withdraw'){entryForm(null,{type:'expense',interval:0,reserveId:id,name:s.reserves.find(x=>x.id===id).name});return;}
  if(action==='category'){
   form('category','Budget anlegen',field('name','Kategorie','','required maxlength="100" placeholder="z. B. Lebensmittel"')+euros('amount','Monatsbudget in €')+field('start','Ab Monat',m,'type="month" required min="'+s.anchor+'"')+'<label class="checkbox"><input type="checkbox" name="rollover">Übriges Budget nach Monatsabschluss übertragen</label>','Budget anlegen');return;
  }
  if(action==='budget-edit'){entryForm(id);return;}
  if(action==='roll'){const e=s.entries.find(e=>e.id===id);e.rollover=!e.rollover;}
  if(action==='purchase'){purchase(id);return;}
  if(action==='item-post'||action==='item-remove'){
   if(s.closedMonths?.[m])throw Error('Budgetmonat zuerst wieder öffnen.');
   for(const [key,a] of Object.entries(s.actuals)){if(!key.endsWith(':'+m)||!a.items?.some(x=>x.id===id))continue;
    if(action==='item-post')a.items.find(x=>x.id===id).pending=false;
    else a.items=a.items.filter(x=>x.id!==id);
    a.amount=a.items.filter(x=>!x.pending).reduce((v,x)=>v+x.amount,0);
   }
  }
  if(action==='move'){
   if(!s.reserves.length)throw Error('Zuerst eine Rücklage anlegen.');
   if(s.closedMonths?.[m])throw Error('Budgetmonat zuerst öffnen.');
   form('move','Budgetrest reservieren',select('reserve','Rücklage',s.reserves.map(x=>[x.id,x.name]))+euros('amount','Betrag in €',Math.max(0,forecast().envelopes[id].available)/100),'Reservieren',id);return;
  }
  if(action==='rule'){ruleForm();return;}
  if(action==='rule-remove')s.rules=s.rules.filter(x=>x.id!==id);
  if(action==='up'){const i=s.rules.findIndex(x=>x.id===id);if(i>0)[s.rules[i-1],s.rules[i]]=[s.rules[i],s.rules[i-1]];}
  if(action==='apply'){
   const open=(s.rules||[]).filter(x=>targetName(x,s)&&!s.entries.some(e=>e.ruleId===x.id&&e.start===m));
   for(const x of distribute(open,forecast().free).filter(x=>x.amount>0)){
    const e=basicEntry(x.kind,targetName(x,s),x.amount,m,{ruleId:x.id,day:31,reserveId:x.kind==='reserve'?x.target:''});s.entries.push(e);
    if(x.kind==='investment')s.portfolio.assets.find(a=>a.id===x.target).planEntryIds.push(e.id);
   }
  }
  if(action==='close-month'){
   s.closedMonths||={};
   if(s.closedMonths[m])delete s.closedMonths[m];
   else {if(Object.values(forecast().envelopes).some(b=>b.pending))throw Error('Vorgemerkte Ausgaben zuerst buchen oder entfernen.');s.closedMonths[m]=today();}
  }
  if(action==='goal'||action==='edit-goal'){strategyForm(g);return;}
  if(action==='refresh-goal'){proposal(g);g.checked=today();toast('Profil und Zielgewichte geprüft.');}
  if(action==='broker-check'){
   const [goalId,isin]=id.split('|'),goal=s.strategies.find(g=>g.id===goalId);
   const checks=goal.brokerChecks||={};if(checks[isin])delete checks[isin];else checks[isin]=today();
  }
  if(action==='adopt'){
   const rec=proposal(g),existing=s.portfolio.assets.find(a=>a.id===g.pieId);
   if(existing){
    const held=s.portfolio.assets.filter(a=>a.parentId===existing.id);
    if(rec.positions.every(p=>held.some(a=>s.portfolio.instruments.find(i=>i.id===a.instrumentId)?.isin===p.id&&a.targetBps===p.weightBps))&&held.filter(a=>a.kind==='cash').reduce((n,a)=>n+a.targetBps,0)===rec.cashWeightBps&&held.reduce((n,a)=>n+a.targetBps,0)===10000){toast('Diese Ziele sind bereits vorgemerkt.');return;}
   }
   const applied=advisorApply(s,{status:'completed',mode:'advisor',id:uid(),profile:{universe:catalog},result:{recommendation:rec}},existing?.id||'');
   const goal=applied.data.strategies.find(x=>x.id===id);goal.pieId=applied.pieId;goal.checked=today();applied.data.portfolio.assets.find(a=>a.id===goal.pieId).name=goal.name;
   commit(applied.data);toast('Zielgewichte im Pie vorgemerkt.');return;
  }
  if(action==='buy'){const b=document.createElement('button');b.dataset.pf='buy';b.dataset.id=id;document.body.append(b);b.click();b.remove();return;}
  if(action==='cloud-status'){await loadRuns(id);return;}
  if(action==='cloud-run'){
   await ensureCloud();toast('Marktprüfung läuft …');await cloudPost({action:'run',requestId:uid(),planRevision:getRevision(),mode:'advisor',strategyId:id});await loadRuns(id);return;
  }
  if(action==='cloud-adopt'){
   const goal=s.strategies?.find(g=>g.id===cloudCache?.goalId);
   if(!goal)throw Error('Anlageziel fehlt.');
   await ensureCloud();const before=JSON.stringify(state());
   const res=await cloudPost({action:'adopt',runId:id,pieId:s.portfolio.assets.some(a=>a.id===goal.pieId)?goal.pieId:'',reviewed:true,planRevision:getRevision()});
   applyCloud(res,before);await loadRuns(goal.id);return;
  }
  if(action==='capital'){
   const pie=s.portfolio.assets.find(a=>a.id===g.pieId);if(!pie)throw Error('Zuerst Ziele im Pie vormerken.');
   if(!g.start||s.entries.some(e=>e.capitalGoal===id))throw Error('Startkapital bereits geplant oder nicht angegeben.');
   const e=basicEntry('investment',g.name+' · Startkapital',g.start,m,{day:31,capitalGoal:id});s.entries.push(e);pie.planEntryIds.push(e.id);toast('Startkapital im Monatsplan vorgemerkt.');
  }
  if(action==='savings'){
   const pie=s.portfolio.assets.find(a=>a.id===g.pieId);if(!pie)throw Error('Zuerst Ziele im Pie vormerken.');
   if(s.entries.some(e=>e.strategyId===id&&(!e.end||e.end>=m)))throw Error('Für dieses Ziel besteht bereits ein Sparplan.');
   if(!g.rate)throw Error('Zuerst eine monatliche Rate im Profil angeben.');
   const e=basicEntry('investment',g.name,g.rate,m,{interval:1,strategyId:id});s.entries.push(e);pie.planEntryIds.push(e.id);toast('Sparrate im Monatsplan angelegt.');
  }
  if(action==='connect-goal'){form('connect','KI-Strategie einrichten',`<p>Dieses Anlageziel erhält einen eigenen Prüfverlauf. Bei aktiviertem Supabase-Cron werden Aktien und ETFs alle ${g.interval} Tage anhand von Kursen, technischen Signalen und Nachrichten geprüft.</p><label class="checkbox"><input type="checkbox" required>Portfolio und Profil für Analysen an OpenRouter übertragen. Anbieter dürfen die Symbole abrufen. API-Kosten sind möglich.</label><label class="checkbox"><input type="checkbox" name="scheduled">Regelmäßige Prüfung aktivieren</label>`,'Cloud-Profil speichern',id);return;}
  if(action==='aidraft'){const list=targets();if(!list.length)throw Error('Zuerst Ziele anlegen.');form('ai','KI-Verteilung vorschlagen',`<p>Die KI erhält den verfügbaren Monatsbetrag und die Namen der möglichen Ziele. Anschließend kannst du die vorgeschlagenen Regeln prüfen.</p>`,'Entwurf anfordern');return;}
  commit(s);
 }
 async function submit(f){
  const s=structuredClone(state()),m=month(),d=new FormData(f),get=k=>String(d.get(k)||''),id=f.dataset.id;
  if(f.id==='v6-category')s.entries.push(basicEntry('budget',get('name').trim(),cents(get('amount')),get('start'),{interval:1,rollover:d.has('rollover')}));
  if(f.id==='v6-purchase'){
   const total=cents(get('total')),part=cents(get('part')),second=get('second'),cat=get('category');
   if(total<=0||part<0||part>=total||Boolean(part)!==Boolean(second)||second===cat)throw Error('Teilbetrag und zweites Budget prüfen.');
   if(get('date').slice(0,7)!==m)throw Error('Datum liegt außerhalb des Monats.');
   const item={name:get('name'),sub:get('sub'),pending:d.has('pending')};
   for(const [category,amount] of [[cat,total-part],[second,part]])if(amount)appendItem(s,category,get('date'),{...item,id:uid(),amount});
  }
  if(f.id==='v6-move'){
   const amount=cents(get('amount'));if(!amount||amount>forecast().envelopes[id].available)throw Error('Betrag übersteigt den verfügbaren Budgetrest.');
   const e=basicEntry('reserve','Aus Budget · '+s.entries.find(e=>e.id===id).name,amount,m,{reserveId:get('reserve'),budgetSource:id});
   s.entries.push(e);s.actuals[e.id+':'+m]={amount,date:today()};
  }
  if(f.id==='v6-rule'){
   const [kind,...parts]=get('target').split(':'),target=parts.join(':'),percent=get('unit')==='percent',amount=cents(get('amount'));
   if(amount<=0||(percent&&amount>10000))throw Error('Betrag oder Prozentsatz prüfen.');
   (s.rules||=[]).push({id:uid(),kind,target,percent,amount});
  }
  if(f.id==='v6-strategy'){
   const g={id:id||uid(),name:get('name'),selection:get('selection'),lossTolerance:Number(get('loss')),sectorLimit:cents(get('sector')),currencyLimit:cents(get('currencyLimit')),risk:get('risk'),years:Number(get('years')),start:cents(get('start')),rate:cents(get('rate')),target:cents(get('target')),cash:cents(get('cash')),cap:cents(get('cap')),interval:Number(get('interval')),noEm:d.has('noEm'),exclude:d.getAll('exclude'),checked:today()};
   proposal(g);const old=(s.strategies||=[]).find(x=>x.id===id);if(old)Object.assign(old,g);else s.strategies.push(g);
  }
  if(f.id==='v6-connect'){
   const g=s.strategies.find(g=>g.id===id),ids=proposal(g).positions.map(x=>x.id);if(!ids.length)throw Error('Strategie enthält nur Cash.');
   await ensureCloud();await cloud.request('/functions/v1/investment-advisor',{method:'POST',auth:true,body:{action:'save-profile',strategyId:g.id,enabled:d.has('scheduled'),consent:true}});
   close();await loadRuns(g.id);toast('Marktprüfung für dieses Ziel eingerichtet.');return;
  }
  if(f.id==='v6-ai'){
   await ensureCloud();const before=JSON.stringify(state()),draftScope=getScope(),list=targets(),available=forecast().free;
   const res=await cloud.request('/functions/v1/investment-advisor',{method:'POST',auth:true,body:{action:'budget-draft',available,targets:list}});
   if(before!==JSON.stringify(state())||m!==month()||draftScope!==getScope())throw Error('Plan geändert. Entwurf erneut anfordern.');
   form('accept','KI-Entwurf prüfen',res.rules.map(x=>row(list.find(([id])=>id===x.target)?.[1],x.percent+' % vom Rest')+`<input type="hidden" name="draft" value="${esc(JSON.stringify(x))}">`).join('')+'<p>Du kannst die Reihenfolge anschließend unter Geld verteilen ändern.</p>','Regeln ergänzen');return;
  }
  if(f.id==='v6-accept'){for(const raw of d.getAll('draft')){const x=JSON.parse(raw);if(!targets().some(([k])=>k===x.target))throw Error('Ziel wurde entfernt.');const [kind,...parts]=x.target.split(':'),target=parts.join(':');(s.rules||=[]).push({id:uid(),kind,target,percent:true,amount:cents(x.percent)});}}
  commit(s);close();
 }
 return {page,wealth,click,submit,purchase};
}
