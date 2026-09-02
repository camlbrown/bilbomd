#!/usr/bin/env bash
#
# launch.sh — (RUN BY THE RECIPIENT) bring the stack up and open a logged-in UI.
# Mirrors the k8s launcher: waits for health, mints a one-time login code in
# Mongo (email is off), and opens the browser straight to the dashboard.
#
# DEV/TEST convenience only — the OTP shortcut needs local DB access. For real
# multi-user login, set up ORCID/email + a proper URL (see README).
#
# Usage:  ./launch.sh          (starts containers if not already up)
#         ./launch.sh --no-up  (assume already up; just mint a code + open)
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "No .env — run ./setup-env.sh first."; exit 1; }
set -a; . ./.env; set +a
PORT="${BILBOMD_UI_PORT:-8080}"
EMAIL="${TEST_EMAIL:-test@example.invalid}"

# docker compose v2 (plugin) or legacy docker-compose
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else echo "Docker Compose not found (need Compose v2: 'docker compose')"; exit 1; fi

if [ "${1:-}" != "--no-up" ]; then
  echo ">>> starting containers ..."
  $DC up -d
fi

echo ">>> waiting for the UI to answer on http://localhost:$PORT ..."
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then break; fi
  sleep 2
done

echo ">>> waiting for the backend to be healthy ..."
for _ in $(seq 1 60); do
  if $DC exec -T backend curl -fsS http://localhost:3500/healthcheck >/dev/null 2>&1; then break; fi
  sleep 2
done

# Mint a fresh one-time login code (valid 1h). Upserts a test user.
CODE="LOGIN$(date +%s)"
echo ">>> minting login code for $EMAIL ..."
$DC exec -T mongodb mongosh -u "$MONGO_USERNAME" -p "$MONGO_PASSWORD" \
  --authenticationDatabase "${MONGO_AUTH_SRC:-admin}" "${MONGO_DB:-bilbomd}" --quiet --eval "
  db.users.updateOne(
    {email:'$EMAIL'},
    {\$set:{otp:{code:'$CODE',expiresAt:new Date(Date.now()+3600000),attempts:0}},
     \$setOnInsert:{username:'testuser',roles:['User'],status:'Active',active:true,jobCount:0,createdAt:new Date(),refreshToken:[]}},
    {upsert:true});
  print('otp-set');" >/dev/null

URL="http://localhost:$PORT/auth/$CODE"
command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 &
command -v open >/dev/null 2>&1 && open "$URL" >/dev/null 2>&1 &

echo
echo "BilboMD is up. Log in via (opened in your browser; copy if it didn't):"
echo "    $URL"
echo "Dashboard: http://localhost:$PORT"
echo
echo "Stop everything with:   $DC down       (add -v to also wipe the database/volumes)"
