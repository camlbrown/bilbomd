#!/usr/bin/env bash
#
# setup-env.sh — (RUN BY THE RECIPIENT) create .env from .env.template with
# freshly generated secrets. Safe to read; writes .env once.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] && { echo ".env already exists — refusing to overwrite. Delete it first to regenerate."; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found (needed to generate secrets)"; exit 1; }

gen() { openssl rand -hex 32; }

sed \
  -e "s|__MONGO_PASSWORD__|$(gen)|" \
  -e "s|__ACCESS_TOKEN_SECRET__|$(gen)|" \
  -e "s|__REFRESH_TOKEN_SECRET__|$(gen)|" \
  -e "s|__SESSION_SECRET__|$(gen)|" \
  -e "s|__HASH_IP_SALT__|$(gen)|" \
  .env.template > .env

chmod 600 .env
echo "Wrote .env with generated secrets."
echo "Review BILBOMD_URL / BILBOMD_UI_PORT if you are not using http://localhost:8080."
