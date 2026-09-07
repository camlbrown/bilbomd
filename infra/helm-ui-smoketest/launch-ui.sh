#!/usr/bin/env bash
#
# launch-ui.sh — one-command launcher for the BilboMD UI on Diamond B21.
#
# Hides the port-forward + OTP-login dance for anyone who already has kubectl
# access to the b21-beamline namespace. It:
#   1. checks kubectl can reach the namespace,
#   2. waits for mongo/backend/UI to be Ready,
#   3. mints a fresh one-time login code straight into Mongo (email is off),
#   4. opens a port-forward to the UI in the background,
#   5. opens your browser straight to the logged-in dashboard,
#   6. tears the port-forward down cleanly on Ctrl+C.
#
# This is a DEV/TEST convenience only — it needs cluster credentials and the
# no-email OTP shortcut. Real self-service login for new users comes with the
# ingress + ORCID/email work (see docs/k8s/DAVID_QUESTIONS_ingress_auth.md).
#
# Usage:
#   ./launch-ui.sh                 # defaults below
#   PORT=9090 ./launch-ui.sh       # use a different local port
#   NS=other-ns ./launch-ui.sh     # different namespace
#
# Prereq (new shell): module load k8s-b21
#
set -euo pipefail

# ----------------------------- configuration -------------------------------
NS="${NS:-b21-beamline}"                 # namespace
RELEASE="${RELEASE:-bilbomd-ui}"         # helm release => svc/deploy name
PORT="${PORT:-8080}"                      # local port to expose the UI on
EMAIL="${EMAIL:-test@example.invalid}"    # test user to log in as
MONGO_DEPLOY="${MONGO_DEPLOY:-bilbomd-mongo}"
BACKEND_DEPLOY="${BACKEND_DEPLOY:-bilbomd-backend}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180s}"

# --------------------------------- helpers ---------------------------------
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }
info()  { printf '  %s\n' "$*"; }

die() { red "ERROR: $*"; exit 1; }

PF_PID=""
cleanup() {
  if [[ -n "$PF_PID" ]] && kill -0 "$PF_PID" 2>/dev/null; then
    echo
    info "Stopping port-forward (pid $PF_PID)…"
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ------------------------------ preflight ----------------------------------
command -v kubectl >/dev/null 2>&1 || die "kubectl not found. Run: module load k8s-b21"

bold "BilboMD UI launcher (namespace: $NS, release: $RELEASE)"

# All cluster calls get a request timeout so a bad context/credentials FAIL FAST
# with a real error instead of hanging forever.
KUBECTL="kubectl --request-timeout=${KUBECTL_TIMEOUT:-15s}"

# 1) Can we reach + authenticate to the API server at all? (fast, real error shown)
info "Checking cluster connectivity…"
if ! err=$($KUBECTL version -o json 2>&1 >/dev/null); then
  red "Cannot reach/authenticate to the Kubernetes API server."
  echo "  current-context: $(kubectl config current-context 2>/dev/null || echo '(none set)')"
  echo "  KUBECONFIG:      ${KUBECONFIG:-(default ~/.kube/config)}"
  echo "  kubectl said:    ${err%%$'\n'*}"
  echo
  echo "  This usually means you are not authenticated to the cluster."
  echo "  'module load k8s-b21' puts kubectl on PATH but does NOT log you in."
  echo "  Ensure a context is selected (kubectl config get-contexts) and that you"
  echo "  have completed the Diamond cluster login for k8s-b21."
  die "cluster unreachable/unauthenticated."
fi

# 2) Namespace access (use a NAMESPACED check — some users can't 'get namespaces'
#    cluster-wide even when they have full access inside the namespace).
if ! err=$($KUBECTL get pods -n "$NS" 2>&1 >/dev/null); then
  red "Reached the cluster, but cannot access namespace '$NS'."
  echo "  kubectl said: ${err%%$'\n'*}"
  echo "  can-i get pods:    $(kubectl auth can-i get pods -n "$NS" 2>/dev/null || echo '?')"
  echo "  can-i create pods: $(kubectl auth can-i create pods -n "$NS" 2>/dev/null || echo '?')"
  echo "  If these say 'no', your FedID needs RBAC in '$NS' — ask the b21 admins."
  die "no access to namespace '$NS'."
fi

$KUBECTL get svc "$RELEASE" -n "$NS" >/dev/null 2>&1 \
  || die "service '$RELEASE' not found in $NS. Is the chart deployed? (helm upgrade --install)"

$KUBECTL get deploy "$MONGO_DEPLOY" -n "$NS" >/dev/null 2>&1 \
  || die "deployment '$MONGO_DEPLOY' not found — cannot mint a login code."

# ------------------------- wait for readiness ------------------------------
info "Waiting for core pods to be Ready (timeout $WAIT_TIMEOUT)…"
kubectl rollout status "deploy/$MONGO_DEPLOY"   -n "$NS" --timeout="$WAIT_TIMEOUT" >/dev/null \
  || die "$MONGO_DEPLOY not ready."
kubectl rollout status "deploy/$BACKEND_DEPLOY" -n "$NS" --timeout="$WAIT_TIMEOUT" >/dev/null \
  || die "$BACKEND_DEPLOY not ready (login needs the backend)."
kubectl rollout status "deploy/$RELEASE"        -n "$NS" --timeout="$WAIT_TIMEOUT" >/dev/null \
  || die "$RELEASE (UI) not ready."
green "  ✓ mongo, backend and UI are Ready"

# ------------------------- mint one-time code ------------------------------
# Unique per run so a stale code never blocks login. Alphanumeric only (safe in
# a URL and inside the mongosh eval string).
CODE="UILOGIN$(date +%s)"
info "Minting one-time login code for $EMAIL …"
kubectl exec -n "$NS" "deploy/$MONGO_DEPLOY" -- sh -c \
 'mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin bilbomd --quiet --eval "db.users.updateOne({email:\"'"$EMAIL"'\"},{\$set:{otp:{code:\"'"$CODE"'\",expiresAt:new Date(Date.now()+3600000),attempts:0}},\$setOnInsert:{username:\"testuser\",roles:[\"User\"],status:\"Active\",active:true,jobCount:0,createdAt:new Date(),refreshToken:[]}},{upsert:true}); print(\"otp-set\");"' \
  >/dev/null || die "failed to mint OTP in Mongo."
green "  ✓ login code ready (valid 1 hour)"

# --------------------------- port-forward ----------------------------------
# Fail early if the local port is already taken.
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  exec 3>&- 3<&-
  die "local port $PORT is already in use. Re-run with PORT=<free port>, e.g. PORT=9090 $0"
fi

info "Opening port-forward svc/$RELEASE $PORT:80 …"
kubectl port-forward -n "$NS" "svc/$RELEASE" "$PORT:80" >/dev/null 2>&1 &
PF_PID=$!

# Wait (up to ~15s) for the tunnel to accept connections.
for _ in $(seq 1 30); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  kill -0 "$PF_PID" 2>/dev/null || die "port-forward exited unexpectedly."
  sleep 0.5
done
green "  ✓ tunnel up on http://localhost:$PORT"

# ------------------------------ open browser -------------------------------
URL="http://localhost:$PORT/auth/$CODE"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 &
fi

echo
bold "BilboMD is ready."
info "Login URL (opened in your browser; copy it if it didn't):"
green "    $URL"
info "Dashboard after login: http://localhost:$PORT"
echo
bold "Leave this terminal open while you use the UI."
info "Press Ctrl+C here to stop the tunnel and exit."
echo

# Block on the port-forward; cleanup() runs on Ctrl+C.
wait "$PF_PID"
