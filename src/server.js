// ParentFirst Health Vault — API server
// Node 18+ (uses global fetch). Stack: Fastify + PostgreSQL.
import 'dotenv/config';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyCookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import pg from 'pg';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractLocal } from './extract-local.js';
import careRoutes from './routes-care.js';
import householdRoutes from './routes-household.js';
import authPlugin, { ensureSeed, roleAtLeast } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(__dirname, '..', 'data', 'reports');
// local calendar date (Postgres DATE columns are timezone-sensitive)
const localDateStr = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    `postgres://${process.env.USER || 'postgres'}@localhost:5432/parentfirst_vault`,
  // most hosted Postgres (Railway, Render, Neon, Supabase) requires SSL
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const IS_PROD = process.env.NODE_ENV === 'production';
const APP_ORIGIN = process.env.APP_ORIGIN || null;   // e.g. https://app.parentfirst.in

const app = Fastify({
  logger: true,
  trustProxy: IS_PROD,          // behind a hosting proxy, so client IPs are right
  bodyLimit: 2 * 1024 * 1024,
});

// security headers. CSP is deliberately permissive about images/fonts because
// the UI loads Google Fonts and YouTube thumbnails.
await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      // the UI uses onclick="" throughout — without this every button is dead
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://img.youtube.com'],
      mediaSrc: ["'self'", 'blob:'],
      frameSrc: ['https://www.youtube.com'],
      connectSrc: ["'self'", 'https://api.anthropic.com'],
      // deliberately NOT upgrade-insecure-requests: it breaks plain-http LAN use
    },
  },
  // HSTS would pin browsers to https:// even on the LAN — only enable behind a proxy
  hsts: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  crossOriginEmbedderPolicy: false,
});

