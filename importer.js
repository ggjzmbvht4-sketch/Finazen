import {emptyState,uid,cents,monthAdd,validateState} from './engine.js';
const xml=t=>{const d=new DOMParser().parseFromString(t,'application/xml');if(d.querySelector('parsererror'))throw Error('Ungültiges Excel-XML.');return d;};
const nodes=(x,name)=>Array.from(x.getElementsByTagNameNS('*',name));
export async function readXlsx(file){
 if(file.size>12*1024*1024)throw Error('Bitte eine Excel-Datei unter 12 MB wählen.');
 const bytes=new Uint8Array(await file.arrayBuffer()),v=new DataView(bytes.buffer);let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(v.getUint32(i,true)===0x06054b50){end=i;break;}
 if(end<0)throw Error('Keine gültige XLSX-Datei.');let p=v.getUint32(end+16,true);const count=v.getUint16(end+10,true);const files={};let total=0;
 if(count>2000)throw Error('Die Excel-Datei enthält zu viele Bestandteile.');
 for(let i=0;i<count;i++){
  if(p+46>bytes.length||v.getUint32(p,true)!==0x02014b50)throw Error('Beschädigte Excel-Datei.');
  const method=v.getUint16(p+10,true),size=v.getUint32(p+20,true),unpacked=v.getUint32(p+24,true),nl=v.getUint16(p+28,true),el=v.getUint16(p+30,true),cl=v.getUint16(p+32,true),offset=v.getUint32(p+42,true);const name=new TextDecoder().decode(bytes.slice(p+46,p+46+nl));p+=46+nl+el+cl;
  total+=unpacked;if(total>40*1024*1024)throw Error('Entpackte Datei ist zu groß.');
  if(!name.endsWith('.xml')||!name.startsWith('xl/'))continue;
  const start=offset+30+v.getUint16(offset+26,true)+v.getUint16(offset+28,true);let raw=bytes.slice(start,start+size);
  if(method===8){try{raw=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());}catch{throw Error('Dieser Browser kann XLSX nicht entpacken. Bitte Safari aktualisieren oder die beiliegende Finanzen-Import.json verwenden.');}}else if(method!==0)throw Error('Nicht unterstützte Excel-Komprimierung.');
  files[name]=new TextDecoder().decode(raw);
 }
 const strings=files['xl/sharedStrings.xml']?nodes(xml(files['xl/sharedStrings.xml']),'si').map(si=>nodes(si,'t').map(t=>t.textContent).join('')):[];
 const rel=files['xl/_rels/workbook.xml.rels'];
 // .rels does not have an .xml extension; read it separately from the ZIP directory.
 const relationships=await readZipRelation(bytes,v,end);
 const sheets={};for(const sh of nodes(xml(files['xl/workbook.xml']||''),'sheet')){
  const rid=sh.getAttribute('r:id'),target=relationships[rid];if(!target)continue;
  const path=target.startsWith('/')?target.slice(1):'xl/'+target.replace(/^\.\//,'');if(!files[path])continue;const cells={};
  for(const c of nodes(xml(files[path]),'c')){let value=nodes(c,'v')[0]?.textContent??'';if(c.getAttribute('t')==='s')value=strings[Number(value)]??'';else if(c.getAttribute('t')==='inlineStr')value=nodes(c,'t').map(t=>t.textContent).join('');else if(value!==''&&Number.isFinite(Number(value)))value=Number(value);cells[c.getAttribute('r')]=value;}
  sheets[sh.getAttribute('name')]=cells;
 }return sheets;
}
async function readZipRelation(bytes,v,end){let p=v.getUint32(end+16,true);for(let i=0;i<v.getUint16(end+10,true);i++){
 const method=v.getUint16(p+10,true),size=v.getUint32(p+20,true),nl=v.getUint16(p+28,true),el=v.getUint16(p+30,true),cl=v.getUint16(p+32,true),o=v.getUint32(p+42,true),name=new TextDecoder().decode(bytes.slice(p+46,p+46+nl));p+=46+nl+el+cl;if(name!=='xl/_rels/workbook.xml.rels')continue;
 const start=o+30+v.getUint16(o+26,true)+v.getUint16(o+28,true);let raw=bytes.slice(start,start+size);if(method===8)raw=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());return Object.fromEntries(nodes(xml(new TextDecoder().decode(raw)),'Relationship').map(r=>[r.getAttribute('Id'),r.getAttribute('Target')]));
 }return {};}
