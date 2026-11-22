const sum = (rows, fn) => rows.reduce((total, row) => total + fn(row), 0);
export function budgetLine(state, entry, month, planned, carry = 0) {
  const actual = state.actuals[entry.id + ':' + month];
  const items = actual?.items || [];
  const spent = actual?.amount || 0;
  const pending = sum(items.filter(x => x.pending), x => x.amount);
  const closed = Boolean(state.closedMonths?.[month] || (actual && !actual.items));
  const available = planned + carry - spent - pending;
  const leftover = closed && entry.rollover ? Math.max(0, available) : 0;
  return {planned, carry, spent, pending, closed, available, leftover,
    forecast: spent + pending + (closed ? 0 : Math.max(0, available))};
}
export function appendItem(state, entryId, date, item) {
  const month = date.slice(0,7), key = entryId + ':' + month;
  if (state.closedMonths?.[month]) throw Error('Monat zuerst wieder öffnen.');
  const actual = state.actuals[key] ||= {amount:0, items:[]};
  if (!actual.items) actual.items = actual.amount ? [{id:crypto.randomUUID(), date:month+'-01', name:'Bisherige Ist-Buchung', amount:actual.amount, pending:false}] : [];
  actual.items.push({...item, date});
  actual.amount = sum(actual.items.filter(x=>!x.pending), x=>x.amount);
}
export function distribute(rules, available) {
  let left = Math.max(0,available);
  return rules.map(rule=>{
    const requested = rule.percent ? Math.floor(left * rule.amount / 10000) : rule.amount;
    const amount = Math.min(left,requested);
    left -= amount;
    return {...rule, amount, shortfall:requested-amount};
  });
}
export function payments(row) {
  const events=[];
  for(const t of row.tx){
    if(t.type==='reserve') continue;
    if(t.envelope && t.items){
      for(const item of t.items) events.push({name:item.name,date:item.date,delta:-item.amount});
      const rest=t.amount-sum(t.items,x=>x.amount);
      if(rest) events.push({name:t.name+' · verbleibend',date:row.month+'-'+new Date(Number(row.month.slice(0,4)),Number(row.month.slice(5)),0).getDate(),delta:-rest});
    }else events.push({name:t.name,date:t.date,delta:t.type==='income'?t.amount:-t.amount});
  }
  let balance=row.startCash;
  return events.sort((a,b)=>a.date.localeCompare(b.date)).map(e=>({...e,balance:balance+=e.delta}));
}
export function validatePlanning(s){
  const safe=n=>Number.isSafeInteger(n)&&n>=0&&n<=1e14;
  const month=m=>/^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  for(const d of s.dividends||[])if(typeof d.assetId!=='string'||!safe(d.amount)||!/^\d{4}-\d{2}-\d{2}$/.test(d.date))throw Error('Dividendenplanung prüfen.');
  for(const c of s.accountChecks||[])if(typeof c.name!=='string'||!month(c.month)||!Number.isSafeInteger(c.amount))throw Error('Kontenabgleich prüfen.');
  for(const a of s.portfolio.assets){const b=a.band;if(b&&(![b.low,b.base,b.high].every(safe)||b.low>b.base||b.base>b.high))throw Error('Bewertungsband prüfen.');}
  for(const prop of ['strategies','rules'])if(s[prop]!==undefined&&(!Array.isArray(s[prop])||s[prop].length>1000))throw Error('Planungsregeln prüfen.');
  const goalIds=new Set();
  for(const g of s.strategies||[]){
    if(typeof g.id!=='string'||goalIds.has(g.id)||typeof g.name!=='string'||!g.name.trim()||!['conservative','balanced','growth'].includes(g.risk)||!Number.isInteger(g.years)||g.years<1||g.years>50||![g.start,g.rate,g.target,g.cash,g.cap].every(safe)||g.cash>10000||g.cap<500||g.cap>10000||![1,7,30].includes(g.interval)||!Array.isArray(g.exclude)||g.exclude.some(x=>typeof x!=='string'))throw Error('Anlageprofil prüfen.');
    goalIds.add(g.id);
  }
  for(const [key,a] of Object.entries(s.actuals)){
    if(!a.items) continue;
    if(!Array.isArray(a.items)||a.items.length>10000||a.items.some(i=>!safe(i.amount)||!i.id||typeof i.name!=='string'||!/^\d{4}-\d\d-\d\d$/.test(i.date)||i.date.slice(0,7)!==key.slice(-7))||sum(a.items.filter(x=>!x.pending),x=>x.amount)!==a.amount) throw Error('Budgetbuchungen prüfen.');
  }
  for(const r of s.rules||[]) if(!safe(r.amount)||(r.percent&&r.amount>10000)||!['reserve','investment'].includes(r.kind)||typeof r.target!=='string'||!r.id) throw Error('Verteilregel prüfen.');
  for(const m of Object.keys(s.closedMonths||{}))if(!month(m))throw Error('Monatsabschluss prüfen.');
}