// brute-force protection, tightest on the login route
await app.register(rateLimit, {
  global: false,
  max: 300,
  timeWindow: '1 minute',
  errorResponseBuilder: (req, ctx) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Too many attempts. Please wait ${Math.ceil(ctx.ttl / 1000)} seconds and try again.`,
  }),
});

// In production, only our own origin may call the API with credentials.
await app.register(cors, {
  origin: IS_PROD ? (APP_ORIGIN || false) : true,
  credentials: true,
});
await app.register(fastifyCookie);
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
});
// auth: session loading + login/signup/logout/me + access guards
await app.register(authPlugin, { pool });

// the caregiver's simple surface (its own page)
app.get('/caregiver', (req, reply) => reply.sendFile('caregiver.html'));

// ── helpers ─────────────────────────────────────────────────────
async function callClaude(content, maxTokens = 1024) {
  if (!ANTHROPIC_KEY) {
    const err = new Error('ANTHROPIC_API_KEY not set in .env');
    err.statusCode = 503;
    throw err;
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    err.statusCode = 502;
    throw err;
  }
  const data = await res.json();
  return data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

async function getRanges() {
  const { rows } = await pool.query('SELECT * FROM reference_ranges');
  const map = {};
  for (const r of rows) map[r.name] = { min: +r.min_value, max: +r.max_value, unit: r.unit };
  return map;
}

// Prefer the reference range printed on the report itself; fall back to our table.
function effectiveRange(ranges, p) {
  if (typeof p.ref_low === 'number' || typeof p.ref_high === 'number') {
    return {
      min: typeof p.ref_low === 'number' ? p.ref_low : -Infinity,
      max: typeof p.ref_high === 'number' ? p.ref_high : Infinity,
      unit: p.unit || '',
      text: p.ref_text || null,
      source: 'report',
    };
  }
  const r = ranges[p.name];
  return r ? { ...r, text: null, source: 'standard' } : null;
}
function statusFor(ranges, p) {
  const r = effectiveRange(ranges, p);
  if (!r) return 'unknown';
  if (p.value < r.min) return 'low';
  if (p.value > r.max) return 'high';
  return 'ok';
}

function statusOf(ranges, name, value) {
  const r = ranges[name];
  if (!r) return 'unknown';
  if (value < r.min) return 'low';
  if (value > r.max) return 'high';
  return 'ok';
}

async function fetchReportWithParams(reportId) {
  const { rows } = await pool.query('SELECT * FROM reports WHERE id=$1', [reportId]);
  if (!rows[0]) return null;
  const { rows: params } = await pool.query(
    `SELECT name, value::float AS value, unit,
            ref_low::float AS ref_low, ref_high::float AS ref_high, ref_text
     FROM report_params WHERE report_id=$1 ORDER BY name`,
    [reportId],
  );
  return { ...rows[0], params };
}

// ── health check ────────────────────────────────────────────────
app.get('/api/health', async () => {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return { ok: rows[0].ok === 1, ai: !!ANTHROPIC_KEY, model: ANTHROPIC_MODEL };
});

// ── parents (scoped to the logged-in user's family) ─────────────
app.get('/api/parents', async (req) => {
  const { rows } = await pool.query(
    `SELECT p.*, fm.role FROM family_members fm
     JOIN parents p ON p.id = fm.parent_id
     WHERE fm.user_id=$1 ORDER BY p.created_at`, [req.user.id]);
  return rows;
});

app.post('/api/parents', async (req, reply) => {
  const { name, age, relation, city } = req.body || {};
  if (!name) return reply.code(400).send({ error: 'name required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO parents (name, age, relation, city, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, age || null, relation || null, city || null, req.user.id],
    );
    // creator becomes admin of this parent
    await client.query(
      `INSERT INTO family_members (user_id, parent_id, role) VALUES ($1,$2,'admin')`,
      [req.user.id, rows[0].id]);
    await client.query('COMMIT');
    return { ...rows[0], role: 'admin' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// invite/add a family member to a parent (admin only) — by email
app.post('/api/parents/:parentId/members', async (req, reply) => {
  if (!roleAtLeast(req.parentRole, 'admin')) return reply.code(403).send({ error: 'admin only' });
  const { email, role } = req.body || {};
  if (!email || !role) return reply.code(400).send({ error: 'email and role required' });
  if (!['admin', 'member', 'caregiver'].includes(role)) return reply.code(400).send({ error: 'bad role' });
  const { rows: u } = await pool.query('SELECT id, name, email FROM users WHERE email=$1', [email.toLowerCase()]);
  if (!u[0]) return reply.code(404).send({ error: 'no user with that email — ask them to sign up first' });
  await pool.query(
    `INSERT INTO family_members (user_id, parent_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, parent_id) DO UPDATE SET role=$3`,
    [u[0].id, req.params.parentId, role]);
  return { added: { name: u[0].name, email: u[0].email, role } };
});

app.get('/api/parents/:parentId/members', async (req, reply) => {
  const { rows } = await pool.query(
    `SELECT u.name, u.email, fm.role FROM family_members fm
     JOIN users u ON u.id = fm.user_id WHERE fm.parent_id=$1 ORDER BY fm.role`,
    [req.params.parentId]);
  return rows;
});

// ── reports ─────────────────────────────────────────────────────
app.get('/api/parents/:parentId/reports', async (req) => {
  const ranges = await getRanges();
  const { rows: reports } = await pool.query(
    'SELECT * FROM reports WHERE parent_id=$1 ORDER BY report_date DESC',
    [req.params.parentId],
  );
  const out = [];
  for (const rep of reports) {
    const { rows: params } = await pool.query(
      `SELECT name, value::float AS value, unit,
              ref_low::float AS ref_low, ref_high::float AS ref_high, ref_text
       FROM report_params WHERE report_id=$1 ORDER BY name`,
      [rep.id],
    );
    let ok = 0, high = 0, low = 0;
    for (const p of params) {
      const s = statusFor(ranges, p);
      if (s === 'ok') ok++;
      else if (s === 'high') high++;
      else if (s === 'low') low++;
    }
    out.push({ ...rep, params, flags: { ok, high, low } });
  }
  return out;
});

app.get('/api/reports/:id', async (req, reply) => {
  const rep = await fetchReportWithParams(req.params.id);
  if (!rep) return reply.code(404).send({ error: 'not found' });
  const ranges = await getRanges();
  rep.params = rep.params.map((p) => {
    const r = effectiveRange(ranges, p);
    return { ...p, status: statusFor(ranges, p), range: r };
  });
  return rep;
});

app.delete('/api/reports/:id', async (req, reply) => {
  const { rows } = await pool.query(
    `SELECT fm.role FROM reports r
     JOIN family_members fm ON fm.parent_id = r.parent_id AND fm.user_id=$1
     WHERE r.id=$2`, [req.user.id, req.params.id]);
  if (!rows[0]) return reply.code(403).send({ error: 'no access' });
  if (!roleAtLeast(rows[0].role, 'admin')) return reply.code(403).send({ error: 'admin access required' });
  await pool.query('DELETE FROM reports WHERE id=$1', [req.params.id]);
  try { await fs.promises.unlink(path.join(REPORTS_DIR, req.params.id)); } catch { /* no file */ }
  return { deleted: true };
});

// stream the original uploaded file (access-checked)
app.get('/api/reports/:id/file', async (req, reply) => {
  const { rows } = await pool.query(
    `SELECT r.file_mime, r.file_name, r.has_file FROM reports r
     JOIN family_members fm ON fm.parent_id = r.parent_id AND fm.user_id=$1
     WHERE r.id=$2`, [req.user.id, req.params.id]);
  if (!rows[0]) return reply.code(403).send({ error: 'no access' });
  if (!rows[0].has_file) return reply.code(404).send({ error: 'no original file stored for this report' });
  const filePath = path.join(REPORTS_DIR, req.params.id);
  if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'file missing on disk' });
  reply.header('Content-Type', rows[0].file_mime || 'application/octet-stream');
  reply.header('Content-Disposition', `inline; filename="${(rows[0].file_name || 'report').replace(/"/g, '')}"`);
  return reply.send(fs.createReadStream(filePath));
});

