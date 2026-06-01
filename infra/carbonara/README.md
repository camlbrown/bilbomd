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