export function excelMonth(serial){const d=new Date(Date.UTC(1899,11,30)+serial*86400000);return d.toISOString().slice(0,7);}
function add(s,type,name,amount,start,extra={}){if(!Number.isFinite(amount)||amount===0)return;s.entries.push({id:uid(),type,name:String(name).trim(),amount:cents(Math.abs(amount)),start,interval:0,end:'',day:1,reserveId:'',note:'',...extra});}
function common(s,sheets){
 s.name='Finanzplanung aus Excel';s.notes=[
 'Importierte Werte sind Planwerte, keine tatsächlichen Buchungen oder aktuellen Depotbestände.',
 'Excel-Nettoeinkommen werden unverändert als Schätzungen übernommen. Es erfolgt keine Steuerberechnung.',
 'Jährliche und quartalsweise Rechnungen sind zunächst ohne Fälligkeit vorgemerkt. Bitte Startmonat und Zahlungstag prüfen und den Eintrag aktivieren. Rücklagen dafür bleiben getrennt.',
 'Anfangsguthaben und vorhandene Rücklagen bitte ergänzen. Ein negativer Verlauf bei 0 € Anfangsguthaben ist eine Planungslücke, kein aus Excel ermittelter Kontostand.'
 ];
 const f=sheets.Fixkosten;if(!f)return;
 const intervals={'jährlich':12,'quartalsweise':3,'halbjährlich':6};
 for(const row of [6,8,12,14,19,20,21,22]){const interval=intervals[f['C'+row]],amount=Number(f['B'+row]);if(interval&&amount)add(s,'expense',f['A'+row],amount,s.anchor,{interval,pending:true,reserveId:row>=19?s.reserves[1]?.id||'':s.reserves[0]?.id||'',note:'Fälligkeit in Excel nicht angegeben. Bitte ergänzen.'});}
}
export function fromWorkbook(sheets,source='Jahresübersicht',year=2027){
 const s=emptyState();const sheet=sheets[source];if(!sheet)throw Error('Das gewählte Tabellenblatt fehlt. Unterstützt werden „Jahresübersicht“ und „Plan“.');
 s.reserves=[{id:uid(),name:'Jahresrechnungen',opening:0,target:0},{id:uid(),name:'Auto · Jahresrechnungen',opening:0,target:0}];
 if(source==='Jahresübersicht'){
  const cols=Object.keys(sheet).filter(k=>/^[A-Z]+3$/.test(k)&&typeof sheet[k]==='number'&&sheet[k]>40000&&sheet[k]<80000).map(k=>k.replace(/3$/,'')).sort((a,b)=>Number(sheet[a+'3'])-Number(sheet[b+'3']));
  if(!cols.length)throw Error('Keine Monatsspalten in der Jahresübersicht gefunden.');s.anchor=excelMonth(sheet[cols[0]+'3']);
  const types={7:'income',8:'expense',9:'reserve',10:'expense',11:'reserve',12:'budget',13:'budget',15:'investment',16:'investment',17:'investment',18:'investment',19:'investment',20:'investment',21:'investment',22:'investment',23:'investment',24:'investment',25:'investment',26:'investment',27:'investment',29:'investment',30:'investment',31:'investment'};
  for(const [r,type]of Object.entries(types)){let name=sheet['B'+r]||sheet['A'+r]||'Eintrag';if(r==='7')name='Nettoeinkommen · inkl. Sonderzahlungen';if(Number(r)>=17&&Number(r)<=22)name='Trading212 · '+name;if(Number(r)>=23&&Number(r)<=27)name='NAO · '+name;
   let run=null;for(const col of cols){const month=excelMonth(sheet[col+'3']),value=Number(sheet[col+r]);if(!Number.isFinite(value)||value===0){run=null;continue;}const amount=cents(Math.abs(value));if(run&&run.amount===amount&&monthAdd(run.end,1)===month)run.end=month;else{add(s,type,name,value,month,{interval:1,end:month,note:`Excel: ${source}!${col}${r}`,reserveId:type==='reserve'?s.reserves[r==='11'?1:0].id:''});run=s.entries.at(-1);}}
  }
 }else{
  s.anchor=`${year}-01`;
  for(let r=14;r<=25;r++){const m=`${year}-${String(r-13).padStart(2,'0')}`;for(const [col,type,name]of [['D','income','Nettoeinkommen · inkl. Sonderzahlungen'],['F','budget','Alltagsbudget'],['H','investment','Deka'],['I','investment','Trading212'],['J','investment','NAO'],['L','investment','Firmenaktien'],['M','income','Geplante Steuerersparnis']])add(s,type,name,Number(sheet[col+r]),m,{note:`Excel: Plan!${col}${r}`});}
  const f=sheets.Fixkosten||{};for(const row of [2,3,4,5,7,9,10,11,13,18])if(Number(f['D'+row])!==0)add(s,'expense',f['A'+row]||'Fixkosten',Number(f['D'+row]),s.anchor,{interval:1,end:`${year}-12`});
  for(const [idx,row]of [[0,31],[1,32]])add(s,'reserve',s.reserves[idx].name,Number(f['D'+row]),s.anchor,{interval:1,end:`${year}-12`,reserveId:s.reserves[idx].id});
 }
 common(s,sheets);return validateState(s);
}
export function csvExport(state,rows){const esc=v=>'"'+String(v??'').replaceAll('"','""')+'"';const lines=[['Monat','Typ','Bezeichnung','Plan EUR','Ist EUR','Wirksam EUR','Status']];for(const r of rows)for(const t of r.tx)lines.push([r.month,t.type,t.name,(t.planned/100).toFixed(2).replace('.',','),t.actual===null?'':(t.actual/100).toFixed(2).replace('.',','),(t.amount/100).toFixed(2).replace('.',','),t.booked?'Gebucht':'Geplant']);return '\uFEFF'+lines.map(r=>r.map(v=>esc(/^[=+@-]/.test(String(v))?'\u0027'+v:v)).join(';')).join('\r\n');}
