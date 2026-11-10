import {historicalPortfolio} from './history.js';
import {money,cents,yearRows,monthAdd,uid,project} from './engine.js';
import {planEdit,stages,comparePortfolio} from './desktop-core.js';
export function desktop(ctx){
 const {state,month,esc,modal,close,commit,entryForm,go}=ctx;
 const btn=(action,label,id='')=>`<button class="btn" data-desk="${action}" data-id="${esc(id)}">${label}</button>`;
 const field=(n,label,v='',type='number',more='')=>`<label>${label}<input name="${n}" type="${type}" value="${esc(v)}" ${more}></label>`;
 const select=(n,label,options,value)=>`<label>${label}<select name="${n}">${options.map(([k,v])=>`<option value="${k}" ${k===value?'selected':''}>${v}</option>`).join('')}</select></label>`;
 const form=(id,title,body,label='Speichern',data='')=>modal(title,`<form id="desk-${id}" data-id="${esc(data)}">${body}<button class="btn primary">${label}</button></form>`,true);
 let editBase='',benchmark=[];
 const pref=()=>{try{return JSON.parse(localStorage.getItem('kontur-appearance')||'{}');}catch{return {};}};
 function apply(){
  const p=pref(),dark=p.theme==='dark'||(!p.theme||p.theme==='system')&&matchMedia('(prefers-color-scheme:dark)').matches;
  document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.dataset.density=p.density||'comfortable';document.documentElement.dataset.contrast=p.contrast||'normal';document.documentElement.dataset.hide=p.hide?'yes':'no';
  document.documentElement.style.setProperty('--accent',{green:'#17664d',blue:'#245bba',violet:'#7050b2',petrol:'#156b79'}[p.color]||'#17664d');
  document.documentElement.style.setProperty('--user-size',(p.size||14)+'px');
 }
 apply();matchMedia('(prefers-color-scheme:dark)').addEventListener('change',apply);
 function settings(){
  const p=pref();return `<section class="card"><h2>Darstellung und Start</h2><form id="desk-preferences"><div class="form-grid">${select('theme','Darstellung',[['system','System'],['light','Hell'],['dark','Dunkel']],p.theme||'system')}${select('color','Akzentfarbe',[['green','Salbei'],['blue','Blau'],['violet','Violett'],['petrol','Petrol']],p.color||'green')}${select('density','Zeilenabstand',[['comfortable','Großzügig'],['compact','Kompakt']],p.density||'comfortable')}${select('contrast','Kontrast',[['normal','Standard'],['high','Hoch']],p.contrast||'normal')}${select('size','Schriftgröße',[['14','14 px'],['16','16 px'],['18','18 px']],String(p.size||14))}${select('start','Startansicht',[['home','Übersicht'],['reserves','Jahresplanung'],['investments','Portfolio'],['wealth','Advisor']],p.start||'home')}</div><label class="checkbox"><input name="hide" type="checkbox" ${p.hide?'checked':''}>Geldbeträge verdecken</label><button class="btn primary">Darstellung speichern</button></form><p>Diese Auswahl gilt für diesen Browser.</p></section>`;
 }
 function matrix(){
  const s=state(),rows=yearRows(s,month().slice(0,4),'forecast'),plan=yearRows(s,month().slice(0,4),'plan');
  const total=(name,fn,endBalance=false)=>`<tr class="matrix-total"><th>${name}</th>${rows.map(r=>`<td class="amount">${money(fn(r))}</td>`).join('')}<td class="amount">${money(endBalance?fn(rows.at(-1)||{}):rows.reduce((n,r)=>n+fn(r),0))}</td></tr>`;
  const group=(title,filter)=>`<tr class="matrix-group"><th colspan="${rows.length+2}">${title}</th></tr>`+s.entries.filter(filter).map(e=>`<tr><th><button data-edit="${esc(e.id)}">${esc(e.name)}</button><small>${e.interval===12?'jährlich · '+money(Math.round(e.amount/12))+'/Monat':e.interval===3?'quartalsweise · '+money(Math.round(e.amount/3))+'/Monat':''}</small></th>${rows.map((r,j)=>{const t=r.tx.find(t=>t.id===e.id),v=plan[j]?.tx.find(t=>t.id===e.id)?.planned||0;return `<td><button class="cell amount" data-desk="cell" data-id="${esc(e.id)}" data-month="${r.month}">${money(t?.amount||0)}${t?.booked?'<small>Ist · Plan '+money(v)+'</small>':''}</button></td>`;}).join('')}<td class="amount">${money(rows.reduce((n,r)=>n+(r.tx.find(t=>t.id===e.id)?.amount||0),0))}</td></tr>`).join('');
  return `<div class="page-heading"><div><h1>Dein Finanzplan ${month().slice(0,4)}</h1><p>Monatsbeträge direkt bearbeiten. Ist-Buchungen ersetzen die Prognose.</p></div><div class="actions">${btn('prev-year','‹ Jahr')}${btn('next-year','Jahr ›')}${btn('new','Planzeile ergänzen')}${btn('salary','Gehalt und Sonderzahlung')}${btn('details','Budgets und Rücklagen')}</div></div><div class="matrix-wrap"><table class="matrix"><thead><tr><th>Planposition</th>${rows.map(r=>'<th>'+r.month+'</th>').join('')}<th>Jahr</th></tr></thead><tbody>`+
  group('Einkommen',e=>e.type==='income')+group('Fixkosten und Jahresrechnungen',e=>e.type==='expense')+group('Rücklagen bilden',e=>e.type==='reserve')+group('Budgets',e=>e.type==='budget')+total('Überschuss 1',r=>stages(r).first)+group('Laufende Investments',e=>e.type==='investment'&&e.interval!==0)+total('Überschuss 2',r=>stages(r).second)+group('Einmalanlagen',e=>e.type==='investment'&&e.interval===0)+total('Überschuss 3',r=>stages(r).third)+total('Freie Liquidität am Monatsende',r=>r.free,true)+total('Reserviert',r=>r.earmarked,true)+`</tbody></table></div><p>Die Jahresspalte der Kontostände zeigt den Jahresendstand. Rücklagenentnahmen sind in den Überschüssen berücksichtigt.</p>`;
 }
 function chart(result){
  const max=Math.max(...result.snaps.map(s=>s.value),result.benchmark||0,1),points=result.snaps.map((s,i)=>(30+i*940/(result.snaps.length-1))+','+(210-s.value/max*180)).join(' ');
  return `<svg viewBox="0 0 1000 240" role="img" aria-label="Gespeicherte Depotstände im Vergleichszeitraum"><polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="3"/>${result.benchmark===null?'':`<line x1="30" y1="${210-result.first.value/max*180}" x2="970" y2="${210-result.benchmark/max*180}" stroke="#b48542" stroke-width="2" stroke-dasharray="7 5"/>`}<text x="30" y="235" fill="currentColor">${result.first.date}</text><text x="850" y="235" fill="currentColor">${result.last.date}</text></svg>`;
 }
 function perf(){
  const s=state();form('performance','Gesamtportfolio vergleichen',field('from','Von',s.portfolio.snapshots[0]?.date||s.anchor+'-01','date','required')+field('to','Bis',new Date().toISOString().slice(0,10),'date','required')+select('source','Bewertungsgrundlage',[['snapshots','Gespeicherte Gesamtdepotstände'],['history','Aus datierten Kursen und Buchungen rekonstruieren']],'snapshots')+select('scope','Vergleichsumfang',[['all','Gesamtportfolio'],['liquid','Ohne private Beteiligungen'],...Array.from(new Set(s.portfolio.assets.filter(a=>a.kind!=='pie').map(a=>a.provider).filter(Boolean))).map(name=>['provider:'+esc(name),esc(name)])],'all')+field('file','Benchmark CSV · optional','','file','accept=".csv"')+'<p>Benchmark-Datei mit Kopfzeile date,level und bereinigten Total-Return-Indexständen. Für Start, Ende und jeden Zahlungsstrom wird ein Stand benötigt. Die Benchmark wird mit denselben Zahlungsströmen berechnet.</p>','Vergleichen');
 }
 async function click(t){
  const a=t.dataset.desk,id=t.dataset.id,s=state();
  if(a==='new'){entryForm();return;}
  if(a==='prev-year'||a==='next-year'){ctx.setMonth(monthAdd(month(),a==='prev-year'?-12:12));return;}
  if(a==='details'){go('plan-details');return;}
  if(a==='performance'){perf();return;}
  if(a==='cell'){
   const e=s.entries.find(e=>e.id===id),m=t.dataset.month,value=e.planOverrides?.[m]??e.amount;editBase=JSON.stringify(s);
   form('cell',e.name+' · '+m,field('month','Ab Monat',m,'month','readonly required')+field('amount','Planbetrag in €',value/100,'number','min="0" step="0.01" required')+select('scope','Gültigkeit',[['month','Nur diesen Monat'],['future','Ab diesem Monat'],['range','Bis einschließlich …']],'month')+field('end','Bis Monat',m,'month')+'<p id="cell-preview" aria-live="polite"></p>','Plan ändern',id);return;
  }
  if(a==='salary')form('salary','Einkommen planen',field('name','Bezeichnung','Grundentgelt','text','required')+field('gross','Brutto in €','','number','min="0" step="0.01" required')+field('ratio','Eigene Nettoquote (%)','65','number','min="0" max="100" step="0.01" required')+field('start','Ab Monat',month(),'month','required')+select('interval','Zahlung',[['1','Monatlich'],['0','Einmalig'],['12','Jährliche Sonderzahlung']],'1')+field('day','Zahlungstag','28','number','min="1" max="31" required'),'Einnahme ergänzen');
 }
 function readEdit(f){const d=new FormData(f);return planEdit(state(),f.dataset.id,d.get('month'),cents(d.get('amount')),d.get('scope'),d.get('end'));}
 function preview(f){
  if(f.id!=='desk-cell')return;
  try{const d=new FormData(f),s=readEdit(f),r=project(s,d.get('month')).at(-1),end=project(s,d.get('month').slice(0,4)+'-12').at(-1),v=stages(r);f.querySelector('#cell-preview').textContent='Vorschau · Überschuss 1 '+money(v.first)+' · 2 '+money(v.second)+' · 3 '+money(v.third)+' · frei Ende Jahr '+money(end.free);}catch(e){f.querySelector('#cell-preview').textContent=e.message;}
 }
 async function submit(f){
  const d=new FormData(f);
  if(f.id==='desk-preferences'){localStorage.setItem('kontur-appearance',JSON.stringify(Object.fromEntries(d)));apply();return;}
  if(f.id==='desk-cell'){if(editBase!==JSON.stringify(state()))throw Error('Plan geändert. Zelle erneut öffnen.');commit(readEdit(f));close();}
  if(f.id==='desk-salary'){
   const s=structuredClone(state()),amount=cents(Number(d.get('gross'))*Number(d.get('ratio'))/100);
   s.entries.push({id:uid(),type:'income',name:String(d.get('name')),amount,start:d.get('start'),end:'',interval:Number(d.get('interval')),day:Number(d.get('day')),reserveId:'',note:'Brutto '+d.get('gross')+' € · eigene Nettoquote '+d.get('ratio')+' %'});commit(s);close();
  }
  if(f.id==='desk-performance'){
   const file=d.get('file');benchmark=[];
   if(file?.size){if(file.size>1000000)throw Error('Datei maximal 1 MB.');const text=await file.text(),lines=text.trim().split(/\r?\n/);if(!/^date[,;]level$/i.test(lines.shift().trim()))throw Error('Kopfzeile date,level erforderlich.');benchmark=lines.map(l=>{const [date,level]=l.split(/[,;]/);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!(Number(level)>0))throw Error('Benchmarkzeile prüfen.');return {date,level:Number(level)};});}
   let portfolio=state().portfolio;
   if(d.get('source')==='history'||d.get('scope')!=='all'){
    portfolio=structuredClone(portfolio);const scope=d.get('scope');
    const leaves=portfolio.assets.filter(a=>a.kind!=='pie'&&(scope==='all'||scope==='liquid'&&a.kind!=='private'||scope.startsWith('provider:')&&a.provider===scope.slice(9)));
    const ids=new Set(leaves.map(a=>a.id));portfolio.assets=portfolio.assets.filter(a=>ids.has(a.id)||a.kind==='pie'&&leaves.some(l=>l.parentId===a.id));portfolio.events=portfolio.events.filter(e=>ids.has(e.assetId));
    const days=Math.ceil((Date.now()-Date.parse(d.get('from')))/86400000)+2;if(days>1800||days<1)throw Error('Rekonstruktion unterstützt die letzten 1800 Tage.');
    const history=historicalPortfolio(portfolio,days);
    portfolio.snapshots=history.filter(x=>x.known).map(x=>({...x,costKnown:true,contribution:portfolio.events.filter(e=>e.date<=x.date&&e.type==='contribution').reduce((n,e)=>n+e.amount,0)}));
   }
   const r=comparePortfolio(portfolio,d.get('from'),d.get('to'),benchmark),row=(n,v)=>'<div class="reserve-detail"><span>'+n+'</span><strong class="amount">'+v+'</strong></div>';
   modal('Performance · '+r.first.date+' bis '+r.last.date,chart(r)+row('Eigene Nettoeinzahlungen',money(r.net))+row('Anlageergebnis',money(r.gain))+row(r.exact?'Zeitgewichtete Rendite':'Zeitgewichtete Näherung · Modified Dietz',r.returnPct===null?'Nicht berechenbar':r.returnPct.toFixed(2)+' %')+row('Persönliche Rendite · XIRR p. a.',r.xirr===null?'Nicht eindeutig berechenbar':(r.xirr*100).toFixed(2)+' %')+row('Benchmark-Endvermögen mit denselben Zahlungsströmen',r.benchmark===null?'Passende Benchmarkstände fehlen':money(r.benchmark))+row('Portfolio minus Benchmark',r.benchmark===null?'–':money(r.last.value-r.benchmark))+'<p>Linie grün · gespeicherte Gesamtdepotwerte einschließlich damaliger Schätzwerte. Gestrichelte Verbindung · Benchmark-Start und -Ende. Keine interpolierten Benchmarkkurse. Für eine exakte zeitgewichtete Rendite sind Bewertungen an jedem Zahlungszeitpunkt nötig.</p>',true);
  }
 }
 return {matrix,settings,click,submit,preview,start:pref().start||'home'};
}
