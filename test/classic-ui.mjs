import { JSDOM } from 'jsdom'; import pg from 'pg'; import fs from 'node:fs';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const B='http://localhost:4600', J={'Content-Type':'application/json'};
let P=0,F=0; const t=(n,c,x)=>{c?P++:(F++,console.log('  FAIL '+n+(x?' -- '+x:'')))};
const jar=()=>{let JAR='';return async(u,o={})=>{const url=u.startsWith('http')?u:B+u;o.headers={...(o.headers||{}),...(JAR?{cookie:JAR}:{})};const r=await fetch(url,o);const sc=r.headers.get('set-cookie');if(sc)JAR=sc.split(';')[0];return r;};};
const user=async(email,name,role)=>{const f=jar();await f('/api/auth/signup',{method:'POST',headers:J,body:JSON.stringify({email,name,password:'password123',signup_role:role})});await pool.query('UPDATE users SET verified=true WHERE email=$1',[email]);return f;};
const open=async(f,email)=>{const html=await (await fetch(B+'/')).text();const errors=[];
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:B+'/',beforeParse(w){w.fetch=f;w.scrollTo=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){}});w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
    w.addEventListener('error',e=>errors.push(e.message));w.addEventListener('unhandledrejection',e=>errors.push('promise: '+(e.reason?.message||e.reason)));}});
  const d=dom.window.document; await new Promise(r=>setTimeout(r,900));
  d.getElementById('authEmail').value=email; d.getElementById('authPassword').value='password123'; d.getElementById('authBtn').click();
  await new Promise(r=>setTimeout(r,3000)); return {w:dom.window,d,errors};};
const vis=(w,el)=>el&&w.getComputedStyle(el).display!=='none';

// carer with a real uploaded + analysed report
const C=await user('c@x.com','Dhanshree','carer');
await C('/api/auth/login',{method:'POST',headers:J,body:JSON.stringify({email:'c@x.com',password:'password123'})});
await C('/api/onboarding',{method:'POST',headers:J,body:JSON.stringify({name:'Ramesh',age:54,account_type:'carer',profile:{relation:'father',smoking:'former'}})});
const PID=(await (await C('/api/me')).json()).parents[0].id;
const fd=new FormData(); fd.append('file',new Blob([fs.readFileSync(process.env.REPORT_PDF)],{type:'application/pdf'}),'r.pdf');
const rep=await (await C(`/api/parents/${PID}/extract`,{method:'POST',body:fd})).json();
t('setup: report saved', !!rep.id, JSON.stringify(rep).slice(0,120));
let {w,d,errors}=await open(C,'c@x.com');
t('C1 carer lands in carer view', [...d.querySelectorAll('.view.active')].some(v=>v.id==='view-monitor'));
const nav=[...d.querySelectorAll('.side-btn[data-v]')].filter(b=>b.style.display!=='none');
for(const b of nav){ b.click(); await new Promise(r=>setTimeout(r,450)); }
t('C2 every carer screen opens ('+nav.length+')', nav.length>=7);
await w.showDetail(rep.id); await new Promise(r=>setTimeout(r,1500));
const an=d.getElementById('repAnalysis')?.textContent||'';
t('C3 report analysis renders in the CURRENT UI', /values read/.test(an) && /Ask the doctor/.test(an) && /Outside range/.test(an), an.slice(0,160));
t('C4 verification line shown', /checked against the report/.test(an));
t('C5 per-row badges (✓ / corrected)', d.querySelectorAll('.vf-ok').length>=1 && d.querySelectorAll('.vf-fix').length>=1);
t('C6 text results shown', /Pale yellow/.test(an));
t('C7 zero page errors', errors.length===0, errors.slice(0,3).join(' | '));
// elder
const E=await user('e@x.com','Ramesh','parent');
({w,d,errors}=await open(E,'e@x.com'));
const byK=k=>[...d.querySelectorAll('#onbBody .onb-f')].find(i=>i.dataset.k===k);
if(byK('name')) byK('name').value='Ramesh'; if(byK('age')) byK('age').value='54';
for(let i=0;i<4;i++){ const nb=d.getElementById('onbNext'); if(nb&&vis(w,d.getElementById('onbOverlay'))) nb.click(); await new Promise(r=>setTimeout(r,800)); }
await new Promise(r=>setTimeout(r,1500));
t('E1 elder view', [...d.querySelectorAll('.view.active')].some(v=>v.id==='view-me'), [...d.querySelectorAll('.view.active')].map(v=>v.id).join());
for(const b of [...d.querySelectorAll('.side-btn[data-v]')].filter(b=>b.style.display!=='none')){ b.click(); await new Promise(r=>setTimeout(r,400)); }
t('E2 zero page errors', errors.length===0, errors.slice(0,3).join(' | '));
// sister signs up WITH the family code from the classic signup form
const fam=(await (await C('/api/families')).json()).families[0];
const S=jar(); ({w,d,errors}=await (async()=>{const html=await (await fetch(B+'/')).text();const errs=[];
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:B+'/',beforeParse(w){w.fetch=S;w.scrollTo=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){}});w.addEventListener('error',e=>errs.push(e.message));}});
  await new Promise(r=>setTimeout(r,900));return {w:dom.window,d:dom.window.document,errors:errs};})());
d.getElementById('authToggleLink')?.click(); await new Promise(r=>setTimeout(r,200));
d.getElementById('authName').value='Harsheeta'; d.getElementById('authEmail').value='h@x.com'; d.getElementById('authPassword').value='password123';
const codeEl=d.getElementById('authFamCode'); if(codeEl) codeEl.value=fam.join_code; if(process.env.CODE8) codeEl.value=fam.invite_code;
d.getElementById('authBtn').click(); await new Promise(r=>setTimeout(r,2000));
const code=(await pool.query("SELECT code FROM email_otps WHERE email='h@x.com'")).rows[0]?.code;
t('S1 OTP created for signup', !!code);
d.getElementById('otpCode').value=code; d.getElementById('otpVerifyBtn').click(); await new Promise(r=>setTimeout(r,3500));
t('S2 sister signed in via classic form', !vis(w,d.getElementById('authOverlay')));
t('S3 sister is in the family (6-char code still works)', (await pool.query("SELECT count(*)::int c FROM family_memberships m JOIN users u ON u.id=m.user_id WHERE u.email='h@x.com' AND m.family_id=$1",[fam.id])).rows[0].c===1);
t('S4 sister mapped to the person cared for', (await pool.query("SELECT count(*)::int c FROM care_relationships cr JOIN users u ON u.id=cr.caregiver_user_id WHERE u.email='h@x.com' AND cr.person_id=$1",[PID])).rows[0].c===1);
const famPage=(await (async()=>{ return true; })()); t('S5 zero page errors', errors.length===0, errors.slice(0,3).join(' | '));
console.log('CLASSIC UI ON V2 BACKEND: '+P+' passed, '+F+' failed'); await pool.end();
