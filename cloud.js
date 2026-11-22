const KEY='kontur-cloud-v1';
const DEFAULT_URL='https://kontur-cloud.ggjzmbvht4-kontur.workers.dev';
const PUBLIC_KEY='cloudflare-public';

export class Cloud{
 constructor(){
  try{this.config=JSON.parse(localStorage.getItem(KEY)||'null');}catch{this.config=null;}
  try{this.session=JSON.parse(localStorage.getItem('kontur-session-v1')||'null');}catch{this.session=null;}
  this.refreshing=null;
  if(this.config?.url?.includes('.supabase.co')){
   this.config={url:DEFAULT_URL,key:PUBLIC_KEY};localStorage.setItem(KEY,JSON.stringify(this.config));this.clearSession();
  }
 }
 configure(url){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Bitte die HTTPS-Worker-URL ohne zusätzlichen Pfad eingeben.');
  this.config={url:u.origin,key:PUBLIC_KEY};localStorage.setItem(KEY,JSON.stringify(this.config));this.clearSession();
 }
 saveSession(s){this.session={...s,expires_at:Math.floor(Date.now()/1000)+(s.expires_in||3600)};localStorage.setItem('kontur-session-v1',JSON.stringify(this.session));}
 clearSession(){this.session=null;localStorage.removeItem('kontur-session-v1');}
 async request(path,{method='GET',body,auth=false}={}){
  if(!this.config)throw Error('Cloudflare zuerst verbinden.');if(auth)await this.token();
  let response;
  try{response=await fetch(this.config.url+path,{method,headers:{apikey:this.config.key,'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+this.session.access_token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(path.startsWith('/functions/')?180000:20000)});}catch(e){if(e?.name==='TimeoutError'||e?.name==='AbortError')throw Error('Zeitüberschreitung — bitte später erneut versuchen.');throw Error('Keine Verbindung — bitte später erneut versuchen.');}
  let data;try{data=await response.json();}catch{data=null;}
  if(!response.ok){
   const raw=String(data?.msg||data?.message||data?.error_description||data?.error||''),code=String(data?.error_code||data?.code||''),hay=(raw+' '+code).toLowerCase();
   if(hay.includes('refresh_token_not_found')||hay.includes('invalid_grant')&&path.includes('grant_type=refresh_token')){this.clearSession();throw Error('Deine Anmeldung ist abgelaufen — bitte neu anmelden.');}
   const known=[['invalid login credentials','E-Mail oder Passwort stimmt nicht.'],['invalid_credentials','E-Mail oder Passwort stimmt nicht.'],['email not confirmed','Bitte zuerst die Bestätigungs-E-Mail anklicken.'],['email_not_confirmed','Bitte zuerst die Bestätigungs-E-Mail anklicken.'],['user already registered','Diese E-Mail ist bereits registriert.'],['user_already_exists','Diese E-Mail ist bereits registriert.'],['over_email_send_rate_limit','Zu viele E-Mails angefragt. Bitte kurz warten und erneut versuchen.'],['sync_conflict','Änderungen auf zwei Geräten — bitte Cloud-Stand laden oder lokal behalten.']];
   const hit=known.find(([k])=>hay.includes(k)),message=hit?hit[1]:(raw&&raw.length<400?raw:'Verbindung fehlgeschlagen (Code '+response.status+'). Bitte später erneut versuchen.'),err=Error(message);
   if(code)err.code=code;if(hay.includes('sync_conflict'))err.code='SYNC_CONFLICT';throw err;
  }
  return data;
 }
 async token(){if(!this.session)throw Error('Bitte anmelden.');if(this.session.expires_at>Date.now()/1000+60)return;if(!this.refreshing)this.refreshing=this.request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:this.session.refresh_token}}).then(s=>this.saveSession(s)).finally(()=>this.refreshing=null);await this.refreshing;}
 async signIn(email,password){const s=await this.request('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});this.saveSession(s);return s.user;}
 async signUp(email,password){return this.request('/auth/v1/signup',{method:'POST',body:{email,password}});}
 async recover(email){return this.request('/auth/v1/recover',{method:'POST',body:{email}});}
 async reset(email,token,password){const s=await this.request('/auth/v1/verify',{method:'POST',body:{email,token,type:'recovery'}});this.saveSession(s);await this.request('/auth/v1/user',{method:'PUT',auth:true,body:{password}});}
 async signOut(){try{if(this.session)await this.request('/auth/v1/logout',{method:'POST',auth:true});}finally{this.clearSession();}}
 async load(){await this.token();const data=await this.request('/rest/v1/finance_plans?select=data,revision,updated_at&owner_id=eq.'+encodeURIComponent(this.session.user.id),{auth:true});return data[0]||null;}
 async save(data,revision){return this.request('/rest/v1/rpc/save_finance_plan',{method:'POST',auth:true,body:{payload:data,expected_revision:revision}});}
}

export {DEFAULT_URL as CLOUDFLARE_URL};
