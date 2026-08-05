# ParentFirst — AI Health Vault

Upload a parent's medical reports (PDF/photo) → AI extracts every value into PostgreSQL → timeline, comparison engine, trends, and grounded AI chat.

**Stack:** Node 18+ · Fastify · PostgreSQL · Anthropic API (server-side)

---

## Setup on macOS

### 1. Install PostgreSQL (skip if you have it)

```bash
brew install postgresql@16
brew services start postgresql@16
```

### 2. Create the database and load the schema

```bash
createdb parentfirst_vault
psql -d parentfirst_vault -f db/schema.sql
```

This creates all tables, loads 13 reference ranges, and seeds one demo parent (Ramesh Sharma) with two sample reports (Jan vs Jun 2026) so the app works immediately.

### 3. Configure

```bash
cp .env.example .env
```

Open `.env` and paste your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

The default database connection uses your Mac username over localhost, which is exactly how Homebrew Postgres works — you usually don't need to set `DATABASE_URL` at all.

### 4. Install & run

```bash
npm install
npm start
```

Open **http://localhost:4500** — the vault loads with the two sample reports.

---

## What works

| Feature | How |
|---|---|
| Report timeline | `GET /api/parents/:id/reports` — grouped by date, in/out-of-range flags computed server-side |
| Report detail | `GET /api/reports/:id` — every parameter vs reference range |
| **AI extraction** | `POST /api/parents/:id/extract` — multipart file upload (PDF/JPG/PNG) → Claude vision → structured rows in Postgres |
| Compare engine | `GET /api/compare?a=&b=` — per-parameter change %, direction, and "improving" (moves toward healthy midpoint) |
| AI summary | `POST /api/compare/summary` — plain-English comparison, never diagnoses |
| Trends | `GET /api/parents/:id/trends` — every parameter across all reports |
| Grounded chat | `POST /api/parents/:id/chat` — answers only from vault data |
| Manual entry | `POST /api/reports` — add a report without AI |


## Extraction: free first, AI only when needed

Uploads run a **two-stage** pipeline to keep costs near zero:

1. **Local path (free).** For digital PDFs, the server reads the text with `pdf-parse` and rule-matches known blood parameters — no API call, no cost. Handles clean lab PDFs (Lal PathLabs, etc.).
2. **AI fallback.** Only if the local path can't cope — a scanned/photo report with no text, an unknown layout, or fewer than 4 values found — does it call Claude vision. That's the only time you pay.

The server log tells you which path ran: `extract: local path succeeded (N params, no AI cost)` or `... → AI fallback`. The method is also saved in each report's `raw_extraction._method`.

To widen free coverage, add aliases for your labs' parameter names in `src/extract-local.js` (the `ALIASES` map).


## Daily care modules (medications, caregiver log, emergency card)

Beyond the report vault, the app runs the day-to-day care loop:

**Medications** — add each medicine with dose and morning/afternoon/night slots. The caregiver ticks off doses; the app computes today's adherence. Tables: `medications`, `medication_log`.

**Daily Care & Family** — the caregiver submits a quick daily check-in (mood, ate well, sleep, BP, sugar, a note). The server turns it into a warm **family update** — written by AI when a key is set, or a friendly template when not — and shows a running family feed. Table: `daily_logs`. This is the "your parent is present in the family's day" loop.

**Emergency Card** — a one-glance sheet aggregating blood group, allergies, conditions, current medicines, doctor, and emergency contacts. Table: `contacts`, plus emergency fields on `parents`. Print it and keep it by the bed.

All three share the same PostgreSQL database and the same parent record as the vault.

## Database schema

