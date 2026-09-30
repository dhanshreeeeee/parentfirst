// ParentFirst — file storage in Postgres.
//
// Render's disk is ephemeral: every deploy wipes it, so reports, documents,
// photos and voice notes stored there silently disappeared. Files now live in
// the database, next to the rows that own them. At family scale (a few MB per
// report) this is simpler and safer than running a separate object store.
//
// owner_kind: 'report' | 'document' | 'media'    owner_id: the row's id
import fs from 'node:fs';

export async function putFile(db, kind, ownerId, mime, buf, name = null) {
  await db.query(
    `INSERT INTO stored_files (owner_kind, owner_id, mime, file_name, size, bytes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_kind, owner_id) DO UPDATE
       SET mime=EXCLUDED.mime, file_name=EXCLUDED.file_name, size=EXCLUDED.size, bytes=EXCLUDED.bytes, created_at=now()`,
    [kind, ownerId, mime || 'application/octet-stream', name, buf.length, buf]);
}

// Returns { mime, bytes, file_name } or null. Falls back to a legacy disk file
// (uploaded before this change) and migrates it into the DB on first read.
export async function getFile(db, kind, ownerId, legacyPath = null) {
  const { rows } = await db.query(
    'SELECT mime, bytes, file_name FROM stored_files WHERE owner_kind=$1 AND owner_id=$2', [kind, ownerId]);
  if (rows[0]) return rows[0];
  if (legacyPath && fs.existsSync(legacyPath)) {
    const bytes = await fs.promises.readFile(legacyPath);
    try { await putFile(db, kind, ownerId, null, bytes); } catch { /* read still succeeds */ }
    return { mime: null, bytes, file_name: null };
  }
  return null;
}

export async function deleteFile(db, kind, ownerId) {
  await db.query('DELETE FROM stored_files WHERE owner_kind=$1 AND owner_id=$2', [kind, ownerId]);
}

// small key/value store for server secrets that must survive deploys (VAPID keys)
export async function getSetting(db, key) {
  const { rows } = await db.query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return rows[0] ? rows[0].value : null;
}
export async function setSetting(db, key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [key, value]);
}
