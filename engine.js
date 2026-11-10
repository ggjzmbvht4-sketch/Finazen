import {budgetLine,validatePlanning} from './planning.js';
import {emptyPortfolio,validatePortfolio} from './portfolio.js';
export const TYPES={income:'Einnahmen',expense:'Fixkosten',budget:'Budgets',investment:'Investments',reserve:'Rücklagen'};
export const FREQUENCIES={0:'Einmalig',1:'Monatlich',3:'Quartalsweise',6:'Halbjährlich',12:'Jährlich'};
export const uid=()=>crypto.randomUUID();
export const cents=x=>Math.round(Number(x)*100);
export const money=x=>new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format((x||0)/100);
export const monthIndex=m=>Number(m.slice(0,4))*12+Number(m.slice(5,7))-1;
export const monthAdd=(m,n)=>{const i=monthIndex(m)+n;return `${Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`;};
export const monthLabel=m=>new Date(m+'-15T12:00:00').toLocaleDateString('de-DE',{month:'long',year:'numeric'});
export const emptyState=()=>({schema:1,name:'Meine Finanzplanung',anchor:new Date().toISOString().slice(0,7),openingCash:0,entries:[],reserves:[],actuals:{},notes:[],portfolio:emptyPortfolio(),updatedAt:new Date().toISOString()});
export function due(e,m){const d=monthIndex(m)-monthIndex(e.start);return !e.pending&&d>=0&&(!e.end||m<=e.end)&&(e.interval===0?d===0:d%e.interval===0);}
export function dayDate(e,m){const last=new Date(Number(m.slice(0,4)),Number(m.slice(5,7)),0).getDate();return `${m}-${String(Math.min(e.day||1,last)).padStart(2,'0')}`;}
export function transactions(state,m,mode='forecast',scenario={}){
 return state.entries.filter(e=>(!e.pending&&(due(e,m)||Object.hasOwn(e.planOverrides||{},m)))||(mode!=='plan'&&Object.hasOwn(state.actuals,`${e.id}:${m}`))).map(e=>{const a=state.actuals[`${e.id}:${m}`];const planned=e.pending?0:(e.planOverrides?.[m]??(due(e,m)?e.amount:0));const amount=mode==='actual'?(a?.amount??0):mode==='forecast'&&a?a.amount:planned;return {...e,date:dayDate(e,m),planned,amount,booked:!!a,actual:a?.amount??null};}).sort((a,b)=>a.date.localeCompare(b.date)||a.name.localeCompare(b.name));
}
export function project(state,until,mode='forecast',scenario={}){
 if(monthIndex(until)-monthIndex(state.anchor)>600)throw Error('Maximal 50 Jahre planen.');
 const rows=[];let previousHeld=0;let carries={};let cash=state.openingCash;let balances=Object.fromEntries(state.reserves.map(r=>[r.id,r.opening||0]));
 for(let m=state.anchor;m<=until;m=monthAdd(m,1)){
  const tx=transactions(state,m,mode,scenario);const totals=Object.fromEntries(Object.keys(TYPES).map(k=>[k,0]));
  const envelopes={},movedByBudget=new Map();let held=0;
  for(const t of tx)if(t.type==='reserve'&&t.budgetSource)movedByBudget.set(t.budgetSource,(movedByBudget.get(t.budgetSource)||0)+t.amount);
  for(const t of tx.filter(t=>t.type==='budget')){
   const moved=movedByBudget.get(t.id)||0;
   const line=budgetLine(state,t,m,t.planned-moved,carries[t.id]||0);
   if(mode==='plan')t.amount-=moved;
   envelopes[t.id]=line;
   if(mode==='forecast'){t.amount=line.forecast;held+=line.leftover;}
   if(mode!=='plan'){t.envelope=true;t.items=state.actuals[t.id+':'+m]?.items?.filter(x=>mode!=='actual'||!x.pending);}
   if(mode!=='plan')carries[t.id]=line.leftover;
  }
  for(const id of Object.keys(carries))if(!envelopes[id]){delete carries[id];}
  for(const t of tx)totals[t.type]+=t.amount;
  for(const type of ['income','expense','investment'])totals[type]=Math.max(0,totals[type]+(scenario[type]||0));
  const startCash=cash,startReserve=Object.values(balances).reduce((a,b)=>a+b,0);let released=0;
  // Reserve contributions are transfers within cash, never expenses.
  for(const t of tx.filter(t=>t.type==='reserve'))if(t.reserveId in balances)balances[t.reserveId]+=t.amount;
  for(const t of tx.filter(t=>t.type==='expense'&&t.reserveId)){const release=Math.min(balances[t.reserveId]||0,t.amount);balances[t.reserveId]=(balances[t.reserveId]||0)-release;released+=release;}
  const delta=totals.income-totals.expense-totals.budget-totals.investment;cash+=delta;
  const earmarked=Object.values(balances).reduce((a,b)=>a+b,0);
  rows.push({month:m,tx,...totals,startCash,cash,earmarked,balances:{...balances},envelopes,budgetHeld:held,released,delta,free:cash-earmarked-held,freeDelta:delta-(earmarked-startReserve)-(held-previousHeld),out:totals.expense+totals.budget,booked:tx.filter(t=>t.booked).length});previousHeld=held;
 }return rows;
}
export function yearRows(state,year,mode='forecast',scenario={}){return project(state,`${year}-12`,mode,scenario).filter(r=>r.month.startsWith(String(year)));}
export function validateState(s){
 if(!s||s.schema!==1||!/^\d{4}-(0[1-9]|1[0-2])$/.test(s.anchor)||!Number.isSafeInteger(s.openingCash)||Math.abs(s.openingCash)>1e14||!Array.isArray(s.entries)||s.entries.length>10000||!Array.isArray(s.reserves)||!s.actuals||typeof s.actuals!=='object'||Array.isArray(s.actuals))throw Error('Ungültige Planungsdatei.');
 const ids=new Set(),rs=new Set();const amount=x=>Number.isSafeInteger(x)&&x>=0&&x<=1e14;
 if(typeof s.name!=='string'||s.notes&&(!Array.isArray(s.notes)||s.notes.length>100||s.notes.some(n=>typeof n!=='string')))throw Error('Ungültige Planungsinformationen.');
 for(const r of s.reserves){if(typeof r.id!=='string'||rs.has(r.id)||typeof r.name!=='string'||!r.name.trim()||!amount(r.opening)||!amount(r.target))throw Error('Ungültige Rücklage.');rs.add(r.id);}
 for(const e of s.entries){if(typeof e.id!=='string'||ids.has(e.id)||!Object.hasOwn(TYPES,e.type)||typeof e.name!=='string'||!e.name.trim()||!amount(e.amount)||!Number.isInteger(e.interval)||!Object.hasOwn(FREQUENCIES,e.interval)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(e.start)||e.start<s.anchor||e.end&&(!/^\d{4}-(0[1-9]|1[0-2])$/.test(e.end)||e.end<e.start)||!Number.isInteger(e.day)||e.day<1||e.day>31||e.reserveId&&!rs.has(e.reserveId)||e.type==='reserve'&&!e.reserveId)throw Error('Ungültiger Eintrag: '+(e.name||'?'));ids.add(e.id);}
 for(const [key,a]of Object.entries(s.actuals)){const split=key.lastIndexOf(':');if(!ids.has(key.slice(0,split))||!/^\d{4}-(0[1-9]|1[0-2])$/.test(key.slice(split+1))||!amount(a?.amount))throw Error('Ungültige Ist-Buchung.');}
 if(s.portfolio===undefined)s.portfolio=emptyPortfolio();validatePortfolio(s.portfolio,s.entries);
 for(const e of s.entries)for(const [m,v] of Object.entries(e.planOverrides||{}))if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)||m<s.anchor||!Number.isSafeInteger(v)||v<0)throw Error('Monatsplan prüfen.');
 validatePlanning(s);return s;
}
export function sampleState(){const s=emptyState();s.anchor='2026-01';s.openingCash=450000;const r={id:uid(),name:'Jahresrechnungen',opening:30000,target:120000};s.reserves=[r];
 const add=(type,name,amount,interval=1,start='2026-01',extra={})=>s.entries.push({id:uid(),type,name,amount:cents(amount),interval,start,end:'',day:1,note:'Fiktives Beispiel',reserveId:'',...extra});
 add('income','Nettogehalt',3100);add('income','Sonderzahlung',1800,0,'2026-11');add('expense','Miete',750);add('expense','Mobilfunk & Internet',50);add('expense','Mobilität',400);add('budget','Lebensmittel',280);add('budget','Freizeit',180);add('investment','ETF-Sparplan',300);add('reserve','Jahresrechnungen',100,1,'2026-01',{reserveId:r.id});add('expense','Jährliche Versicherung',600,12,'2026-12',{reserveId:r.id});return s;}
