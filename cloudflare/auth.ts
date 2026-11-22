import { first, json, now, run, uuid } from './db';

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const token = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map((x)=>x.toString(16).padStart(2,'0')).join('');
}

async function passwordRecord(password: string, salt = b64url(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:b64decode(salt),iterations:100000},key,256);
  return {salt,hash:b64url(new Uint8Array(bits))};
}

function b64decode(value: string) {
  const normalized=value.replace(/-/g,'+').replace(/_/g,'/');
  const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4));
  return Uint8Array.from(binary,(c)=>c.charCodeAt(0));
}

async function verifyPassword(password:string,salt:string,expected:string) {
  const actual=await passwordRecord(password,salt), a=encoder.encode(actual.hash), b=encoder.encode(expected);
  let diff=a.length^b.length;
  for(let i=0;i<Math.max(a.length,b.length);i++) diff|=(a[i]||0)^(b[i]||0);
  return diff===0;
}

export async function verifyCredentials(env:any,email:string,password:string) {
  const normalized=String(email||'').trim().toLowerCase();
  const user:any=await first(env,'SELECT * FROM auth_users WHERE email=?',[normalized]);
  if(!user||!(await verifyPassword(String(password||''),user.password_salt,user.password_hash)))return null;
  return user;
}

function publicUser(row:any) {
  return {id:row.id,email:row.email,email_confirmed_at:row.email_confirmed_at,created_at:row.created_at,updated_at:row.updated_at,aud:'authenticated',role:'authenticated',app_metadata:{provider:'email',providers:['email']},user_metadata:{}};
}

function authError(message:string,status=400,code='') {
  return json({msg:message,message,error:message,error_description:message,...(code?{error_code:code}:{})},status);
}

async function createSession(env:any,user:any) {
  const access=token(),refresh=token(),stamp=now();
  await run(env,'INSERT INTO auth_sessions(access_hash,user_id,refresh_hash,expires_at,refresh_expires_at,created_at) VALUES(?,?,?,?,?,?)',[
    await sha256(access),user.id,await sha256(refresh),new Date(Date.now()+3600000).toISOString(),new Date(Date.now()+30*86400000).toISOString(),stamp,
  ]);
  return {access_token:access,refresh_token:refresh,token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:publicUser(user)};
}

export async function userFromRequest(env:any,request:Request) {
  const authorization=request.headers.get('Authorization')||'';
  if (!authorization.startsWith('Bearer ')) return null;
  const hash=await sha256(authorization.slice(7));
  const row:any=await first(env,`SELECT u.* FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.access_hash=? AND s.expires_at>?`,[hash,now()]);
  return row||null;
}

async function issueToken(env:any,kind:'confirmation'|'recovery',userId:string,value:string) {
  await run(env,'DELETE FROM auth_verification_tokens WHERE user_id=? AND kind=?',[userId,kind]);
  await run(env,'INSERT INTO auth_verification_tokens(id,user_id,token_hash,kind,expires_at,created_at) VALUES(?,?,?,?,?,?)',[
    uuid(),userId,await sha256(value),kind,new Date(Date.now()+(kind==='recovery'?3600000:86400000)).toISOString(),now(),
  ]);
}

async function sendEmail(env:any,to:string,subject:string,html:string) {
  if (!env.RESEND_API_KEY||!env.RESEND_FROM) return false;
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({from:env.RESEND_FROM,to:[to],subject,html}),signal:AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('E-Mail-Versand fehlgeschlagen. Bitte später erneut versuchen.');
  return true;
}

function escapeHtml(value:string) {
  return value.replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]||c));
}

