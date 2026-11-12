import {due,monthAdd} from './engine.js';
// Future plan amounts only: real holdings are never derived from planned deposits.
export function savingsProjection(entry,startCents,years,rates,asOf,actuals={}){
 if(!entry||!/^\d{4}-\d{2}-\d{2}$/.test(asOf)||!Number.isFinite(startCents)||years<1||years>50)throw Error('Sparplan oder Datenstand fehlt.');
 let paid=startCents/100,values=rates.map(()=>paid);const rows=[{year:0,paid,values:[...values]}],base=asOf.slice(0,7);
 const currentAmount=entry.pending?0:entry.planOverrides?.[base]??(due(entry,base)?entry.amount:0),remainingCurrent=(entry.day||1)>Number(asOf.slice(8,10))&&!Object.hasOwn(actuals,entry.id+':'+base)?currentAmount/100:0;
 for(let i=1;i<=years*12;i++){const m=monthAdd(base,i),deposit=(entry.pending?0:entry.planOverrides?.[m]??(due(entry,m)?entry.amount:0))/100+(i===1?remainingCurrent:0);paid+=deposit;values=values.map((v,k)=>v*Math.pow(1+rates[k]/100,1/12)+deposit);if(i%12===0)rows.push({year:i/12,paid,values:[...values]});}return rows;
}
