# AutoMD-SAXS — local end-to-end run guide

How to run the new `automd-saxs` job type end-to-end on the DLS workstation.
Prepared from inspection of the local stack; commands are for you to execute.

## Verified environment facts

- Running containers: `mongodb`, `redis`, `ui` (published image). Backend and
  worker are **not** running — they are started separately for dev.
- The app images (backend/worker/ui) are **published** (`ghcr.io/bl1231/...`);
  this checkout has no Dockerfiles for them, so new code is not picked up by just
  restarting a container.
- `DATA_VOL` = `/bilbomd/uploads` in the worker, bind-mounted from
  `infra/uploads-dev` on the host. Job dirs: `infra/uploads-dev/<uuid>/`.
- Worker OpenMM interpreter: `/opt/envs/openmm/bin/python` (in the worker image).
  Checked in `ghcr.io/bl1231/bilbomd-worker:2.10.0`:
  - present: `openmm`, `pdbfixer`, `mdtraj`, `scipy`, `numpy`, `pyyaml`, `pip`
  - **missing: `scikit-learn`** (needed by CLoNe/PCA clustering)
  - `foxs` and `multi_foxs` on PATH at `/usr/bin` ✓
- AutoMD-SAXS clustering is now non-fatal: a missing `scikit-learn` only skips the
  clustering step (noted in the manifest); MD + FoXS still complete.

## The contract the worker uses

The worker spawns `${AUTOMD_SAXS_BIN} run --config config.json --out <jobdir>/results`,
then reads `<jobdir>/results/manifest.json`. So `automd-saxs` must be installed
into the OpenMM env and `AUTOMD_SAXS_BIN` must point at it:

```
AUTOMD_SAXS_BIN=/opt/envs/openmm/bin/automd-saxs
```

## Step 1 — get automd-saxs into the worker OpenMM env

Bake a derived worker image from the published one (no upstream Dockerfile needed):

```dockerfile
# /tmp/Dockerfile.worker-automd-saxs
FROM ghcr.io/bl1231/bilbomd-worker:2.10.0
COPY AutoMD-SAXS /opt/automd-saxs
RUN /opt/envs/openmm/bin/pip install --no-cache-dir scikit-learn /opt/automd-saxs
ENV AUTOMD_SAXS_BIN=/opt/envs/openmm/bin/automd-saxs
```

```bash
cp -r /home/kri42825/AutoMD-SAXS /tmp/AutoMD-SAXS        # build context
cd /tmp && podman build -f Dockerfile.worker-automd-saxs -t bilbomd-worker:automd-saxs .
# verify the CLI is wired into the openmm env:
podman run --rm bilbomd-worker:automd-saxs /opt/envs/openmm/bin/automd-saxs --help
```

This image has automd-saxs + scikit-learn, but still runs the **published** worker
JS (no `automd-saxs` dispatch). Step 2 supplies the new worker code.

## Step 2 — run the NEW worker JS

The new worker dispatch/pipeline lives in this worktree. Build it, then run the
derived image with the freshly built worker bundle overlaid. From the worktree:

```bash
cd /home/kri42825/bilbomd-automd-saxs
export PATH="/dls_sw/apps/node/24.6.0/bin:$PATH"     # node 24 + corepack pnpm
corepack pnpm -F "@bilbomd/worker..." build          # builds worker + @bilbomd deps
# produce a self-contained deployable bundle (real node_modules, no pnpm symlinks):
corepack pnpm --filter @bilbomd/worker deploy --prod /tmp/worker-deploy
```

Run the worker container from the derived image with the deploy bundle + scripts
mounted over the app, plus uploads/logs and the worker env:

```bash
podman rm -f bilbomd-local-worker-1 2>/dev/null || true
podman run -d --name bilbomd-local-worker-1 \
  --network bilbomd-local_app-network \
  --env-file /home/kri42825/bilbomd/infra/worker.env \
  -e AUTOMD_SAXS_BIN=/opt/envs/openmm/bin/automd-saxs \
  --device nvidia.com/gpu=all --security-opt=label=disable --tmpfs /tmp \
  -v /home/kri42825/bilbomd/infra/uploads-dev:/bilbomd/uploads \
  -v /home/kri42825/bilbomd/infra/logs/worker:/bilbomd/logs \
  -v /tmp/worker-deploy/dist:/bilbomd/dist:ro \
  -v /tmp/worker-deploy/node_modules/@bilbomd:/bilbomd/node_modules/@bilbomd:ro \
  bilbomd-worker:automd-saxs node dist/worker.js
podman logs -f bilbomd-local-worker-1
```

(If `scripts/openmm` is referenced, it is already in the base image at
`/bilbomd/scripts`; AutoMD-SAXS does not use those scripts.)

## Step 3 — backend + UI with the new code (source-run on host)

Backend needs the rebuilt `@bilbomd/mongodb-schema` (new discriminator) but not
OpenMM, so run it on the host against the running mongo/redis:

```bash
cd /home/kri42825/bilbomd-automd-saxs
export PATH="/dls_sw/apps/node/24.6.0/bin:$PATH"
corepack pnpm -F "@bilbomd/backend..." build
corepack pnpm -F @bilbomd/backend start      # or `dev`; ensure it uses infra/.env.local values
# UI:
corepack pnpm -F @bilbomd/ui dev             # serves the new AutoMD-SAXS form/route/sidebar
```

Point the UI/back end at the same Mongo/Redis/uploads the worker uses (the
existing `infra/.env.local` / `worker.env` values).

## Step 4 — submit a smoke job (browser)

A tiny CPU job (no SAXS) to validate the path end-to-end:

- Title: `automd-saxs-smoke`
- PDB: any small protein (e.g. `apps/.../tests/fixtures/tiny.pdb`, or a real
  lysozyme PDB for a meaningful run)
- System: Protein, Force field: AMBER14
- Simulation length: 1 ns, Repeats: 1
- Leave SAXS empty for the first run (skips FoXS; exercises prep→MD→frames→cluster)

Or POST directly to `/jobs/bilbomd-automd-saxs` (multipart: `bilbomd_mode=automd-saxs`,
`title`, `pdb_file`, params).

## Step 5 — verify

```bash
# job dir
ls infra/uploads-dev/<uuid>/results/
cat infra/uploads-dev/<uuid>/results/manifest.json     # status: completed
ls infra/uploads-dev/<uuid>/results-*.tar.gz           # download bundle
podman logs bilbomd-local-worker-1 | grep automd-saxs  # step markers
```

In the UI: the job page shows step progress, the AutoMD-SAXS results dashboard
(metrics when SAXS provided), and a working Download Results button.

## Likely first-run issues

- `automd-saxs: command not found` → `AUTOMD_SAXS_BIN` not set / not the openmm
  env path.
- `Unknown job type: automd-saxs` in worker log → the new worker dist isn't
  mounted (Step 2 overlay missing).
- backend `BilboMdAutoMDSAXS is not a registered discriminator` → backend is using
  the old published `@bilbomd/mongodb-schema`; rebuild + source-run it.
- clustering skipped note in manifest → scikit-learn missing (Step 1 installs it).