export async function auth(env:any,request:Request,path:string):Promise<Response> {
  const url=new URL(request.url);
  let body:any={};
  if (request.method!=='GET'&&request.headers.get('Content-Type')?.includes('application/json')) {
    try{body=await request.json();}catch{return authError('Ungültige Anfrage.');}
  }
  try {
    if (path==='/auth/v1/signup'&&request.method==='POST') {
      const email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) return authError('Bitte eine gültige E-Mail-Adresse eingeben.');
      if (password.length<8||password.length>128) return authError('Das Passwort muss zwischen 8 und 128 Zeichen haben.');
      const existing=await first(env,'SELECT id FROM auth_users WHERE email=?',[email]);
      if (existing) return authError('Diese E-Mail ist bereits registriert.',400,'user_already_exists');
      const record=await passwordRecord(password),id=uuid(),stamp=now();
      const emailEnabled=Boolean(env.RESEND_API_KEY&&env.RESEND_FROM);
      await run(env,'INSERT INTO auth_users(id,email,password_hash,password_salt,email_confirmed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',[
        id,email,record.hash,record.salt,emailEnabled?null:stamp,stamp,stamp,
      ]);
      const user:any=await first(env,'SELECT * FROM auth_users WHERE id=?',[id]);
      if (emailEnabled) {
        try {
          const confirmation=token(); await issueToken(env,'confirmation',id,confirmation);
          const link=new URL('/auth/v1/confirm',url.origin); link.searchParams.set('token',confirmation);
          await sendEmail(env,email,'Kontur-Konto bestätigen',`<p>Hallo,</p><p>bitte bestätige dein Kontur-Konto über diesen Link:</p><p><a href="${escapeHtml(link.toString())}">Konto bestätigen</a></p><p>Der Link ist 24 Stunden gültig.</p>`);
        } catch(error) {
          await run(env,'DELETE FROM auth_users WHERE id=? AND email_confirmed_at IS NULL',[id]);
          throw error;
        }
      }
      return json({user:publicUser(user),session:null,emailConfirmationRequired:emailEnabled},201);
    }
    if (path==='/auth/v1/token'&&request.method==='POST') {
      const grant=url.searchParams.get('grant_type');
      if (grant==='password') {
        const email=String(body.email||'').trim().toLowerCase(),user:any=await verifyCredentials(env,email,String(body.password||''));
        if (!user) return authError('E-Mail oder Passwort stimmt nicht.',400,'invalid_credentials');
        if (!user.email_confirmed_at) return authError('Bitte zuerst die Bestätigungs-E-Mail anklicken.',400,'email_not_confirmed');
        return json(await createSession(env,user));
      }
      if (grant==='refresh_token') {
        const hash=await sha256(String(body.refresh_token||''));
        const session:any=await first(env,'DELETE FROM auth_sessions WHERE refresh_hash=? AND refresh_expires_at>? RETURNING user_id',[hash,now()]);
        if (!session) return authError('Refresh token nicht gefunden.',400,'refresh_token_not_found');
        const user:any=await first(env,'SELECT * FROM auth_users WHERE id=?',[session.user_id]);
        if (!user) return authError('Refresh token nicht gefunden.',400,'refresh_token_not_found');
        return json(await createSession(env,user));
      }
      return authError('Ungültiger Anmeldetyp.');
    }
    if (path==='/auth/v1/user'&&request.method==='GET') {
      const user=await userFromRequest(env,request);
      return user?json(publicUser(user)):authError('Bitte erneut anmelden.',401,'invalid_token');
    }
    if (path==='/auth/v1/user'&&request.method==='PUT') {
      const user:any=await userFromRequest(env,request); if(!user) return authError('Bitte erneut anmelden.',401,'invalid_token');
      const password=String(body.password||''); if(password.length<8||password.length>128) return authError('Das Passwort muss zwischen 8 und 128 Zeichen haben.');
      const record=await passwordRecord(password);
      await run(env,'UPDATE auth_users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?',[record.hash,record.salt,now(),user.id]);
      const accessHash=await sha256((request.headers.get('Authorization')||'').slice(7));
      await run(env,'DELETE FROM auth_sessions WHERE user_id=? AND access_hash<>?',[user.id,accessHash]);
      return json(publicUser({...user,password_hash:record.hash,password_salt:record.salt}));
    }
    if (path==='/auth/v1/logout'&&request.method==='POST') {
      const hash=await sha256((request.headers.get('Authorization')||'').slice(7));
      await run(env,'DELETE FROM auth_sessions WHERE access_hash=?',[hash]); return json({});
    }
    if (path==='/auth/v1/recover'&&request.method==='POST') {
      if (!env.RESEND_API_KEY||!env.RESEND_FROM) return authError('Der E-Mail-Versand ist noch nicht eingerichtet. Bitte den Administrator kontaktieren.',503,'email_provider_not_configured');
      const email=String(body.email||'').trim().toLowerCase(),user:any=await first(env,'SELECT * FROM auth_users WHERE email=?',[email]);
      if (user) {
        const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,'0');
        await issueToken(env,'recovery',user.id,code);
        await sendEmail(env,email,'Kontur-Passwort zurücksetzen',`<p>Dein Wiederherstellungscode lautet:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>Der Code ist eine Stunde gültig.</p>`);
      }
      return json({});
    }
    if (path==='/auth/v1/verify'&&request.method==='POST'&&body.type==='recovery') {
      const email=String(body.email||'').trim().toLowerCase(),hash=await sha256(String(body.token||''));
      const row:any=await first(env,`SELECT u.*,v.id verification_id FROM auth_verification_tokens v JOIN auth_users u ON u.id=v.user_id WHERE u.email=? AND v.token_hash=? AND v.kind='recovery' AND v.used_at IS NULL AND v.expires_at>?`,[email,hash,now()]);
      if (!row) return authError('Der Wiederherstellungscode ist ungültig oder abgelaufen.',400,'invalid_token');
      await run(env,'UPDATE auth_verification_tokens SET used_at=? WHERE id=?',[now(),row.verification_id]);
      return json(await createSession(env,row));
    }
    if (path==='/auth/v1/confirm'&&request.method==='GET') {
      const hash=await sha256(url.searchParams.get('token')||'');
      const row:any=await first(env,`SELECT * FROM auth_verification_tokens WHERE token_hash=? AND kind='confirmation' AND used_at IS NULL AND expires_at>?`,[hash,now()]);
      if (!row) return new Response('Der Bestätigungslink ist ungültig oder abgelaufen.',{status:400,headers:{'Content-Type':'text/plain; charset=utf-8'}});
      await run(env,'UPDATE auth_verification_tokens SET used_at=? WHERE id=?',[now(),row.id]);
      await run(env,'UPDATE auth_users SET email_confirmed_at=COALESCE(email_confirmed_at,?),updated_at=? WHERE id=?',[now(),now(),row.user_id]);
      return Response.redirect(String(env.APP_URL||'https://ggjzmbvht4-sketch.github.io/Finazen/')+'#/settings',302);
    }
    if (path.startsWith('/auth/v1/admin/users/')&&request.method==='DELETE') {
      if (request.headers.get('apikey')!=='cloudflare-internal') return authError('Nicht autorisiert.',401);
      const id=decodeURIComponent(path.split('/').pop()||'');
      await run(env,'DELETE FROM auth_users WHERE id=?',[id]); return json({});
    }
    return authError('Endpunkt nicht gefunden.',404);
  } catch(error:any) {
    return authError(String(error?.message||'Anmeldung fehlgeschlagen.').replace(/[\r\n]+/g,' ').slice(0,300),500);
  }
}