- `parents` — the elder (name, age, relation, city)
- `reports` — one uploaded document (type, lab, doctor, date, raw AI extraction as JSONB)
- `report_params` — one measured value (canonical name, numeric value, unit)
- `reference_ranges` — healthy bands used for all status flags (editable — they're just rows)

## Notes

- The Anthropic key lives **only in `.env` on the server**. The browser never sees it.
- The AI is deliberately constrained: extraction and explanation only, no diagnosis. Keep it that way — in India, health data means DPDP Act obligations and interpretive AI invites real liability.
- Add a second parent via `POST /api/parents {"name": "..."}` — the frontend currently shows the first parent; multi-parent switching is an easy next step.
- To reset the database: `dropdb parentfirst_vault && createdb parentfirst_vault && psql -d parentfirst_vault -f db/schema.sql`


## Care modules (added)

Beyond the report vault, the app now covers the daily care loop:

**Medications** — schedule meds by slot (morning/afternoon/night); the caregiver ticks off each dose; live adherence %. `GET /api/parents/:id/medications/today` returns the day's schedule + adherence.

**Daily Care & Family** — the caregiver logs mood, meals, sleep, BP/sugar and a note in seconds. The server turns it into a warm **family update** (AI if a key is set, otherwise a built-in template — free) shown in a family feed. `POST /api/parents/:id/logs`.

**Emergency Card** — one page with blood group, conditions, allergies, current meds, doctor, and emergency contacts. Printable (browser print → Save as PDF). `GET /api/parents/:id/emergency-card`.

Emergency info and contacts live on the parent and in a `contacts` table; edit via `PUT /api/parents/:id/emergency-info` and `POST /api/parents/:id/contacts`.

If you already ran an older schema, apply the additions with:
```bash
psql -d parentfirst_vault -f db/migrations/001_care_modules.sql
```
(idempotent — safe to run once, on your existing data).


## Engagement modules (added)

**Parent Monitor** — the home dashboard. One glance: today's family update + mood, medication adherence, key vitals from the latest report, care team, and next scheduled service. `GET /api/parents/:id/monitor`.

**Care Team** — shows the assigned caregivers/specialists (with ratings), and lets you book a new caregiver, nurse, physiotherapist or companion. Bookings are stored as service requests with a status. `GET/POST /api/parents/:id/care-team`, `GET/POST /api/parents/:id/service-requests`.

**Activities & Wellness (Moh TV)** — a curated library of senior-safe exercise & chair-yoga videos (real YouTube content), filterable by category, playing inline. `GET /api/activities`. Add your own rows to the `activities` table to grow the library.

Apply on an existing database:
```bash
psql -d parentfirst_vault -f db/migrations/002_engagement.sql
```
(idempotent).


## Accounts, families & roles (added)

The app now has real login and multi-parent support.

**First run:** the server creates a default admin account and prints the credentials in the terminal:
```
Email:    dhanshree@parentfirst.local
Password: changeme123
```
All the demo data is linked to it. Log in, then create more accounts from the sign-up screen.

**Roles** (per parent, set in the user menu → Family & roles):
- **admin** — full control: add/remove medicines, edit emergency info, delete reports, invite family, add parents
- **member** — view everything, book services, log daily care, use AI chat
- **caregiver** — mark medicines taken and log the daily check-in (the helper's access)

**Multiple parents:** an admin can add more parents (parent menu → Add a parent) and switch between them from the top bar. Each parent has its own vault, meds, care team and family.

**Inviting family:** ask them to sign up first, then invite them by email from Family & roles and pick their role.

Apply on an existing database:
```bash
psql -d parentfirst_vault -f db/migrations/004_accounts.sql
```

Security notes: passwords are scrypt-hashed; sessions are httpOnly cookies. This is real auth, but it has no email verification or password reset yet, and no HTTPS in dev — keep it local until those exist.


## Caregiver surface (added)

A separate, phone-first page at **/caregiver** for the helper — big buttons, minimal text, nothing to navigate.

- **Auto-routing:** a user whose only role is `caregiver` is sent to /caregiver automatically on login. Admins/members can preview it from the user menu → Caregiver view.
- **What the caregiver does:** tick off each medicine as it's given, log a two-tap daily check-in (mood, meals, sleep, a note), and hit "Report a problem" to flag something.
- **Flags reach the family:** a caregiver alert shows as a banner on the Parent Monitor; a member/admin can resolve it. `POST /api/parents/:id/alerts` (any member incl. caregiver), `GET` + resolve are member+.

Apply on an existing database:
```bash
psql -d parentfirst_vault -f db/migrations/005_alerts.sql
```


## Layer 3: deeper features (added)

**Original report files.** Uploaded PDFs/photos are now kept on disk (`data/reports/`) — open a report and click "View original" to see the actual document, not just the extracted numbers. Served access-checked at `GET /api/reports/:id/file`.

**Appointments & reminders.** A new Appointments view tracks doctor visits and reminders (e.g. "Vitamin D recheck"). The Parent Monitor shows the next appointment and flags overdue ones. `GET/POST /api/parents/:id/appointments`, status updates member+.

**Emergency SOS.** The emergency card now has a one-tap SOS block: call the primary family contact, the doctor, or an ambulance (108) via `tel:` links (they dial on a phone), plus "Alert my family in the app" which raises an in-app alert.

**Graceful AI.** When there's no `ANTHROPIC_API_KEY`, the AI summary panel now explains it's optional instead of showing "Bad Gateway" — every other feature works without a key.

Apply on an existing database:
```bash
psql -d parentfirst_vault -f db/migrations/006_report_files.sql
psql -d parentfirst_vault -f db/migrations/007_appointments.sql
```


## Layer 4: intelligence (added)

**Proactive insights** on the Parent Monitor — computed for free from the data, no AI required:
- Reads blood-report trends across time ("HbA1c improving but still above range", "Vitamin D back in the healthy range")
- Flags low medication adherence later in the day, overdue appointments/reminders, and open caregiver alerts
- Sorted urgent → watch → good, so the family sees what matters first

`GET /api/parents/:id/insights` returns the rule-based observations. If an `ANTHROPIC_API_KEY` is set, an **"Ask AI to explain"** button turns them into a warm plain-English paragraph (`POST /api/parents/:id/insights/explain`) — optional, graceful without a key.

**Smarter Ask AI** — the chat is now grounded in the whole vault (reports + current medicines + recent daily logs + upcoming appointments), not just blood reports. Also degrades gracefully when there's no key.

No migration needed — Layer 4 is compute + endpoints only.


## Household, dependents & intake (added)

**One login page for everyone.** On sign-up you pick "Caring for someone" (owner) or "Signing up for myself" (dependent). Everyone signs in at the same place; the app routes by role.

**Intake form.** Every new user completes a 3-step intake: basics (name, age, gender, city), daily living (mobility, eyesight, hearing, speech, memory, falls, lives alone), and health/lifestyle (smoking, alcohol, diet, blood group, allergies, conditions, preferred text size). Stored in `care_profiles`.

**The intake actually does things:**
- **Adapts the interface** — poor eyesight or a chosen text size scales the whole app (`ts-large`, `ts-xlarge`).
- **Feeds the insights engine** — e.g. multiple falls + limited mobility surfaces "High fall risk"; living alone with confusion surfaces a staffing suggestion; current smoking is flagged.

**Roles.** `admin` (owner), `member` (family), `caregiver` (the helper), `dependent` (the elder themselves). Several owners can share several dependents — you and your sister as admins on both your father and mother.

**Dependent's view ("My Day").** The same app, simplified: a daily check-in, their medicines, and messages from family. Family-management surfaces are hidden.

**Daily check-in.** The dependent taps how they're feeling (good / okay / not well / I need help). "Not well" or "I need help" raises an immediate alert to the family and appears at the top of insights. A missed check-in after 11am is flagged.

**Two-way messages.** Family sends notes the dependent sees on their screen — presence, not just monitoring.

**Document vault.** Insurance, ID, hospital papers, prescriptions — uploaded, categorised, and openable. `GET/POST /api/parents/:id/documents`, `GET /api/documents/:id/file`.

Apply on an existing database:
```bash
psql -d parentfirst_vault -f db/migrations/008_household.sql
```

## Roadmap candidates

- Multi-parent switcher in the nav
- Auth (this has none — do not expose it to the internet as-is)
- File storage of the original PDF (S3/local) alongside the extraction
- WhatsApp notification when a new report lands ("Papa's HbA1c improved!")
- PM2 deployment on your server: `pm2 start src/server.js --name vault`
