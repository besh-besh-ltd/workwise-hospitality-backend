#!/usr/bin/env bash
# Purchase Requisitions: brings up the LOCAL end-to-end backend stack (Task 19a).
#
#   scripts/pr/e2e_up.sh              # prepare the DB if missing, (re-)seed it, start the server in the background
#   scripts/pr/e2e_up.sh --fresh      # drop + rebuild the database first
#   scripts/pr/e2e_up.sh --foreground # run the server in the foreground instead
#   scripts/pr/e2e_up.sh --stop       # stop the server this script started
#
# Everything is isolated from the other E2E stacks and from stage/prod:
#   database  hospitality_test_e2e_pr   (E2E_DB_NAME)   local Postgres only
#   server    port 8124                 (E2E_PORT)
#   AWS sink  port 9556                 (E2E_AWS_SINK_PORT), objects in /tmp/pr-e2e-aws-sink
#   mail      JSON files in /tmp/pr-e2e-mail (no SMTP)
# The server is started ONLY through scripts/vendor_networks/e2e_server.sh, which forces a
# local DB, the local AWS sink and the file mail sink. Never `npm run dev` / `node server.js`:
# backend/.env points at STAGE AWS/RDS and the SMTP host is hard-coded to the real relay.
set -euo pipefail
cd "$(dirname "$0")/../.."

export E2E_DB_NAME="${E2E_DB_NAME:-hospitality_test_e2e_pr}"
export E2E_PORT="${E2E_PORT:-8124}"
export E2E_AWS_SINK_PORT="${E2E_AWS_SINK_PORT:-9556}"
export E2E_AWS_SINK_DIR="${E2E_AWS_SINK_DIR:-/tmp/pr-e2e-aws-sink}"
export E2E_MAIL_DIR="${E2E_MAIL_DIR:-/tmp/pr-e2e-mail}"
export E2E_DB_HOST="${E2E_DB_HOST:-127.0.0.1}"
export E2E_FRONTEND_URL="${E2E_FRONTEND_URL:-http://localhost:3101}"
RUN_ID="${E2E_DB_NAME#hospitality_test_}"
LOG="${E2E_LOG:-/tmp/pr-e2e-server.log}"
PIDFILE="${E2E_PIDFILE:-/tmp/pr-e2e-server.pid}"

case "$E2E_DB_HOST" in localhost|127.0.0.1|::1) ;; *) echo "ABORT: E2E_DB_HOST '$E2E_DB_HOST' is not local" >&2; exit 2 ;; esac
if ! [[ "$E2E_DB_NAME" =~ ^hospitality_test_ ]] || [[ "$E2E_DB_NAME" =~ [Pp][Rr][Oo][Dd]|[Ss][Tt][Aa][Gg][Ee]|[Mm][Aa][Ii][Nn] ]]; then
  echo "ABORT: '$E2E_DB_NAME' is not a local hospitality_test_* database" >&2; exit 2
fi
if [ "$E2E_DB_NAME" = "hospitality_test_e2e" ] || [ "$E2E_PORT" = "8122" ]; then
  echo "ABORT: hospitality_test_e2e / port 8122 belong to the Vendor Networks stack" >&2; exit 2
fi

# Kills the recorded pid only when it is still OUR backend: a stale pidfile can
# name a pid the OS has since given to an unrelated process, which must never
# be killed. The launcher execs `node … server.js`, so that is what we look for.
stop_server() {
  if [ -s "$PIDFILE" ]; then
    local pid cmd
    pid="$(cat "$PIDFILE")"
    if kill -0 "$pid" 2>/dev/null; then
      cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
      if [[ "$cmd" =~ (^|[[:space:]/])server\.js([[:space:]]|$) ]]; then
        kill "$pid" && echo "[pr-e2e] stopped server pid $pid"
        for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      else
        echo "[pr-e2e] NOT killing pid $pid from $PIDFILE: not a server.js process ($cmd)" >&2
      fi
    fi
  fi
  rm -f "$PIDFILE"
}

MODE=background; FRESH=0
for a in "$@"; do
  case "$a" in
    --fresh) FRESH=1 ;;
    --foreground) MODE=foreground ;;
    --stop) stop_server; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

stop_server
if lsof -tiTCP:"$E2E_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ABORT: something else is listening on port $E2E_PORT (pid $(lsof -tiTCP:"$E2E_PORT" -sTCP:LISTEN | head -1)); stop it first" >&2
  exit 2
fi

DB_EXISTS=$(psql -h "$E2E_DB_HOST" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$E2E_DB_NAME'" || true)
if [ "$FRESH" = 1 ] || [ -z "$DB_EXISTS" ]; then
  echo "[pr-e2e] preparing $E2E_DB_NAME (schema + reference seed + pending migrations + fixtures)"
  E2E_RUN_ID="$RUN_ID" node scripts/vendor_networks/e2e_prepare_db.mjs
else
  echo "[pr-e2e] $E2E_DB_NAME exists; keeping it"
fi

echo "[pr-e2e] seeding"
node scripts/pr/seed_e2e.mjs --db="$E2E_DB_NAME" --host="$E2E_DB_HOST"

if [ "$MODE" = foreground ]; then
  exec scripts/vendor_networks/e2e_server.sh
fi

nohup scripts/vendor_networks/e2e_server.sh > "$LOG" 2>&1 &
echo $! > "$PIDFILE"
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$E2E_PORT/api/v1/pr/categories"; then break; fi
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "server died, see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; }
  sleep 1
done
PID=$(lsof -tiTCP:"$E2E_PORT" -sTCP:LISTEN | head -1 || true)
[ -n "$PID" ] && echo "$PID" > "$PIDFILE"
cat <<MSG

[pr-e2e] backend up: http://localhost:$E2E_PORT/api/v1   pid ${PID:-$(cat "$PIDFILE")}   log $LOG   stop: scripts/pr/e2e_up.sh --stop

Frontend (run in the PR FE worktree: <repo>/.worktrees/purchase-req/frontend; a shell variable beats .env.development):
  NEXT_PUBLIC_API_URL=http://localhost:$E2E_PORT/api/v1 npx next dev -p 3101
Admin panel (<repo>/.worktrees/purchase-req/admin-panel; its .env points at PROD, the shell variable below overrides it):
  NEXT_PUBLIC_API_WEB_URL=http://localhost:$E2E_PORT/api/v1 npx next dev -p 3102
Buyer login: employee_code from the seed table (e.g. PRREQHK) + password PrE2e@12345, via /users/login?conform=true
Admin login: pr.platform.admin@example.com / PrE2e@12345
MSG
