# Deploying ParentFirst to Render

The thing to understand before anything else: **Render's filesystem is
ephemeral.** It is wiped on every deploy and every restart. This app writes
uploaded reports, uploaded documents, and its push-notification keys to disk.
Without a persistent disk, all three are destroyed on each deploy — silently.

## 1. Postgres

Create a Render Postgres instance. Copy its **Internal Database URL** into the
web service as `DATABASE_URL`. TLS is detected automatically from the hostname.

## 2. Persistent disk (required)

Render → your service → **Disks** → Add Disk.

| Field      | Value        |
|------------|--------------|
| Name       | `data`       |
| Mount path | `/var/data`  |
| Size       | 1 GB to start |

Then set `DATA_DIR=/var/data`. Uploaded files and `vapid.json` go there.

Skip this and reports vanish on the next deploy. There is no warning, because
the upload itself succeeds — it is the disk underneath that disappears.

## 3. Push keys

Generate once, locally:

```bash
npm run vapid
```

Set `VAPID_PUBLIC` and `VAPID_PRIVATE` in Render → Environment. They must never
change afterwards: new keys invalidate every existing subscription, so medicine
reminders stop arriving and nothing reports it. The server now refuses to boot
in production if it would have to generate fresh keys with nowhere to keep them.

## 4. Environment variables

| Key | Required | Notes |
|-----|----------|-------|
| `DATABASE_URL`    | yes | Render's Internal Database URL |
| `DATA_DIR`        | yes | `/var/data` — the mounted disk |
| `NODE_ENV`        | yes | `production` (secures the session cookie) |
| `APP_URL`         | yes | e.g. `https://parentfirst.onrender.com` — invite links use it |
| `VAPID_PUBLIC`    | yes | from `npm run vapid` |
| `VAPID_PRIVATE`   | yes | from `npm run vapid`, keep secret |
| `ANTHROPIC_API_KEY` | no | report extraction and AI summaries; the rest works without it |
| `SMTP_*`, `NOTIFY_*` | no | verification codes and invites; without them codes only reach the log |
| `SHOW_OTP_IN_UI`  | **never** | local development only; refused when `NODE_ENV=production` |

## 5. Build and start

| Setting | Value |
|---------|-------|
| Build command | `npm ci` |
| Start command | `npm run render-start` |

`render-start` applies any pending migrations, then boots. Migrations are
tracked in `schema_migrations`, so re-running is a no-op and a failure stops
the deploy instead of starting a server against a half-migrated database.

## 6. After the first deploy

```bash
curl https://YOUR-APP.onrender.com/api/health
```

Then sign up, confirm the code arrives, and check the Family page shows a join
code.

## Known limits

- **One instance only.** The care loop and digest schedulers run in-process. Two
  instances means two sets of reminders. `loop_marks` dedupes medicine nudges,
  but the digests are not claim-guarded.
- **Free tier sleeps.** A sleeping service runs no reminders. The care loop is
  the product; it needs a plan that stays awake.
- **Disk backups are yours to arrange.** Render snapshots the database, not the
  disk. Uploaded reports are not in those snapshots.
