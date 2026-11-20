import {displayMonth} from './dates.js';
import {budgetLine,validatePlanning} from './planning.js';
import {emptyPortfolio,validatePortfolio,today} from './portfolio.js';
export const TYPES={income:'Einnahmen',expense:'Fixkosten',budget:'Budgets',investment:'Investments',reserve:'Rücklagen'};
export const FREQUENCIES={0:'Einmalig',1:'Monatlich',3:'Quartalsweise',6:'Halbjährlich',12:'Jährlich'};
export const uid=()=>crypto.randomUUID();
export const cents=x=>Math.round((Number(x)+Number.EPSILON)*100);
const moneyFormat=new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'});
const pctFormats=new Map();
export const money=x=>moneyFormat.format((x||0)/100);
export const pct=(x,digits=1)=>{let f=pctFormats.get(digits);if(!f){f=new Intl.NumberFormat('de-DE',{minimumFractionDigits:digits,maximumFractionDigits:digits});pctFormats.set(digits,f);}return f.format(x)+' %';};
export const monthIndex=m=>Number(m.slice(0,4))*12+Number(m.slice(5,7))-1;
export const monthAdd=(m,n)=>{const i=monthIndex(m)+n;return `${Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`;};
export const monthLabel=m=>displayMonth(m);
export const emptyState=()=>({schema:1,name:'Meine Finanzplanung',anchor:today().slice(0,7),openingCash:0,entries:[],reserves:[],actuals:{},notes:[],portfolio:emptyPortfolio(),updatedAt:new Date().toISOString()});
export const due=(e,m)=>e.start<=m&&(!e.end||m<=e.end)&&(m<e.start?false:e.interval?((monthIndex(m)-monthIndex(e.start))%e.interval+12)%e.interval===0:m===e.start);
export const dayDate=(m,day=1)=>{const max=new Date(+m.slice(0,4),+m.slice(5),0).getDate();return m+'-'+String(Math.max(1,Math.min(day,max))).padStart(2,'0');};
export const actualKey=(e,m)=>(e.items?e.id+'-'+dayDate(m,e.day):e.id)+':'+m;
export function monthly(e,m){return due(e,m)?(e.planOverrides?.[m]??e.amount):0;}
export function transactions(s,m){return s.entries.filter(e=>due(e,m)||Object.hasOwn(e.planOverrides||{},m)).map(e=>({entry:e,name:e.name,amount:e.planOverrides?.[m]??e.amount,type:e.type,reserveId:e.reserveId}));}
export function yearRows(s,year){const months=[];for(let i=0;i<12;i++){const m=year+'-'+String(i+1).padStart(2,'0');if(m>=s.anchor)months.push(m);}return months;}
export function budgetShare(s,m){const groups=new Map();for(const e of s.entries.filter(e=>e.type==='budget')){const g=budgetLine(e,m);if(g>0)groups.set(e.category||e.name,(groups.get(e.category||e.name)||0)+g);}return [...groups.entries()].map(([name,amount])=>({name,amount}));}
export function project(s,month,mode='mixed'){const out=[];let cash=s.openingCash,earmarked=s.openingCash;for(let i=0;i<600;i++){const m=monthAdd(s.anchor,i),tx=transactions(s,m),a=s.actuals[actualKey({id:'__month__'},'__never__')]&&null;
 const planned={income:0,expense:0,budget:0,investment:0,reserve:0},actual={income:0,expense:0,budget:0,investment:0,reserve:0};
 for(const t of tx){const key=actualKey(t.entry,m),saved=s.actuals[key];const value=mode!=='plan'&&saved&&!saved.pending?saved.amount:t.amount;if(mode==='actual'&&!saved)continue;planned[t.type]+=t.amount;actual[t.type]+=value;}
 const reserveMove=tx.filter(t=>t.type==='reserve').reduce((n,t)=>{const key=actualKey(t.entry,m),saved=s.actuals[key];return n+(mode!=='plan'&&saved&&!saved.pending?saved.amount:t.amount);},0);
 const bookedCash=Object.entries(s.actuals).filter(([k,v])=>k.endsWith(':'+m)&&!v.pending&&v.cash!==undefined).map(([k,v])=>v.cash);
 const budgetAdjust=(mode==='plan'?[]:budgetShare(s,m).map(g=>s.actuals['budget:'+g.name+':'+m]).filter(v=>v&&!v.pending).map((v,i)=>budgetShare(s,m)[i].amount-v.amount)).reduce((a,b)=>a+b,0);
 const flow=actual.income-actual.expense-actual.budget-actual.investment;
 const last=bookedCash.length&&m<=month?bookedCash.at(-1):cash+flow+(mode==='plan'?reserveMove:0);
 const free=last-(earmarked+=reserveMove);
 out.push({month:m,...planned,actual,income:mode==='plan'?planned.income:actual.income,expense:mode==='plan'?planned.expense:actual.expense,budget:mode==='plan'?planned.budget:actual.budget+budgetAdjust,investment:mode==='plan'?planned.investment:actual.investment,reserveMove,earmarked,cash:last,free});
 if(m===month)break;cash=last;}
 return out;}
export function validateState(s){
 if(!s||s.schema!==1||typeof s.name!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(s.anchor)||!Number.isInteger(s.openingCash)||!Array.isArray(s.entries)||!Array.isArray(s.reserves)||!s.actuals||typeof s.actuals!=='object')throw Error('Planformat ungültig.');
 if(s.openingCash<-100000000000)throw Error('Anfangsguthaben zu klein.');
 const ids=new Set(),rs=new Set(s.reserves.map(r=>r.id));
 for(const r of s.reserves)if(typeof r.id!=='string'||typeof r.name!=='string'||!r.name.trim()||!Number.isInteger(r.target)||r.target<0)throw Error('Ungültige Rücklage: '+(r.name||'?'));
 const amount=n=>Number.isInteger(n)&&n>=0&&n<=100000000000;
 for(const e of s.entries){if(typeof e.id!=='string'||ids.has(e.id)||!Object.hasOwn(TYPES,e.type)||typeof e.name!=='string'||!e.name.trim())throw Error('Ungültiger Eintrag: '+(e.name||'?'));if(e.type==='reserve'&&!e.reserveId)throw Error('Rücklagenraten benötigen eine verknüpfte Rücklage. Lege zuerst eine Rücklage an.');if(!amount(e.amount)||!Number.isInteger(e.interval)||!Object.hasOwn(FREQUENCIES,e.interval)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(e.start)||e.start<s.anchor||e.end&&(!/^\d{4}-(0[1-9]|1[0-2])$/.test(e.end)||e.end<e.start)||!Number.isInteger(e.day)||e.day<1||e.day>31||e.reserveId&&!rs.has(e.reserveId))throw Error('Ungültiger Eintrag: '+(e.name||'?'));ids.add(e.id);}
 for(const [k,v] of Object.entries(s.actuals)){const id=k.split(':')[0];if(typeof v!=='object'||!amount(v.amount))throw Error('Ungültige Ist-Buchung.');}
 validatePlanning(s);validatePortfolio(s.portfolio,s.entries);return true;
}