// Manual report creation (no AI needed) — body: {parent_id, report_type, lab_name, doctor_name, report_date, params:[{name,value,unit}]}
app.post('/api/reports', async (req, reply) => {
  const { parent_id, report_type, lab_name, doctor_name, report_date, params } = req.body || {};
  if (!parent_id || !report_date || !Array.isArray(params) || params.length === 0) {
    return reply.code(400).send({ error: 'parent_id, report_date and params[] required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO reports (parent_id, report_type, lab_name, doctor_name, report_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [parent_id, report_type || 'Manual Report', lab_name || null, doctor_name || null, report_date],
    );
    const rep = rows[0];
    for (const p of params) {
      if (typeof p.value !== 'number') continue;
      await client.query(
        'INSERT INTO report_params (report_id, name, value, unit) VALUES ($1,$2,$3,$4)',
        [rep.id, p.name, p.value, p.unit || null],
      );
    }
    await client.query('COMMIT');
    return rep;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ── AI extraction: multipart upload (pdf/jpg/png) → parsed report in DB ──
app.post('/api/parents/:parentId/extract', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'file required (multipart field "file")' });
  const buf = await file.toBuffer();
  const isPdf = file.mimetype.includes('pdf');

  let obj = null;
  let method = 'local';

  // ── 1) FREE path: local text extraction for digital PDFs ──
  if (isPdf) {
    try {
      const local = await extractLocal(buf);
      if (local.ok) {
        obj = { type: local.type, lab: local.lab, doctor: local.doctor, date: local.date, params: local.params };
        app.log.info(`extract: local path succeeded (${local.params.length} params, no AI cost)`);
      } else {
        app.log.info(`extract: local path insufficient (${local.reason}) → AI fallback`);
      }
    } catch (e) {
      app.log.warn(`extract: local path errored (${e.message}) → AI fallback`);
    }
  }

  // ── 2) FALLBACK: AI vision (scanned PDFs, images, unknown layouts) ──
  if (!obj) {
    method = 'ai';
    const b64 = buf.toString('base64');
    const docBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: file.mimetype, data: b64 } };
    const instruction = {
      type: 'text',
      text: `Extract this medical/blood report into JSON ONLY (no markdown, no prose). Schema:
{"type":"report type","lab":"lab name","doctor":"doctor name or empty string","date":"YYYY-MM-DD","params":[{"name":"parameter name","value":number,"unit":"unit","ref_low":number or null,"ref_high":number or null,"ref_text":"the reference range exactly as printed, or empty"}]}
IMPORTANT: most lab reports print a reference/biological interval next to each result (e.g. "0.66 - 1.25", "137 - 145", "< 50", "up to 2.0"). Capture it: put the numeric bounds in ref_low/ref_high where you can, and the printed text in ref_text. For "< 50" use ref_low 0 and ref_high 50. If no range is printed, use null.
Use these canonical names where they match: Hemoglobin, HbA1c, Fasting Glucose, Total Cholesterol, LDL Cholesterol, HDL Cholesterol, Triglycerides, Creatinine, Vitamin D, Vitamin B12, TSH, Platelets, WBC.
Only include numeric parameters. Return ONLY the JSON object.`,
    };
    const raw = await callClaude([docBlock, instruction], 2048);
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
      obj = JSON.parse(clean);
    } catch {
      return reply.code(422).send({ error: 'AI returned unparseable JSON', raw: clean.slice(0, 500) });
    }
  }
  obj._method = method;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO reports (parent_id, report_type, lab_name, doctor_name, report_date, source_file, raw_extraction)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        req.params.parentId,
        obj.type || 'Uploaded Report',
        obj.lab || null,
        obj.doctor || null,
        obj.date || new Date().toISOString().slice(0, 10),
        file.filename,
        JSON.stringify(obj),
      ],
    );
    const rep = rows[0];
    for (const p of obj.params || []) {
      if (typeof p.value !== 'number') continue;
      await client.query(
        `INSERT INTO report_params (report_id, name, value, unit, ref_low, ref_high, ref_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [rep.id, p.name, p.value, p.unit || null,
         typeof p.ref_low === 'number' ? p.ref_low : null,
         typeof p.ref_high === 'number' ? p.ref_high : null,
         p.ref_text || null],
      );
    }
    // keep the original file on disk so it can be viewed later
    try {
      await fs.promises.mkdir(REPORTS_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(REPORTS_DIR, rep.id), buf);
      await client.query(
        'UPDATE reports SET has_file=true, file_name=$2, file_mime=$3 WHERE id=$1',
        [rep.id, file.filename, file.mimetype]);
    } catch (e) {
      app.log.warn('could not store original file: ' + e.message);
    }
    await client.query('COMMIT');
    return await fetchReportWithParams(rep.id);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ── compare two reports ─────────────────────────────────────────
app.get('/api/compare', async (req, reply) => {
  const { a, b } = req.query;
  if (!a || !b) return reply.code(400).send({ error: 'query params a and b (report ids) required' });
  const [ra, rb] = await Promise.all([fetchReportWithParams(a), fetchReportWithParams(b)]);
  if (!ra || !rb) return reply.code(404).send({ error: 'report not found' });
  const ranges = await getRanges();

  const names = [...new Set([...ra.params.map((p) => p.name), ...rb.params.map((p) => p.name)])];
  const rows = [];
  const onlyEarlier = [];
  const onlyLater = [];
  for (const n of names) {
    const pa = ra.params.find((p) => p.name === n);
    const pb = rb.params.find((p) => p.name === n);
    if (pa && !pb) { onlyEarlier.push({ name: n, value: pa.value, unit: pa.unit, status: statusFor(ranges, pa) }); continue; }
    if (pb && !pa) { onlyLater.push({ name: n, value: pb.value, unit: pb.unit, status: statusFor(ranges, pb) }); continue; }
    const diff = pb.value - pa.value;
    const pct = pa.value !== 0 ? (diff / pa.value) * 100 : 0;
    const r = effectiveRange(ranges, pb) || effectiveRange(ranges, pa);
    let improving = null;
    if (r && Number.isFinite(r.min) && Number.isFinite(r.max)) {
      const mid = (r.min + r.max) / 2;
      improving = Math.abs(pb.value - mid) < Math.abs(pa.value - mid);
    }
    rows.push({
      name: n,
      before: pa.value,
      after: pb.value,
      unit: pa.unit,
      change_pct: +pct.toFixed(1),
      before_status: statusFor(ranges, pa),
      after_status: statusFor(ranges, pb),
      improving,
    });
  }
  return {
    earlier: { id: ra.id, date: ra.report_date, type: ra.report_type },
    later: { id: rb.id, date: rb.report_date, type: rb.report_type },
    rows,
    only_earlier: onlyEarlier,
    only_later: onlyLater,
  };
});

// ── AI summary of a comparison ──────────────────────────────────
app.post('/api/compare/summary', async (req, reply) => {
  const { a, b } = req.body || {};
  if (!a || !b) return reply.code(400).send({ error: 'a and b report ids required' });
  if (!ANTHROPIC_KEY) return reply.code(200).send({ summary: null, no_key: true });
  const [ra, rb] = await Promise.all([fetchReportWithParams(a), fetchReportWithParams(b)]);
  if (!ra || !rb) return reply.code(404).send({ error: 'report not found' });
  const shared = ra.params.filter((p) => rb.params.some((q) => q.name === p.name)).map((p) => p.name);
  const dEarlier = String(ra.report_date).slice(0, 10);
  const dLater = String(rb.report_date).slice(0, 10);
  const prompt = `You are a careful health-report explainer for a family caregiver (not a doctor).

There are TWO reports. The EARLIER one is dated ${dEarlier}. The LATER (most recent) one is dated ${dLater}. "Change" always means what happened going FROM the earlier date TO the later date. Never describe the earlier report as the recent one.

${shared.length === 0
  ? 'IMPORTANT: these two reports share NO parameters in common — they are different kinds of test panels. Say so plainly in one sentence, describe what the LATER report shows on its own (flagging anything outside its reference range), and do not invent comparisons.'
  : `These parameters appear in both and can be compared: ${shared.join(', ')}. Only describe changes for those. Mention briefly that the rest of each report cannot be compared because the panels differ.`}

Write 3-4 warm, plain-English sentences. Flag anything outside its reference range clearly and without alarm. Do NOT diagnose. End by suggesting they discuss anything concerning with their doctor.

EARLIER report (${dEarlier}, ${ra.report_type}): ${JSON.stringify(ra.params)}
LATER report (${dLater}, ${rb.report_type}): ${JSON.stringify(rb.params)}`;
  try {
    const text = await callClaude(prompt);
    return { summary: text };
  } catch (e) {
    return reply.code(200).send({ summary: null, error: 'The AI summary is temporarily unavailable. The comparison above is still accurate.' });
  }
});

// ── AI chat grounded in the vault ───────────────────────────────
app.post('/api/parents/:parentId/chat', async (req, reply) => {
  const { question } = req.body || {};
  if (!question) return reply.code(400).send({ error: 'question required' });
  if (!ANTHROPIC_KEY) return reply.code(200).send({ answer: null, no_key: true });
  const pid = req.params.parentId;

  const { rows: reports } = await pool.query(
    'SELECT id, report_type, report_date FROM reports WHERE parent_id=$1 ORDER BY report_date', [pid]);
  const lines = [];
  for (const rep of reports) {
    const { rows: params } = await pool.query(
      'SELECT name, value::float AS value, unit FROM report_params WHERE report_id=$1', [rep.id]);
    lines.push(`${rep.report_date} (${rep.report_type}): ${params.map((p) => `${p.name} ${p.value}${p.unit || ''}`).join(', ')}`);
  }
  // broaden context: meds, recent daily logs, upcoming appointments
  const { rows: meds } = await pool.query(
    'SELECT name, dosage, slot_morning, slot_afternoon, slot_night FROM medications WHERE parent_id=$1 AND active=true', [pid]);
  const medLines = meds.map((m) => `${m.name}${m.dosage ? ' ' + m.dosage : ''} (${['morning', 'afternoon', 'night'].filter((s) => m[`slot_${s}`]).join('/') || '—'})`);
  const { rows: logs } = await pool.query(
    'SELECT log_date, mood, ate_well, notes FROM daily_logs WHERE parent_id=$1 ORDER BY log_date DESC LIMIT 5', [pid]);
  const logLines = logs.map((l) => `${l.log_date}: mood ${l.mood || '-'}, ate ${l.ate_well || '-'}${l.notes ? ' — ' + l.notes : ''}`);
  const { rows: appts } = await pool.query(
    `SELECT title, with_whom, appt_date FROM appointments WHERE parent_id=$1 AND status='upcoming' ORDER BY appt_date LIMIT 5`, [pid]);
  const apptLines = appts.map((a) => `${a.appt_date}: ${a.title}${a.with_whom ? ' with ' + a.with_whom : ''}`);

  const prompt = `You are a caring health companion helping a family member understand how their parent is doing. Answer ONLY using the data below. Be warm and brief. Never diagnose — suggest consulting a doctor for anything concerning.

BLOOD REPORTS:
${lines.join('\n') || 'none'}

CURRENT MEDICINES:
${medLines.join('\n') || 'none'}

RECENT DAILY CARE LOGS:
${logLines.join('\n') || 'none'}

UPCOMING APPOINTMENTS:
${apptLines.join('\n') || 'none'}

QUESTION: ${question}`;
  try {
    const text = await callClaude(prompt);
    return { answer: text };
  } catch (e) {
    return reply.code(200).send({ answer: null, error: 'The assistant is unavailable right now. Please try again in a moment.' });
  }
});

// ── trends for a parameter across all reports ───────────────────
app.get('/api/parents/:parentId/trends', async (req) => {
  const ranges = await getRanges();
  const { rows } = await pool.query(
    `SELECT rp.name, rp.value::float AS value, rp.unit, r.report_date
     FROM report_params rp JOIN reports r ON r.id = rp.report_id
     WHERE r.parent_id=$1 ORDER BY rp.name, r.report_date`,
    [req.params.parentId],
  );
  const byName = {};
  for (const row of rows) {
    byName[row.name] ||= { name: row.name, unit: row.unit, range: ranges[row.name] || null, points: [] };
    byName[row.name].points.push({ date: row.report_date, value: row.value });
  }
  return Object.values(byName);
});

// ── care modules (medications, daily logs, emergency card) ──────
await app.register(householdRoutes, { pool });

await app.register(careRoutes, {
  pool,
  callClaude,
  hasKey: () => !!ANTHROPIC_KEY,
  roleAtLeast,
});


// ── document vault: upload & download ───────────────────────────
const DOCS_DIR = path.join(__dirname, '..', 'data', 'documents');

app.post('/api/parents/:parentId/documents', async (req, reply) => {
  if (!roleAtLeast(req.parentRole, 'member')) return reply.code(403).send({ error: 'member access required' });
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'file required' });
  const title = (file.fields?.title?.value) || file.filename;
  const category = (file.fields?.category?.value) || 'other';
  const buf = await file.toBuffer();
  const { rows } = await pool.query(
    `INSERT INTO documents (parent_id, title, category, file_name, file_mime, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.params.parentId, title, category, file.filename, file.mimetype, req.user.id]);
  await fs.promises.mkdir(DOCS_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(DOCS_DIR, rows[0].id), buf);
  return rows[0];
});

