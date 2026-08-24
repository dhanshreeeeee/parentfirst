// ParentFirst — the care loop. The spine of the product.
//
// dose time ──60min──▶ gentle nudge to the elder ──60min──▶ alert the family
// 11:00 no check-in ──▶ warm nudge ──13:00 still silent──▶ alert the family
//
// Design rules learned from the evidence:
//  • Escalation is DEFAULT-ON (Medisafe's opt-in family alert saw ~7% uptake;
//    in a family app the escalation is the product).
//  • The elder-facing messages are warm, never surveillance-flavoured.
//  • Every send marks itself in loop_marks first — the loop can run every
//    minute, crash, restart, and never double-send.
import { notifyPeople, sendWhatsApp } from './notify.js';

const SLOT_TIMES = { morning: '08:00', afternoon: '14:00', night: '21:00' };
const NUDGE_AFTER_MIN = 60;
const ESCALATE_AFTER_MIN = 120;
const CHECKIN_NUDGE = '11:00';
const CHECKIN_ESCALATE = '13:00';

export function istNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}
const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const minsSince = (now, t) => {
  const [h, m] = t.split(':').map(Number);
  return (now.getHours() * 60 + now.getMinutes()) - (h * 60 + m);
};

export function startCareLoop(app, pool) {
  if (process.env.CARELOOP_DISABLED === '1') { app.log.info('care-loop: disabled'); return; }
  setInterval(() => runTick(app, pool, istNow()).catch((e) => app.log.error('care-loop: ' + e.message)), 60 * 1000);
  app.log.info('care-loop: running (nudge +60m, family alert +120m; check-in 11:00/13:00 IST)');
}

// exported separately so tests can drive it with an injected clock
export async function runTick(app, pool, now) {
  const today = now.toISOString().slice(0, 10);

  const { rows: elders } = await pool.query(`
    SELECT DISTINCT p.id, p.name, p.user_id, cp.phone
    FROM parents p
    LEFT JOIN care_profiles cp ON cp.parent_id = p.id
    JOIN family_members fm ON fm.parent_id = p.id AND fm.role IN ('admin','member')
    WHERE p.user_id IS NULL OR p.user_id <> fm.user_id`);

  for (const elder of elders) {
    try { await medLoop(app, pool, elder, now, today); } catch (e) { app.log.error(`care-loop meds ${elder.name}: ${e.message}`); }
    try { await checkinLoop(app, pool, elder, now, today); } catch (e) { app.log.error(`care-loop checkin ${elder.name}: ${e.message}`); }
  }
}

async function claim(pool, day, kind, refId, slot = '') {
  const { rowCount } = await pool.query(
    `INSERT INTO loop_marks (day, kind, ref_id, slot) VALUES ($1,$2,$3,$4)
     ON CONFLICT (day, kind, ref_id, slot) DO NOTHING`, [day, kind, refId, slot]);
  return rowCount === 1;
}

async function watchers(pool, elderId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.email FROM family_members fm JOIN users u ON u.id = fm.user_id
     WHERE fm.parent_id=$1 AND fm.role IN ('admin','member')
       AND (SELECT p.user_id FROM parents p WHERE p.id=$1) IS DISTINCT FROM u.id`, [elderId]);
  return rows;
}

async function medLoop(app, pool, elder, now, today) {
  for (const [slot, time] of Object.entries(SLOT_TIMES)) {
    const elapsed = minsSince(now, time);
    if (elapsed < NUDGE_AFTER_MIN) continue;

    const { rows: pending } = await pool.query(
      `SELECT m.id, m.name FROM medications m
       WHERE m.parent_id=$1 AND m.active=true AND m.slot_${slot}=true
         AND NOT EXISTS (SELECT 1 FROM medication_log ml
                         WHERE ml.medication_id=m.id AND ml.log_date=$2::date AND ml.slot=$3 AND ml.taken)`,
      [elder.id, today, slot]);
    if (!pending.length) continue;
    const names = pending.map((m) => m.name).slice(0, 4).join(', ');

    if (elapsed >= NUDGE_AFTER_MIN && elapsed < ESCALATE_AFTER_MIN) {
      if (await claim(pool, today, 'med_nudge', elder.id, slot)) {
        const msg = `Gentle reminder 🌼 — your ${slot} medicines are waiting: ${names}. Reply HO GAYA once taken.`;
        if (elder.user_id) { try { await app.sendPush([elder.user_id], 'Medicine time 🌼', names, '/'); } catch {} }
        if (elder.phone) { try { await sendWhatsApp(app, [elder.phone], msg); } catch {} }
        app.log.info(`care-loop: nudged ${elder.name} (${slot})`);
      }
    }

    if (elapsed >= ESCALATE_AFTER_MIN) {
      if (await claim(pool, today, 'med_escalate', elder.id, slot)) {
        const w = await watchers(pool, elder.id);
        if (w.length) {
          const first = (elder.name || '').split(' ')[0];
          const body = `${first} hasn't marked the ${slot} medicines yet (${names}). Worth a quick call — or tap "I checked" in the app if they've taken them.`;
          await pool.query(
            `INSERT INTO alerts (parent_id, severity, message, status) VALUES ($1,'alert',$2,'open')`,
            [elder.id, body]);
          try { await app.sendPush(w.map((x) => x.id), `⏰ ${first} — ${slot} medicines`, body, '/'); } catch {}
          try { await notifyPeople(app, w.map((x) => x.email), `${first} — ${slot} medicines unmarked`, [body]); } catch {}
          app.log.info(`care-loop: escalated ${elder.name} (${slot}) to ${w.length} watcher(s)`);
        }
      }
    }
  }
}

async function checkinLoop(app, pool, elder, now, today) {
  const t = hhmm(now);
  const { rows: ci } = await pool.query(
    `SELECT 1 FROM checkins WHERE parent_id=$1 AND created_at::date=$2::date LIMIT 1`, [elder.id, today]);
  if (ci.length) return;

  if (t >= CHECKIN_NUDGE && t < CHECKIN_ESCALATE) {
    if (await claim(pool, today, 'checkin_nudge', elder.id)) {
      const msg = `Good morning ☀️ Your family would love to hear how you're doing today. One tap in ParentFirst, or just reply here.`;
      if (elder.user_id) { try { await app.sendPush([elder.user_id], 'Good morning ☀️', 'How are you feeling today?', '/'); } catch {} }
      if (elder.phone) { try { await sendWhatsApp(app, [elder.phone], msg); } catch {} }
    }
  }

  if (t >= CHECKIN_ESCALATE) {
    if (await claim(pool, today, 'checkin_escalate', elder.id)) {
      const w = await watchers(pool, elder.id);
      if (w.length) {
        const first = (elder.name || '').split(' ')[0];
        const body = `${first} hasn't checked in today and it's past 1pm. Probably nothing — but a quick call would be good.`;
        await pool.query(
          `INSERT INTO alerts (parent_id, severity, message, status) VALUES ($1,'alert',$2,'open')`,
          [elder.id, body]);
        try { await app.sendPush(w.map((x) => x.id), `${first} — no check-in yet`, body, '/'); } catch {}
        try { await notifyPeople(app, w.map((x) => x.email), `${first} hasn't checked in today`, [body]); } catch {}
      }
    }
  }
}
