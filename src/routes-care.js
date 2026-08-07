import { notifyOperator, notifyPeople } from './notify.js';
// Care modules: medications, caregiver daily logs (+ family update), emergency card.
// Registered as a Fastify plugin from server.js.

export default async function careRoutes(app, { pool, callClaude, hasKey, roleAtLeast }) {
  const SLOTS = ['morning', 'afternoon', 'night'];
  // Dates: Postgres DATE columns come back as LOCAL midnight, so converting with
  // toISOString() shifts the day backwards in any timezone ahead of UTC (e.g. IST).
  // Always compare/store using the local calendar date.
  const localDate = (d = new Date()) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);


  const need = (req, reply, role) => {
    if (!roleAtLeast(req.parentRole, role)) { reply.code(403).send({ error: `${role} access required` }); return false; }
    return true;
  };
  // medicines: an admin, or the elder managing their own list
  const canManageMeds = (role) => role === 'admin' || role === 'dependent';
  const needMeds = (req, reply) => {
    if (!canManageMeds(req.parentRole)) { reply.code(403).send({ error: 'not allowed to change medicines' }); return false; }
    return true;
  };

  // ────────────────────────── MEDICATIONS ──────────────────────────
  app.get('/api/parents/:parentId/medications', async (req) => {
    const { rows } = await pool.query(
      'SELECT * FROM medications WHERE parent_id=$1 AND active=true ORDER BY created_at',
      [req.params.parentId],
    );
    return rows;
  });

  app.post('/api/parents/:parentId/medications', async (req, reply) => {
    if (!needMeds(req, reply)) return;
    const { name, dosage, slot_morning, slot_afternoon, slot_night, notes,
            days_of_week, times, frequency } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'name required' });
    const { rows } = await pool.query(
      `INSERT INTO medications (parent_id, name, dosage, slot_morning, slot_afternoon, slot_night, notes,
         days_of_week, times, frequency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.params.parentId, name, dosage || null, !!slot_morning, !!slot_afternoon, !!slot_night, notes || null,
       Array.isArray(days_of_week) && days_of_week.length ? days_of_week : null,
       Array.isArray(times) && times.length ? times : null,
       frequency || 'daily'],
    );
    return rows[0];
  });

  // What's due around now — the frontend polls this to raise reminders.
  // Returns doses scheduled within the last `window` minutes that aren't ticked off.
  app.get('/api/parents/:parentId/medications/due', async (req) => {
    const windowMin = Math.min(+(req.query.window || 30), 180);
    const now = new Date();
    const today = localDate(now);
    const dow = now.getDay();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const { rows: meds } = await pool.query(
      'SELECT * FROM medications WHERE parent_id=$1 AND active=true', [req.params.parentId]);
    const { rows: logs } = await pool.query(
      `SELECT ml.medication_id, ml.slot FROM medication_log ml
       JOIN medications m ON m.id=ml.medication_id
       WHERE m.parent_id=$1 AND ml.log_date=$2 AND ml.taken=true`, [req.params.parentId, today]);
    const taken = new Set(logs.map((l) => `${l.medication_id}:${l.slot}`));

    const slotFor = (hhmm) => {
      const h = +hhmm.split(':')[0];
      return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'night';
    };
    const due = [];
    for (const m of meds) {
      // scheduled today?
      if (Array.isArray(m.days_of_week) && m.days_of_week.length && !m.days_of_week.includes(dow)) continue;
      const times = (m.times && m.times.length) ? m.times : [];
      for (const t of times) {
        const [hh, mm] = t.split(':').map(Number);
        if (Number.isNaN(hh)) continue;
        const tMin = hh * 60 + (mm || 0);
        const delta = nowMin - tMin;
        if (delta < 0 || delta > windowMin) continue;   // not yet, or too long ago
        const slot = slotFor(t);
        if (taken.has(`${m.id}:${slot}`)) continue;      // already given
        due.push({ id: m.id, name: m.name, dosage: m.dosage, notes: m.notes, time: t, slot, minutes_late: delta });
      }
    }
    return { now: now.toISOString(), due };
  });

  // resolve the parent behind a medication and check the user's role on it
  async function medRole(req) {
    const { rows } = await pool.query(
      `SELECT fm.role FROM medications m
       JOIN family_members fm ON fm.parent_id = m.parent_id AND fm.user_id=$1
       WHERE m.id=$2`, [req.user.id, req.params.id]);
    return rows[0]?.role || null;
  }

  app.delete('/api/medications/:id', async (req, reply) => {
    const role = await medRole(req);
    if (!role) return reply.code(403).send({ error: 'no access' });
    if (!canManageMeds(role)) return reply.code(403).send({ error: 'not allowed to change medicines' });
    await pool.query('UPDATE medications SET active=false WHERE id=$1', [req.params.id]);
    return { deactivated: true };
  });

  // Mark a dose taken / untaken for a slot on a date (any role incl. caregiver)
  app.post('/api/medications/:id/log', async (req, reply) => {
    const role = await medRole(req);
    if (!role) return reply.code(403).send({ error: 'no access' });
    const { slot, taken, date } = req.body || {};
    if (!SLOTS.includes(slot)) return reply.code(400).send({ error: 'slot must be morning|afternoon|night' });
    const logDate = date || localDate();
    if (taken === false) {
      await pool.query('DELETE FROM medication_log WHERE medication_id=$1 AND log_date=$2 AND slot=$3',
        [req.params.id, logDate, slot]);
      return { taken: false };
    }
    await pool.query(
      `INSERT INTO medication_log (medication_id, log_date, slot, taken)
       VALUES ($1,$2,$3,true)
       ON CONFLICT (medication_id, log_date, slot) DO UPDATE SET taken=true, taken_at=now()`,
      [req.params.id, logDate, slot],
    );
    return { taken: true };
  });

  // Today's schedule grouped by slot, with taken status + adherence %
  app.get('/api/parents/:parentId/medications/today', async (req) => {
    const date = req.query.date || localDate();
    const { rows: meds } = await pool.query(
      'SELECT * FROM medications WHERE parent_id=$1 AND active=true ORDER BY name',
      [req.params.parentId],
    );
    const { rows: logs } = await pool.query(
      `SELECT ml.medication_id, ml.slot FROM medication_log ml
       JOIN medications m ON m.id = ml.medication_id
       WHERE m.parent_id=$1 AND ml.log_date=$2 AND ml.taken=true`,
      [req.params.parentId, date],
    );
    const takenSet = new Set(logs.map((l) => `${l.medication_id}:${l.slot}`));
    const schedule = { morning: [], afternoon: [], night: [] };
    let due = 0, done = 0;
    const slotOf = (t) => { const h = +String(t).split(':')[0]; return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'night'; };
    for (const m of meds) {
      // map any specific times onto their slot so the card can show "8:00 AM"
      const timesBySlot = {};
      for (const t of (m.times || [])) { (timesBySlot[slotOf(t)] ||= []).push(t); }
      for (const slot of SLOTS) {
        if (!m[`slot_${slot}`]) continue;
        due++;
        const taken = takenSet.has(`${m.id}:${slot}`);
        if (taken) done++;
        schedule[slot].push({
          id: m.id, name: m.name, dosage: m.dosage, notes: m.notes, taken,
          time: (timesBySlot[slot] || []).join(', ') || null,
          days_of_week: m.days_of_week || null,
        });
      }
    }
    return { date, schedule, adherence: due ? Math.round((done / due) * 100) : 100, due, done };
  });

  // ────────────────────────── DAILY LOGS ──────────────────────────
  app.get('/api/parents/:parentId/logs', async (req) => {
    const { rows } = await pool.query(
      'SELECT * FROM daily_logs WHERE parent_id=$1 ORDER BY log_date DESC LIMIT 30',
      [req.params.parentId],
    );
    return rows;
  });

  app.post('/api/parents/:parentId/logs', async (req, reply) => {
    const { log_date, mood, ate_well, sleep_quality, bp, sugar, notes } = req.body || {};
    const date = log_date || localDate();

    // Build the family-facing update (AI if key present, else a warm template)
    let familyUpdate;
    const parentRow = (await pool.query('SELECT name FROM parents WHERE id=$1', [req.params.parentId])).rows[0];
    const who = parentRow ? parentRow.name.split(' ')[0] : 'Your parent';
    if (hasKey()) {
      try {
        const prompt = `Write a short, warm 2-3 sentence daily update for a family about their elderly parent, based on the caregiver's notes below. Reassuring but honest. End with a small warm touch. No medical advice.

Parent: ${who}
Mood: ${mood || '-'} | Ate: ${ate_well || '-'} | Sleep: ${sleep_quality || '-'}
BP: ${bp || '-'} | Sugar: ${sugar || '-'}
Caregiver note: ${notes || '-'}`;
        familyUpdate = await callClaude(prompt, 300);
      } catch {
        familyUpdate = templateUpdate(who, { mood, ate_well, sleep_quality, bp, sugar, notes });
      }
    } else {
      familyUpdate = templateUpdate(who, { mood, ate_well, sleep_quality, bp, sugar, notes });
    }

    const { rows } = await pool.query(
      `INSERT INTO daily_logs (parent_id, log_date, mood, ate_well, sleep_quality, bp, sugar, notes, family_update)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (parent_id, log_date) DO UPDATE SET
         mood=$3, ate_well=$4, sleep_quality=$5, bp=$6, sugar=$7, notes=$8, family_update=$9
       RETURNING *`,
      [req.params.parentId, date, mood || null, ate_well || null, sleep_quality || null,
        bp || null, sugar || null, notes || null, familyUpdate],
    );
    return rows[0];
  });

  function templateUpdate(who, d) {
    const bits = [];
    if (d.mood) bits.push(d.mood === 'happy' ? `${who} was in good spirits today`
      : d.mood === 'low' ? `${who} was a little low today`
      : d.mood === 'unwell' ? `${who} wasn't feeling their best today`
      : `${who} had a calm day`);
    if (d.ate_well === 'yes') bits.push('ate well');
    else if (d.ate_well === 'partly') bits.push('ate a little');
    else if (d.ate_well === 'no') bits.push('didn\'t eat much');
    if (d.bp || d.sugar) bits.push(`vitals ${[d.bp && 'BP ' + d.bp, d.sugar && 'sugar ' + d.sugar].filter(Boolean).join(', ')}`);
    let s = bits.join(', ') + '.';
    if (d.notes) s += ' ' + d.notes;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ────────────────────────── EMERGENCY CARD ──────────────────────────
  app.get('/api/parents/:parentId/emergency-card', async (req, reply) => {
    const { rows: pr } = await pool.query('SELECT * FROM parents WHERE id=$1', [req.params.parentId]);
    if (!pr[0]) return reply.code(404).send({ error: 'parent not found' });
    const parent = pr[0];
    const { rows: contacts } = await pool.query(
      'SELECT name, relation, phone, is_primary FROM contacts WHERE parent_id=$1 ORDER BY is_primary DESC',
      [req.params.parentId],
    );
    const { rows: meds } = await pool.query(
      'SELECT name, dosage FROM medications WHERE parent_id=$1 AND active=true ORDER BY name',
      [req.params.parentId],
    );
    return {
      name: parent.name,
      age: parent.age,
      blood_group: parent.blood_group,
      allergies: parent.allergies,
      conditions: parent.conditions,
      doctor: parent.primary_doctor,
      doctor_phone: parent.doctor_phone,
      medications: meds,
      contacts,
      generated_at: new Date().toISOString(),
    };
  });

  app.put('/api/parents/:parentId/emergency-info', async (req, reply) => {
    if (!need(req, reply, 'admin')) return;
    const { blood_group, allergies, conditions, primary_doctor, doctor_phone } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE parents SET
         blood_group=COALESCE($2,blood_group),
         allergies=COALESCE($3,allergies),
         conditions=COALESCE($4,conditions),
         primary_doctor=COALESCE($5,primary_doctor),
         doctor_phone=COALESCE($6,doctor_phone)
       WHERE id=$1 RETURNING *`,
      [req.params.parentId, blood_group, allergies, conditions, primary_doctor, doctor_phone],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'parent not found' });
    return rows[0];
  });

  // contacts
  app.post('/api/parents/:parentId/contacts', async (req, reply) => {
    const { name, relation, phone, is_primary } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'name required' });
    const { rows } = await pool.query(
      'INSERT INTO contacts (parent_id, name, relation, phone, is_primary) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.parentId, name, relation || null, phone || null, !!is_primary],
    );
    return rows[0];
  });

  // ────────────────────────── PARENT MONITOR (overview) ──────────────────────────
  app.get('/api/parents/:parentId/monitor', async (req) => {
    const pid = req.params.parentId;
    const today = localDate();

    // latest daily log
    const { rows: dl } = await pool.query(
      'SELECT * FROM daily_logs WHERE parent_id=$1 ORDER BY log_date DESC LIMIT 1', [pid]);
    // med adherence today
    const { rows: meds } = await pool.query(
      'SELECT * FROM medications WHERE parent_id=$1 AND active=true', [pid]);
    const { rows: mlogs } = await pool.query(
      `SELECT ml.medication_id, ml.slot FROM medication_log ml
       JOIN medications m ON m.id=ml.medication_id
       WHERE m.parent_id=$1 AND ml.log_date=$2 AND ml.taken=true`, [pid, today]);
    const takenSet = new Set(mlogs.map((l) => `${l.medication_id}:${l.slot}`));
    let due = 0, done = 0;
    for (const m of meds) for (const s of ['morning', 'afternoon', 'night']) {
      if (m[`slot_${s}`]) { due++; if (takenSet.has(`${m.id}:${s}`)) done++; }
    }
    // latest report + a couple key vitals
    const { rows: rep } = await pool.query(
      'SELECT id, report_date FROM reports WHERE parent_id=$1 ORDER BY report_date DESC LIMIT 1', [pid]);
    let keyVitals = [];
    if (rep[0]) {
      const { rows: ranges } = await pool.query('SELECT * FROM reference_ranges');
      const rmap = {}; for (const r of ranges) rmap[r.name] = { min: +r.min_value, max: +r.max_value, unit: r.unit };
      const { rows: params } = await pool.query(
        `SELECT name, value::float AS value, unit FROM report_params
         WHERE report_id=$1 AND name = ANY($2)`,
        [rep[0].id, ['HbA1c', 'Fasting Glucose', 'Total Cholesterol']]);
      keyVitals = params.map((p) => {
        const r = rmap[p.name]; let status = 'unknown';
        if (r) status = p.value < r.min ? 'low' : p.value > r.max ? 'high' : 'ok';
        return { ...p, status };
      });
    }
    // care team + next booking
    const { rows: team } = await pool.query(
      'SELECT name, role FROM care_team WHERE parent_id=$1 AND active=true ORDER BY created_at', [pid]);
    const { rows: nextSvc } = await pool.query(
      `SELECT service_type, preferred_date FROM service_requests
       WHERE parent_id=$1 AND status IN ('pending','confirmed') ORDER BY created_at DESC LIMIT 1`, [pid]);
    const { rows: repCount } = await pool.query(
      'SELECT count(*)::int AS c FROM reports WHERE parent_id=$1', [pid]);
    const { rows: openAlerts } = await pool.query(
      `SELECT a.message, a.created_at, u.name AS by_name FROM alerts a
       LEFT JOIN users u ON u.id=a.created_by
       WHERE a.parent_id=$1 AND a.status='open' ORDER BY a.created_at DESC`, [pid]);
    const { rows: nextAppt } = await pool.query(
      `SELECT title, with_whom, appt_date, appt_time, kind FROM appointments
       WHERE parent_id=$1 AND status='upcoming' AND appt_date >= CURRENT_DATE
       ORDER BY appt_date ASC LIMIT 1`, [pid]);
    const { rows: overdue } = await pool.query(
      `SELECT count(*)::int AS c FROM appointments
       WHERE parent_id=$1 AND status='upcoming' AND appt_date < CURRENT_DATE`, [pid]);

    return {
      today: dl[0] || null,
      medication: { due, done, adherence: due ? Math.round((done / due) * 100) : 100 },
      key_vitals: keyVitals,
      latest_report_date: rep[0]?.report_date || null,
      reports_count: repCount[0].c,
      care_team: team,
      next_service: nextSvc[0] || null,
      alerts: openAlerts,
      next_appointment: nextAppt[0] || null,
      overdue_count: overdue[0].c,
    };
  });

  // ────────────────────────── CARE TEAM ──────────────────────────
  app.get('/api/parents/:parentId/care-team', async (req) => {
    const { rows } = await pool.query(
      'SELECT * FROM care_team WHERE parent_id=$1 AND active=true ORDER BY created_at', [req.params.parentId]);
    return rows;
  });
  app.post('/api/parents/:parentId/care-team', async (req, reply) => {
    if (!need(req, reply, 'admin')) return;
    const { name, role, phone, since } = req.body || {};
    if (!name || !role) return reply.code(400).send({ error: 'name and role required' });
    const { rows } = await pool.query(
      'INSERT INTO care_team (parent_id, name, role, phone, since) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.parentId, name, role, phone || null, since || null]);
    return rows[0];
  });

  // ────────────────────────── SERVICE REQUESTS (bookings) ──────────────────────────
  app.get('/api/parents/:parentId/service-requests', async (req) => {
    const { rows } = await pool.query(
      'SELECT * FROM service_requests WHERE parent_id=$1 ORDER BY created_at DESC', [req.params.parentId]);
    return rows;
  });
  app.post('/api/parents/:parentId/service-requests', async (req, reply) => {
    if (!need(req, reply, 'member')) return;
    const { service_type, service_slug, frequency, preferred_date, preferred_time, notes, contact_phone, concern } = req.body || {};
    if (!service_type) return reply.code(400).send({ error: 'service_type required' });
    const { rows } = await pool.query(
      `INSERT INTO service_requests (parent_id, service_type, service_slug, frequency, preferred_date, preferred_time, notes, contact_phone, concern)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.parentId, service_type, service_slug || null, frequency || 'one-time',
       preferred_date || null, preferred_time || null, notes || null, contact_phone || null, concern || null]);
    // tell the operator immediately — these are fulfilled by hand
    const { rows: pr } = await pool.query('SELECT name, city FROM parents WHERE id=$1', [req.params.parentId]);
    notifyOperator(app, `New booking: ${service_type}`, [
      `For:       ${pr[0]?.name || 'unknown'}${pr[0]?.city ? ' (' + pr[0].city + ')' : ''}`,
      `Service:   ${service_type}`,
      `When:      ${preferred_date || 'not specified'}${preferred_time ? ' ' + preferred_time : ''}`,
      `Frequency: ${frequency || 'one-time'}`,
      `Requested by: ${req.user.name} <${req.user.email}>`,
      contact_phone ? `Phone:     ${contact_phone}` : '',
      concern ? `Concern:   ${concern}` : '',
      notes ? `Notes:     ${notes}` : '',
      '',
      'ACTION: call the family, then confirm it in the Requests tab.',
    ].filter(Boolean)).catch(() => {});
    return rows[0];
  });

  // ────────────────────────── ACTIVITIES (Moh TV) ──────────────────────────
  app.get('/api/activities', async (req) => {
    const cat = req.query.category;
    const { rows } = cat
      ? await pool.query('SELECT * FROM activities WHERE category=$1 ORDER BY sort_order', [cat])
      : await pool.query('SELECT * FROM activities ORDER BY sort_order');
    return rows;
  });

  // ────────────────────────── GET CARE: triage (problem → solutions) ──────────────────────────
  const CATALOGUE = {
    caregiver:       { label: 'Caregiver / Attendant', desc: 'Daily help with bathing, meals, mobility & company.' },
    nurse:           { label: 'Home Nurse',            desc: 'Injections, wound care, post-hospital medical care.' },
    physiotherapist: { label: 'Physiotherapist',       desc: 'Recovery, joint & knee pain, mobility work.' },
    companion:       { label: 'Companion',             desc: 'Conversation, walks, activities — eases loneliness.' },
    teleconsult:     { label: 'Doctor Teleconsult',    desc: 'Video consult with a geriatrician or specialist.' },
    labtest:         { label: 'Lab Test at Home',      desc: 'Blood, ECG & sample collection at home.' },
    equipment:       { label: 'Medical Equipment',     desc: 'Wheelchair, oxygen, hospital bed on rent.' },
    checkup:         { label: 'Health Checkup + Diet', desc: 'Full assessment & a dietician nutrition plan.' },
    emergency:       { label: 'Emergency Response',    desc: '24/7 SOS, ambulance & hospital coordination.' },
  };
  const CONCERNS = {
    'Knee, joint or back pain':        { services: ['physiotherapist', 'teleconsult'], why: { physiotherapist: 'Targeted exercises to reduce pain and rebuild strength at home.', teleconsult: 'A doctor can review the pain and advise if further tests are needed.' } },
    'Not eating well / weakness':      { services: ['checkup', 'teleconsult', 'caregiver'], why: { checkup: 'A full checkup and diet plan to find the cause and rebuild strength.', teleconsult: 'Rule out anything underlying with a quick doctor consult.', caregiver: 'Help with cooking and encouraging regular meals.' } },
    'Feeling lonely or low':           { services: ['companion'], why: { companion: 'A regular friendly companion for conversation, walks and activities.' } },
    'Needs daily help at home':        { services: ['caregiver'], why: { caregiver: 'A trained attendant for bathing, meals, mobility and daily company.' } },
    'Recovering after hospital':       { services: ['nurse', 'physiotherapist', 'equipment'], why: { nurse: 'Medical care at home — dressings, injections, monitoring.', physiotherapist: 'Structured recovery to regain strength and mobility.', equipment: 'Rent a wheelchair, bed or oxygen for the recovery period.' } },
    'Memory or confusion':             { services: ['teleconsult', 'caregiver'], why: { teleconsult: 'A specialist can assess memory changes and guide next steps.', caregiver: 'A trained caregiver for safety, routine and gentle supervision.' } },
    'Just a routine checkup':          { services: ['checkup', 'labtest'], why: { checkup: 'A complete senior health assessment.', labtest: 'Home blood tests so nobody has to travel to a lab.' } },
    'Urgent / emergency':              { services: ['emergency', 'nurse'], why: { emergency: '24/7 response, ambulance and hospital coordination.', nurse: 'Immediate medical care at home if needed.' } },
  };

  function ruleTriage(concern, details) {
    let hit = CONCERNS[concern];
    if (!hit && details) {
      const t = details.toLowerCase();
      const test = (words) => words.some((w) => t.includes(w));
      if (test(['knee', 'joint', 'back', 'pain', 'walk', 'mobility'])) hit = CONCERNS['Knee, joint or back pain'];
      else if (test(['eat', 'weak', 'weight', 'appetite', 'thin'])) hit = CONCERNS['Not eating well / weakness'];
      else if (test(['lonely', 'alone', 'bored', 'sad', 'low', 'depress'])) hit = CONCERNS['Feeling lonely or low'];
      else if (test(['surgery', 'hospital', 'discharge', 'operation', 'recover'])) hit = CONCERNS['Recovering after hospital'];
      else if (test(['memory', 'forget', 'confus', 'dementia', 'alzheim'])) hit = CONCERNS['Memory or confusion'];
      else if (test(['checkup', 'test', 'routine', 'blood', 'sugar', 'bp'])) hit = CONCERNS['Just a routine checkup'];
      else if (test(['emergency', 'urgent', 'fell', 'fall', 'chest', 'breath'])) hit = CONCERNS['Urgent / emergency'];
      else if (test(['bath', 'daily', 'help', 'feed', 'toilet', 'dress'])) hit = CONCERNS['Needs daily help at home'];
    }
    if (!hit) hit = { services: ['teleconsult', 'caregiver'], why: { teleconsult: 'A doctor can help understand the situation.', caregiver: 'Daily support and company at home.' } };
    const recommendations = hit.services.map((id) => ({ id, ...CATALOGUE[id], why: hit.why[id] || CATALOGUE[id].desc }));
    return { summary: null, recommendations };
  }

  app.post('/api/parents/:parentId/triage', async (req, reply) => {
    const { concern, details } = req.body || {};
    if (!concern && !details) return reply.code(400).send({ error: 'concern or details required' });

    // AI path: constrained to the catalogue, warm summary + reasons. Free fallback otherwise.
    if (hasKey()) {
      try {
        const ids = Object.keys(CATALOGUE).map((k) => `${k}: ${CATALOGUE[k].label} — ${CATALOGUE[k].desc}`).join('\n');
        const prompt = `A family is describing a concern about their elderly parent. From the fixed service catalogue below, pick the 2-3 most relevant services. Reply ONLY as JSON: {"summary":"one warm sentence acknowledging the concern","recommendations":[{"id":"catalogue_id","why":"one sentence why this helps"}]}. Do NOT diagnose. Only use ids from the catalogue.

CATALOGUE:
${ids}

CONCERN: ${concern || ''}
DETAILS: ${details || ''}`;
        const raw = await callClaude(prompt, 600);
        const obj = JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());
        const recommendations = (obj.recommendations || [])
          .filter((r) => CATALOGUE[r.id])
          .map((r) => ({ id: r.id, ...CATALOGUE[r.id], why: r.why || CATALOGUE[r.id].desc }));
        if (recommendations.length) return { summary: obj.summary || null, recommendations };
      } catch { /* fall through to rules */ }
    }
    return ruleTriage(concern, details);
  });

  // ────────────────────────── INSIGHTS (proactive, rule-based + optional AI) ──────────────────────────
  const KEY_PARAMS = ['HbA1c', 'Fasting Glucose', 'LDL Cholesterol', 'Total Cholesterol', 'Triglycerides', 'HDL Cholesterol', 'Vitamin D', 'Hemoglobin', 'Creatinine', 'TSH'];

  async function computeInsights(pid) {
    const insights = [];
    // reference ranges
    const { rows: rr } = await pool.query('SELECT * FROM reference_ranges');
    const R = {}; for (const r of rr) R[r.name] = { min: +r.min_value, max: +r.max_value, unit: r.unit };

    // time series per key param
    const { rows: series } = await pool.query(
      `SELECT rp.name, rp.value::float AS value, r.report_date
       FROM report_params rp JOIN reports r ON r.id = rp.report_id
       WHERE r.parent_id=$1 AND rp.name = ANY($2)
       ORDER BY rp.name, r.report_date`, [pid, KEY_PARAMS]);
    const byName = {};
    for (const s of series) { (byName[s.name] ||= []).push({ date: s.report_date, value: s.value }); }

    const dist = (v, r) => v < r.min ? r.min - v : v > r.max ? v - r.max : 0; // outside-band distance
    for (const [name, pts] of Object.entries(byName)) {
      const r = R[name]; if (!r || pts.length === 0) continue;
      const latest = pts[pts.length - 1];
      const prev = pts.length >= 2 ? pts[pts.length - 2] : null;
      const inRange = latest.value >= r.min && latest.value <= r.max;
      const mid = (r.min + r.max) / 2;

      // celebrate: came back into range
      if (inRange && prev && (prev.value < r.min || prev.value > r.max)) {
        insights.push({ level: 'good', title: `${name} is back in the healthy range`, detail: `Now ${latest.value}${r.unit} (was ${prev.value}${r.unit}). A real improvement.` });
        continue;
      }
      // out of range: worsening vs improving
      if (!inRange) {
        // trend over last up to 3 points
        const tail = pts.slice(-3);
        const worsening = tail.length >= 2 && dist(tail[tail.length - 1].value, r) > dist(tail[0].value, r);
        const far = dist(latest.value, r) > (r.max - r.min) * 0.4; // notably outside
        const dir = latest.value > r.max ? 'above' : 'below';
        if (worsening) {
          insights.push({
            level: far ? 'urgent' : 'watch',
            title: `${name} is ${dir} range and trending the wrong way`,
            detail: `Latest ${latest.value}${r.unit}${prev ? ` (was ${prev.value}${r.unit})` : ''}. Healthy is ${r.min}–${r.max}${r.unit}. Worth discussing with the doctor.`,
          });
        } else if (prev && dist(latest.value, r) < dist(prev.value, r)) {
          insights.push({ level: 'watch', title: `${name} is improving but still ${dir} range`, detail: `Now ${latest.value}${r.unit}, moving toward the ${r.min}–${r.max}${r.unit} range. Keep it up.` });
        } else {
          insights.push({ level: far ? 'urgent' : 'watch', title: `${name} is ${dir} the healthy range`, detail: `Latest ${latest.value}${r.unit}. Healthy is ${r.min}–${r.max}${r.unit}.` });
        }
      }
    }

    // medication adherence (only meaningful later in the day)
    const hour = new Date().getHours();
    const today = localDate();
    const { rows: meds } = await pool.query('SELECT * FROM medications WHERE parent_id=$1 AND active=true', [pid]);
    const { rows: mlogs } = await pool.query(
      `SELECT ml.medication_id, ml.slot FROM medication_log ml JOIN medications m ON m.id=ml.medication_id
       WHERE m.parent_id=$1 AND ml.log_date=$2 AND ml.taken=true`, [pid, today]);
    const taken = new Set(mlogs.map(l => `${l.medication_id}:${l.slot}`));
    let due = 0, done = 0;
    for (const m of meds) for (const s of ['morning', 'afternoon', 'night']) { if (m[`slot_${s}`]) { due++; if (taken.has(`${m.id}:${s}`)) done++; } }
    if (due > 0 && hour >= 14 && done / due < 0.5) {
      insights.push({ level: 'watch', title: 'Medicines aren\'t marked yet today', detail: `Only ${done} of ${due} doses ticked off. A quick check might help.` });
    }

    // overdue appointments/reminders
    const { rows: overdue } = await pool.query(
      `SELECT title, appt_date FROM appointments WHERE parent_id=$1 AND status='upcoming' AND appt_date < CURRENT_DATE ORDER BY appt_date`, [pid]);
    for (const o of overdue) insights.push({ level: 'watch', title: `Overdue: ${o.title}`, detail: `Was due ${new Date(o.appt_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}.` });

    // missed appointments in the last 60 days — worth the family knowing
    const { rows: missed } = await pool.query(
      `SELECT title, appt_date FROM appointments
       WHERE parent_id=$1 AND status='missed' AND appt_date > CURRENT_DATE - 60
       ORDER BY appt_date DESC LIMIT 3`, [pid]);
    for (const m of missed) {
      insights.push({ level: 'watch', title: `Missed: ${m.title}`,
        detail: `Was scheduled for ${new Date(m.appt_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}. Worth rebooking.` });
    }

    // open caregiver alerts
    const { rows: alerts } = await pool.query(
      `SELECT a.message, u.name AS by_name FROM alerts a LEFT JOIN users u ON u.id=a.created_by
       WHERE a.parent_id=$1 AND a.status='open' ORDER BY a.created_at DESC`, [pid]);
    for (const al of alerts) insights.push({ level: 'urgent', title: `${al.by_name || 'Caregiver'} flagged a concern`, detail: al.message });

    // daily check-in: missed today (after 11am) or a worrying answer
    const { rows: ci } = await pool.query(
      `SELECT feeling, note, checkin_date FROM checkins WHERE parent_id=$1 ORDER BY checkin_date DESC LIMIT 1`, [pid]);
    const { rows: hasLogin } = await pool.query('SELECT user_id FROM parents WHERE id=$1', [pid]);
    if (hasLogin[0]?.user_id) { // only meaningful if the elder actually has a login
      const last = ci[0];
      const lastDate = last ? localDate(last.checkin_date) : null;
      if (lastDate === today) {
        if (last.feeling === 'need_help') insights.push({ level: 'urgent', title: 'They tapped "I need help" today', detail: last.note || 'Please check on them right away.' });
        else if (last.feeling === 'not_well') insights.push({ level: 'urgent', title: 'They said they\'re not feeling well today', detail: last.note || 'Worth a call.' });
        else insights.push({ level: 'good', title: 'They checked in today', detail: `Said they're feeling ${last.feeling}.` });
      } else if (hour >= 11) {
        insights.push({ level: 'watch', title: 'No check-in yet today', detail: lastDate ? `Last checked in on ${lastDate}. A quick call might be nice.` : 'They haven\'t checked in yet. A quick call might be nice.' });
      }
    }

    // vitals drift — the "spot it before it becomes a crisis" bit
    const { rows: vrows } = await pool.query(
      `SELECT taken_on, systolic, diastolic, sugar FROM vitals
       WHERE parent_id=$1 AND taken_on > CURRENT_DATE - 21 ORDER BY taken_on DESC`, [pid]);
    if (vrows.length >= 2) {
      const highBP = vrows.filter((v) => v.systolic && (v.systolic > 140 || (v.diastolic || 0) > 90));
      if (highBP.length >= 2) {
        insights.push({ level: highBP.length >= 3 ? 'urgent' : 'watch',
          title: `Blood pressure has been high on ${highBP.length} recent readings`,
          detail: `Latest ${highBP[0].systolic}/${highBP[0].diastolic || '—'}. Worth mentioning to the doctor.` });
      }
      const highSugar = vrows.filter((v) => v.sugar && v.sugar > 180);
      if (highSugar.length >= 2) {
        insights.push({ level: 'watch',
          title: `Sugar has run high on ${highSugar.length} recent readings`,
          detail: `Latest ${highSugar[0].sugar} mg/dL. Worth reviewing with the doctor.` });
      }
      // a rising run: 3+ consecutive increases in systolic
      const asc = [...vrows].reverse().filter((v) => v.systolic);
      let run = 1, best = 1;
      for (let i = 1; i < asc.length; i++) {
        if (asc[i].systolic > asc[i - 1].systolic) { run++; best = Math.max(best, run); } else run = 1;
      }
      if (best >= 3) {
        insights.push({ level: 'watch', title: 'Blood pressure is drifting upward',
          detail: `${best} readings in a row higher than the one before. A pattern worth flagging early.` });
      }
    }

    // standing risk factors from the care profile
    const { rows: prof } = await pool.query('SELECT * FROM care_profiles WHERE parent_id=$1', [pid]);
    const P = prof[0];
    if (P) {
      if (P.fall_history === 'multiple' && ['walker', 'stick', 'wheelchair'].includes(P.mobility)) {
        insights.push({ level: 'watch', title: 'High fall risk', detail: 'Multiple past falls with limited mobility — grab bars, better lighting and a physio review are worth considering.' });
      }
      if (P.lives_alone && (P.memory === 'confused' || P.mobility === 'bedbound')) {
        insights.push({ level: 'urgent', title: 'Living alone with high support needs', detail: 'Consider a daily attendant or live-in caregiver.' });
      }
      if (P.smoking === 'current') insights.push({ level: 'watch', title: 'Currently smoking', detail: 'Worth raising with the doctor, especially alongside any heart or lung readings.' });
    }

    // nothing wrong → a reassuring note
    if (!insights.length) insights.push({ level: 'good', title: 'Everything looks steady', detail: 'No concerning trends in the latest data. Nice.' });

    // sort urgent → watch → good
    const rank = { urgent: 0, watch: 1, good: 2 };
    insights.sort((a, b) => rank[a.level] - rank[b.level]);
    return insights;
  }

  app.get('/api/parents/:parentId/insights', async (req) => {
    return { insights: await computeInsights(req.params.parentId) };
  });

  // optional AI narrative over the computed insights (graceful without a key)
  app.post('/api/parents/:parentId/insights/explain', async (req, reply) => {
    const insights = await computeInsights(req.params.parentId);
    if (!hasKey()) return reply.send({ summary: null, no_key: true });
    const { rows: pr } = await pool.query('SELECT name FROM parents WHERE id=$1', [req.params.parentId]);
    const who = pr[0] ? pr[0].name.split(' ')[0] : 'your parent';
    try {
      const prompt = `You are a warm, careful health companion for a family caregiver (NOT a doctor). Based only on these computed observations about ${who}, write 3-4 plain-English, reassuring-but-honest sentences that help the family understand what to pay attention to. Do NOT diagnose or prescribe. End by gently suggesting they raise anything concerning with the doctor.

OBSERVATIONS:
${insights.map(i => `- [${i.level}] ${i.title}: ${i.detail}`).join('\n')}`;
      const summary = await callClaude(prompt, 400);
      return reply.send({ summary });
    } catch (e) {
      return reply.send({ summary: null, error: 'AI explanation is unavailable right now — the observations above are complete on their own.' });
    }
  });

  // ═══════════════════ ONBOARDING & CARE PROFILE ═══════════════════
  // A new user completes intake. Two shapes:
  //   account_type 'dependent' → creates their OWN parent record, links user_id, role 'dependent'
  //   account_type 'owner'     → creates a parent record they administer (role 'admin')
  app.post('/api/onboarding', async (req, reply) => {
    // Everyone who signs up gets exactly ONE record: their own. Whether their
    // vault is shared is decided by their care_role in the household — never by
    // creating extra records. This is what prevents the same human existing twice.
    const { name, age, city, profile } = req.body || {};
    const personName = name || req.user.name;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // reuse the self record if one already exists (e.g. created by joining a group)
      const { rows: existing } = await client.query(
        'SELECT id FROM parents WHERE user_id=$1 ORDER BY created_at LIMIT 1', [req.user.id]);
      let parent;
      if (existing[0]) {
        const { rows } = await client.query(
          `UPDATE parents SET name=$2, age=COALESCE($3,age), city=COALESCE($4,city)
           WHERE id=$1 RETURNING *`,
          [existing[0].id, personName, age || null, city || null]);
        parent = rows[0];
      } else {
        const { rows } = await client.query(
          `INSERT INTO parents (name, age, relation, city, created_by, user_id)
           VALUES ($1,$2,'self',$3,$4,$4) RETURNING *`,
          [personName, age || null, city || null, req.user.id]);
        parent = rows[0];
      }
      await client.query(
        `INSERT INTO family_members (user_id, parent_id, role) VALUES ($1,$2,'dependent')
         ON CONFLICT (user_id, parent_id) DO UPDATE SET role='dependent'`,
        [req.user.id, parent.id]);
      if (profile && typeof profile === 'object') await upsertProfile(client, parent.id, profile);
      if (profile?.allergies || profile?.conditions || profile?.blood_group) {
        await client.query(
          `UPDATE parents SET allergies=COALESCE($2,allergies), conditions=COALESCE($3,conditions),
             blood_group=COALESCE($4,blood_group) WHERE id=$1`,
          [parent.id, profile.allergies || null, profile.conditions || null, profile.blood_group || null]);
      }
      await client.query('UPDATE users SET onboarded=true WHERE id=$1', [req.user.id]);
      await client.query('COMMIT');
      return { parent };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  });

  const PROFILE_COLS = ['gender', 'height_cm', 'weight_kg', 'smoking', 'alcohol', 'mobility',
    'eyesight', 'hearing', 'speech', 'memory', 'lives_alone', 'fall_history', 'diet',
    'languages', 'notes', 'text_size'];

  async function upsertProfile(client, parentId, p) {
    const cols = PROFILE_COLS.filter((c) => p[c] !== undefined && p[c] !== null && p[c] !== '');
    if (!cols.length) { await client.query('INSERT INTO care_profiles (parent_id) VALUES ($1) ON CONFLICT DO NOTHING', [parentId]); return; }
    const vals = cols.map((c) => (c === 'lives_alone' ? !!p[c] : p[c]));
    const placeholders = cols.map((_, i) => `$${i + 2}`).join(',');
    const updates = cols.map((c, i) => `${c}=$${i + 2}`).join(',');
    await client.query(
      `INSERT INTO care_profiles (parent_id, ${cols.join(',')}) VALUES ($1, ${placeholders})
       ON CONFLICT (parent_id) DO UPDATE SET ${updates}, updated_at=now()`,
      [parentId, ...vals]);
  }

  app.get('/api/parents/:parentId/profile', async (req) => {
    const { rows } = await pool.query('SELECT * FROM care_profiles WHERE parent_id=$1', [req.params.parentId]);
    return rows[0] || { parent_id: req.params.parentId, text_size: 'normal' };
  });

  app.put('/api/parents/:parentId/profile', async (req, reply) => {
    if (!need(req, reply, 'member')) return;
    const client = await pool.connect();
    try {
      await upsertProfile(client, req.params.parentId, req.body || {});
      const { rows } = await client.query('SELECT * FROM care_profiles WHERE parent_id=$1', [req.params.parentId]);
      return rows[0];
    } finally { client.release(); }
  });

  // ═══════════════════ DAILY CHECK-IN (by the dependent) ═══════════════════
  app.get('/api/parents/:parentId/checkins', async (req) => {
    const { rows } = await pool.query(
      'SELECT * FROM checkins WHERE parent_id=$1 ORDER BY checkin_date DESC LIMIT 30', [req.params.parentId]);
    const today = localDate();
    return { checkins: rows, today: rows.find((r) => localDate(r.checkin_date) === today) || null };
  });

  app.post('/api/parents/:parentId/checkins', async (req, reply) => {
    const { feeling, note } = req.body || {};
    if (!['good', 'okay', 'not_well', 'need_help'].includes(feeling)) {
      return reply.code(400).send({ error: 'feeling must be good|okay|not_well|need_help' });
    }
    const date = localDate();
    const { rows } = await pool.query(
      `INSERT INTO checkins (parent_id, checkin_date, feeling, note) VALUES ($1,$2,$3,$4)
       ON CONFLICT (parent_id, checkin_date) DO UPDATE SET feeling=$3, note=$4, created_at=now()
       RETURNING *`, [req.params.parentId, date, feeling, note || null]);
    // a distress check-in raises an alert for the family immediately
    if (feeling === 'need_help' || feeling === 'not_well') {
      const { rows: pr } = await pool.query('SELECT name FROM parents WHERE id=$1', [req.params.parentId]);
      const who = pr[0]?.name || 'Your parent';
      await pool.query('INSERT INTO alerts (parent_id, message, created_by, severity) VALUES ($1,$2,$3,$4)',
        [req.params.parentId,
         feeling === 'need_help' ? `${who} tapped "I need help" in their daily check-in.`
                                 : `${who} said they're not feeling well today.${note ? ' Note: ' + note : ''}`,
         req.user.id, feeling === 'need_help' ? 'sos' : 'alert']);
    }
    return rows[0];
  });

  // ═══════════════════ MESSAGES (two-way presence) ═══════════════════
  app.get('/api/parents/:parentId/messages', async (req) => {
    const { rows } = await pool.query(
      `SELECT m.*, u.name AS from_name FROM messages m
       LEFT JOIN users u ON u.id = m.from_user_id
       WHERE m.parent_id=$1 ORDER BY m.created_at DESC LIMIT 50`, [req.params.parentId]);
    return rows;
  });

  app.post('/api/parents/:parentId/messages', async (req, reply) => {
    const { body, direction } = req.body || {};
    if (!body || !body.trim()) return reply.code(400).send({ error: 'body required' });
    const dir = direction === 'from_parent' ? 'from_parent' : 'to_parent';
    const { rows } = await pool.query(
      `INSERT INTO messages (parent_id, from_user_id, direction, body) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.parentId, req.user.id, dir, body.trim()]);
    return rows[0];
  });

  app.post('/api/parents/:parentId/messages/seen', async (req) => {
    await pool.query(`UPDATE messages SET seen=true WHERE parent_id=$1 AND direction='to_parent'`, [req.params.parentId]);
    return { ok: true };
  });

  // ═══════════════════ DOCUMENT VAULT ═══════════════════
  app.get('/api/parents/:parentId/documents', async (req) => {
    const { rows } = await pool.query(
      `SELECT d.*, u.name AS by_name FROM documents d
       LEFT JOIN users u ON u.id=d.uploaded_by
       WHERE d.parent_id=$1 ORDER BY d.created_at DESC`, [req.params.parentId]);
    const stored = rows.map((d) => ({
      id: d.id, title: d.title, category: d.category,
      created_at: d.created_at, by_name: d.by_name,
      link: `/api/documents/${d.id}/file`, source: 'document', can_delete: true,
    }));
    // lab reports and prescriptions live with the vault — show them here too,
    // so "everything in one place" is actually true
    const { rows: reps } = await pool.query(
      `SELECT id, report_type, report_date, lab_name, doctor_name, has_file, doc_kind, created_at
       FROM reports WHERE parent_id=$1 ORDER BY report_date DESC`, [req.params.parentId]);
    const fromVault = reps.map((r) => ({
      id: r.id,
      title: r.report_type + (r.lab_name ? ' · ' + r.lab_name : ''),
      category: r.doc_kind === 'prescription' ? 'prescription' : 'report',
      created_at: r.created_at,
      by_name: r.doctor_name || null,
      link: r.has_file ? `/api/reports/${r.id}/file` : null,
      opens: r.doc_kind === 'prescription' ? null : r.id,   // report detail
      source: 'vault', can_delete: false,
    }));
    const all = [...stored, ...fromVault]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const counts = {};
    for (const d of all) counts[d.category] = (counts[d.category] || 0) + 1;
    return { items: all, counts, total: all.length };
  });

  app.delete('/api/documents/:id', async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT fm.role FROM documents d
       JOIN family_members fm ON fm.parent_id=d.parent_id AND fm.user_id=$1
       WHERE d.id=$2`, [req.user.id, req.params.id]);
    if (!rows[0]) return reply.code(403).send({ error: 'no access' });
    if (!roleAtLeast(rows[0].role, 'member')) return reply.code(403).send({ error: 'member access required' });
    await pool.query('DELETE FROM documents WHERE id=$1', [req.params.id]);
    return { deleted: true };
  });

  // edit a medicine (admin or the elder themselves)
  app.put('/api/medications/:id', async (req, reply) => {
    const role = await medRole(req);
    if (!role) return reply.code(403).send({ error: 'no access' });
    if (!canManageMeds(role)) return reply.code(403).send({ error: 'not allowed to change medicines' });
    const { name, dosage, slot_morning, slot_afternoon, slot_night, notes,
            days_of_week, times, frequency } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'name required' });
    const { rows } = await pool.query(
      `UPDATE medications SET name=$2, dosage=$3, slot_morning=$4, slot_afternoon=$5,
         slot_night=$6, notes=$7, days_of_week=$8, times=$9, frequency=$10
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, dosage || null, !!slot_morning, !!slot_afternoon, !!slot_night,
       notes || null,
       Array.isArray(days_of_week) && days_of_week.length ? days_of_week : null,
       Array.isArray(times) && times.length ? times : null,
       frequency || 'daily']);
    if (!rows[0]) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  // ═══════════════════ FOOD & WELLNESS ═══════════════════
  // who may log wellness: the elder themselves and family who are actually there.
  // Admins (often remote) get a read-only view.
  const canLogWellness = (role) => role === 'dependent' || role === 'member';

  app.get('/api/parents/:parentId/wellness', async (req) => {
    const today = localDate();
    const { rows } = await pool.query(
      'SELECT * FROM wellness_logs WHERE parent_id=$1 ORDER BY log_date DESC LIMIT 30',
      [req.params.parentId]);
    const todayRow = rows.find((r) => localDate(r.log_date) === today) || null;
    // simple streak: consecutive days with any activity ticked
    let streak = 0;
    const byDate = {};
    for (const r of rows) byDate[localDate(r.log_date)] = r;
    for (let i = 0; i < 30; i++) {
      const d = localDate(new Date(Date.now() - i * 864e5));
      const r = byDate[d];
      if (r && (r.walked || r.exercise || r.meditation)) streak++;
      else if (i > 0) break;           // today not yet logged shouldn't break the streak
      else if (!r) continue;
      else break;
    }
    return {
      today: todayRow,
      history: rows.map((r) => ({
        date: localDate(r.log_date),
        walked: r.walked, exercise: r.exercise, meditation: r.meditation,
        ate_healthy: r.ate_healthy, water_glasses: r.water_glasses,
        notes: r.notes, updated_at: r.updated_at,
      })),
      streak,
      can_edit: canLogWellness(req.parentRole),
      last_saved: todayRow ? todayRow.updated_at : null,
    };
  });

  app.post('/api/parents/:parentId/wellness', async (req, reply) => {
    if (!canLogWellness(req.parentRole)) {
      return reply.code(403).send({ error: 'Only the person themselves or a family member on the ground can log this.' });
    }
    const { walked, exercise, meditation, ate_healthy, water_glasses, notes } = req.body || {};
    const date = localDate();
    const { rows } = await pool.query(
      `INSERT INTO wellness_logs (parent_id, log_date, walked, exercise, meditation, ate_healthy, water_glasses, notes, updated_at, saved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)
       ON CONFLICT (parent_id, log_date) DO UPDATE SET
         walked        = COALESCE(EXCLUDED.walked,        wellness_logs.walked),
         exercise      = COALESCE(EXCLUDED.exercise,      wellness_logs.exercise),
         meditation    = COALESCE(EXCLUDED.meditation,    wellness_logs.meditation),
         ate_healthy   = COALESCE(EXCLUDED.ate_healthy,   wellness_logs.ate_healthy),
         water_glasses = COALESCE(EXCLUDED.water_glasses, wellness_logs.water_glasses),
         notes         = COALESCE(EXCLUDED.notes,         wellness_logs.notes),
         updated_at    = now(),
         saved_by      = EXCLUDED.saved_by
       RETURNING *`,
      [req.params.parentId, date,
       walked === undefined ? null : !!walked,
       exercise === undefined ? null : !!exercise,
       meditation === undefined ? null : !!meditation,
       ate_healthy === undefined ? null : !!ate_healthy,
       water_glasses == null ? null : +water_glasses,
       notes || null, req.user.id]);
    return rows[0];
  });

  // Food suggestions, tailored to diet preference and any noted conditions.
  // Deliberately general, home-style guidance — never a prescriptive medical diet.
  app.get('/api/parents/:parentId/food', async (req) => {
    const { rows: pr } = await pool.query('SELECT conditions FROM parents WHERE id=$1', [req.params.parentId]);
    const { rows: cp } = await pool.query('SELECT diet FROM care_profiles WHERE parent_id=$1', [req.params.parentId]);
    const diet = (cp[0]?.diet || 'vegetarian').toLowerCase();
    const cond = (pr[0]?.conditions || '').toLowerCase();
    const veg = diet !== 'non-vegetarian';

    const meals = {
      Breakfast: veg
        ? ['Vegetable poha with peanuts', 'Moong dal chilla with mint chutney', 'Oats upma with vegetables', 'Idli with sambar', 'Besan cheela']
        : ['Egg bhurji with multigrain toast', 'Boiled eggs with vegetable poha', 'Oats upma with a boiled egg', 'Idli with sambar'],
      Lunch: veg
        ? ['Roti, dal, seasonal sabzi and curd', 'Khichdi with vegetables and a spoon of ghee', 'Rajma with brown rice and salad', 'Curd rice with vegetables']
        : ['Roti, dal, grilled fish and salad', 'Chicken curry with brown rice and vegetables', 'Roti with egg curry and sabzi'],
      Dinner: veg
        ? ['Light vegetable khichdi', 'Roti with lauki or tinda sabzi', 'Vegetable dalia', 'Dal soup with steamed vegetables']
        : ['Grilled fish with sautéed vegetables', 'Light chicken soup with vegetables', 'Roti with egg curry'],
      Snacks: ['A handful of soaked almonds or walnuts', 'Seasonal fruit — papaya, guava, apple', 'Roasted chana', 'Buttermilk or coconut water', 'Sprouts chaat'],
    };

    const tips = [
      'Small, regular meals sit better than large ones — and are easier on digestion.',
      'Keep water within easy reach; older adults often feel less thirsty than they should.',
      'Include a protein at every meal — dal, curd, paneer, eggs or fish — it protects muscle.',
      'Cook soft and easy to chew if teeth or swallowing are a problem.',
      'Fresh and seasonal beats packaged, almost always.',
    ];
    const gentleAvoid = [
      'Deep-fried snacks and namkeen — heavy and hard to digest',
      'Very salty pickles and papad, especially with blood pressure',
      'Packaged biscuits, sweets and sugary drinks',
      'Late, heavy dinners — they disturb sleep',
    ];
    if (cond.includes('diabet')) {
      tips.unshift('With diabetes, pairing carbohydrates with protein or vegetables helps keep meals steadier.');
      gentleAvoid.unshift('Sweets, fruit juices and sugary tea — the quickest sugar spikes');
    }
    if (cond.includes('hypertension') || cond.includes('bp') || cond.includes('pressure')) {
      tips.unshift('Going easy on salt and pickles helps with blood pressure.');
    }

    return {
      diet, vegetarian: veg, meals, tips, avoid: gentleAvoid,
      note: 'General home-style suggestions, not a medical diet plan. For anything specific — especially with diabetes, kidney or heart conditions — check with their doctor or a dietitian.',
    };
  });

  // ═══════════════════ OPS CONSOLE (manual fulfilment) ═══════════════════
  // Everything the operator needs to work by hand, across every family they admin.
  app.get('/api/ops/queue', async (req) => {
    const { rows: reqs } = await pool.query(
      `SELECT sr.*, p.name AS parent_name, p.city, p.id AS pid
       FROM service_requests sr
       JOIN parents p ON p.id = sr.parent_id
       JOIN family_members fm ON fm.parent_id = p.id AND fm.user_id = $1 AND fm.role='admin'
       ORDER BY (sr.status='pending') DESC, sr.created_at DESC LIMIT 100`, [req.user.id]);
    const { rows: alerts } = await pool.query(
      `SELECT a.*, p.name AS parent_name, u.name AS by_name
       FROM alerts a
       JOIN parents p ON p.id = a.parent_id
       JOIN family_members fm ON fm.parent_id = p.id AND fm.user_id = $1 AND fm.role='admin'
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.status='open' ORDER BY a.created_at DESC LIMIT 50`, [req.user.id]);
    // contact numbers, so the operator can call straight from the queue
    const { rows: contacts } = await pool.query(
      `SELECT c.parent_id, c.name, c.phone, c.relation FROM contacts c
       JOIN family_members fm ON fm.parent_id = c.parent_id AND fm.user_id=$1 AND fm.role='admin'
       ORDER BY c.is_primary DESC`, [req.user.id]);
    const byParent = {};
    for (const c of contacts) (byParent[c.parent_id] ||= []).push(c);
    return {
      requests: reqs.map((r) => ({ ...r, contacts: byParent[r.pid] || [] })),
      alerts,
      pending: reqs.filter((r) => r.status === 'pending').length,
    };
  });

  app.post('/api/service-requests/:id/status', async (req, reply) => {
    const { status } = req.body || {};
    if (!['pending', 'confirmed', 'done', 'cancelled'].includes(status)) {
      return reply.code(400).send({ error: 'bad status' });
    }
    const { rows: chk } = await pool.query(
      `SELECT fm.role FROM service_requests sr
       JOIN family_members fm ON fm.parent_id = sr.parent_id AND fm.user_id=$1
       WHERE sr.id=$2`, [req.user.id, req.params.id]);
    if (!chk[0]) return reply.code(403).send({ error: 'no access' });
    if (!roleAtLeast(chk[0].role, 'admin')) return reply.code(403).send({ error: 'admin access required' });
    const { rows } = await pool.query(
      'UPDATE service_requests SET status=$2 WHERE id=$1 RETURNING *', [req.params.id, status]);
    return rows[0];
  });

  // ═══════════════════ VITALS (BP, sugar, weight) ═══════════════════
  const VITAL_BANDS = {
    systolic: { min: 90, max: 140, unit: 'mmHg' },
    diastolic: { min: 60, max: 90, unit: 'mmHg' },
    pulse: { min: 55, max: 100, unit: 'bpm' },
    sugar: { min: 70, max: 140, unit: 'mg/dL' },
  };

  app.get('/api/parents/:parentId/vitals', async (req) => {
    const days = Math.min(+(req.query.days || 30), 180);
    const { rows } = await pool.query(
      `SELECT v.*, u.name AS by_name FROM vitals v
       LEFT JOIN users u ON u.id = v.logged_by
       WHERE v.parent_id=$1 AND v.taken_on > CURRENT_DATE - $2::int
       ORDER BY v.taken_on DESC, v.created_at DESC`, [req.params.parentId, days]);
    const norm = rows.map((r) => ({ ...r, taken_on: localDate(r.taken_on) }));
    // simple series for charting, oldest first
    const series = [...norm].reverse();
    const latest = norm[0] || null;
    return {
      latest,
      entries: norm,
      series: {
        bp: series.filter((r) => r.systolic).map((r) => ({ date: r.taken_on, systolic: r.systolic, diastolic: r.diastolic })),
        sugar: series.filter((r) => r.sugar).map((r) => ({ date: r.taken_on, value: r.sugar, type: r.sugar_type })),
        weight: series.filter((r) => r.weight_kg).map((r) => ({ date: r.taken_on, value: +r.weight_kg })),
      },
      bands: VITAL_BANDS,
      can_edit: roleAtLeast(req.parentRole, 'member') || req.parentRole === 'caregiver',
    };
  });

  app.post('/api/parents/:parentId/vitals', async (req, reply) => {
    // the elder, family on the ground, and the caregiver can all record vitals
    if (!(roleAtLeast(req.parentRole, 'member') || req.parentRole === 'caregiver')) {
      return reply.code(403).send({ error: 'not allowed to record vitals' });
    }
    const { taken_on, taken_time, systolic, diastolic, pulse, sugar, sugar_type, weight_kg, notes } = req.body || {};
    if (!systolic && !sugar && !weight_kg && !pulse) {
      return reply.code(400).send({ error: 'record at least one reading' });
    }
    const { rows } = await pool.query(
      `INSERT INTO vitals (parent_id, taken_on, taken_time, systolic, diastolic, pulse, sugar, sugar_type, weight_kg, notes, logged_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.parentId, taken_on || localDate(), taken_time || null,
       systolic || null, diastolic || null, pulse || null,
       sugar || null, sugar_type || null, weight_kg || null, notes || null, req.user.id]);
    return rows[0];
  });

  app.delete('/api/parents/:parentId/vitals/:id', async (req, reply) => {
    if (!need(req, reply, 'member')) return;
    await pool.query('DELETE FROM vitals WHERE id=$1 AND parent_id=$2', [req.params.id, req.params.parentId]);
    return { deleted: true };
  });

  // ═══════════════════ ONE MEDICAL TIMELINE ═══════════════════
  // Every prescription, consult, lab report, vital and check-in in one thread.
  app.get('/api/parents/:parentId/timeline', async (req) => {
    const pid = req.params.parentId;
    const items = [];

    const { rows: reps } = await pool.query(
      `SELECT id, report_type, lab_name, doctor_name, report_date, has_file, doc_kind
       FROM reports WHERE parent_id=$1 ORDER BY report_date DESC LIMIT 40`, [pid]);
    for (const r of reps) {
      items.push({
        kind: r.doc_kind === 'prescription' ? 'prescription' : 'report',
        date: localDate(r.report_date),
        title: r.report_type,
        detail: [r.lab_name, r.doctor_name].filter(Boolean).join(' · '),
        link: r.has_file ? `/api/reports/${r.id}/file` : null,
        ref: r.id,
      });
    }
    const { rows: appts } = await pool.query(
      `SELECT id, title, with_whom, appt_date, status, kind FROM appointments
       WHERE parent_id=$1 ORDER BY appt_date DESC LIMIT 30`, [pid]);
    for (const a of appts) {
      items.push({ kind: 'appointment', date: localDate(a.appt_date), title: a.title,
        detail: [a.with_whom, a.status].filter(Boolean).join(' · '), ref: a.id });
    }
    const { rows: vit } = await pool.query(
      `SELECT * FROM vitals WHERE parent_id=$1 ORDER BY taken_on DESC LIMIT 40`, [pid]);
    for (const v of vit) {
      const bits = [];
      if (v.systolic) bits.push(`BP ${v.systolic}/${v.diastolic || '—'}`);
      if (v.sugar) bits.push(`sugar ${v.sugar}${v.sugar_type ? ' (' + v.sugar_type + ')' : ''}`);
      if (v.weight_kg) bits.push(`${v.weight_kg} kg`);
      if (v.pulse) bits.push(`pulse ${v.pulse}`);
      items.push({ kind: 'vital', date: localDate(v.taken_on), title: bits.join(' · ') || 'Vitals', detail: v.taken_time || '', ref: v.id });
    }
    const { rows: ci } = await pool.query(
      `SELECT * FROM checkins WHERE parent_id=$1 ORDER BY checkin_date DESC LIMIT 20`, [pid]);
    for (const c of ci) {
      items.push({ kind: 'checkin', date: localDate(c.checkin_date),
        title: `Felt ${String(c.feeling).replace('_', ' ')}`, detail: c.note || '', ref: c.id });
    }
    items.sort((a, b) => b.date.localeCompare(a.date));
    return { items: items.slice(0, 120) };
  });

  app.get('/api/care-catalogue', async () => ({ catalogue: CATALOGUE, concerns: Object.keys(CONCERNS) }));

  // ────────────────────────── ALERTS (caregiver flags a problem) ──────────────────────────
  app.post('/api/parents/:parentId/alerts', async (req, reply) => {
    const { message, severity } = req.body || {};
    if (!message) return reply.code(400).send({ error: 'message required' });
    const { rows } = await pool.query(
      'INSERT INTO alerts (parent_id, message, created_by, severity) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.parentId, message, req.user.id, severity === 'sos' ? 'sos' : 'alert']);
    const { rows: pr2 } = await pool.query('SELECT name FROM parents WHERE id=$1', [req.params.parentId]);
    // tell everyone who looks after this person
    const { rows: watchers } = await pool.query(
      `SELECT DISTINCT u.email FROM family_members fm JOIN users u ON u.id = fm.user_id
       WHERE fm.parent_id=$1 AND fm.role IN ('admin','member') AND u.id <> $2`,
      [req.params.parentId, req.user.id]);
    const isSos = (severity === 'sos');
    notifyPeople(app, watchers.map((w) => w.email),
      `${isSos ? '\ud83d\udea8 SOS' : '\u26a0 Alert'} — ${pr2[0]?.name || 'a family member'}`, [
        `${message}`,
        '',
        `Raised by: ${req.user.name}`,
        isSos ? 'Please call them now. Open the app to see who else is responding.'
              : 'Open the app to see the details and mark it resolved.',
      ]).catch(() => {});
    return rows[0];
  });
  app.get('/api/parents/:parentId/alerts', async (req) => {
    const { rows } = await pool.query(
      `SELECT a.*, u.name AS by_name, ack.name AS ack_name, res.name AS res_name
       FROM alerts a
       LEFT JOIN users u   ON u.id   = a.created_by
       LEFT JOIN users ack ON ack.id = a.acknowledged_by
       LEFT JOIN users res ON res.id = a.resolved_by
       WHERE a.parent_id=$1 ORDER BY (a.status='open') DESC, a.created_at DESC LIMIT 30`,
      [req.params.parentId]);
    return rows;
  });

  // Who to ring, and the facts a responder needs — attached to every alert view.
  app.get('/api/parents/:parentId/response-kit', async (req) => {
    const { rows: pr } = await pool.query(
      'SELECT name, blood_group, allergies, conditions, primary_doctor, doctor_phone FROM parents WHERE id=$1',
      [req.params.parentId]);
    const { rows: contacts } = await pool.query(
      'SELECT name, relation, phone, is_primary FROM contacts WHERE parent_id=$1 ORDER BY is_primary DESC',
      [req.params.parentId]);
    const { rows: team } = await pool.query(
      `SELECT name, role, phone FROM care_team WHERE parent_id=$1 AND active=true ORDER BY created_at`,
      [req.params.parentId]);
    const { rows: meds } = await pool.query(
      'SELECT name, dosage FROM medications WHERE parent_id=$1 AND active=true ORDER BY name',
      [req.params.parentId]);
    const p = pr[0] || {};
    const calls = [];
    for (const c of contacts) if (c.phone) calls.push({ label: c.name, sub: c.relation || 'Family', phone: c.phone, kind: 'family' });
    for (const t of team) if (t.phone) calls.push({ label: t.name, sub: t.role, phone: t.phone, kind: 'care' });
    if (p.doctor_phone) calls.push({ label: p.primary_doctor || 'Doctor', sub: 'Doctor', phone: p.doctor_phone, kind: 'doctor' });
    calls.push({ label: 'Ambulance', sub: 'Emergency · 108', phone: '108', kind: 'ambulance' });
    return {
      steps: [
        'Call them directly — if they answer and are safe, that settles it fastest.',
        'No answer? Call whoever is physically nearest — the caregiver or a neighbour.',
        'If they are hurt, confused, breathless or in chest pain, call an ambulance (108) first and the doctor after.',
        'Tap "I\'m on it" so the rest of the family knows someone is responding.',
      ],
      calls,
      essentials: {
        name: p.name, blood_group: p.blood_group, conditions: p.conditions,
        allergies: p.allergies, medications: meds.map((m) => m.name + (m.dosage ? ' ' + m.dosage : '')),
      },
    };
  });

  // "I'm on it" — so the family isn't all calling at once, or all assuming someone else did
  app.post('/api/parents/:parentId/alerts/:alertId/ack', async (req, reply) => {
    const { rows } = await pool.query(
      `UPDATE alerts SET acknowledged_by=$3, acknowledged_at=now()
       WHERE id=$2 AND parent_id=$1 AND acknowledged_by IS NULL RETURNING *`,
      [req.params.parentId, req.params.alertId, req.user.id]);
    if (!rows[0]) {
      const { rows: cur } = await pool.query(
        `SELECT a.*, u.name AS ack_name FROM alerts a LEFT JOIN users u ON u.id=a.acknowledged_by
         WHERE a.id=$1`, [req.params.alertId]);
      return { already: true, alert: cur[0] || null };
    }
    return { ok: true, alert: rows[0] };
  });
  app.post('/api/parents/:parentId/alerts/:alertId/resolve', async (req, reply) => {
    const { resolution } = req.body || {};
    await pool.query(
      `UPDATE alerts SET status='resolved', resolved_by=$3, resolved_at=now(), resolution=$4
       WHERE id=$2 AND parent_id=$1`,
      [req.params.parentId, req.params.alertId, req.user.id, resolution || null]);
    return { resolved: true };
  });

  // ────────────────────────── APPOINTMENTS & REMINDERS ──────────────────────────
  app.get('/api/parents/:parentId/appointments', async (req) => {
    const { rows } = await pool.query(
      `SELECT * FROM appointments WHERE parent_id=$1
       ORDER BY (status='upcoming') DESC, appt_date ASC`, [req.params.parentId]);
    return rows;
  });
  app.post('/api/parents/:parentId/appointments', async (req, reply) => {
    if (!need(req, reply, 'member')) return;
    const { kind, title, with_whom, appt_date, appt_time, location, notes } = req.body || {};
    if (!title || !appt_date) return reply.code(400).send({ error: 'title and date required' });
    const { rows } = await pool.query(
      `INSERT INTO appointments (parent_id, kind, title, with_whom, appt_date, appt_time, location, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.parentId, kind || 'appointment', title, with_whom || null, appt_date,
       appt_time || null, location || null, notes || null]);
    return rows[0];
  });
  app.put('/api/parents/:parentId/appointments/:apptId', async (req, reply) => {
    if (!need(req, reply, 'member')) return;
    const { kind, title, with_whom, appt_date, appt_time, location, notes } = req.body || {};
    if (!title || !appt_date) return reply.code(400).send({ error: 'title and date required' });
    const { rows } = await pool.query(
      `UPDATE appointments SET kind=$3, title=$4, with_whom=$5, appt_date=$6,
         appt_time=$7, location=$8, notes=$9
       WHERE id=$2 AND parent_id=$1 RETURNING *`,
      [req.params.parentId, req.params.apptId, kind || 'appointment', title,
       with_whom || null, appt_date, appt_time || null, location || null, notes || null]);
    if (!rows[0]) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  app.delete('/api/parents/:parentId/appointments/:apptId', async (req, reply) => {
    if (!need(req, reply, 'member')) return;
    await pool.query('DELETE FROM appointments WHERE id=$1 AND parent_id=$2',
      [req.params.apptId, req.params.parentId]);
    return { deleted: true };
  });

  app.post('/api/parents/:parentId/appointments/:apptId/status', async (req, reply) => {
    if (!need(req, reply, 'member')) return;
    const { status } = req.body || {};
    if (!['upcoming', 'done', 'missed', 'cancelled'].includes(status)) return reply.code(400).send({ error: 'bad status' });
    await pool.query('UPDATE appointments SET status=$1 WHERE id=$2 AND parent_id=$3',
      [status, req.params.apptId, req.params.parentId]);
    return { status };
  });
}