app.get('/api/documents/:id/file', async (req, reply) => {
  const { rows } = await pool.query(
    `SELECT d.file_mime, d.file_name FROM documents d
     JOIN family_members fm ON fm.parent_id=d.parent_id AND fm.user_id=$1
     WHERE d.id=$2`, [req.user.id, req.params.id]);
  if (!rows[0]) return reply.code(403).send({ error: 'no access' });
  const p = path.join(DOCS_DIR, req.params.id);
  if (!fs.existsSync(p)) return reply.code(404).send({ error: 'file missing' });
  reply.header('Content-Type', rows[0].file_mime || 'application/octet-stream');
  reply.header('Content-Disposition', `inline; filename="${(rows[0].file_name || 'document').replace(/"/g, '')}"`);
  return reply.send(fs.createReadStream(p));
});

// ── prescription scan: photo/PDF → medicines with reminders ─────
app.post('/api/parents/:parentId/prescription', async (req, reply) => {
  if (!(roleAtLeast(req.parentRole, 'admin') || req.parentRole === 'dependent')) {
    return reply.code(403).send({ error: 'not allowed to add medicines' });
  }
  if (!ANTHROPIC_KEY) {
    return reply.code(200).send({ ok: false, no_key: true,
      error: 'Reading a prescription needs an Anthropic API key. Add ANTHROPIC_API_KEY to .env, or add the medicines by hand.' });
  }
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'file required' });
  const buf = await file.toBuffer();
  const b64 = buf.toString('base64');
  const isPdf = file.mimetype.includes('pdf');
  const docBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: file.mimetype, data: b64 } };

  const instruction = { type: 'text', text: `Read this doctor's prescription and return JSON ONLY (no markdown, no prose):
{"doctor":"doctor name or empty","date":"YYYY-MM-DD or empty","medicines":[{"name":"medicine name","dosage":"e.g. 500mg","times":["HH:MM"],"notes":"e.g. after food","frequency":"daily"}]}
Rules:
- Indian prescriptions often write frequency as 1-0-1 (morning-afternoon-night). Convert: 1-0-0 → times ["08:00"]; 1-0-1 → ["08:00","21:00"]; 1-1-1 → ["08:00","14:00","21:00"]; 0-0-1 → ["21:00"].
- Put instructions like "after food", "before food", "with milk" into notes.
- If a medicine is weekly, set frequency "weekly" and note the day.
- Only include medicines you can actually read. If the handwriting is unclear for a medicine, omit it rather than guessing.
Return ONLY the JSON object.` };

  let obj;
  try {
    const raw = await callClaude([docBlock, instruction], 2048);
    obj = JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());
  } catch (e) {
    return reply.code(200).send({ ok: false, error: 'Could not read that prescription clearly. Try a sharper photo, or add the medicines by hand.' });
  }
  const meds = Array.isArray(obj.medicines) ? obj.medicines : [];
  if (!meds.length) {
    return reply.code(200).send({ ok: false, error: 'No medicines could be read from that image. Try a sharper, well-lit photo.' });
  }

  const client = await pool.connect();
  const created = [];
  try {
    await client.query('BEGIN');
    // keep the prescription itself in the vault
    const { rows: rep } = await client.query(
      `INSERT INTO reports (parent_id, report_type, doctor_name, report_date, source_file, doc_kind, raw_extraction)
       VALUES ($1,'Prescription',$2,$3,$4,'prescription',$5) RETURNING id`,
      [req.params.parentId, obj.doctor || null, obj.date || localDateStr(), file.filename, JSON.stringify(obj)]);
    try {
      await fs.promises.mkdir(REPORTS_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(REPORTS_DIR, rep[0].id), buf);
      await client.query('UPDATE reports SET has_file=true, file_name=$2, file_mime=$3 WHERE id=$1',
        [rep[0].id, file.filename, file.mimetype]);
    } catch { /* file storage is best-effort */ }

    for (const m of meds) {
      if (!m.name) continue;
      const times = Array.isArray(m.times) && m.times.length ? m.times : ['08:00'];
      const slots = { slot_morning: false, slot_afternoon: false, slot_night: false };
      for (const t of times) {
        const h = +String(t).split(':')[0];
        if (h < 12) slots.slot_morning = true; else if (h < 17) slots.slot_afternoon = true; else slots.slot_night = true;
      }
      const { rows } = await client.query(
        `INSERT INTO medications (parent_id, name, dosage, slot_morning, slot_afternoon, slot_night, notes, times, frequency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, name, dosage, times, notes`,
        [req.params.parentId, m.name, m.dosage || null, slots.slot_morning, slots.slot_afternoon,
         slots.slot_night, m.notes || null, times, m.frequency || 'daily']);
      created.push(rows[0]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return reply.code(500).send({ error: e.message });
  } finally { client.release(); }

  return { ok: true, doctor: obj.doctor || null, date: obj.date || null, medicines: created };
});

