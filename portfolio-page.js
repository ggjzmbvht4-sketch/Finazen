import {CLASS_COLORS,treemapHTML,historyChart} from './wealth-visuals.js';
import {money} from './engine.js';
import {assetTotals,portfolioSummary,latestQuote,today} from './portfolio.js';
import {holdingAt} from './trading.js';
export function portfolioPage(ctx){
 const {state,esc}=ctx;
 let search='',mapMode='pies',highlight='';
 function row(a,parent=''){
  const p=state().portfolio,t=assetTotals(p,a.id),i=p.instruments.find(i=>i.id===a.instrumentId),q=latestQuote(p,a),n=i?holdingAt(p,a,today()):null;
  return '<tr data-highlight="'+(a.id===highlight||a.parentId===highlight||a.kind===highlight)+'"><td><button class="position-link" data-pf="detail" data-id="'+esc(a.id)+'">'+esc(a.name)+'</button><small>'+esc(i?[i.isin,i.symbol,i.currency].filter(Boolean).join(' · '):parent||a.provider)+'</small></td><td class="amount">'+(i?(n===null?'Ungeklärt':esc(n)):'–')+'</td><td class="amount">'+(t.known?money(t.value):'Wert fehlt')+'</td><td class="amount">'+(t.gain===null?'Kostenbasis offen':money(t.gain))+'</td><td>'+esc(q?.asOf||'–')+'</td><td>'+(i?'<button class="btn small" data-pf="buy" data-id="'+esc(a.id)+'">Kauf eintragen</button>':'')+' <button class="text-btn" data-pf="detail" data-id="'+esc(a.id)+'">Verwalten</button></td></tr>';
 }
 const table=rows=>'<div class="table-scroll"><table class="advisor-table"><thead><tr><th>Position</th><th>Stück</th><th>Wert EUR</th><th>Ergebnis EUR</th><th>Wertstand</th><th>Aktion</th></tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
 function page(){
  const p=state().portfolio,s=portfolioSummary(p),includes=a=>[a.name,a.provider,p.instruments.find(i=>i.id===a.instrumentId)?.isin].join(' ').toLowerCase().includes(search.toLowerCase());
  const pies=p.assets.filter(a=>a.kind==='pie'&&(includes(a)||p.assets.some(c=>c.parentId===a.id&&includes(c))));
  const roots=p.assets.filter(a=>!a.parentId&&a.kind!=='pie'&&includes(a));
  let mapItems=s.roots.map(r=>({id:r.asset.id,name:r.asset.name,value:r.known?r.value:0,color:CLASS_COLORS[r.asset.kind]||'#7f9090'}));
  if(mapMode==='class'){
   const groups=new Map();for(const a of p.assets.filter(a=>a.kind!=='pie')){const t=assetTotals(p,a.id),group=groups.get(a.kind)||{id:a.kind,name:({stock:'Aktien',etf:'ETFs',bond:'Anleihen',cash:'Liquidität',private:'Beteiligungen',fund:'Fonds',alternative:'Weitere Anlagen'})[a.kind]||a.kind,value:0,color:CLASS_COLORS[a.kind]||'#7f9090'};group.value+=t.known?t.value:0;groups.set(a.kind,group);}mapItems=[...groups.values()];
  }

  return '<div class="page-heading"><div><p class="eyebrow">DEIN VERMÖGEN</p><h1>Portfolio</h1><p>Jeder Pie mit seinen enthaltenen Positionen. Bestände aus allen Anbietern zusammen.</p></div><div class="actions"><button class="btn" data-desk="performance">Performance vergleichen</button><button class="btn primary" data-pf="trade-choose">Kauf oder Verkauf eintragen</button></div></div>'+
  '<section class="card portfolio-graph"><div class="card-title"><div><h2>Deine Vermögensentwicklung</h2><p>Gespeicherte Depotwerte · einschließlich Einzahlungen und damaliger Schätzwerte</p></div><button class="btn" data-pf="snapshot">Tagesstand speichern</button></div>'+historyChart([...p.snapshots].sort((a,b)=>a.date.localeCompare(b.date)),v=>new Intl.NumberFormat('de-DE',{notation:'compact'}).format(v)+' €')+'</section><div class="overview-metrics"><div><small>Erfasster Depotwert</small><strong class="amount">'+money(s.value)+'</strong></div><div><small>Positionen ohne Wert</small><strong>'+s.unvalued+'</strong></div><div><small>Geschätzte Werte</small><strong class="amount">'+money(s.estimatedValue)+'</strong></div><div><small>Veraltete Werte</small><strong>'+s.stale+'</strong></div></div>'+
  '<div class="section-toolbar"><label class="portfolio-search-label">Position suchen<input id="portfolio-v9-search" type="search" placeholder="Name, ISIN oder Anbieter" value="'+esc(search)+'"></label><div class="actions"><button class="btn" data-pf="add">Investment anlegen</button><button class="btn" data-pf="prices">Kurse aktualisieren</button><button class="btn" data-pf="reports">Beteiligungsberichte</button></div></div>'+
  pies.map(a=>{const t=assetTotals(p,a.id),children=p.assets.filter(c=>c.parentId===a.id);return '<section class="card pie-expanded"><div class="card-title"><div><span class="eyebrow">'+esc(a.provider||'Pie')+'</span><h2>'+esc(a.name)+'</h2><p>'+children.length+' enthaltene Positionen · Zielgewichte '+(children.reduce((n,c)=>n+c.targetBps,0)/100)+' %</p></div><div><strong class="amount">'+money(t.value)+(t.known?'':' · Teilwert')+'</strong><button class="btn" data-pf="detail" data-id="'+esc(a.id)+'">Zusammensetzung bearbeiten</button></div></div>'+table(children.map(c=>row(c,a.name)))+(!children.length?'<p>Dieser Pie enthält noch keine Positionen. Unter Zusammensetzung bearbeiten Wertpapiere ergänzen oder eine Advisor-Empfehlung übernehmen.</p>':'')+'</section>';}).join('')+
  '<section class="card"><div class="card-title"><h2>Aktuelle Gewichtung</h2><button class="btn" data-portfolio-map="switch">'+(mapMode==='pies'?'Nach Anlageklassen':'Nach Pies und Anlagen')+'</button></div>'+treemapHTML(mapItems,esc,'portfolio-tile')+'<p>Flächen entsprechen erfassten, vollständig bewerteten Positionen. Fehlende Bewertungen sind nicht enthalten.</p></section>'+
  (roots.length?'<section class="card"><h2>Weitere Anlagen und Beteiligungen</h2>'+table(roots.map(a=>row(a)))+'</section>':'')+
  (!p.assets.length?'<section class="card advisor-empty"><h2>Dein erster Bestand</h2><p>Erfasse einen ausgeführten Kauf oder lege einen bestehenden Pie mit seinen Positionen an.</p><button class="btn primary" data-pf="add">Bestand anlegen</button></section>':'');
 }
 function input(e){if(e.target.id!=='portfolio-v9-search')return false;search=e.target.value;ctx.render();const node=document.getElementById('portfolio-v9-search');node?.focus();return true;}
 function click(t){if(t.dataset.portfolioMap){mapMode=mapMode==='pies'?'class':'pies';highlight='';}else highlight=t.dataset.id;ctx.render();}
 return {page,input,click};
}
