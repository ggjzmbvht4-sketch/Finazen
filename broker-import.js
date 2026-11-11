import {createSecurityPosition,saveTrades} from './trading.js';
import {isDate} from './report-core.js';
export function csvRecords(text){
 const source=text.replace(/^\uFEFF/,'');const sep=source.split(/\r?\n/)[0].includes(';')?';':',';
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<source.length;i++){
  const c=source[i];if(c==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(!quoted&&c===sep){row.push(cell);cell='';}
  else if(!quoted&&c==='\n'){row.push(cell.trimEnd());rows.push(row);row=[];cell='';}
  else cell+=c;
 }
 if(quoted)throw Error('CSV enthält ein offenes Anführungszeichen.');
 if(cell||row.length){row.push(cell.trimEnd());rows.push(row);}
 const keys=rows.shift()?.map(k=>k.trim())||[];if(!keys.includes('Action')||!keys.includes('ISIN'))throw Error('Englischen Trading212-Verlauf im CSV-Format wählen.');
 return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(keys.map((k,i)=>[k,r[i]||''])));
}
const num=v=>Number(String(v||0).replace(',','.'));
export function brokerRows(text){
 return csvRecords(text).map((r,index)=>{
  const action=r.Action.toLowerCase(),side=/\bbuy$/.test(action)?'buy':/\bsell$/.test(action)?'sell':action.startsWith('dividend')?'dividend':'';
  const date=r.Time.slice(0,10),isin=r.ISIN.trim(),quantity=r['No. of shares'].replace(',','.'),price=num(r['Price / share']),currency=r['Currency (Price / share)'],amount=Math.round(num(r.Total)*100);
  const feeKeys=Object.keys(r).filter(k=>/fee|tax|stamp duty|levy/i.test(k)&&!k.startsWith('Currency')&&num(r[k])>0&&!/withholding/i.test(k));
  const feeAmount=feeKeys.reduce((n,k)=>n+Math.round(num(r[k])*100),0);
  const gross=side==='buy'?amount-feeAmount:amount+feeAmount;
  const fx=currency==='EUR'?1:gross/(100*price*num(quantity));
  const reason=!side?'Andere Buchungsart':!isDate(date)||!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)?'Datum oder ISIN fehlt':r['Currency (Total)']!=='EUR'||feeKeys.some(k=>r['Currency ('+k+')']!=='EUR')?'Gesamtbetrag/Gebühren nicht in EUR':!Number.isSafeInteger(amount)||amount<=0?'Betrag fehlt':side!=='dividend'&&(!(price>0)||!(num(quantity)>0)||!(fx>0)||!currency)?'Ausführung unvollständig':side!=='dividend'&&currency==='EUR'&&Math.abs(Math.round(num(quantity)*price*100)-gross)>2?'Gesamtbetrag weicht vom Ausführungspreis ab':'';
  const key=r.ID||[r.Time,r.Action,isin,quantity,price,r.Total].join('|');
  return {index,side,date,time:r.Time,isin,quantity,price,currency,feeAmount,fx,amount,key,reason,name:r.Name||r.Ticker,symbol:r.Ticker};
 });
}
export function importBroker(state,rows,choices){
 const s=structuredClone(state);let p=s.portfolio;
 for(const r of [...rows].sort((a,b)=>a.time.localeCompare(b.time)||a.index-b.index)){
  const dest=choices[r.index];if(!dest||r.reason||p.events.some(e=>e.brokerKey===r.key))continue;
  const parentId=dest==='root'?'':dest;
  if(parentId&&!p.assets.some(a=>a.id===parentId&&a.kind==='pie'))throw Error('Ziel-Pie fehlt.');
  const matches=p.assets.filter(a=>a.parentId===parentId&&p.instruments.some(i=>i.id===a.instrumentId&&i.isin===r.isin&&(r.side==='dividend'||i.currency===r.currency))&&(parentId||/trading\s*212/i.test(a.provider)));
  if(matches.length>1)throw Error('Mehrdeutige Position für '+r.name);
  let id=matches[0]?.id;
  if(!id){if(r.side!=='buy')throw Error('Für '+r.name+' fehlt der Anfangsbestand.');
   const created=createSecurityPosition(p,{name:r.name,isin:r.isin,symbol:r.symbol,currency:r.currency,kind:r.kind||'stock',provider:'Trading212',parentId,mode:'opening',quantity:'0',date:r.date},s.entries);p=created.portfolio;id=created.assetId;
  }
  if(r.side==='dividend')p.events.push({id:crypto.randomUUID(),assetId:id,type:'distribution',amount:r.amount,date:r.date,note:'Trading212 · Netto laut Export',brokerKey:r.key});
  else {p=saveTrades(p,[{assetId:id,side:r.side,date:r.date,quantity:r.quantity,price:r.price,fx:r.fx,feeAmount:r.feeAmount,recordQuote:true,note:'Trading212 CSV'}],s.entries);
   p.events.filter(e=>e.assetId===id&&e.trade===r.side).at(-1).brokerKey=r.key;}
 }if(p.events.length!==state.portfolio.events.length)p.lastImportedAt=new Date().toISOString();s.portfolio=p;return s;
}
