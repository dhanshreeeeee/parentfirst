// Family digest — a short summary of each cared-for person, emailed to their
// carers three times a day (IST): morning, afternoon, night.
//
// The point: family shouldn't have to open the app to know the basics.
// "Did Papa check in? Did he take his morning medicines?" arrives by itself.
import { notifyPeople, sendWhatsApp } from './notify.js';

const SLOTS = [
  { name: 'morning',   hhmm: '09:00' },
  { name: 'afternoon', hhmm: '14:30' },
  { name: 'night',     hhmm: '21:15' },
];

const sent = new Set(); // `${date}|${slot}` — once per slot per day

function istNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

export function startDigest(app, pool) {
  if (process.env.DIGEST_DISABLED === '1') { app.log.info('digest: disabled'); return; }
  setInterval(() => runIfDue(app, pool).catch((e) => app.log.error('digest: ' + e.message)), 60 * 1000);
  app.log.info('digest: scheduler running (09:00, 14:30, 21:15 IST)');
}

async function runIfDue(app, pool) {
  const now = istNow();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const today = now.toISOString().slice(0, 10);
  const slot = SLOTS.find((s) => s.hhmm === hhmm);
  if (!slot) return;
  const key = `${today}|${slot.name}`;
  if (sent.has(key)) return;
  sent.add(key);

  // every person being cared for (has watchers beyond themselves)
  const { rows: elders } = await pool.query(`
    SELECT DISTINCT p.id, p.name FROM parents p
    JOIN family_members fm ON fm.parent_id = p.id AND fm.role IN ('admin','member')
    JOIN users u ON u.id = fm.user_id
    WHERE p.user_id IS NULL OR p.user_id <> fm.user_id`);

  for (const elder of elders) {
    try { await digestFor(app, pool, elder, slot, today); }
    catch (e) { app.log.error(`digest ${elder.name}: ${e.message}`); }
  }
}

async function digestFor(app, pool, elder, slot, today) {
  const lines = [];

  // check-in
  const { rows: ci } = await pool.query(
    `SELECT feeling, note, created_at FROM checkins
     WHERE parent_id=$1 AND created_at::date = $2::date ORDER BY created_at DESC LIMIT 1`,
    [elder.id, today]);
  if (ci[0]) {
    const f = { great: 'feeling great', good: 'doing okay', not_great: 'not feeling well', need_help: 'ASKED FOR HELP' }[ci[0].feeling] || ci[0].feeling;
    lines.push(`Check-in: ${f}${ci[0].note ? ' — "' + ci[0].note + '"' : ''}`);
  } else {
    lines.push('Check-in: not yet today');
  }

  // medicines
  const { rows: meds } = await pool.query(
    `SELECT m.name, m.slot_morning, m.slot_afternoon, m.slot_night,
            COALESCE(bool_or(ml.taken), false) AS taken
     FROM medications m
     LEFT JOIN medication_log ml ON ml.medication_id = m.id AND ml.log_date = $2::date
     WHERE m.parent_id=$1 AND m.active = true
     GROUP BY m.id`, [elder.id, today]);
  if (meds.length) {
    const taken = meds.filter((m) => m.taken).length;
    const pending = meds.filter((m) => !m.taken).map((m) => m.name);
    lines.push(`Medicines: ${taken}/${meds.length} marked taken today` +
      (pending.length && slot.name !== 'morning' ? ` — still pending: ${pending.slice(0, 4).join(', ')}` : ''));
  }

  // latest vital today
  const { rows: vt } = await pool.query(
    `SELECT systolic, diastolic, sugar, pulse FROM vitals
     WHERE parent_id=$1 AND taken_on=$2::date ORDER BY id DESC LIMIT 1`,
    [elder.id, today]);
  if (vt[0]) {
    const bits = [];
    if (vt[0].systolic) bits.push(`BP ${vt[0].systolic}/${vt[0].diastolic}`);
    if (vt[0].sugar) bits.push(`Sugar ${vt[0].sugar}`);
    if (vt[0].pulse) bits.push(`Pulse ${vt[0].pulse}`);
    if (bits.length) lines.push('Vitals: ' + bits.join(' · '));
  }

  // open alerts
  const { rows: al } = await pool.query(
    `SELECT count(*)::int AS n FROM alerts WHERE parent_id=$1 AND status='open'`, [elder.id]);
  if (al[0].n) lines.push(`⚠ ${al[0].n} open alert${al[0].n === 1 ? '' : 's'} — open the app`);

  // only send if there's something worth saying, or it's the night wrap-up
  if (lines.length <= 1 && slot.name !== 'night') return;

  const { rows: watchers } = await pool.query(
    `SELECT DISTINCT u.id, u.email FROM family_members fm JOIN users u ON u.id=fm.user_id
     WHERE fm.parent_id=$1 AND fm.role IN ('admin','member')
       AND (SELECT p.user_id FROM parents p WHERE p.id=$1) IS DISTINCT FROM u.id`, [elder.id]);
  if (!watchers.length) return;

  const title = { morning: 'Morning update', afternoon: 'Afternoon update', night: 'Tonight\'s wrap-up' }[slot.name];
  await notifyPeople(app, watchers.map((w) => w.email),
    `${title} — ${elder.name}`, lines);

  // same summary, everywhere the family actually looks
  try { await app.sendPush(watchers.map((w) => w.id), `${title} — ${elder.name}`, lines[0] || '', '/'); } catch {}
  try {
    const { rows: ph } = await pool.query(
      `SELECT cp.phone FROM care_profiles cp
       JOIN parents p ON p.id = cp.parent_id
       WHERE p.user_id = ANY($1::uuid[]) AND cp.phone IS NOT NULL`,
      [watchers.map((w) => w.id)]);
    if (ph.length) await sendWhatsApp(app, ph.map((x) => x.phone),
      `${title} — ${elder.name}\n\n` + lines.join('\n'));
  } catch {}
}
