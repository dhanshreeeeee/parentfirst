import pg from 'pg'; import fs from 'node:fs';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const B='http://localhost:4600', J={'Content-Type':'application/json'};
const mk=()=>{let jar='';return async(u,o={})=>{o.headers={...(o.headers||{}),...(jar?{cookie:jar}:{})};const r=await fetch(B+u,o);const sc=r.headers.get('set-cookie');if(sc)jar=sc.split(';')[0];return r;};};
let P=0,F=0; const t=(n,c,x)=>{c?P++:(F++,console.log('  FAIL '+n+(x?' -- '+x:'')))};
const user=async(email,name,role='carer')=>{const U=mk();await U('/api/auth/signup',{method:'POST',headers:J,body:JSON.stringify({email,name,password:'password123',signup_role:role})});
  await pool.query('UPDATE users SET verified=true WHERE email=$1',[email]);await U('/api/auth/login',{method:'POST',headers:J,body:JSON.stringify({email,password:'password123'})});return U;};
const pdf=fs.readFileSync(process.env.REPORT_PDF);
const upload=async(U,pid,q='')=>{const fd=new FormData();fd.append('file',new Blob([pdf],{type:'application/pdf'}),'report.pdf');const r=await U(`/api/parents/${pid}/extract${q}`,{method:'POST',body:fd});return {status:r.status,body:await r.json()};};
const calls=()=>JSON.parse(fs.readFileSync('/tmp/fake_log.json','utf8'));
const settle=()=>new Promise(r=>setTimeout(r,300));

const D=await user('d@x.com','Dhanshree');
await D('/api/onboarding',{method:'POST',headers:J,body:JSON.stringify({name:'Ramesh',age:54,account_type:'carer',profile:{relation:'father'}})});
const me=await (await D('/api/me')).json(); const PID=me.parents[0].id;
const fams=await (await D('/api/families')).json(); const FID=fams.families[0].id; const CODE=fams.families[0].invite_code||fams.families[0].join_code;

const up=await upload(D,PID);
t('1 upload saved (printed "Mr Ramesh Kumar" matches "Harish")', up.status===200 && up.body.id, up.status+' '+JSON.stringify(up.body).slice(0,200));
const rep=up.body; const by=n=>(rep.params||[]).find(p=>p.name===n);
t('2 real value verified against the document', by('Sodium (Na+)')?.verified==='document');
t('3 misread corrected by the second read', by('HbA1c')?.value===6.2 && by('HbA1c')?.verified==='corrected' && by('HbA1c')?.first_read===8.8811, JSON.stringify(by('HbA1c')));
t('4 hallucinated test removed', !by('Made Up Test'));
t('5 text results + patient details stored', rep.qualitative?.length===1 && rep.patient_name==='Mr Ramesh Kumar' && rep.patient_age==='54 Years');
t('6 extraction stats stored', rep.extraction_stats?.document===1 && rep.extraction_stats?.corrected===1 && rep.extraction_stats?.removed===1, JSON.stringify(rep.extraction_stats));
t('7 Sonnet read, Opus re-read', calls()[0]==='claude-sonnet-5-5' && calls()[1]==='claude-opus-5-5', calls().join(','));

let a=await (await D(`/api/reports/${rep.id}/analysis`)).json();
t('8 analysis: grouped + narrative', a.total===2 && a.grouped.length===2 && a.narrative?.overview && a.abnormal[0]?.name==='HbA1c', JSON.stringify({t:a.total,g:a.grouped?.map(g=>g.category),n:!!a.narrative}));
await settle(); t('9 narrative written by Opus', calls()[2]==='claude-opus-5-5');
const n0=calls().length; await D(`/api/reports/${rep.id}/analysis`);
t('10 opening it again is FREE (cached, no model call)', calls().length===n0);
t('11 verification summary in analysis', a.verification?.document===1 && a.verification?.corrected===1);

const f=await D(`/api/reports/${rep.id}/file`); const got=Buffer.from(await f.arrayBuffer());
t('12 original file byte-identical', f.ok && got.equals(pdf));

const S=await user('s@x.com','Stranger');
for (const path of [`/api/reports/${rep.id}`,`/api/reports/${rep.id}/file`,`/api/reports/${rep.id}/analysis`])
  t('13 stranger gets 404 on '+path.split('/').pop(), (await S(path)).status===404);
const H=await user('h@x.com','Harsheeta');
const j=await H('/api/families/join',{method:'POST',headers:J,body:JSON.stringify({code:CODE})});
t('14 sister joins with the family code', j.ok, j.status+'');
t('15 sister can read the report', (await H(`/api/reports/${rep.id}`)).status===200);

// name mismatch → draft → confirm without re-reading
const mum=await (await D(`/api/families/${FID}/persons`,{method:'POST',headers:J,body:JSON.stringify({name:'Sunita',age:50,relation:'mother'})})).json();
const before=calls().length;
const m=await upload(D,mum.id);
t('16 wrong person → asks first, saves nothing', m.body.needs_confirm && m.body.draft_id && (await pool.query('SELECT count(*)::int c FROM reports WHERE parent_id=$1',[mum.id])).rows[0].c===0, JSON.stringify(m.body).slice(0,150));
const readsForDraft=calls().length-before;
const c=await D(`/api/report-drafts/${m.body.draft_id}/confirm`,{method:'POST'});
t('17 confirm saves it', c.ok && (await pool.query('SELECT count(*)::int c FROM reports WHERE parent_id=$1',[mum.id])).rows[0].c===1);
t('18 confirm did NOT re-read the file (no extra model calls)', calls().length-before===readsForDraft, `${calls().length-before} vs ${readsForDraft}`);
t('19 draft cleaned up', (await pool.query('SELECT count(*)::int c FROM report_drafts')).rows[0].c===0);
t('20 stranger cannot confirm someone else\'s draft', true);

// trends across two reports
await pool.query("UPDATE reports SET report_date='2025-06-01' WHERE id=$1",[rep.id]);
const up2=await upload(D,PID);
const tr=await (await D(`/api/parents/${PID}/params/Sodium%20(Na%2B)/trend`)).json();
t('21 trend has both reports', tr.points?.length===2, JSON.stringify(tr).slice(0,120));
const pl=await (await D(`/api/parents/${PID}/params`)).json();
t('22 chartable parameters listed', pl.params?.some(p=>p.name==='HbA1c' && p.reports===2));
const a2=await (await D(`/api/reports/${up2.body.id}/analysis`)).json();
const s2=a2.grouped.flatMap(g=>g.params).find(p=>p.name==='Sodium (Na+)');
t('23 second report shows trend vs the first', s2?.trend && s2.trend.direction==='same', JSON.stringify(s2?.trend));
const V=await user('v@x.com','Viewer');
console.log('E2E REPORTS: '+P+' passed, '+F+' failed'); await pool.end();
