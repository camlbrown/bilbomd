# Handoff → Carbonara-dev chat: k8s deployment context

**Read me first.** You're the chat focussed on bilbomd-Carbonara development. This doc is
from the *k8s deployment* chat (kept separate). It gives you the deployment reality — how
Carbonara actually runs on the Diamond B21 cluster, how that differs from the local podman
demo, and which of those differences could suspects for the discrepancies you're
seeing (but it could be other reasons - need to properly investigate). It is deliberately light on cluster ops (port-forwards, quotas) — those don't
affect the science.

---

Note: the podman demo image was temprarily removed to make space for k8 image. space was cleared subsequently. image can be redeployed if needed.

## 1. The three repos/trees (know which is which)

| Path | What it is |
|------|-----------|
| `/home/kri42825/bilbomd-automd-saxs` | **BilboMD monorepo** (worker/backend/ui/infra). Branch **`integration/k8s-carbonara-automdsaxs`**. Origin `git@github.com:camlbrown/bilbomd.git`. This is the BilboMD *wrapper* layer + deployment. | Other branches include feature/carbonara-worker and feature/automd-saxs-worker
| `/home/kri42825/carbonara-pseudoWaxsis` | **The Carbonara library SOURCE** (C++ engine + python). Baked into the worker image at build time. **This is the thing whose version determines the science.** |
| `/home/kri42825/AutoMD-SAXS` | Separate AutoMD-SAXS python package. *Not* Carbonara — ignore for this work. |

---

## 2. How Carbonara runs on k8s — the one thing that matters most

On the cluster, Carbonara runs **`CARBONARA_EXEC=inprocess`**: the runner executes
**directly inside the worker pod** — *no nested container, no `/job` bind-mount*. Carbonara
is baked into the combined worker image (task "9a") at `/opt/carbonara/`, reached via
micromamba wrappers `carbonara-python` / `convert_cg2all_carbonara`. C++ engine binaries
live at `/opt/carbonara/build/bin/{predictStructureQvary,generate_structure,single_fit}`.

**Contrast with the local podman demo**, which runs `CARBONARA_EXEC=podman` with the job
dir bind-mounted at `/job`, and historically used a **separate Carbonara image**
(`carbonara-allatom-runtime:dev`, built from `infra/carbonara/Dockerfile.carbonara-allatom-runtime`).

⇒ Worth checking the Carbonara builds/versions between branches.** The k8s image bakes the engine from `carbonara-pseudoWaxsis` at build
time; the demo image may have been built from a different commit. 

k8s runtime environment specifics (all different from a default podman run): **non-root UID
62704**, **`HOME=/tmp`** (micromamba/matplotlib need a writable home to lock — this bit us
before), `MPLCONFIGDIR`/`XDG_CACHE_HOME` under `/tmp`, and **real absolute paths** instead
of `/job/...`.

---

## 3. The wrapper contract & files (BilboMD side — distinct from the library)

The runner + helpers baked into the image (sources live in `infra/carbonara/`):

- **`carbonara_bilbomd_runner_refined.py`** — orchestrator: sanitise input → `setup_carbonara.py`
  → generate `RunMe` → run the fits → collect outputs → optional cg2all reconstruction →
  optional `multi_foxs` mixture scoring. Writes `results/wrapper_summary.json`.
- **`carbonara_autoflex.py`** — flexible-region selection (PAE-guided + heuristics).
- **`carbonara_initfoxs.py`** — initial FoXS fit / preview.
- **`carbonara_results.py`** — post-hoc analysis → `results/analysis.json`.
- **`CarbonaraDataTools.py`** (in the library) — PDB sanitiser, `getFlexibility`, mmCIF conversion.

TypeScript glue in the monorepo:
- `apps/worker/src/services/functions/carbonara-functions.ts` — builds `job.json`, builds the
  container/inprocess arg vectors, parses summaries. **Threads `jobMount`** so inprocess uses
  real paths and podman uses `/job`.
- `apps/worker/src/services/pipelines/bilbomd-carbonara.ts` — the pipeline (validate → prepare
  → run → collect → reconstruct → score → analysis → archive).

---

## 4. Fits & parallelism — a variable that changed on 2026-08-10

The runner patches Carbonara's generated `RunMe` (`patch_runme_for_bilbomd`) so **each of
`fit_n_times` is launched as a background subprocess (`&`)** and it waits on all PIDs. The
fits are **independent stochastic optimisations**; the "gather" is just globbing
`mol*_end_xyz.dat` / `fitLog*.dat` in the `fitdata` dir.

**Recently changed:** the k8s worker's CPU **limit was bumped 4 → 12** so up to 12 fits now
run truly in parallel (it was throttled to 4 before). If your discrepancies appeared or
changed recently, **rule this in or out**:
- More concurrency shouldn't change per-fit science *if each fit is seeded independently*.
- **But** if per-fit RNG seeding derives from wall-clock/PID, changing how many fits run at
  once can shift the seed distribution → different set of final models. **Worth checking how
  Carbonara seeds each fit** before attributing anything to it.

