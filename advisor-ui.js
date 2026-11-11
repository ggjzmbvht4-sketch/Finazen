import {CLASS_COLORS,treemapHTML} from './wealth-visuals.js';
import {money} from './engine.js';
import {assetTotals,today,allocation,latestQuote} from './portfolio.js';
import {holdingAt} from './trading.js';
export function advisorUI(ctx){
 const {state,esc,commit,render,cloud,ensureCloud,revision,applyCloud,scope}=ctx;
 let selected='',viewTab='overview',mapMode='class',mapBasis='actual',highlight='',cache=new Map(),loading=new Set(),pending=new Set();
 const button=(action,label,id='',primary=false)=>`<button class="btn ${primary?'primary':''}" data-advisor="${action}" data-id="${esc(id)}">${label}</button>`;
 const matching=(p,u)=>p.instruments.find(i=>i.currency===u.currency&&((u.isin&&i.isin===u.isin)||(i.symbol===u.symbol&&i.exchange.toUpperCase()===u.exchange.toUpperCase())));
 const call=body=>cloud.request('/functions/v1/investment-advisor',{method:'POST',auth:true,body});
 const key=id=>scope()+'|'+id;
 async function load(id){
  const k=key(id);if(loading.has(k))return;
  loading.add(k);cache.set(k,{status:'loading'});render();
  try{const data=await call({action:'list',strategyId:id});cache.set(k,{status:'ready',data});}
  catch(e){cache.set(k,{status:'error',error:e.message});}
  finally{loading.delete(k);if(key(id)===k)render();}
 }
 function table(headers,rows){return '<div class="table-scroll"><table class="advisor-table"><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';}
 const cell=x=>'<td>'+x+'</td>';
 function holdings(g){
  const p=state().portfolio,pie=p.assets.find(a=>a.id===g.pieId&&a.kind==='pie');
  if(!pie)return '<div class="advisor-empty"><h3>Dein Strategie-Pie ist noch offen</h3><p>Prüfe eine Empfehlung und übernimm sie als Ziel-Pie. Danach stehen hier alle enthaltenen Wertpapiere.</p></div>';
  const total=assetTotals(p,pie.id),children=p.assets.filter(a=>a.parentId===pie.id),rows=children.map(a=>{
   const i=p.instruments.find(i=>i.id===a.instrumentId),v=assetTotals(p,a.id),q=latestQuote(p,a),qty=i?holdingAt(p,a,today()):null;
   return '<tr data-highlight="'+(highlight===a.id||highlight===a.kind)+'">'+cell('<strong>'+esc(a.name)+'</strong><small>'+esc(i?[i.isin,i.symbol,i.exchange,i.currency].filter(Boolean).join(' · '):'Liquidität')+'</small>')+cell(i?esc(qty===null?'Bestand ungeklärt':new Intl.NumberFormat('de-DE',{maximumFractionDigits:8}).format(qty)):'–')+cell(i?(q?new Intl.NumberFormat('de-DE',{style:'currency',currency:i.currency}).format(q.priceMicros/1e6):'Kurs fehlt'):'–')+cell(v.known?'<span class="amount">'+money(v.value)+'</span>':'Bewertung fehlt')+cell(total.known&&total.value?(100*v.value/total.value).toFixed(1)+' %':'–')+cell((a.targetBps/100).toFixed(1)+' %')+cell(q?esc(q.asOf):'–')+cell(i?'<button class="text-btn" data-pf="buy" data-id="'+esc(a.id)+'">Kauf</button> <button class="text-btn" data-pf="sell" data-id="'+esc(a.id)+'">Verkauf</button> <button class="text-btn" data-pf="detail" data-id="'+esc(a.id)+'">Details</button>':'<button class="text-btn" data-feature="cash" data-id="'+esc(a.id)+'">Cash verwalten</button>')+'</tr>';
  });
  return '<div class="card-title"><div><h2>'+esc(pie.name)+'</h2><p>Tatsächliche Bestände und vorgemerkte Ziele</p></div><strong class="amount">'+(total.known?money(total.value):money(total.value)+' · Teilwert')+'</strong></div>'+
  (rows.length?table(['Wertpapier','Stück','Stückkurs','Wert EUR','Ist','Ziel','Wertstand','Buchung'],rows):'<div class="notice">Dieser Pie ist leer. Übernimm eine fertige Empfehlung oder ergänze über Pie verwalten deine vorhandenen Wertpapiere.</div>')+
  '<p>Eine Zielposition mit null Stück wurde noch nicht gekauft. Wertstände werden mit Datum angezeigt.</p>'+
  '<div class="actions"><button class="btn" data-pf="detail" data-id="'+esc(pie.id)+'">Pie verwalten</button>'+button('funding','Nächste Sparrate verteilen',g.id)+'</div>';
 }
 function map(g){
  const p=state().portfolio,children=p.assets.filter(a=>a.parentId===g.pieId);
  let items=children.map(a=>({id:a.id,name:a.name,kind:a.kind,value:mapBasis==='target'?a.targetBps:assetTotals(p,a.id).known?assetTotals(p,a.id).value:0,color:CLASS_COLORS[a.kind]||'#7c8990'}));
  if(mapMode==='class'){const groups=new Map();for(const a of items){const entry=groups.get(a.kind)||{id:a.kind,name:({stock:'Aktien',etf:'ETFs',bond:'Anleihen',cash:'Liquidität',fund:'Fonds',private:'Beteiligungen',alternative:'Weitere Anlagen'})[a.kind]||a.kind,value:0,color:a.color};entry.value+=a.value;groups.set(a.kind,entry);}items=[...groups.values()];}
  return '<div class="card-title"><h2>Gewichtung</h2><div class="actions">'+button('mapmode',mapMode==='class'?'Einzelne Wertpapiere':'Anlageklassen')+button('mapbasis',mapBasis==='actual'?'Zielgewichte zeigen':'Tatsächliche Werte zeigen')+'</div></div><p>'+ (mapBasis==='actual'?'Erfasste, bewertete Bestände':'Vorgemerkte Zielgewichte')+'</p>'+treemapHTML(items,esc)+
   '<div class="map-legend">'+items.map(x=>'<span><i style="background:'+x.color+'"></i>'+esc(x.name)+'</span>').join('')+'</div><p>Ein Rechteck auswählen, um die zugehörigen Tabellenzeilen hervorzuheben. ETFs werden als eigene Klasse gezeigt, solange eine bestätigte Durchschau fehlt.</p>';
 }
 function recommended(g,run){
  const rec=run.result?.recommendation;if(!rec)return '<p>'+esc(run.error||'Die Prüfung läuft.')+'</p>';
  const p=state().portfolio,universe=run.result.selection||run.profile.universe,pie=p.assets.find(a=>a.id===g.pieId),root=pie?assetTotals(p,pie.id):null,base=root?.value||g.start||0;
  const outdated=run.profile.risk!==g.risk||run.profile.horizonYears!==g.years||run.profile.maxWeightBps!==g.cap||run.profile.selection!==(g.selection||undefined);
  const rows=rec.positions.map(pos=>{
   const u=universe.find(u=>u.id===pos.id);if(!u)return '';
   const i=matching(p,u),a=i&&p.assets.find(a=>a.parentId===pie?.id&&a.instrumentId===i.id),v=a?assetTotals(p,a.id):null;
   return '<tr>'+cell('<strong>'+esc(u.name)+'</strong><small>'+esc([u.isin,u.symbol,u.exchange,u.currency].filter(Boolean).join(' · '))+'</small>')+cell(u.kind==='etf'?'ETF':'Aktie')+cell((pos.weightBps/100).toFixed(1)+' %')+cell(root&&!root.known?'Bewertung offen':'<span class="amount">'+money(Math.round(base*pos.weightBps/10000))+'</span>')+cell(v?.known?money(v.value):a?'Wert fehlt':'0,00 €')+cell(esc(pos.reason))+'</tr>';
  });
  rows.push('<tr>'+cell('Liquidität')+cell('Cash')+cell(rec.cashWeightBps/100+' %')+cell(money(Math.round(base*rec.cashWeightBps/10000)))+cell('')+cell('Cashanteil der Strategie')+'</tr>');
  const c=run.result.coverage,d=run.result.decision;
  return '<div class="recommendation-header"><span class="status-pill">'+(run.adopted_at?'Übernommen':'Zur Prüfung')+'</span><span>'+esc(run.result.asOf||run.finished_at?.slice(0,10)||'')+'</span></div><h3>'+esc(rec.summary)+'</h3><p>'+esc(rec.portfolioAssessment)+'</p>'+
  '<section class="decision-banner"><strong>'+esc(({hold:'Bestand und Strategie beibehalten',deposit:'Nächste Sparrate anders verteilen',rebalance:'Zielanpassung vorgeschlagen'})[rec.action]||'Zusammensetzung prüfen')+'</strong><p>'+esc(rec.changeReason||'Prüfe die Begründung und den Vergleich mit deinem Bestand.')+'</p></section>'+table(['Konkretes Wertpapier','Art','Empfohlen','Zielbetrag EUR','Bestand EUR','Auswahlgrund'],rows)+
  (pie?'<p>Bestehende Pie-Positionen außerhalb dieser Empfehlung erhalten nach Übernahme Zielgewicht 0 %. Ihre Bestände bleiben bis zu einer Verkaufsbuchung erhalten.</p>':'')+
  (d?'<section class="advisor-options"><div><h4>Beibehalten</h4><p>Bestehende Zielgewichte und Positionen weiterführen.</p></div><div><h4>Nächste Sparrate</h4>'+d.positions.map(x=>'<p>'+esc(x.name)+' <strong class="amount">'+money(x.nextDeposit)+'</strong></p>').join('')+'<p>Cash '+money(d.cashDeposit)+'</p></div><div><h4>Ziel vollständig anpassen</h4>'+d.trades.map(x=>'<p>'+esc(x.name)+' <strong class="amount">'+money(x.delta)+'</strong></p>').join('')+'<small>'+esc(d.costStatus)+'</small></div></section>':'')+
  '<details><summary>Daten und Risiken prüfen</summary>'+rec.risks.map(x=>'<p>'+esc(x)+'</p>').join('')+(c?'<p>'+c.total+' Katalogeinträge · '+c.checked+' Kandidaten geprüft · '+c.usable+' mit verwendbaren Daten. Brokerabgleich '+(c.brokerMatched?'aktiv':'offen')+'.</p>':'')+(run.result.market||[]).map(m=>'<p>'+esc(m.name)+' · '+esc(m.indicators?.asOf||m.error||'')+' · Fundamentaldaten '+(m.fundamentals?'vorhanden':'fehlen')+'</p>').join('')+'</details>'+
  (outdated?'<div class="notice">Dein Anlageprofil wurde geändert. Starte eine neue Strategieprüfung.</div>':run.adopted_at?'<p>Diese Empfehlung wurde bereits als Ziel übernommen.</p>':'<form id="advisor-adopt" data-id="'+esc(run.id)+'" data-goal="'+esc(g.id)+'"><label class="checkbox"><input type="checkbox" required name="reviewed">Ich habe Wertpapiere, Gewichtung, Datenstand und Brokerverfügbarkeit geprüft.</label><button class="btn primary" '+(pending.has(key(g.id))?'disabled':'')+'>Diese Zusammensetzung als Ziel übernehmen</button></form>');
 }
 function page(){
  const s=state(),goals=s.strategies||[];let g=goals.find(g=>g.id===selected)||goals[0];selected=g?.id||'';
  const head='<div class="page-heading"><div><p class="eyebrow">VERMÖGEN BETREUEN</p><h1>Deine Anlagestrategien</h1><p>Ziel festlegen. Zusammensetzung prüfen. Bestand und nächste Einzahlung verfolgen.</p></div><button class="btn primary" data-design-start="">Anlageziel anlegen</button></div>';
  if(!g)return head+'<section class="advisor-empty card"><h2>Welches Vermögen möchtest du aufbauen?</h2><p>Lege ein Anlageziel mit Zeitraum, Sparrate und Risiko fest. Der Advisor ermittelt konkrete Aktien und ETFs und zeigt die vollständige Zusammensetzung vor der Übernahme.</p><button class="btn primary" data-design-start="">Erste Strategie anlegen</button></section>';
  const item=cache.get(key(g.id));
  if(!item&&cloud.session)void load(g.id);
  const data=item?.data,runs=data?.runs||[],latest=runs.find(r=>r.status==='completed'&&r.result?.recommendation&&r.mode==='advisor'),profile=data?.profile;
  const busy=pending.has(key(g.id)),next=profile?.next_due?new Date(profile.next_due).toLocaleString('de-DE'):'';
  return head+'<div class="advisor-layout"><aside class="strategy-list">'+goals.map(x=>button('select',esc(x.name),x.id,x.id===g.id)).join('')+'</aside><div class="strategy-workspace" data-wealth-tab="'+viewTab+'"><section class="strategy-hero"><div><h2>'+esc(g.name)+'</h2><p>'+({conservative:'Vorsichtig',balanced:'Ausgewogen',growth:'Wachstumsorientiert'}[g.risk]||'')+' · '+g.years+' Jahre · '+esc(g.selection==='etf'?'ETFs':g.selection==='core'?'ETF-Kern mit Einzelaktien':'Aktien und ETFs')+'</p></div><div><small>Sparrate</small><strong class="amount">'+money(g.rate)+'</strong></div><div><small>Ziel</small><strong class="amount">'+money(g.target)+'</strong></div><button class="btn" data-design-start="'+esc(g.id)+'">Anlageziel bearbeiten</button></section>'+
  '<div class="wealth-tabs">'+[['overview','Überblick'],['composition','Zusammensetzung'],['care','Betreuung']].map(([id,label])=>button('viewtab',label,id,id===viewTab)).join('')+'</div><section class="card map-panel">'+map(g)+'</section><section class="card holdings-panel">'+holdings(g)+(viewTab==='composition'&&latest&&!latest.adopted_at?'<h2>Vorgeschlagene Zusammensetzung</h2>'+recommended(g,latest):'')+'</section>'+
  '<section class="card recommendation-panel"><div class="card-title"><div><h2>Aktuelle Empfehlung</h2><p>'+esc(profile?.enabled?'Automatische Prüfung aktiviert · nächste Fälligkeit '+next:'Manuelle Prüfung')+'</p></div>'+button('refresh','Ergebnisse laden',g.id)+'</div>'+
  (busy?'<p role="status">Marktdaten und Zusammensetzung werden geprüft. Du kannst weiterarbeiten und das Ergebnis später laden.</p>':'')+
  (item?.status==='error'?'<div class="notice danger">'+esc(item.error)+'</div>':'')+
  (!cloud.session?'<p>Für die KI-Strategie unter Einstellungen mit Supabase anmelden und deinen Plan synchronisieren.</p><button class="btn" data-view="settings">Verbindung einrichten</button>':
  item?.status==='loading'?'<p role="status">Gespeicherte Empfehlungen werden geladen …</p>':
  latest?recommended(g,latest):'<div class="advisor-empty"><h3>Noch keine fertige Zusammensetzung</h3><p>Aktiviere die Analyse dieses Ziels und starte die erste Prüfung. Das Ergebnis zeigt die ausgewählten Wertpapiere mit Zielgewicht und Begründung.</p></div>')+
  (cloud.session?'<form id="advisor-run" data-id="'+esc(g.id)+'"><details '+(!profile?'open':'')+'><summary>Analyse und regelmäßige Betreuung</summary><label class="checkbox"><input type="checkbox" name="consent" required>Ich stimme der Analyse von Portfolio und Profil über OpenRouter zu. Marktanbieter erhalten die abgefragten Symbole. API-Kosten sind möglich.</label><label class="checkbox"><input type="checkbox" name="enabled" '+(profile?.enabled?'checked':'')+'>Automatisch alle '+g.interval+' Tage prüfen</label><button class="btn" name="operation" value="save">Betreuung speichern</button> <button class="btn primary" name="operation" value="run" '+(busy?'disabled':'')+'>Jetzt Strategie prüfen</button></details></form>':'')+'</section>'+
  '<details class="card care-panel"><summary>Prüfverlauf · '+runs.length+' Läufe</summary>'+runs.map(r=>'<div class="run-history"><strong>'+esc(r.created_at?.slice(0,16).replace('T',' '))+'</strong><span>'+esc(({completed:'Abgeschlossen',failed:'Fehlgeschlagen',running:'Läuft'})[r.status]||r.status)+'</span>'+(r.error?'<p class="negative">'+esc(r.error)+'</p>':'')+(r.result?button('history','Zusammensetzung ansehen',r.id):'')+'</div>').join('')+'</details>'+
  '<details class="card care-panel"><summary>Pie zuordnen und Sparrate planen</summary><form id="advisor-link" data-id="'+esc(g.id)+'"><label>Bestehender Pie<select name="pieId"><option value="">Keine Zuordnung</option>'+s.portfolio.assets.filter(a=>a.kind==='pie').map(a=>'<option value="'+esc(a.id)+'" '+(g.pieId===a.id?'selected':'')+'>'+esc(a.name)+'</option>').join('')+'</select></label><button class="btn">Zuordnen</button></form><button class="btn" data-plan="savings" data-id="'+esc(g.id)+'">Sparrate in Finanzplan übernehmen</button></details></div></div>';
 }
 async function click(t){
  const id=t.dataset.id;
  if(t.dataset.visual){highlight=id;viewTab='composition';render();return;}
  if(t.dataset.advisor==='viewtab'){viewTab=id;render();return;}
  if(t.dataset.advisor==='mapmode'){mapMode=mapMode==='class'?'positions':'class';highlight='';render();return;}
  if(t.dataset.advisor==='mapbasis'){mapBasis=mapBasis==='actual'?'target':'actual';render();return;}

  if(t.dataset.advisor==='select'){selected=id;render();}
  if(t.dataset.advisor==='refresh')await load(id);
  if(t.dataset.advisor==='history'){
   const g=state().strategies.find(g=>g.id===selected),run=cache.get(key(g.id))?.data?.runs.find(r=>r.id===id);if(run)ctx.modal('Empfehlung vom '+run.created_at.slice(0,10),recommended(g,run),true);
  }
  if(t.dataset.advisor==='funding'){
   const g=state().strategies.find(g=>g.id===id),p=state().portfolio,result=allocation(p,g.pieId,g.rate);
   ctx.modal('Nächste Sparrate · '+g.name,table(['Position','Jetzt einzahlen','Gewicht danach'],result.map(x=>'<tr>'+cell(esc(x.name))+cell(money(x.add))+cell(x.newWeight.toFixed(1)+' %')+'</tr>')),true);
  }
 }
 async function submit(f,operation){
  const id=f.dataset.goal||f.dataset.id,k=key(id);if(pending.has(k))return;
  if(f.id==='advisor-link'){const s=structuredClone(state()),g=s.strategies.find(g=>g.id===id);const pieId=new FormData(f).get('pieId');if(pieId&&s.strategies.some(x=>x.id!==id&&x.pieId===pieId))throw Error('Dieser Pie gehört bereits zu einer anderen Strategie.');g.pieId=pieId;commit(s);return;}
  const d=new FormData(f);pending.add(k);
  try{
   if(f.id==='advisor-run'){const old=state().strategies.find(g=>g.id===id);if(old&&!old.selection){const next=structuredClone(state());next.strategies.find(g=>g.id===id).selection='free';commit(next);}}
   await ensureCloud();
   if(f.id==='advisor-run'){
    if(!d.has('consent'))throw Error('Bitte die Einwilligung zur Analyse bestätigen.');
    await call({action:'save-profile',strategyId:id,enabled:d.has('enabled'),consent:d.has('consent')});
    if(operation==='run'){render();await call({action:'run',strategyId:id,requestId:crypto.randomUUID(),mode:'advisor',planRevision:revision()});}
   }else{
    const before=JSON.stringify(state()),g=state().strategies.find(g=>g.id===id);
    const res=await call({action:'adopt',runId:f.dataset.id,pieId:g.pieId||'',reviewed:d.has('reviewed'),planRevision:revision()});
    if(key(id)!==k)throw Error('Konto gewechselt. Ergebnis im ursprünglichen Konto laden.');applyCloud(res,before);ctx.close();
   }
   await load(id);
  }finally{pending.delete(k);if(key(id)===k)render();}
 }
 return {page,click,submit,selectGoal:id=>{selected=id;viewTab='overview';}};
}
