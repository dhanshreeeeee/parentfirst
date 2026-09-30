#!/usr/bin/env bash
# Full report flow over HTTP with a fake model. Needs a local Postgres in DATABASE_URL
# and the sample report at REPORT_PDF (required).
set -e; cd "$(dirname "$0")/.."
PDF=${REPORT_PDF:?set REPORT_PDF to a sample lab report PDF}
psql "$DATABASE_URL" -qc "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" && psql "$DATABASE_URL" -qf db/schema.sql >/dev/null
echo '[]' > /tmp/fake_log.json
node test/run-fake-model.mjs 141.9 & FP=$!
NODE_ENV=production ALLOW_INSECURE_COOKIE=1 PORT=4600 ANTHROPIC_API_KEY=fake ANTHROPIC_BASE_URL=http://localhost:4700 node src/server.js > /tmp/e2e.log 2>&1 & SP=$!
for i in $(seq 1 30); do curl -s --max-time 2 localhost:4600/api/health >/dev/null 2>&1 && break; sleep 0.5; done
node test/e2e-reports.mjs; kill $SP $FP
