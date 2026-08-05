# ParentFirst — Setup on your Mac

## If this is a FRESH install (no database yet)

```bash
# 1. from inside this folder (where package.json is)
createdb parentfirst_vault
psql -d parentfirst_vault -f db/schema.sql

# 2. create your .env
cp .env.example .env
open -e .env
#    set this line with your Postgres password:
#    DATABASE_URL=postgres://dhanshreekhandelwal:YOURPASSWORD@localhost:5432/parentfirst_vault
#    (optional) add: ANTHROPIC_API_KEY=sk-ant-...

# 3. install + run
npm install
npm start
```

## If you ALREADY have the database (upgrading)

Run every migration you haven't run yet — they're all safe to run again:

```bash
psql -d parentfirst_vault -f db/migrations/001_care_modules.sql
psql -d parentfirst_vault -f db/migrations/002_engagement.sql
psql -d parentfirst_vault -f db/migrations/003_booking_fields.sql
psql -d parentfirst_vault -f db/migrations/004_accounts.sql
psql -d parentfirst_vault -f db/migrations/005_alerts.sql
psql -d parentfirst_vault -f db/migrations/006_report_files.sql
psql -d parentfirst_vault -f db/migrations/007_appointments.sql
psql -d parentfirst_vault -f db/migrations/008_household.sql
psql -d parentfirst_vault -f db/migrations/009_med_schedule.sql

npm install
npm start
```

Tip: to avoid typing the Postgres password at every migration, run once first:
```bash
export PGPASSWORD='YOURPASSWORD'
```

## Then

Open **http://localhost:4500**

On the very first run the terminal prints a login:
```
Email:    dhanshree@parentfirst.local
Password: changeme123
```

## Notes
- Everything works WITHOUT an Anthropic key. Only the AI chat and the optional
  "Ask AI to explain" narratives need `ANTHROPIC_API_KEY` in `.env`.
- The caregiver's simple phone screen is at **/caregiver**.
- On sign-up you choose "Caring for someone" (owner) or "Signing up for myself" (dependent),
  then fill a 3-step intake. Dependents see a simplified version of the app ("My Day").
- Owners can add more parents and invite family (user menu -> Family & roles).
- Keep this local for now — it holds health data and has no HTTPS/password-reset yet.


## Create the family's accounts

```bash
node scripts/seed-family.js
```

Creates 5 logins (all password `parentfirst123`), linked to Harish Khandelwal:

| Login | Role | What they can do |
|---|---|---|
| dhanshree@family.local | admin | Everything: medicines, emergency info, invite family, delete reports |
| harsheeta@family.local | admin | Same as above |
| jyoti@family.local | member | View everything, book services, add appointments, message |
| harish@family.local | dependent | His own "My Day": daily check-in, his medicines, family notes |
| ramu@family.local | caregiver | Marks medicines given, logs the daily check-in |

Change any password with:
```bash
node scripts/reset-password.js <email> <new-password>
```
