import assert from 'node:assert/strict';
import test from 'node:test';
import {RETURNS,returns,mean,variance,std,skewness,kurtosis,annualizationFactor,annualizedReturn,volatility,maxDrawdown,quantile,historicalVar,expectedShortfall,sharpeRatio,beta,trackingError,daysBetween,portfolioRisk} from '../quant.js';

const series=(values,start='2026-01-01',stepDays=1)=>values.map((value,i)=>{const d=new Date(Date.parse(start+'T12:00:00Z')+i*stepDays*86400000);return {date:d.toISOString().slice(0,10),value};});
const vals=s=>s.map(p=>p.value);
const close=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps,`erwartet ${b}, erhalten ${a}`);

test('daysBetween zählt Tage von a nach b',()=>{
 assert.equal(daysBetween('2026-01-01','2026-01-02'),1);
 assert.equal(daysBetween('2026-01-01','2027-01-01'),365);
});

test('returns: simple, log, absolute (gs_quant.timeseries.econometrics.returns)',()=>{
 const s=series([100,110,99]);
 close(vals(returns(s,RETURNS.simple))[0],0.1);
 close(vals(returns(s,RETURNS.simple))[1],99/110-1);
 close(vals(returns(s,RETURNS.log))[0],Math.log(1.1));
 close(vals(returns(s,RETURNS.log))[1],Math.log(99/110));
 assert.deepEqual(vals(returns(s,RETURNS.absolute)),[10,-11]);
 assert.deepEqual(returns(s).map(r=>r.date),[s[1].date,s[2].date]);
 assert.throws(()=>returns([{date:'2026-01-01',value:1}],RETURNS.simple),/Mindestens zwei/);
 assert.throws(()=>returns(s,'kaputt'),/Unbekannter Renditetyp/);
});

test('mean/std/variance: Stichprobe mit N-1 (gs_quant.timeseries.statistics)',()=>{
 const xs=[2,4,4,4,5,5,7,9];
 close(mean(xs),5);
 close(variance(xs,0),4);
 close(variance(xs,1),32/7);
 close(std(xs,1),Math.sqrt(32/7));
 assert.equal(variance([1],1),null);
 assert.equal(mean([]),null);
});

test('skewness/kurtosis: bias-korrigiert wie scipy bias=False',()=>{
 const xs=[1,2,3,4,5,6,7,8,9,20];
 const n=xs.length,m=mean(xs);
 const m2=xs.reduce((a,x)=>a+(x-m)**2,0)/n,m3=xs.reduce((a,x)=>a+(x-m)**3,0)/n,m4=xs.reduce((a,x)=>a+(x-m)**4,0)/n;
 close(skewness(xs),Math.sqrt(n*(n-1))/(n-2)*m3/Math.pow(m2,1.5));
 const g2=m4/(m2*m2)-3;
 close(kurtosis(xs),(n-1)/((n-2)*(n-3))*((n+1)*g2+6));
 assert.equal(skewness([1,2]),null);
 assert.equal(kurtosis([1,2,3]),null);
 assert.equal(skewness([5,5,5,5]),null);
});

test('annualizationFactor: Bänder aus gs_quant _get_annualization_factor',()=>{
 assert.equal(annualizationFactor(series([1,2,3,4], '2026-01-01',1).map(p=>p.date)),252);
 assert.equal(annualizationFactor(series([1,2,3], '2026-01-01',7).map(p=>p.date)),52);
 assert.equal(annualizationFactor(series([1,2,3], '2026-01-01',15).map(p=>p.date)),26);
 assert.equal(annualizationFactor(series([1,2,3], '2026-01-01',30).map(p=>p.date)),12);
 assert.equal(annualizationFactor(series([1,2,3], '2026-01-01',90).map(p=>p.date)),4);
 assert.equal(annualizationFactor(series([1,2], '2026-01-01',365).map(p=>p.date)),1);
 assert.equal(annualizationFactor(series([1,2,3], '2026-01-01',20).map(p=>p.date)),26);
 assert.throws(()=>annualizationFactor(series([1,2], '2026-01-01',400).map(p=>p.date)),/Annualisierungsfaktor/);
 assert.throws(()=>annualizationFactor(['2026-01-02','2026-01-01']),/aufsteigende/);
});

test('annualizedReturn: (V1/V0)^(365.25/T)-1 (gs_quant _annualized_return)',()=>{
 const s=series([100,110],'2026-01-01',365);
 close(annualizedReturn(s),Math.pow(1.1,365.25/365)-1);
 assert.equal(annualizedReturn(series([100])),null);
 assert.equal(annualizedReturn(series([0,110],'2026-01-01',365)),null);
});

