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

Put your connection string in `.env` (copy `.env.example`), then:

```bash
npm install
npm run db:migrate
npm start
```

`db:migrate` applies every migration you haven't run yet, in order, each in its
own transaction, and records what it applied so re-running is a no-op. To see
what it would do without touching anything:

```bash
npm run db:migrate -- --dry
```

Migration `024` is the one that adds family join codes, the ADMIN role, and the
columns the full intake form writes to. Until it runs, family actions will error.

## Tests

```bash
npm run test:routes
```

Routing and authorization — needs no database. The full architecture suite
(`npm test`) also runs the family-graph tests, which need `DATABASE_URL`
pointing at a database it may TRUNCATE. Never point it at production.

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

## If your screens look empty

The original demo data (medicines, reports, care team) belongs to the seeded
"Ramesh Sharma" record. To move it onto the real parent:

```bash
node scripts/move-demo-data.js
```

## Running it manually (concierge mode)

While you fulfil bookings by hand:

**1. Get notified.** Add SMTP settings to `.env` so every booking and alert emails you
(see `.env.example`). For Gmail, create an *App Password* — not your normal password.
Without SMTP it still prints a loud banner in the server console.

**2. Work the queue.** Admins get a **Requests** tab: every booking and open alert across
all your families, with the family's phone numbers to tap and call, and status buttons
to move each one pending → confirmed → done.

**3. Be honest in the product.** Booking confirmations say "we'll call you to confirm" —
they do not promise instant dispatch. Keep it that way while it's manual.
