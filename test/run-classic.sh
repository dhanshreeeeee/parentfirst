#!/usr/bin/env bash
# The CURRENT UI driven in a real browser engine against this backend. Arg: 6 or 8 (family code format).
cd "$(dirname "$0")/.."
psql "$DATABASE_URL" -qc "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>/dev/null; psql "$DATABASE_URL" -qf db/schema.sql >/dev/null 2>&1
echo '[]' > /tmp/fake_log.json
node test/run-fake-model.mjs 141.9 & FP=$!
NODE_ENV=production ALLOW_INSECURE_COOKIE=1 PORT=4600 ANTHROPIC_API_KEY=fake ANTHROPIC_BASE_URL=http://localhost:4700 node src/server.js > /tmp/cl.log 2>&1 & SP=$!
for i in $(seq 1 30); do curl -s --max-time 2 localhost:4600/api/health >/dev/null 2>&1 && break; sleep 0.5; done
if [ "$1" = "8" ]; then CODE8=1 timeout 100 node test/classic-ui.mjs; else timeout 100 node test/classic-ui.mjs; fi
kill $SP $FP 2>/dev/null; wait 2>/dev/null
