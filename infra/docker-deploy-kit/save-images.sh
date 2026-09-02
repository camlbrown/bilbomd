#!/usr/bin/env bash
#
# save-images.sh — (RUN BY YOU, the sender) build ONE self-contained tarball to
# hand to a colleague (e.g. via OneDrive). It:
#   1. retags the built worker/backend/ui images to neutral names,
#   2. saves them + pulls & saves mongo/redis (so the recipient needs NO internet),
#   3. copies the deploy-kit files (compose, scripts, README) alongside,
#   4. tars the whole thing into a single uploadable file.
#
# Usage:
#   ./save-images.sh [WORKDIR]
#   WORKDIR defaults to /scratch/kri42825/tmp/bilbomd-bundle
#
# Result: <WORKDIR>/bilbomd-docker-deploy.tar   <-- upload THIS to OneDrive.
set -euo pipefail

WORKDIR=${1:-/scratch/kri42825/tmp/bilbomd-bundle}
export TMPDIR=${TMPDIR:-/scratch/kri42825/tmp/podman-tmp}
mkdir -p "$WORKDIR" "$TMPDIR"

KIT="$(cd "$(dirname "$0")" && pwd)"
ENGINE=$(command -v podman || command -v docker) || { echo "no podman/docker"; exit 1; }
echo "engine: $ENGINE"
echo "workdir: $WORKDIR"

# ---- EDIT these to match your local tags if different ----
WORKER_SRC=gitlab.diamond.ac.uk:5050/kri42825/bilbomd/bilbomd-worker:chi2fix-20260810
BACKEND_SRC=localhost/bilbomd-backend:diamond
UI_SRC=localhost/bilbomd-ui:diamond
MONGO_IMG=docker.io/library/mongo:8.3.2
REDIS_IMG=docker.io/library/redis:8.8.0

STAGE="$WORKDIR/bilbomd-docker-deploy"
IMAGES="$STAGE/images"
rm -rf "$STAGE"
mkdir -p "$IMAGES"

# Neutral names the compose (and load-images.sh) expect:
"$ENGINE" tag "$WORKER_SRC"  bilbomd-worker:carbonara
"$ENGINE" tag "$BACKEND_SRC" bilbomd-backend:carbonara
"$ENGINE" tag "$UI_SRC"      bilbomd-ui:carbonara

# mongo/redis: pull so they can be bundled (recipient needs no internet).
echo ">>> pulling mongo/redis (public) so they can be bundled ..."
"$ENGINE" pull "$MONGO_IMG"
"$ENGINE" pull "$REDIS_IMG"

save() {  # <image> <outfile>
  echo ">>> saving $1 -> images/$2 ..."
  "$ENGINE" save "$1" | gzip -1 > "$IMAGES/$2"
  ls -lh "$IMAGES/$2"
}

save bilbomd-worker:carbonara  worker.tar.gz
save bilbomd-backend:carbonara backend.tar.gz
save bilbomd-ui:carbonara      ui.tar.gz
save "$MONGO_IMG"              mongo.tar.gz
save "$REDIS_IMG"             redis.tar.gz

# Copy the recipient-facing kit files (NOT this sender script).
echo ">>> copying deploy-kit files ..."
cp "$KIT/docker-compose.yml" "$KIT/.env.template" "$KIT/setup-env.sh" \
   "$KIT/load-images.sh" "$KIT/launch.sh" "$KIT/README.md" "$STAGE/"
chmod +x "$STAGE"/*.sh

# One uploadable tarball. No extra gzip (image files are already compressed).
BUNDLE="$WORKDIR/bilbomd-docker-deploy.tar"
echo ">>> building bundle $BUNDLE ..."
tar -cf "$BUNDLE" -C "$WORKDIR" bilbomd-docker-deploy

echo
echo "DONE."
echo "  Bundle:  $BUNDLE"
ls -lh "$BUNDLE"
echo "  Upload that single file to OneDrive. The recipient extracts it and follows README.md."