// ── plain-English analysis of one report ────────────────────────
// Deliberately NOT a diagnosis: it says what is outside range, how far,
// and how promptly it's worth showing someone. It never names a condition.
app.get('/api/reports/:id/analysis', async (req, reply) => {
  const { rows: chk } = await pool.query(
    `SELECT 1 FROM reports r JOIN family_members fm ON fm.parent_id=r.parent_id AND fm.user_id=$1
     WHERE r.id=$2`, [req.user.id, req.params.id]);
  if (!chk[0]) return reply.code(403).send({ error: 'no access' });

  const rep = await fetchReportWithParams(req.params.id);
  if (!rep) return reply.code(404).send({ error: 'not found' });
  const ranges = await getRanges();

  const flagged = [];
  let unknown = 0;
  for (const p of rep.params) {
    const r = effectiveRange(ranges, p);
    if (!r) { unknown++; continue; }
    const status = statusFor(ranges, p);
    if (status === 'ok' || status === 'unknown') continue;
    // how far outside, as a multiple of the healthy band width
    const width = (Number.isFinite(r.max) && Number.isFinite(r.min) && r.max > r.min) ? (r.max - r.min) : Math.abs(p.value) || 1;
    const over = status === 'high' ? p.value - r.max : r.min - p.value;
    const ratio = over / width;
    const degree = ratio > 1.5 ? 'marked' : ratio > 0.4 ? 'notable' : 'slight';
    flagged.push({
      name: p.name, value: p.value, unit: p.unit || '',
      status, degree, ratio: +ratio.toFixed(2),
      range: { min: r.min, max: r.max, text: r.text },
    });
  }
  const order = { marked: 0, notable: 1, slight: 2 };
  flagged.sort((a, b) => order[a.degree] - order[b.degree] || b.ratio - a.ratio);

  const marked = flagged.filter((f) => f.degree === 'marked');
  const notable = flagged.filter((f) => f.degree === 'notable');
  const inRange = rep.params.length - flagged.length - unknown;

  let level, headline, advice;
  if (!flagged.length) {
    level = 'good';
    headline = 'Nothing in this report stands out.';
    advice = 'Everything that could be checked sits inside its reference range. Worth keeping for the record.';
  } else if (marked.length >= 2) {
    level = 'urgent';
    headline = `${flagged.length} value${flagged.length === 1 ? '' : 's'} are outside their range, and ${marked.length} of them by a wide margin.`;
    advice = 'This is worth showing a doctor soon rather than waiting for the next routine visit. Take the original report with you.';
  } else if (marked.length === 1) {
    level = 'urgent';
    headline = `${marked[0].name} is well outside its range, along with ${flagged.length - 1} other value${flagged.length - 1 === 1 ? '' : 's'}.`;
    advice = 'Worth showing a doctor soon rather than waiting. Take the original report with you.';
  } else if (notable.length) {
    level = 'watch';
    headline = `${flagged.length} value${flagged.length === 1 ? ' is' : 's are'} outside the normal range.`;
    advice = 'Worth raising with the doctor — at the next visit if there are no symptoms, sooner if anything feels off.';
  } else {
    level = 'watch';
    headline = `${flagged.length} value${flagged.length === 1 ? ' is' : 's are'} slightly outside the normal range.`;
    advice = 'Mild differences are common and often not a concern on their own. Worth mentioning at the next visit.';
  }

  return {
    level, headline, advice,
    flagged, in_range: inRange, unreadable: unknown,
    report: { id: rep.id, type: rep.report_type, date: rep.report_date, lab: rep.lab_name },
    disclaimer: 'This is a plain reading of the numbers against the ranges printed on the report — not a diagnosis. Only a doctor can say what it means.',
  };
});

