#!/usr/bin/env bash
#
# save-images.sh — (RUN BY YOU, the sender) retag the built images to the neutral
# names the compose expects and export them as gzipped tarballs for transfer
# (e.g. upload to OneDrive). Uses podman or docker, whichever is present.
#
# Output: <OUTDIR>/{worker,backend,ui}.tar.gz  (+ optional mongo/redis).
#
# Usage:
#   ./save-images.sh [OUTDIR]
#   OUTDIR defaults to /scratch/kri42825/tmp/bilbomd-deploy-images
#
# The worker tarball is large (~8–12 GB gzipped). gzip -1 keeps it fast; the
# layers are already compressed so the size gain from higher levels is tiny.
set -euo pipefail

OUT=${1:-/scratch/kri42825/tmp/bilbomd-deploy-images}
export TMPDIR=${TMPDIR:-/scratch/kri42825/tmp/podman-tmp}
mkdir -p "$OUT" "$TMPDIR"

ENGINE=$(command -v podman || command -v docker) || { echo "no podman/docker"; exit 1; }
echo "engine: $ENGINE   outdir: $OUT"

# ---- EDIT these to match your local tags if different ----
WORKER_SRC=gitlab.diamond.ac.uk:5050/kri42825/bilbomd/bilbomd-worker:chi2fix-20260810
BACKEND_SRC=localhost/bilbomd-backend:diamond
UI_SRC=localhost/bilbomd-ui:diamond

# Neutral names the compose (and load-images.sh) expect:
"$ENGINE" tag "$WORKER_SRC"  bilbomd-worker:carbonara
"$ENGINE" tag "$BACKEND_SRC" bilbomd-backend:carbonara
"$ENGINE" tag "$UI_SRC"      bilbomd-ui:carbonara

save() {  # <image> <outfile>
  echo ">>> saving $1 -> $OUT/$2 (this can take a while for the worker) ..."
  "$ENGINE" save "$1" | gzip -1 > "$OUT/$2"
  ls -lh "$OUT/$2"
}

save bilbomd-worker:carbonara  worker.tar.gz
save bilbomd-backend:carbonara backend.tar.gz
save bilbomd-ui:carbonara      ui.tar.gz

# OPTIONAL: only if the recipient CANNOT pull public images from Docker Hub.
# Otherwise they just `docker pull mongo:8.3.2 redis:8.8.0` themselves.
# "$ENGINE" pull docker.io/library/mongo:8.3.2 && save docker.io/library/mongo:8.3.2 mongo.tar.gz
# "$ENGINE" pull docker.io/library/redis:8.8.0 && save docker.io/library/redis:8.8.0 redis.tar.gz

echo
echo "DONE. Upload the whole '$OUT' folder + the deploy-kit files to OneDrive."
du -sh "$OUT"
