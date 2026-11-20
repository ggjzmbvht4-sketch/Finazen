const berlinMonth=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit'}).format(new Date());
export function accountEmptyPlan(){return {schema:1,name:'Meine Finanzplanung',anchor:berlinMonth(),openingCash:0,entries:[],reserves:[],actuals:{},notes:[],portfolio:{version:1,assets:[],instruments:[],events:[],quotes:[],compositions:[],snapshots:[]},updatedAt:new Date().toISOString()};}
export function accountDeleteInvestment(state,id,keepChildren=false){
 const next=structuredClone(state),p=next.portfolio,ids=new Set([id]);
 if(keepChildren)for(const a of p.assets)if(a.parentId===id)a.parentId='';else for(const a of p.assets)if(a.parentId===id)ids.add(a.id);
 p.assets=p.assets.filter(a=>!ids.has(a.id));p.instruments=p.instruments.filter(i=>p.assets.some(a=>a.instrumentId===i.id));
 p.events=p.events.filter(e=>!ids.has(e.assetId));p.quotes=p.quotes.filter(q=>!ids.has(q.assetId));p.compositions=p.compositions.filter(c=>!ids.has(c.pieId));
 next.entries=(next.entries||[]).filter(e=>!p.assets.some(a=>(a.planEntryIds||[]).includes(e.id)));
 for(const a of p.assets)a.planEntryIds=(a.planEntryIds||[]).filter(x=>next.entries.some(e=>e.id===x));
 next.updatedAt=new Date().toISOString();return {data:next,assetIds:[...ids]};
}