// optional warm AI narrative over that analysis
app.post('/api/reports/:id/explain', async (req, reply) => {
  if (!ANTHROPIC_KEY) return reply.send({ summary: null, no_key: true });
  const { rows: chk } = await pool.query(
    `SELECT 1 FROM reports r JOIN family_members fm ON fm.parent_id=r.parent_id AND fm.user_id=$1
     WHERE r.id=$2`, [req.user.id, req.params.id]);
  if (!chk[0]) return reply.code(403).send({ error: 'no access' });
  const rep = await fetchReportWithParams(req.params.id);
  if (!rep) return reply.code(404).send({ error: 'not found' });
  const ranges = await getRanges();
  const lines = rep.params.map((p) => {
    const r = effectiveRange(ranges, p);
    return `${p.name}: ${p.value}${p.unit || ''}${r ? ` (range ${Number.isFinite(r.min) ? r.min : '—'}–${Number.isFinite(r.max) ? r.max : '—'}, ${statusFor(ranges, p)})` : ' (no range available)'}`;
  });
  try {
    const summary = await callClaude(`You are explaining a lab report to a worried family member — not a doctor, and NOT diagnosing.

Rules you must follow:
- Never name or suggest a disease, condition or cause. Not even as a possibility.
- Say plainly which values are outside their range and roughly how far.
- Be calm and clear. Do not minimise genuinely abnormal results, and do not frighten.
- If several values are well outside range, say it deserves a doctor's attention soon.
- Suggest what to take to the appointment (the original report, any earlier ones).
- 4-5 sentences, warm and readable.

REPORT: ${rep.report_type}, ${String(rep.report_date).slice(0, 10)}${rep.lab_name ? ', ' + rep.lab_name : ''}
${lines.join('\n')}`, 500);
    return { summary };
  } catch (e) {
    return reply.send({ summary: null, error: 'The explanation is unavailable right now — the readings above are still accurate.' });
  }
});

