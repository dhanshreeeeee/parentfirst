// ParentFirst — the care profile: how a person actually lives.
//
// Its own module because two route files write it — routes-care.js when
// someone completes onboarding or edits details, routes-family.js when an
// admin fills in the intake for a person who has no login. Fastify plugin
// scopes don't share decorations, so the shared thing has to be an import.

// Everything the intake form can set on a person's health profile.
export const PROFILE_COLS = ['gender', 'height_cm', 'weight_kg', 'smoking', 'smoking_years', 'tobacco',
  'alcohol', 'alcohol_frequency', 'mobility', 'eyesight', 'hearing', 'speech', 'memory',
  'lives_alone', 'fall_history', 'diet', 'activity_level', 'sleep_hours',
  'chronic_conditions', 'surgeries', 'family_history', 'vaccinations',
  'insurer', 'policy_number', 'languages', 'notes', 'text_size', 'phone'];

const NUMERIC_COLS = ['height_cm', 'weight_kg', 'smoking_years', 'sleep_hours'];

// The form sends strings for everything; the columns are not all text.
function coerce(col, v) {
  if (col === 'lives_alone') return !!v;
  if (col === 'chronic_conditions') return JSON.stringify(Array.isArray(v) ? v : []);
  if (NUMERIC_COLS.includes(col)) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return v;
}

// Write only the answers we were given — a half-filled form must never blank
// out what someone else filled in last week.
export async function upsertProfile(client, parentId, p) {
  const cols = PROFILE_COLS.filter((c) => p[c] !== undefined && p[c] !== null && p[c] !== '');
  if (!cols.length) {
    await client.query('INSERT INTO care_profiles (parent_id) VALUES ($1) ON CONFLICT DO NOTHING', [parentId]);
    return;
  }
  const vals = cols.map((c) => coerce(c, p[c]));
  const cast = (c, i) => `$${i + 2}` + (c === 'chronic_conditions' ? '::jsonb' : '');
  const placeholders = cols.map(cast).join(',');
  const updates = cols.map((c, i) => `${c}=` + cast(c, i)).join(',');
  await client.query(
    `INSERT INTO care_profiles (parent_id, ${cols.join(',')}) VALUES ($1, ${placeholders})
     ON CONFLICT (parent_id) DO UPDATE SET ${updates}, updated_at=now()`,
    [parentId, ...vals]);
}

// Same write, but starting from a pool: used where there is no open transaction.
export async function saveIntakeProfile(pool, parentId, profile) {
  const client = await pool.connect();
  try {
    await upsertProfile(client, parentId, profile);
    await client.query('UPDATE care_profiles SET intake_completed_at=now() WHERE parent_id=$1', [parentId]);
  } finally { client.release(); }
}
