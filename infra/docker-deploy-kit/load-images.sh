#!/usr/bin/env bash
#
# load-images.sh — (RUN BY THE RECIPIENT) load the transferred image tarballs
# into Docker. Expects the *.tar.gz files in ./images (or pass a dir as $1).
set -euo pipefail
cd "$(dirname "$0")"

DIR=${1:-images}
[ -d "$DIR" ] || { echo "image dir '$DIR' not found. Put worker/backend/ui.tar.gz there, or pass the path."; exit 1; }
command -v docker >/dev/null || { echo "docker not found"; exit 1; }

for name in worker backend ui; do
  f="$DIR/$name.tar.gz"
  [ -f "$f" ] || { echo "missing $f — skipping"; continue; }
  echo ">>> loading $f ..."
  gunzip -c "$f" | docker load
done

# Optional public images (skip if you can `docker pull` them):
for name in mongo redis; do
  f="$DIR/$name.tar.gz"
  [ -f "$f" ] && { echo ">>> loading $f ..."; gunzip -c "$f" | docker load; }
done

echo
echo "Loaded images:"
docker images | grep -E "bilbomd-(worker|backend|ui)|^mongo|^redis" || true