---

## 5. Known discrepancy 

Running the **smarcal monomer** (same system + settings) on k8s vs the podman demo:
**autoflex may have selected MORE flexible regions on k8s.** Nothing looked *wrong*, but it's a real
difference. Leading hypotheses, in order:
1. Different Carbonara build baked into the k8s image vs the demo image (§2, §7).
2. Autoflex nondeterminism (`carbonara_autoflex.py`).
3. inprocess environment differences (paths / non-root / HOME).

---

## 6. A cause for concern - written by me, not claude code

Running a talin job on the k8s (carbonara-pseudoWaxsis/pdbs/talin_tags.pdb carbonara-pseudoWaxsis/saxs/talin.dat produced some interesting results. A Mixture n=4 of the same structure job. 10 fits. Initial foxs chi2 in the setup was chi2 ~26. Once job submitted, Carbonara chi2 convergence plot shows chi2 going down across the fits. Once job finished, looked at results UI page. Best mixture run only had one species - mol1_sub_0_end, and have a multifoxs chi2 of ~45. When toggling to the Classic Carbonara fitting tab it gave a best single structure foxs fit of 27.47 for mol1_sub_0_end. There should not be a big discrepancy in chi2 between the multifoxs fit (100%) and the single strutcure fit - in fact they should be the same surely. This needs to be investigated. 


## 6. If using real k8s path:
**Hard-won lesson (happened twice):** podman-mode bind-mount tests **mask** inprocess bugs
— the `/job` path bug and the `HOME=/` micromamba bug both passed under podman and failed
only on k8s. To reproduce deployed behaviour you must run the **pure-inprocess** path:
real paths, **no `/job` mount**, non-root UID, `HOME` unset/`/tmp`.

Two ways:
- **Locally, in the worker image as user 62704:**
  `carbonara-python /opt/carbonara/carbonara_bilbomd_runner_refined.py --job-json <dir>/job.json --clean`
  (bind a real job dir, chmod so 62704 can write; do *not* mount at `/job`).
- **On the cluster:** submit via the UI, then read the worker pod logs and the results on the
  shared PVC — `results/wrapper_summary.json`, `results/analysis.json`,
  `logs/carbonara.*.log`. (Ask the k8s chat / me for the exact kubectl/log commands.)

---

## 7. Pin down the deployed Carbonara version (do this early)

The baked engine comes from `/home/kri42825/carbonara-pseudoWaxsis` **at image build time**.
Confirm its exact commit and compare against whatever the podman demo image was built from.
If they differ, that's very likely the root cause and you should decide which build is
"correct" before chasing anything subtler. The worker image is built by a **3-step podman
chain** (worker → +automd_saxs → +carbonara); see the deployment runbook §4.1 and the
`automd-saxs-k8s-9a-carbonara-bakein` notes for the exact commands.

---

## 8. k8s-specific fixes already made (don't re-derive or accidentally revert these)

These are **environment/path** fixes, *not* science changes — Carbonara output should be
byte-identical between podman and inprocess **if the same engine build is used**. If it
isn't identical, *that gap is the bug to chase* (see §7).

- `acc6472b` — inprocess uses real job-dir paths (`jobMount`), not `/job`.
- `6d988537` — PAE `--pae` arg path fixed for inprocess (was hardcoded `/job`).
- `8e345bd6` — pre-bake the cg2all model checkpoint (non-root can't download at runtime).
- ConfigMap sets `HOME=/tmp` etc. so micromamba can lock.
- `8c17e8a0` — create `results-<uuid>.tar.gz` so "Download Results" works.

---

## 9. Git coordination (so the two chats don't clobber each other)

Current efforts are on **`integration/k8s-carbonara-automdsaxs`**.

- **Uncommitted in the k8s chat's tree right now — do NOT commit these from your chat:**
  `infra/helm-ui-smoketest/values.yaml` + `templates/worker.yaml` (the CPU bump),
  `infra/helm-ui-smoketest/launch-ui.sh`, `docs/k8s/DAVID_QUESTIONS_ingress_auth.md`, and
  this file. Also `apps/ui/vite.config.ts` is a **permanent local-only edit — never commit it**.
- If both chats share **one working copy**: coordinate — commit/stash & pull when switching.
- If they're **separate checkouts** of the same branch: push/pull to sync; watch for merge
  conflicts in `carbonara-functions.ts`, `bilbomd-carbonara.ts`, and `infra/carbonara/*.py`.
- **Deploying your change is heavy:** editing the runner python (`infra/carbonara/*.py`) or
  the baked engine only reaches the cluster after a **~23 GB worker image rebuild + repush +
  redeploy**. The local podman demo can pick up runner python changes *without* a rebuild via
  the dev mount wrappers (`CARBONARA_RUNNER_MOUNT` / dataTools mount — supported by
  `buildCarbonaraContainerArgs`), so iterate there first.

---

## 10. When your analysis is ready

Create a handoff.md containing the information found so I can pass it back to the k8
