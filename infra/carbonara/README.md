# Carbonara container integration

These are the **BilboMD-side** integration artifacts for the Carbonara worker
pathway. They are authored and maintained as part of this (BilboMD) repository.

> The upstream **Carbonara scientific code is NOT vendored here.** Carbonara is a
> third‑party project owned by others; it is cloned separately and treated as
> read‑only. Nothing in this directory modifies Carbonara's scientific code —
> the wrapper only *calls* Carbonara's existing scripts/utilities.

## Contents

- `carbonara_bilbomd_runner_refined.py` — the **wrapper / container entry point**
  (the stable execution boundary between BilboMD and Carbonara). Given a
  `job.json`, it: prepares an isolated `/job` working dir, runs
  `setup_carbonara.py`, applies BilboMD-requested selections (e.g. distance
  constraints — `fixedDistanceConstraints1.dat` + `pairedPredictions`), patches
  the generated `RunMe` for process tracking, runs the coarse fit, and collects
  outputs + `wrapper_summary.json`. (Optional cg2all all-atom reconstruction is
  orchestrated separately by the BilboMD worker via `backmap_cli.py`.)
  **This copy is the source of truth.**
- `carbonara_initfoxs.py` — lightweight **initial scattering check** helper
  (B5). Called by the BilboMD worker's `carbonara-preview` queue. Given
  `--pdb`, `--saxs`, `--outdir`, and an optional `--max_q`, it: converts
  CIF/mmCIF to PDB if needed (via CarbonaraDataTools or openmm.app), runs
  `pyfoxs`, parses the `.fit` file (chi^2 + q/exp/model/error rows), and
  writes `outdir/result.json`. On any failure writes
  `{"status":"error","message":"..."}` and exits 1. Baked into the image at
  `/opt/carbonara/carbonara_initfoxs.py`; override for local dev via
  `CARBONARA_INITFOXS_MOUNT`. **This copy is the source of truth.**
- `Dockerfile.carbonara-allatom-runtime` — builds the `carbonara-allatom-runtime`
  image (Carbonara C++ engine + Python env + cg2all + pyFoXS + this wrapper).

## Building the image

The Dockerfile build context must contain BOTH:
1. `Carbonara/` — a clone of the upstream Carbonara repository (NOT committed
   here; clone it yourself and keep it pristine), and
2. `carbonara_bilbomd_runner_refined.py` — this wrapper.

Example:

```bash
mkdir -p /tmp/carbonara-build && cd /tmp/carbonara-build
git clone <upstream-carbonara-repo> Carbonara          # pristine third-party code
cp /path/to/bilbomd/infra/carbonara/carbonara_bilbomd_runner_refined.py .
cp /path/to/bilbomd/infra/carbonara/Dockerfile.carbonara-allatom-runtime .
podman build -f Dockerfile.carbonara-allatom-runtime -t carbonara-allatom-runtime:dev .
```

The Dockerfile bakes the wrapper at
`/opt/carbonara/carbonara_bilbomd_runner_refined.py`.

## Baking Carbonara INTO the worker image (k8s `inprocess` mode)

`Dockerfile.carbonara-allatom-runtime` (above) builds a **standalone** Carbonara
image that the worker invokes with `podman run` — fine on a single host, but a
**nested-container anti-pattern on Kubernetes** (a pod launching a container).

For k8s we instead **layer the Carbonara runtime onto the combined worker image**
so the worker runs Carbonara **in its own pod** with `CARBONARA_EXEC=inprocess`
(no nested container). That is what `bilbomd-worker-carbonara.dockerfile` does —
it is the **third** step of the worker build chain:

1. `apps/worker/bilbomd-worker.dockerfile` → branch worker
2. `infra/automd-saxs/Dockerfile` → **+ AutoMD-SAXS** (`BASE_IMAGE` = step 1)
3. `infra/carbonara/bilbomd-worker-carbonara.dockerfile` → **+ Carbonara**
   (`BASE_IMAGE` = step 2) = the final deploy worker image

It installs the Carbonara py3.12 env + isolated cg2all py3.10 env + the C++ engine
into `/opt/conda` **without reordering the global PATH**, so the worker's own
OpenMM Python (`/opt/envs/openmm`) and the `automd-saxs` CLI are never shadowed.
Carbonara is reached via env-activating wrappers (`/usr/local/bin/carbonara-python`,
`/usr/local/bin/convert_cg2all_carbonara`) and the image bakes in the
`CARBONARA_*` env (`CARBONARA_PYTHON_BIN`, `CARBONARA_ROOT`, `CARBONARA_RUNNER`,
`CARBONARA_CG2ALL_EXEC`, `CARBONARA_MULTIFOXS_BIN`, …) so `inprocess` resolves the
baked tools with no extra wiring beyond `CARBONARA_EXEC=inprocess`.

Build context (same layout as the standalone image):

```bash
mkdir -p /tmp/carb-build && cd /tmp/carb-build
git clone <upstream-carbonara-repo> Carbonara          # pristine third-party code
cp /path/to/bilbomd/infra/carbonara/carbonara_bilbomd_runner_refined.py .
cp /path/to/bilbomd/infra/carbonara/carbonara_initfoxs.py .
cp /path/to/bilbomd/infra/carbonara/carbonara_autoflex.py .
cp /path/to/bilbomd/infra/carbonara/carbonara_results.py .
cp /path/to/bilbomd/infra/carbonara/bilbomd-worker-carbonara.dockerfile .
podman build -f bilbomd-worker-carbonara.dockerfile \
  --build-arg BASE_IMAGE=<the combined worker+automd image from step 2> \
  -t <DIAMOND_REGISTRY>/bilbomd-worker:<IMAGE_TAG> .
```

The C++ engine is compiled to `/opt/carbonara/build/bin/` (`predictStructureQvary`,
`generate_structure`, `single_fit`), exactly where the runner looks
(`CARBONARA_ROOT/build/bin/…`). Validated locally (2026-08): built on the combined
worker image and run as the k8s non-root user — both toolchains coexist
(`automd-saxs`, `carbonara-python`+`CarbonaraDataTools`/`biobox`/`torch`, `pyfoxs`,
`convert_cg2all_carbonara`, the C++ binaries, `multi_foxs`) with the worker's
OpenMM/automd-saxs unshadowed. See `docs/k8s/K8S_DEPLOYMENT_RUNBOOK.md` §4.1 and
`docs/k8s/K8S_READINESS_AUDIT.md` §6.3.

## Local development without rebuilding the image

To iterate on the wrapper without rebuilding the (large) image, the BilboMD
worker can bind-mount this file over the baked path. Set:

```bash
CARBONARA_RUNNER_MOUNT=/path/to/bilbomd/infra/carbonara/carbonara_bilbomd_runner_refined.py
```

When set, the worker adds `-v <that file>:/opt/carbonara/carbonara_bilbomd_runner_refined.py:ro,Z`
to the `podman run`. Leave it empty in production (the baked image wrapper is
used). The in-container path is `CARBONARA_RUNNER`
(default `/opt/carbonara/carbonara_bilbomd_runner_refined.py`).

Similarly, for the initial scattering check helper (`carbonara_initfoxs.py`),
set:

```bash
CARBONARA_INITFOXS_MOUNT=/path/to/bilbomd/infra/carbonara/carbonara_initfoxs.py
```

When set, the worker adds `-v <that file>:/opt/carbonara/carbonara_initfoxs.py:ro,Z`
to the `podman run` for preview jobs. Leave it empty in production (the baked
image copy is used). The in-container path is `CARBONARA_INITFOXS_PATH`
(default `/opt/carbonara/carbonara_initfoxs.py`).
