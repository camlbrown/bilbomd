#!/usr/bin/env bash
#
# load-images.sh — (RUN BY THE RECIPIENT) load ALL bundled image tarballs into
# Docker and normalise their names to what docker-compose.yml expects.
#
# Expects the *.tar.gz files in ./images (or pass a dir as $1). Everything is
# bundled — you do NOT need to pull anything from the internet.
set -euo pipefail
cd "$(dirname "$0")"

DIR=${1:-images}
[ -d "$DIR" ] || { echo "image dir '$DIR' not found. Extract the bundle so ./images/*.tar.gz exist, or pass the path."; exit 1; }
command -v docker >/dev/null || { echo "docker not found"; exit 1; }

load() { echo ">>> loading $1 ..."; gunzip -c "$1" | docker load; }

for f in "$DIR"/*.tar.gz; do
  [ -e "$f" ] || { echo "no *.tar.gz in $DIR"; exit 1; }
  load "$f"
done

# podman-saved images carry a 'localhost/' prefix; compose uses the bare name.
# Re-tag so `image: bilbomd-worker:carbonara` (etc.) resolves to the loaded image.
for name in worker backend ui; do
  if docker image inspect "localhost/bilbomd-$name:carbonara" >/dev/null 2>&1; then
    docker tag "localhost/bilbomd-$name:carbonara" "bilbomd-$name:carbonara"
    echo "  retagged localhost/bilbomd-$name:carbonara -> bilbomd-$name:carbonara"
  fi
done

echo
echo "Loaded images:"
docker images | grep -E "bilbomd-(worker|backend|ui)|^mongo |^redis " || true
echo
echo "Next: ./setup-env.sh   then   ./launch.sh"
