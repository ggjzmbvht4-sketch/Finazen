export const CLASS_COLORS={stock:'#ed7767',etf:'#1ddbc3',bond:'#56bed5',fund:'#a68ad0',cash:'#7ba23c',private:'#b889dd',alternative:'#f0b94e',pie:'#37bfa8'};
export function modelProjection(start,monthly,years,rates){
 if(![start,monthly,years,...rates].every(Number.isFinite)||start<0||monthly<0||years<1||years>50||rates.some(x=>x<=-100||x>100))throw Error('Modellannahmen prüfen.');
 const rows=[];
 const balances=rates.map(()=>start);
 for(let m=0;m<=years*12;m++){
  if(m)for(let i=0;i<rates.length;i++)balances[i]=balances[i]*Math.pow(1+rates[i]/100,1/12)+monthly;
  if(m%12===0)rows.push({year:m/12,paid:start+monthly*m,values:[...balances]});
 }
 return rows;
}
export function projectionChart(rows,format){
 const width=900,height=370,pad=48,max=Math.max(1,...rows.flatMap(r=>[r.paid,...r.values])),x=i=>pad+i*(width-pad*2)/(rows.length-1),y=v=>height-pad-v/max*(height-pad*2);
 const line=k=>rows.map((r,i)=>x(i)+','+y(k(r))).join(' ');
 const area=line(r=>r.values.at(-1))+' '+rows.map((r,i)=>[x(i),y(r.values[0])]).reverse().map(p=>p.join(',')).join(' ');
 const ticks=Array.from({length:5},(_,i)=>max*i/4);
 return '<svg class="wealth-chart" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Modellszenarien und kumulierte Einzahlungen">'+ticks.map(v=>'<line x1="'+pad+'" x2="'+(width-pad)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--line)"/><text x="'+(width-pad+5)+'" y="'+(y(v)+4)+'" fill="var(--muted)" font-size="11">'+format(v)+'</text>').join('')+
 '<polygon points="'+area+'" fill="var(--accent)" opacity=".3"/><polyline points="'+line(r=>r.values[1])+'" fill="none" stroke="var(--accent)" stroke-width="3"/><polyline points="'+line(r=>r.paid)+'" fill="none" stroke="var(--muted)" stroke-width="2"/>'+
 rows.filter((r,i)=>i===0||r.year%5===0||i===rows.length-1).map(r=>'<text x="'+x(rows.indexOf(r))+'" y="'+(height-18)+'" text-anchor="middle" fill="var(--muted)" font-size="12">'+(r.year?r.year+' J.':'Heute')+'</text>').join('')+'</svg>';
}
export function treemap(items){
 const valid=items.filter(x=>Number.isFinite(x.value)&&x.value>0),result=[];
 function split(rows,x,y,w,h){
  if(!rows.length)return;
  if(rows.length===1){result.push({...rows[0],x,y,w,h});return;}
  const total=rows.reduce((n,r)=>n+r.value,0);let left=0,index=0;
  while(index<rows.length-1&&left<total/2){left+=rows[index].value;index++;}
  const fraction=left/total;
  if(w>=h){split(rows.slice(0,index),x,y,w*fraction,h);split(rows.slice(index),x+w*fraction,y,w*(1-fraction),h);}
  else{split(rows.slice(0,index),x,y,w,h*fraction);split(rows.slice(index),x,y+h*fraction,w,h*(1-fraction));}
 }
 split([...valid].sort((a,b)=>b.value-a.value),0,0,100,100);return result;
}
export function treemapHTML(items,esc,action='tile'){
 const total=items.reduce((n,x)=>n+x.value,0);
 if(!total)return '<div class="map-empty">Für diese Darstellung fehlen positive Werte.</div>';
 return '<div class="wealth-map" aria-label="Gewichtung nach Flächenanteil">'+treemap(items).map(x=>'<button type="button" data-visual="'+action+'" data-id="'+esc(x.id)+'" class="map-tile" style="left:'+x.x+'%;top:'+x.y+'%;width:'+x.w+'%;height:'+x.h+'%;background:'+x.color+'" title="'+esc(x.name)+' · '+(x.value/total*100).toFixed(1)+' %"><span>'+esc(x.name)+'</span><strong>'+(x.value/total*100).toFixed(1)+' %</strong></button>').join('')+'</div>';
}
export function historyChart(rows,format){
 if(rows.length<2)return '<p class="chart-empty">Mit datierten Wertständen entsteht hier dein Depotverlauf.</p>';
 const max=Math.max(...rows.map(r=>r.value),1),min=Math.min(...rows.map(r=>r.value),0),first=Date.parse(rows[0].date),last=Date.parse(rows.at(-1).date),x=r=>45+(Date.parse(r.date)-first)/(last-first||1)*810,y=r=>260-(r.value-min)/(max-min||1)*220;
 return '<svg class="wealth-chart" viewBox="0 0 930 310" role="img" aria-label="Depotverlauf aus gespeicherten Wertständen">'+[0,.5,1].map(f=>'<line x1="45" x2="855" y1="'+(260-220*f)+'" y2="'+(260-220*f)+'" stroke="var(--line)"/><text x="860" y="'+(264-220*f)+'" font-size="11" fill="var(--muted)">'+format(min+(max-min)*f)+'</text>').join('')+'<polyline fill="none" stroke="var(--accent)" stroke-width="3" points="'+rows.map(r=>x(r)+','+y(r)).join(' ')+'"/><text x="45" y="295" fill="var(--muted)" font-size="12">'+rows[0].date+'</text><text x="750" y="295" fill="var(--muted)" font-size="12">'+rows.at(-1).date+'</text></svg>';
}