// ── voice notes on messages ─────────────────────────────────────
const MEDIA_DIR = path.join(__dirname, '..', 'data', 'media');

app.post('/api/parents/:parentId/messages/voice', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'audio required' });
  const buf = await file.toBuffer();
  const body = (file.fields?.body?.value) || '';
  const secs = +(file.fields?.secs?.value || 0) || null;
  const dir = (file.fields?.direction?.value) === 'from_parent' ? 'from_parent' : 'to_parent';
  const kind = (file.mimetype || '').startsWith('image/') ? 'image' : 'audio';

  const { rows } = await pool.query(
    `INSERT INTO messages (parent_id, from_user_id, direction, body, media_kind, media_mime, media_secs, has_media)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
    [req.params.parentId, req.user.id, dir, body || (kind === 'audio' ? 'Voice note' : 'Photo'),
     kind, file.mimetype, secs]);
  await fs.promises.mkdir(MEDIA_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(MEDIA_DIR, rows[0].id), buf);
  return rows[0];
});

app.get('/api/messages/:id/media', async (req, reply) => {
  const { rows } = await pool.query(
    `SELECT m.media_mime FROM messages m
     JOIN family_members fm ON fm.parent_id = m.parent_id AND fm.user_id=$1
     WHERE m.id=$2`, [req.user.id, req.params.id]);
  if (!rows[0]) return reply.code(403).send({ error: 'no access' });
  const p = path.join(MEDIA_DIR, req.params.id);
  if (!fs.existsSync(p)) return reply.code(404).send({ error: 'media missing' });
  reply.header('Content-Type', rows[0].media_mime || 'application/octet-stream');
  return reply.send(fs.createReadStream(p));
});

const port = +(process.env.PORT || 4500);
app.listen({ port, host: '0.0.0.0' }).then(async () => {
  console.log(`ParentFirst Vault API on http://localhost:${port}`);
  try {
    const seeded = await ensureSeed(pool);
    if (seeded) {
      console.log('──────────────────────────────────────────────');
      console.log(' First run: a default account was created.');
      console.log(`   Email:    ${seeded.email}`);
      console.log(`   Password: ${seeded.password}`);
      console.log(' Log in, then change it. All demo data is linked to it.');
      console.log('──────────────────────────────────────────────');
    }
  } catch (e) {
    app.log.error('seed failed: ' + e.message);
  }
});
