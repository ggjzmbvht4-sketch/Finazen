// Port der Kern-Analytik von github.com/goldmansachs/gs-quant (gs_quant.timeseries.econometrics / .statistics / .measures_reports) nach JavaScript.
// Alle Quoten sind Brüche: 0.2 bedeutet 20 %. Serien sind Arrays aus {date:'YYYY-MM-DD', value:Zahl}. Mapping und Formeln siehe QUANT.md.
export const RETURNS={simple:'simple',log:'log',absolute:'absolute'};
const DAY_MS=86400000;
export const daysBetween=(a,b)=>(Date.parse(b)-Date.parse(a))/DAY_MS;
export function returns(series,type=RETURNS.simple){
 if(!Array.isArray(series)||series.length<2)throw Error('Mindestens zwei Werte mit Datum benötigt.');
 const out=[];
 for(let i=1;i<series.length;i++){
  const p=series[i-1].value,v=series[i].value;let r=null;
  if(type===RETURNS.log)r=p>0&&v>0?Math.log(v/p):null;
  else if(type===RETURNS.absolute)r=v-p;
  else if(type===RETURNS.simple)r=p!==0?v/p-1:null;
  else throw Error('Unbekannter Renditetyp: '+type);
  if(r!==null&&Number.isFinite(r))out.push({date:series[i].date,value:r});
 }
 return out;
}
export function mean(xs){if(!xs.length)return null;let s=0;for(const x of xs)s+=x;return s/xs.length;}
export function variance(xs,ddof=1){const n=xs.length;if(n<=ddof)return null;const m=mean(xs);let s=0;for(const x of xs)s+=(x-m)**2;return s/(n-ddof);}
export function std(xs,ddof=1){const v=variance(xs,ddof);return v===null?null:Math.sqrt(v);}
export function skewness(xs){const n=xs.length;if(n<3)return null;const m=mean(xs);let m2=0,m3=0;for(const x of xs){const d=x-m;m2+=d*d;m3+=d*d*d;}m2/=n;m3/=n;if(m2===0)return null;return Math.sqrt(n*(n-1))/(n-2)*m3/Math.pow(m2,1.5);}
export function kurtosis(xs){const n=xs.length;if(n<4)return null;const m=mean(xs);let m2=0,m4=0;for(const x of xs){const d=x-m;m2+=d*d;m4+=d**4;}m2/=n;m4/=n;if(m2===0)return null;const g2=m4/(m2*m2)-3;return (n-1)/((n-2)*(n-3))*((n+1)*g2+6);}
const ANNUALIZATION_BANDS=[{max:2.1,f:252},{min:6,max:8,f:52},{min:14,max:17,f:26},{min:25,max:35,f:12},{min:85,max:97,f:4},{min:360,max:386,f:1}];
export function annualizationFactor(dates){
 if(!Array.isArray(dates)||dates.length<2)throw Error('Mindestens zwei Datenpunkte nötig.');
 const distances=[];for(let i=1;i<dates.length;i++){const d=daysBetween(dates[i-1],dates[i]);if(d<=0)throw Error('Datenpunkte brauchen aufsteigende, eindeutige Daten.');distances.push(d);}
 const avg=distances.reduce((a,b)=>a+b,0)/distances.length;
 if(avg>386)throw Error('Annualisierungsfaktor nicht bestimmbar · durchschnittlicher Abstand: '+avg.toFixed(1)+' Tage.');
 let best=null,bestDist=Infinity;
 for(const b of ANNUALIZATION_BANDS){const lo=b.min??0,hi=b.max??Infinity;const dist=avg<lo?lo-avg:avg>hi?avg-hi:0;if(dist<bestDist){bestDist=dist;best=b;}}
 return best.f;
}
export function annualizedReturn(series){
 if(!Array.isArray(series)||series.length<2)return null;
 const first=series[0],last=series[series.length-1],days=daysBetween(first.date,last.date);
 if(days<=0||first.value<=0||last.value<=0)return null;
 return Math.pow(last.value/first.value,365.25/days)-1;
}
export function volatility(series,{type=RETURNS.simple,assumeZeroMean=false,factor}={}){
 const rs=returns(series,type);if(rs.length<2)return null;
 let f=factor;if(f===undefined){try{f=annualizationFactor(series.map(p=>p.date));}catch{return null;}}
 const xs=rs.map(r=>r.value);
 const s=assumeZeroMean?Math.sqrt(xs.reduce((a,r)=>a+r*r,0)/xs.length):std(xs,1);
 if(s===null)return null;return s*Math.sqrt(f);
}
export function maxDrawdown(series){
 if(!Array.isArray(series)||!series.length)return null;
 let peak=-Infinity,worst=0;
 for(const p of series){if(p.value>peak)peak=p.value;const dd=peak>0?p.value/peak-1:0;if(dd<worst)worst=dd;}
 return worst;
}
export function quantile(xs,q){
 if(!xs.length)return null;if(q<0||q>1)throw Error('Quantil muss zwischen 0 und 1 liegen.');
 const s=[...xs].sort((a,b)=>a-b),pos=(s.length-1)*q,lo=Math.floor(pos),hi=Math.ceil(pos);
 return lo===hi?s[lo]:s[lo]+(s[hi]-s[lo])*(pos-lo);
}
export function historicalVar(rs,confidence=0.95){if(!rs.length)return null;return -quantile(rs,1-confidence);}
export function expectedShortfall(rs,confidence=0.95){
 if(!rs.length)return null;const q=quantile(rs,1-confidence);const tail=rs.filter(r=>r<=q);
 return tail.length?-mean(tail):null;
}
export function sharpeRatio(series,riskFreeAnnual=0){
 const rs=returns(series,RETURNS.simple);if(rs.length<2)return null;
 let f;try{f=annualizationFactor(series.map(p=>p.date));}catch{return null;}
 const xs=rs.map((r,i)=>r.value-riskFreeAnnual*daysBetween(series[i].date,series[i+1].date)/360);
 const m=mean(xs),s=std(xs,1);if(s===null||s===0)return null;
 return m/s*Math.sqrt(f);
}
export function beta(rsA,rsB){
 if(rsA.length!==rsB.length||rsA.length<2)return null;
 const ma=mean(rsA),mb=mean(rsB);let cov=0;
 for(let i=0;i<rsA.length;i++)cov+=(rsA[i]-ma)*(rsB[i]-mb);
 cov/=rsA.length-1;const vb=variance(rsB,1);
 return vb?cov/vb:null;
}
export function trackingError(rsA,rsB,factor){
 if(rsA.length!==rsB.length||rsA.length<2)return null;
 const s=std(rsA.map((r,i)=>r-rsB[i]),1);
 return s===null?null:s*Math.sqrt(factor);
}
const alignReturns=(a,b)=>{const mapB=new Map(b.map(r=>[r.date,r.value]));return a.map(r=>mapB.has(r.date)?{date:r.date,a:r.value,b:mapB.get(r.date)}:null).filter(Boolean);};
export function portfolioRisk(snapshots,{confidence=0.95,riskFreeAnnual=0}={}){
 const series=[...(snapshots||[])].sort((a,b)=>a.date.localeCompare(b.date)).filter(s=>s&&Number.isFinite(s.value)&&s.value>=0).map(s=>({date:s.date,value:s.value}));
 if(series.length<2)return null;
 const first=series[0],last=series[series.length-1],days=daysBetween(first.date,last.date);
 const rs=returns(series,RETURNS.simple),rsVals=rs.map(r=>r.value);
 let factor=null;try{factor=annualizationFactor(series.map(p=>p.date));}catch{}
 const vol=factor===null?null:volatility(series,{factor});
 const varFrac=historicalVar(rsVals,confidence),cvarFrac=expectedShortfall(rsVals,confidence);
 const snapSorted=[...(snapshots||[])].sort((a,b)=>a.date.localeCompare(b.date));
 const snapFirst=snapSorted.find(s=>Number.isFinite(s.value)&&s.value>=0),snapLast=[...snapSorted].reverse().find(s=>Number.isFinite(s.value)&&s.value>=0);
 const name=snapFirst?.benchmarkName&&snapFirst.benchmarkName===snapLast?.benchmarkName?snapLast.benchmarkName:'';
 let benchmark=null;
 if(name&&snapFirst.benchmarkMicros>0&&snapLast.benchmarkMicros>0){
  const bLevels=snapSorted.filter(s=>s.benchmarkName===name&&s.benchmarkMicros>0).map(s=>({date:s.date,value:s.benchmarkMicros/1e6}));
  const aligned=alignReturns(rs,returns(bLevels,RETURNS.simple));
  benchmark={name,annualizedReturn:annualizedReturn(bLevels),beta:aligned.length>=2?beta(aligned.map(x=>x.a),aligned.map(x=>x.b)):null,trackingError:factor!==null&&aligned.length>=2?trackingError(aligned.map(x=>x.a),aligned.map(x=>x.b),factor):null};
 }
 return {points:series.length,days,totalReturn:first.value>0?last.value/first.value-1:null,annualizedReturn:annualizedReturn(series),volatility:vol,maxDrawdown:maxDrawdown(series),skewness:skewness(rsVals),kurtosis:kurtosis(rsVals),var:varFrac,cvar:cvarFrac,varAmount:varFrac===null?null:Math.round(varFrac*last.value),cvarAmount:cvarFrac===null?null:Math.round(cvarFrac*last.value),sharpe:sharpeRatio(series,riskFreeAnnual),benchmark};
}
