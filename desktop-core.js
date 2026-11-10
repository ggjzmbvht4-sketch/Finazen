import {monthAdd,due,project} from './engine.js';
export function planEdit(state,id,month,value,scope,end=month){
 if(!Number.isSafeInteger(value)||value<0)throw Error('Betrag prüfen.');
 const s=structuredClone(state),e=s.entries.find(e=>e.id===id);if(!e)throw Error('Eintrag fehlt.');
 if(scope==='future')end=monthAdd(s.anchor,599);
 if(end<month||end>monthAdd(s.anchor,599))throw Error('Zeitraum prüfen.');
 e.planOverrides||={};
 for(let m=month;m<=end;m=monthAdd(m,1))if(m===month||due(e,m)||Object.hasOwn(e.planOverrides,m))e.planOverrides[m]=value;
 return s;
}
export function stages(r){
 const recurring=r.tx.filter(t=>t.type==='investment'&&t.interval!==0).reduce((n,t)=>n+t.amount,0);
 const once=r.investment-recurring;
 const first=r.income-r.expense-r.budget-r.reserve+r.released;
 return {first,second:first-recurring,third:first-recurring-once,recurring,once};
}
export function irr(flows){
 if(!flows.some(f=>f.amount<0)||!flows.some(f=>f.amount>0))return null;
 const start=Date.parse(flows[0].date),npv=r=>flows.reduce((n,f)=>n+f.amount/((1+r)**((Date.parse(f.date)-start)/31557600000)),0);
 let low=-0.9999,high=1;while(npv(low)*npv(high)>0&&high<1e6)high=high*2+1;
 if(npv(low)*npv(high)>0)return null;
 for(let i=0;i<160;i++){const mid=(low+high)/2;if(npv(low)*npv(mid)>0)low=mid;else high=mid;}
 return (low+high)/2;
}
export function comparePortfolio(p,from,to,levels=[]){
 const snaps=p.snapshots.filter(x=>x.date>=from&&x.date<=to).sort((a,b)=>a.date.localeCompare(b.date));
 if(snaps.length<2)throw Error('Mindestens zwei gespeicherte Tagesstände im Zeitraum erforderlich.');
 const first=snaps[0],last=snaps.at(-1),events=p.events.filter(e=>e.date>first.date&&e.date<=last.date);
 for(const s of snaps)for(const type of ['contribution','withdrawal','distribution','fee']){
  const sum=p.events.filter(e=>e.date<=s.date).reduce((n,e)=>n+(e.type===type?e.amount:0)+(type==='fee'?(e.feeAmount||0):0),0);
  if(s[type]!==sum)throw Error('Buchungen wurden nach einem Tagesstand verändert. Tagesstände prüfen.');
 }
 const cashflow=e=>{
  if(e.linkedTradeId||e.cashAssetId)return 0;
  if(e.type==='contribution')return e.amount+(e.feeAmount||0);
  if(e.type==='withdrawal')return -e.amount+(e.feeAmount||0);
  if(e.type==='distribution')return -e.amount;
  if(e.type==='fee')return e.amount;
  return 0;
 };
 const flows=events.filter(e=>cashflow(e)).map(e=>({date:e.date,amount:cashflow(e)})),net=flows.reduce((n,e)=>n+e.amount,0);
 const xirr=irr([{date:first.date,amount:-first.value},...flows.map(f=>({...f,amount:-f.amount})),{date:last.date,amount:last.value}]);
 let factor=1,exact=true;
 for(let i=1;i<snaps.length;i++){
  const a=snaps[i-1],b=snaps[i],f=flows.filter(f=>f.date>a.date&&f.date<=b.date),weighted=f.reduce((n,x)=>n+x.amount*(Date.parse(b.date)-Date.parse(x.date))/(Date.parse(b.date)-Date.parse(a.date)),0),sum=f.reduce((n,x)=>n+x.amount,0),den=a.value+weighted;
  if(den<=0){factor=null;break;}factor*=1+(b.value-a.value-sum)/den;if(f.length)exact=false;
 }
 const level=date=>levels.find(x=>x.date===date)?.level;
 let units=level(first.date)>0?first.value/level(first.date):null;
 if(units!==null)for(const f of flows){if(!(level(f.date)>0)){units=null;break;}units+=f.amount/level(f.date);}
 const benchmark=units!==null&&level(last.date)>0?Math.round(units*level(last.date)):null;
 return {first,last,snaps,flows,net,gain:last.value-first.value-net,xirr,returnPct:factor===null?null:(factor-1)*100,exact,benchmark};
}