test('volatility: Std der Renditen × sqrt(Faktor) (gs_quant volatility)',()=>{
 const s=series([100,105,100]);
 const r=[0.05,100/105-1],m=(r[0]+r[1])/2;
 const expected=Math.sqrt(((r[0]-m)**2+(r[1]-m)**2)/1)*Math.sqrt(252);
 close(volatility(s),expected,1e-9);
 close(volatility(series([100,110,121])),0,1e-9);
 assert.equal(volatility(series([100,110])),null);
 close(volatility(s,{assumeZeroMean:true}),Math.sqrt((r[0]*r[0]+r[1]*r[1])/2)*Math.sqrt(252),1e-9);
});

test('maxDrawdown: kleinstes Peak-to-Trough-Verhältnis (gs_quant max_drawdown)',()=>{
 close(maxDrawdown(series([100,120,90,130])),90/120-1);
 close(maxDrawdown(series([100,110,120])),0);
 assert.equal(maxDrawdown([]),null);
});

test('quantile: lineare Interpolation wie numpy/pandas',()=>{
 close(quantile([4,1,3,2],0.25),1.75);
 close(quantile([1,2,3],0.5),2);
 close(quantile([5],0.9),5);
 assert.equal(quantile([],0.5),null);
 assert.throws(()=>quantile([1],2),/zwischen 0 und 1/);
});

test('historicalVar/expectedShortfall (gs_quant realized_var + CVaR)',()=>{
 const rs=[-0.05,-0.02,-0.01,0.01,0.03];
 close(historicalVar(rs,0.8),0.026);
 close(expectedShortfall(rs,0.8),0.05);
 close(historicalVar(rs,0.95),0.044);
 assert.equal(historicalVar([],0.95),null);
});

test('sharpeRatio: Überschussrendite Act/360, annualisiert über sqrt(F)',()=>{
 const s=series([100,101,102,103]);
 const rs=vals(returns(s)),f=252;
 const m=mean(rs),sd=std(rs);
 close(sharpeRatio(s,0),m/sd*Math.sqrt(f),1e-12);
 const rf=0.04;
 const rsX=rs.map((r,i)=>r-rf*daysBetween(s[i].date,s[i+1].date)/360);
 close(sharpeRatio(s,rf),mean(rsX)/std(rsX)*Math.sqrt(f),1e-12);
 assert.equal(sharpeRatio(series([100,100,100]),0),null);
});

test('beta und trackingError gegen Benchmark-Renditen',()=>{
 const a=[0.01,-0.02,0.03,0.005],b=[0.02,-0.01,0.01,-0.004];
 const ma=mean(a),mb=mean(b);
 const cov=a.reduce((s,x,i)=>s+(x-ma)*(b[i]-mb),0)/(a.length-1);
 close(beta(a,b),cov/variance(b,1),1e-12);
 const diff=a.map((r,i)=>r-b[i]);
 close(trackingError(a,b,12),std(diff,1)*Math.sqrt(12),1e-12);
 assert.equal(beta([0.01],[0.02]),null);
 assert.equal(trackingError([0.01,0.02],[0.01],12),null);
});

test('portfolioRisk: Aggregation über Tagesstände inkl. Benchmark',()=>{
 const snaps=[
  {date:'2026-03-31',value:110000,benchmarkName:'Ref',benchmarkMicros:105000000},
  {date:'2026-01-31',value:100000,benchmarkName:'Ref',benchmarkMicros:100000000},
  {date:'2026-02-28',value:104000,benchmarkName:'Ref',benchmarkMicros:102000000},
 ];
 const r=portfolioRisk(snaps,{confidence:0.95});
 assert.equal(r.points,3);
 assert.equal(r.days,daysBetween('2026-01-31','2026-03-31'));
 close(r.totalReturn,110000/100000-1);
 close(r.annualizedReturn,Math.pow(1.1,365.25/r.days)-1);
 assert.equal(r.maxDrawdown,0);
 assert.ok(r.volatility>0);
 assert.ok(r.cvar>=r.var);
 assert.equal(r.varAmount,Math.round(r.var*110000));
 assert.equal(r.cvarAmount,Math.round(r.cvar*110000));
 assert.ok(r.sharpe!==null);
 assert.ok(r.benchmark);
 assert.equal(r.benchmark.name,'Ref');
 close(r.benchmark.annualizedReturn,Math.pow(105/100,365.25/r.days)-1);
 assert.ok(Number.isFinite(r.benchmark.beta));
 assert.ok(r.benchmark.trackingError>=0);
 assert.equal(portfolioRisk([{date:'2026-01-01',value:1}]),null);
 assert.equal(portfolioRisk([]),null);
});

test('portfolioRisk: Drawdown und VaR an fallender Serie',()=>{
 const snaps=series([100000,90000,95000,80000],'2026-01-01',30);
 const r=portfolioRisk(snaps.map(s=>({...s})));
 close(r.maxDrawdown,80000/100000-1);
 assert.ok(r.var>0);
 assert.ok(r.annualizedReturn<0);
 assert.equal(r.benchmark,null);
});
