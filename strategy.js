const issuer = id=>'https://www.ishares.com/de/privatanleger/de/produkte/'+id+'/';
export const catalog = [
 ['IE00BJ0KDQ92','Xtrackers MSCI World 1C','XDWD','world',12,'https://etf.dws.com/de-de/IE00BJ0KDQ92-msci-world-ucits-etf-1c/'],
 ['IE00B4L5Y983','iShares Core MSCI World','EUNL','world',20,issuer(251882)],
 ['IE00BKM4GZ66','iShares Core MSCI EM IMI','IS3N','em',18,issuer(264659)],
 ['IE00B4WXJJ64','iShares Core € Govt Bond','EUNH','bond',7,issuer(251740)],
 ['IE00BDBRDM35','iShares Core Global Aggregate Bond EUR Hedged','EUNA','bond',10,issuer(291770)]
].map(([isin,name,symbol,group,fee,source])=>({id:isin,isin,name,symbol,group,fee,source,exchange:'XETRA',currency:'EUR',kind:'etf',asOf:'2026-11-09'}));
export function proposal(g){
 const equities={conservative:3000,balanced:6000,growth:8500}[g.risk];
 if(equities===undefined||!Number.isInteger(g.years)||g.years<1||g.years>50||!Number.isInteger(g.cash)||g.cash<0||g.cash>10000)throw Error('Risikoprofil prüfen.');
 const cash=Math.max(g.cash,g.years<3?8000:0);
 const stock=Math.min(equities,g.years<5?3000:10000,10000-cash);
 const em=g.noEm?0:Math.round(stock*0.15);
 const weights={world:stock-em,em,bond:10000-cash-stock};
 let spare=10000;
 const positions=[];
 for(const [group,bps] of Object.entries(weights)){
  let left=bps;
  const candidates=catalog.filter(x=>x.group===group&&!g.exclude?.includes(x.isin)).sort((a,b)=>a.fee-b.fee);
  for(const x of candidates){
   if(!left)break;
   const weightBps=Math.min(left,g.cap||10000);
   positions.push({id:x.id,weightBps,reason:group==='world'?'Industrieländer breit abbilden':group==='em'?'Schwellenländer beimischen':'Anleihenanteil aufbauen'});
   spare-=weightBps;left-=weightBps;
  }
 }
 return {summary:g.name,positions,cashWeightBps:spare,feeBps:positions.reduce((n,p)=>n+catalog.find(x=>x.id===p.id).fee*p.weightBps/10000,0)};
}
export function strategyProfile(goal,enabled){
 const rec=proposal(goal),eligible=catalog.filter(c=>!goal.exclude?.includes(c.isin)&&!(goal.noEm&&c.group==='em'));
 if(!eligible.length||!rec.positions.length)throw Error('Dieses Profil sieht ausschließlich Cash vor.');
 const equityCap=rec.positions.reduce((sum,p)=>sum+(catalog.find(x=>x.id===p.id).group==='bond'?0:p.weightBps),0);
 return {...(goal.selection?{selection:goal.selection,excluded:goal.exclude||[],lossTolerance:goal.lossTolerance,sectorLimit:goal.sectorLimit||10000,currencyLimit:goal.currencyLimit||10000}:{}),strategyId:goal.id,risk:goal.risk,horizonYears:goal.years,maxWeightPercent:goal.cap/100,minCashPercent:rec.cashWeightBps/100,goal:goal.name,intervalDays:goal.interval,enabled,consent:true,universe:eligible,equityCap,emCap:rec.positions.filter(p=>catalog.find(x=>x.id===p.id).group==='em').reduce((n,p)=>n+p.weightBps,0)};
}
