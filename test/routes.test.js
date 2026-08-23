// ParentFirst — route & authorization tests. NO DATABASE NEEDED.
//
// The pool is stubbed to return no rows for everything, which puts every
// membership and admin lookup in its "no" state — exactly where the gates
// must hold. So this suite answers two questions the architecture suite
// can't: are the paths registered without conflicting, and does anything
// answer to a request that carries no session?
//
// Run: node test/routes.test.js
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import familyRoutes from '../src/routes-family.js';
import careRoutes from '../src/routes-care.js';
import authPlugin from '../src/auth.js';

// Stub pool: no rows for anything, so every membership/admin check says "no".
// That is exactly the state we want to assert the gates in.
const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release(){} }) };
const app = Fastify({ logger: false });
app.decorate('sendPush', async () => {});
await app.register(cookie);
await app.register(authPlugin, { pool });
await app.register(familyRoutes, { pool });
await app.register(careRoutes, { pool, extractFromFile: async()=>({}), callClaude: async()=>'', hasKey: ()=>false });
await app.ready();

let pass=0, fail=0;
async function check(label, opts, expect){
  const r = await app.inject(opts);
  const ok = Array.isArray(expect) ? expect.includes(r.statusCode) : r.statusCode===expect;
  console.log(`  ${ok?'✓':'✗'} ${label} → ${r.statusCode}${ok?'':' (wanted '+expect+')'} ${ok?'':r.body.slice(0,120)}`);
  ok?pass++:fail++;
}

console.log('\nPUBLIC (must work with no session):');
await check('GET  /api/families/code/ABCD-2345/peek', {method:'GET', url:'/api/families/code/ABCD-2345/peek'}, 404); // reachable, no such family
await check('GET  /api/families/code/nope/peek     ', {method:'GET', url:'/api/families/code/nope/peek'}, 400);      // malformed, still reachable
await check('GET  /api/invitations/tok/peek        ', {method:'GET', url:'/api/invitations/tok/peek'}, 404);

console.log('\nGATED (no session → 401, never a leak):');
await check('POST /api/families/join               ', {method:'POST', url:'/api/families/join', payload:{code:'ABCD-2345'}}, 401);
await check('GET  /api/families/<id>/code          ', {method:'GET', url:'/api/families/11111111-1111-1111-1111-111111111111/code'}, 401);
await check('GET  /api/families/<id>/access        ', {method:'GET', url:'/api/families/11111111-1111-1111-1111-111111111111/access'}, 401);
await check('PATCH member role                     ', {method:'PATCH', url:'/api/families/11111111-1111-1111-1111-111111111111/members/22222222-2222-2222-2222-222222222222', payload:{role:'ADMIN'}}, 401);
await check('PUT  per-person permissions           ', {method:'PUT', url:'/api/families/11111111-1111-1111-1111-111111111111/access/2/3', payload:{permissions:{}}}, 401);
await check('POST add a person                     ', {method:'POST', url:'/api/families/11111111-1111-1111-1111-111111111111/persons', payload:{name:'Papa'}}, 401);
await check('GET  family members                   ', {method:'GET', url:'/api/families/11111111-1111-1111-1111-111111111111/members'}, 401);
await check('DEL  family event                     ', {method:'DELETE', url:'/api/families/11111111-1111-1111-1111-111111111111/events/33333333-3333-3333-3333-333333333333'}, 401);

console.log('\nSIGNUP validates the code before the email dance:');
await check('POST signup, malformed code           ', {method:'POST', url:'/api/auth/signup', payload:{email:'a@b.com',name:'A',password:'password123',join_code:'xyz'}}, 400);
await check('POST signup, unknown code             ', {method:'POST', url:'/api/auth/signup', payload:{email:'a@b.com',name:'A',password:'password123',join_code:'ZZZZ-9999'}}, 400);

await app.close();

// ── the OTP dev flag ────────────────────────────────────────────────
// SHOW_OTP_IN_UI=1 puts a verification code in the HTTP response, which in
// production would let anyone log in as anyone. It has to be impossible there,
// so the guard is tested rather than trusted.
const otpPool = { query: async (q) => (/INSERT INTO users/.test(q)
    ? { rows:[{ id:'u1', email:'a@b.com', name:'A' }] } : { rows:[] }),
  connect: async () => ({ query: async () => ({ rows: [] }), release(){} }) };

async function signupOnce(){
  const a = Fastify({ logger:false });
  await a.register(cookie); await a.register(authPlugin, { pool: otpPool });
  await a.ready();
  const r = await a.inject({ method:'POST', url:'/api/auth/signup',
    payload:{ email:'a@b.com', name:'A', password:'password123' } });
  await a.close();
  return JSON.parse(r.body);
}
function assertOtp(label, ok){ console.log(`  ${ok?'✓':'✗'} ${label}`); ok?pass++:fail++; }

console.log('\nOTP dev flag (must never fire in production):');
const prevFlag = process.env.SHOW_OTP_IN_UI, prevEnv = process.env.NODE_ENV;
delete process.env.SHOW_OTP_IN_UI; delete process.env.NODE_ENV;
let body = await signupOnce();
assertOtp('off by default — no code in the response', !('dev_code' in body));
assertOtp('reports honestly that the email did not send', body.email_sent === false);
process.env.SHOW_OTP_IN_UI = '1';
body = await signupOnce();
assertOtp('SHOW_OTP_IN_UI=1 in dev returns the code', /^[0-9]{6}$/.test(body.dev_code || ''));
process.env.NODE_ENV = 'production';
body = await signupOnce();
assertOtp('SHOW_OTP_IN_UI=1 in PRODUCTION is refused', !('dev_code' in body));
if (prevFlag === undefined) delete process.env.SHOW_OTP_IN_UI; else process.env.SHOW_OTP_IN_UI = prevFlag;
if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
