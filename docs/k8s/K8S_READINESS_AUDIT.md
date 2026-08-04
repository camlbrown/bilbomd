# BilboMD + Carbonara + AutoMD-SAXS — Kubernetes Readiness Audit

**Originally a Phase-1 read-only audit; Phase-2/3 preparation has since been
implemented.** The findings below are the original audit; **§1a "Implementation
status" records what has actually been done since** (branch built + pushed,
combined worker image proven, Helm chart made Diamond-deployable). Where a later
section still describes something as "to do", check §1a — it may be done.

Author: Claude Code audit, 2026-08-04 (audit); updated after Phase-2/3 prep.
Companion docs in this folder: `K8S_PHASE2_PREP_PLAN.md`,
`K8S_DEPLOYMENT_RUNBOOK.md`, `K8S_MEETING_CHECKLIST.md`,
`K8S_GIT_INTEGRATION_PROCEDURE.md`. Background planning notes
`K8S_DEPLOYMENT_PLAN.md` and `ROUTE_TO_K8S.md` live in the AutoMD-SAXS repo. This
document supersedes the earlier planning notes where they disagree — it is grounded
in direct code inspection and helm-render verification.

Evidence is tagged:

- **[CONFIRMED]** — verified directly in the repository at the cited path.
- **[INFERRED]** — a reasonable conclusion from confirmed facts.
- **[VERIFY]** — still needs checking (in code, or with the Kubernetes admin).

---

## 1. Executive summary

- BilboMD is a multi-service web app (UI + backend + worker + MongoDB + Redis)
  that already **runs on Kubernetes at NERSC** and ships a **working Helm chart**
  (`infra/helm/`). The web tier is a solved problem; we adapt, not author. **[CONFIRMED]**
- The Carbonara and AutoMD-SAXS pipelines are **not separate services** — they are
  extra **job types** processed by the single existing **worker** Deployment, routed
  in application code by the Mongo `__t` discriminator. So there is **no new
  Kubernetes workload to design** for either pipeline. **[CONFIRMED]**
- The one real architectural obstacle is that the worker historically ran these
  pipelines by **launching another container at runtime** (`podman run …`) — a
  "container-in-container" pattern that does not belong on a shared cluster. Both
  pipelines already have (or nearly have) a de-nested "run in the worker pod"
  path. **[CONFIRMED]**
- **The branch story is much simpler than feared.** The two feature branches
  diverged 6 weeks ago and Carbonara has advanced by exactly **one commit** since;
  the AutoMD-SAXS branch already **contains all Carbonara history** up to that point
  **plus** the k8s de-nesting switch that the Carbonara branch does **not** have.
  The recommended deployment source is therefore an integration branch **based on
  the AutoMD-SAXS branch**, with that single Carbonara commit brought in. **[CONFIRMED]**

**Minimum realistic goal for the meeting:** arrive with a clean single deployment
branch, buildable + version-tagged images (including both pipelines baked into the
worker image), a Diamond-specific Helm values file, and the list of environment
facts only the cluster admin can supply. **→ This goal is now met (see §1a).**

---

## 1a. Implementation status (what has been DONE since the audit)

Everything below is committed on **`integration/k8s-carbonara-automdsaxs`** (pushed
to `origin` = `camlbrown/bilbomd`) unless noted, and every Helm change was verified
with `helm template` (helm 3.14.3) to leave the **NERSC render unchanged** (all
Diamond behaviour is gated on the `.Values.persistence` block).

**Git / source of truth (was audit §3.2, §10):**
- ✅ Pending fixes committed on `feature/automd-saxs-worker` (excl. local-only
  `vite.config.ts`); `AutoMD-SAXS` repo committed + tagged **`v0.1.1`** (pushed).
- ✅ Integration branch created from the AutoMD-SAXS branch; the one missing
  Carbonara commit `914769d3` cherry-picked (clean); backup tags in both repos.
- ✅ Branch builds (backend/worker/ui) and is pushed; 0/0 vs origin.

**Combined worker image (was audit §5.5, §6.2):**
- ✅ Built + verified: `automd-saxs` CLI + FoXS/MultiFoXS + `v0.1.1` package +
  propka/sklearn all present. **Correction found:** the image ends as **root** (the
  automd-saxs Dockerfile does `USER root`), harmless because Helm sets
  `runAsUser: 62704`; and the *published* base worker is `uid 62704` (so the earlier
  UID-mismatch worry does **not** apply). Image is **~12 GB**.
- ⚠ **Build must be TWO steps** (build the branch worker, THEN layer AutoMD-SAXS);
  layering onto the published `bilbomd-worker:2.10.0` gives OLD worker JS. Documented
  in `K8S_DEPLOYMENT_RUNBOOK.md` §4.1. (The actual push to a Diamond registry is
  admin-gated, not yet done.)

**Carbonara de-nesting (was audit §6.1 "4 of 6"):**
- ✅ **Now 6/6** call sites honor `CARBONARA_EXEC=inprocess` — the 2 preview/auto-flex
  handlers were wired. Carbonara can run fully in-pod.

**Helm chart — now renders a *startable* Diamond deployment (was audit §5.3/§5.4, §7):**
- ✅ Liveness/readiness probes (worker `/config:3000`, backend `/healthcheck:3500`).
- ✅ Values-driven `resources` (worker GPU + memory via values); default `{}` for NERSC.
- ✅ Optional PVC templates (uploads RWX + mongo/redis RWO), created when
  `persistence.create: true`, each annotated `helm.sh/resource-policy: keep` so
  `helm uninstall` never wipes data.
- ✅ Uploads volume: hostPath → **RWX PVC** on Diamond (worker + backend).
- ✅ ConfigMap: injects `CARBONARA_EXEC=inprocess` + `AUTOMD_SAXS_BIN`; renders
  `USE_NERSC=false` + `BILBOMD_DEPLOY_SITE=diamond` on Diamond (MD runs in-pod).
- ✅ **Former startup blockers fixed (gated):** sfapi secret → `optional: true`;
  logs/scripts → `emptyDir`; NERSC `postStart` hook → off.
- ✅ `values-diamond.yaml` committed (placeholder-driven; header documents the few
  non-blocking remaining edits).

**Still genuinely remaining (all admin-gated or optional; not startup blockers):**
- ☐ Fill `values-diamond.yaml` placeholders with admin facts (registry, storage
  classes/sizes, GPU count, ingress/TLS, UID/fsGroup, ORCID).
- ☐ Build the combined worker image (two-step) and **push** to the Diamond registry.
- ☐ `helm upgrade` + smoke-test each worker.
- ☐ Optional: `USER 62704` in the automd-saxs Dockerfile; review UI `VITE_USE_NERSC`.

---

## 2. Current architecture

### 2.1 Services (what runs) **[CONFIRMED]**

| Service | Image (prod) | Role | GPU |
| --- | --- | --- | --- |
| ui | `ghcr.io/bl1231/bilbomd-ui` | React SPA (nginx) | no |
| backend | `ghcr.io/bl1231/bilbomd-backend` | Express REST API; enqueues jobs | no |
| worker | `ghcr.io/bl1231/bilbomd-worker` | BullMQ consumer; runs all pipelines | **yes** |
| mongodb | `mongo:8.x` | job/user state | no |
| redis | `redis:8.x` | BullMQ queue | no |

Data flow: **UI → backend → (Mongo doc + Redis/BullMQ enqueue) → worker → results
on a shared volume → backend serves results → UI.** **[CONFIRMED]**

### 2.2 The worker is one process that does everything **[CONFIRMED]**

A single worker drains the `bilbomd` Redis queue and dispatches by job type to a
pipeline module (`apps/worker/src/services/pipelines/bilbomd-<type>.ts`). Carbonara
and AutoMD-SAXS are two such pipelines; they also add small preview/prep queues
(`carbonara-preview`, `carbonara-autoflex`, `automd-saxs-prep`). There is **one**
worker Deployment in Helm — both pipelines share it.

### 2.3 The three source repositories **[CONFIRMED]**

This is the single most important thing to hold in your head, because image
reproducibility depends on all three:

| Repo | Local path | Remote | Branch (HEAD) | Feeds |
| --- | --- | --- | --- | --- |
| bilbomd (fork) | `/home/kri42825/bilbomd` | `camlbrown/bilbomd` | `feature/carbonara-worker` @ `914769d3` | backend/ui/worker images, Helm chart |
| bilbomd worktree | `/home/kri42825/bilbomd-automd-saxs` | (same repo) | `feature/automd-saxs-worker` @ `fe34372c` | the deployment branch |
| AutoMD-SAXS (Python) | `/home/kri42825/AutoMD-SAXS` | `camlbrown/AutoMD-SAXS` | `AutoMD-SAXS-OpenMM` @ `4d4decc` | the `automd_saxs` CLI baked into the worker/runtime image |
| Carbonara (source) | `/home/kri42825/carbonara-pseudoWaxsis` | (no git here) | n/a | build context for the Carbonara worker bake-in (`bilbomd-worker-carbonara.dockerfile`) + the standalone runtime image |

`/home/kri42825/bilbomd` and `/home/kri42825/bilbomd-automd-saxs` are **two git
worktrees of the same repository** (one shared `.git`), checked out to the two
feature branches. `origin` = the fork `camlbrown/bilbomd`; `upstream` =
`bl1231/bilbomd` with **push DISABLED** (good — prevents accidental pushes to the
maintainer). **[CONFIRMED]**

---

## 3. Repository & branch relationships

### 3.1 Divergence facts (all [CONFIRMED] via git)

```
merge-base(carbonara-worker, automd-saxs-worker) = 2c90414e  (2026-06-26)
carbonara-worker  is  1 commit ahead of merge-base   → 914769d3 only
automd-saxs-worker is 29 commits ahead of merge-base  → all the automd-saxs work
```

- The AutoMD-SAXS branch **contains the entire Carbonara implementation** up to the
  merge-base (they share history), **plus** 29 commits of AutoMD-SAXS work, **plus**
  a Carbonara k8s de-nesting commit (`d0f5967b`) that the Carbonara branch lacks.
- The **only** Carbonara change the AutoMD-SAXS branch is missing is `914769d3`
  ("handle mmCIF inputs in setup sanitiser and analysis overlay"), touching **2
  Carbonara-only files** (`CarbonaraStructureViewer.tsx`,
  `infra/carbonara/carbonara_bilbomd_runner_refined.py`). AutoMD-SAXS does not
  touch these → **clean cherry-pick, no conflict expected**. **[INFERRED from file
  scope; VERIFY by dry-running the cherry-pick]**
- Both feature branches are **in sync with `origin`** (0 ahead / 0 behind). The
  AutoMD-SAXS repo is likewise in sync with its origin. **[CONFIRMED]**

### 3.2 Uncommitted work that must be resolved before building images

> **✅ RESOLVED (see §1a).** All legitimate fixes are now committed on the
> integration branch and in the AutoMD-SAXS repo (tagged `v0.1.1`); only the
> local-only `vite.config.ts` remains uncommitted by design. The section below is
> the original finding, kept for the record.

Reproducible images require a clean, committed tree. Today there is uncommitted
work in two repos (mostly this-session bug-fixes that should be kept):

**bilbomd worktree (`feature/automd-saxs-worker`) — 9 modified files [CONFIRMED]:**
`automdSaxsJobController.ts`, `automdSaxsPrepController.ts`, `AutoMDSAXSResults.tsx`,
`AutoMDSAXSReviewPage.tsx`, `AutoMDSAXSStructureViewer.tsx`,
`AutoMDSAXSTrajectoryViewer.tsx`, `NewAutoMDSaxsJobForm.tsx`,
`automdSaxsPrepHandler.ts` (all legitimate fixes), **plus `apps/ui/vite.config.ts`**
(a local-only dev-proxy port change `3501→3500` that should **not** be committed).

**AutoMD-SAXS repo (`AutoMD-SAXS-OpenMM`) — 3 modified files [CONFIRMED]:**
`ligand.py`, `prepare.py`, `workflow.py` (MultiFoXS unique-filename fix + code-review
fixes). Also untracked example data + a stray spec `.md` that should stay untracked.

> **Consequence:** the deployment branch's exact source is currently ambiguous
> (HEAD `fe34372c` does **not** include the 8 legitimate fixes or the SAXS
> `dat_file` fix). This must be committed before tagging an image. See the Git
> integration procedure (separate deliverable).

---

## 4. Carbonara divergence findings (audit question #1)

| Question | Finding |
| --- | --- |
| How do the Carbonara impls differ between branches? | Only by **one commit** (`914769d3`, mmCIF handling) that is on `carbonara-worker` but not on `automd-saxs-worker`; **and** by **one commit the other way** (`d0f5967b`, the `CARBONARA_EXEC` k8s de-nesting switch) that is on `automd-saxs-worker` but **not** on `carbonara-worker`. **[CONFIRMED]** |
| Which Carbonara commits are missing from AutoMD-SAXS? | Exactly `914769d3`. **[CONFIRMED]** |
| Do any conflict with AutoMD-SAXS? | No overlap in files touched → no expected conflict. **[INFERRED; VERIFY via dry-run cherry-pick]** |
| Regressions / incomplete changes on the Carbonara branch? | The Carbonara branch **lacks the k8s de-nesting switch** — so as a *deployment* source it is **behind** the AutoMD-SAXS branch. (At audit time the de-nesting covered only the 4 main pipeline calls; the 2 preview/autoflex handlers have **since been wired — now 6/6, §1a**.) **[CONFIRMED]** |
| Safest way to bring current Carbonara into the deployment branch? | Base the integration branch on `automd-saxs-worker` (which already has newer Carbonara-for-k8s) and **cherry-pick the single `914769d3`**. Do **not** merge `carbonara-worker` wholesale — that would *regress* the de-nesting work. **[INFERRED, high confidence]** |

**Bottom line:** the "Carbonara is out of date on the AutoMD-SAXS branch" worry is
real but tiny (one UI/runner fix), and it is outweighed by the AutoMD-SAXS branch
being **ahead** on the thing that actually matters for k8s (de-nesting).

---

## 5. Existing Kubernetes / Helm support

### 5.1 What exists **[CONFIRMED]** (`infra/helm/`, Chart `0.1.57`, appVersion `2.19.0`)

- **Deployments:** backend, worker, ui, mongo, redis (each 1 replica).
- **Services:** ClusterIP for all five; LoadBalancer for backend and mongo.
- **Ingress:** nginx + TLS for the UI.
- **CronJob:** `mongo-backup` (daily mongodump).
- **ConfigMaps:** `bilbomd-config` (~48 env vars), `mongo-config`, `bilbomd-ui-config`.
- **Values:** `values.yaml` + `values-dev.yaml` + `values-prod.yaml`.
- **Docs:** `infra/HELM_NOTES.md` documents the NERSC/Spin deploy and the required
  Secrets.
- **The Helm chart is byte-for-byte identical on both branches** (`git diff` over
  `infra/helm/` returns nothing). Adding AutoMD-SAXS required **zero** Helm changes.

### 5.2 Is AutoMD-SAXS represented in Helm? **[CONFIRMED]**

Yes — implicitly and correctly. Because both pipelines are job types inside the
single worker, they need **no** dedicated Deployment/Job/Service. The worker
Deployment already runs them. **Nothing is "missing" from Helm for AutoMD-SAXS in
the workload sense.** What *is* missing is the environment adaptation (below).

### 5.3 What the Helm chart assumes that is NERSC-specific (must change for Diamond)

> **✅ Most rows below are now IMPLEMENTED (see §1a),** gated on `.Values.persistence`
> so NERSC is unchanged: storage → RWX PVC + PVC templates; GPU → values-driven
> `worker.resources`; Slurm/SFAPI → secret optional + `USE_NERSC=false`. Remaining
> are values-only: registry, ingress/TLS/DNS, UID/fsGroup (fill in `values-diamond.yaml`).

| Area | Current (NERSC) | Evidence | Diamond change |
| --- | --- | --- | --- |
| Registry | `docker_registry: registry.nersc.gov`; images `ghcr.io/bl1231/*` | `values.yaml:2`, `values-*.yaml` | Point at Diamond registry / pull-through cache |
| Shared job storage | **hostPath** onto CFS: `/global/cfs/cdirs/m4659/…` mounted at `/bilbomd/uploads` (+ logs) on backend & worker | `values-dev.yaml:4`, mongo/worker/backend deployments | Replace with a **ReadWriteMany PVC** both backend & worker mount |
| Mongo/Redis PVCs | claims `mongodb-volume`, `redis-volume` assumed **pre-created** (no PVC template) | `mongo-deployment.yaml:73-75`, `redis-deployment.yaml:72-73` | Create these PVCs (or add templates) with a Diamond storage class |
| GPU | worker template has **no** GPU request (`resources: {}`); NERSC offloads MD to Perlmutter via Slurm | `worker-deployment.yaml` | For "MD in k8s": add `resources.limits."nvidia.com/gpu": 1` |
| Slurm/SFAPI | secret `sfapi-priv-key` + `USE_NERSC` path | `HELM_NOTES.md`, configmaps | Not needed if MD runs in-pod (Option A); needed only for Option B |
| Ingress/TLS/DNS | NERSC host rules + `ui-tls` secret | `ingress.yaml` | Diamond ingress class, cert mechanism, DNS |
| Security context | `runAsUser: 62704`, `fsGroup: 104818` (NERSC UIDs) | `worker-deployment.yaml:59,77` | May need Diamond-allowed UID/fsGroup range (§8.3) |

### 5.4 Gaps in the Helm chart (independent of NERSC) **[CONFIRMED → ✅ FIXED, §1a]**

- ✅ **Liveness/readiness probes** added (worker `/config:3000`, backend
  `/healthcheck:3500`); was: none.
- ✅ **Resource requests/limits** now values-driven (default `{}`; Diamond sets
  worker GPU + memory); was: `resources: {}` everywhere.
- Security contexts otherwise look sane (`allowPrivilegeEscalation: false`,
  `drop: [ALL]`, non-root) — good for a shared cluster.

### 5.5 Image versioning reality (a real reproducibility risk) **[CONFIRMED]**

There are **four different worker image versions** referenced across the repo:

- `values-dev.yaml` worker `2.13.2`
- `values-prod.yaml` worker `2.8.0`
- `docker-compose-epyc.prod.yml` worker `2.14.2`
- the **AutoMD-SAXS runtime image is built `FROM ghcr.io/bl1231/bilbomd-worker:2.10.0`**

So the AutoMD-SAXS runtime layer is pinned to an **older** worker base than any of
the deploy targets. For Diamond we must build **one** worker image (worker + both
pipelines baked in) at **one** pinned tag and reference exactly that everywhere.

**Critical build-chain caveat (found in M3/S3):** `infra/automd-saxs/Dockerfile`
only *layers* the `automd_saxs` package onto an existing worker image — it does
**not** rebuild the worker JS. `bilbomd-worker.dockerfile` is what actually builds
the worker code (multi-stage: `pnpm build` → copy the bundle onto
`bilbomd-worker-base:0.0.8`). Therefore the combined worker image must be built in
**two steps**: (1) build the worker image **from this branch** via
`bilbomd-worker.dockerfile`; (2) layer AutoMD-SAXS onto *that* with
`--build-arg BASE_IMAGE=<branch-worker>`. The quick image built during M3 layered
onto the **published** `bilbomd-worker:2.10.0`, so it contains the **old published
worker JS** (no Carbonara de-nesting, no AutoMD-SAXS handlers) — it proved the
AutoMD-SAXS layer mechanism only and is **not deployable**. The corrected two-step
build is in `K8S_DEPLOYMENT_RUNBOOK.md` §4.1. **[CONFIRMED by inspecting both
Dockerfiles]**

---

## 6. The nested-container problem and its status per pipeline

This is the crux of "will it run in a k8s pod."

### 6.1 Carbonara — de-nesting now complete, all 6 call sites **[✅ DONE, §1a]**

- The worker runs Carbonara steps via `runCarbonaraContainer()`. It supports two
  modes via `CARBONARA_EXEC` (`apps/worker/src/config/config.ts:134`,
  default `'podman'`):
  - `'podman'` (default): `podman run -v <jobdir>:/job <image> <cmd>` — nested container.
  - `'inprocess'`: `inProcessCommandFromArgs()` strips the `podman run … <image>`
    wrapper and `spawn`s the remaining command **directly in the worker pod**
    (`carbonara-functions.ts`). The bind-mount becomes moot because the job dir is
    already in the pod. This is the k8s-correct path. **[CONFIRMED]**
- **Coverage — ✅ now 6/6 (was 4/6):** the audit found only 4 of 6
  `runCarbonaraContainer` call sites passed `execMode`. The 2 gaps (the preview and
  auto-flex handlers, `carbonaraPreviewHandler.ts`, `carbonaraAutoFlexHandler.ts`)
  were **wired in S1**, so all 6 now honor `CARBONARA_EXEC=inprocess` and run
  in-pod. **[✅ DONE]**
- Requires the Carbonara tools **baked into the worker image** — **✅ now DONE
  (task 9a)** via `infra/carbonara/bilbomd-worker-carbonara.dockerfile` (build
  step 3, runbook §4.1), built + validated locally as the k8s non-root user. See
  §6.3. The alternative (k8s-Job-per-task from the standalone image) in §9 is no
  longer needed. **[✅ DONE]**

### 6.2 AutoMD-SAXS — effectively k8s-ready **[CONFIRMED]**

- The worker calls the CLI directly: `spawn(config.automdSaxs.bin, args)` where
  `AUTOMD_SAXS_BIN` defaults to bare `automd-saxs`
  (`config.ts:219`). **No nested container in the code path.** The local `podman`
  behaviour comes only from a **dev-only shim** (`infra/automd-saxs/automd-saxs-run`)
  that the local env points `AUTOMD_SAXS_BIN` at.
- The runtime image is literally `bilbomd-worker:<tag>` + `pip install
  scikit-learn propka` + `pip install /opt/automd-saxs` (the AutoMD-SAXS repo) +
  `ENV AUTOMD_SAXS_BIN=/opt/envs/openmm/bin/automd-saxs`
  (`infra/automd-saxs/Dockerfile`). Build context = the AutoMD-SAXS repo. **[CONFIRMED]**
- **Therefore the cleanest k8s move is to make that Dockerfile's layer the actual
  worker image** (worker + automd-saxs baked in). Then AutoMD-SAXS "just works" in
  the worker pod with `AUTOMD_SAXS_BIN=/opt/envs/openmm/bin/automd-saxs` and no code
  change. **[INFERRED, high confidence]**

### 6.3 Runtime self-containment — can this branch alone run each worker on k8s? **[CONFIRMED]**

The question: after a proper `helm install` of this branch, do the workers need
anything from the original local Carbonara/AutoMD-SAXS installs? Traced every
runtime dependency against the branch + the images built from it.

**Both pipelines are proven to work locally** — each has the worker `podman run`
its own runtime image (AutoMD-SAXS → `localhost/bilbomd-automd-saxs:dev`; Carbonara
→ `carbonara-allatom-runtime`). The k8s question is only about **where those tools
live** once the host `podman run` is removed.

**AutoMD-SAXS — ✅ runtime self-contained.**
- Worker code (pipeline + prep handler) is in the branch; it only reads/writes the
  job dir on the shared PVC (`automd-saxs.log`, `manifest.json`).
- The `automd-saxs` CLI + deps (OpenMM/FoXS/propka/sklearn) are **baked into the
  worker image** (verified: CLI runs, tools present, `v0.1.1` package present).
- **Build-time caveat:** the `automd_saxs` package **source is not in this branch**
  — the Dockerfile `COPY`s it from the separate **AutoMD-SAXS repo** (`v0.1.1`) at
  image-build time. You need that repo when you *build* the image; the cluster needs
  nothing from it at runtime.

**Carbonara — ✅ runtime self-contained via 9a bake-in (DONE + validated 2026-08).**
- The de-nesting **code** is complete (`inprocess`, 6/6). `inprocess` runs the
  Carbonara scripts + `convert_cg2all_carbonara` + `pyfoxs` + the C++ binaries
  **directly in the worker pod**, at `/opt/carbonara` + `/usr/local/bin`.
- **The Carbonara runtime is now baked into the worker image** by
  `infra/carbonara/bilbomd-worker-carbonara.dockerfile` — the **third** build step
  (branch worker → +automd-saxs → +carbonara; see runbook §4.1). It layers the
  Carbonara py3.12 env + isolated cg2all py3.10 env + the C++ engine into
  `/opt/conda` **without reordering the global PATH**, so the worker's own OpenMM
  Python (`/opt/envs/openmm`) and the `automd-saxs` CLI are never shadowed. The
  `CARBONARA_*` env is baked in, so `inprocess` resolves the tools with no extra
  wiring beyond `CARBONARA_EXEC=inprocess`.
- **Validated locally (2026-08):** built on the combined worker image
  (`worker-full:test`, ~23 GB) and run **as the k8s non-root user 62704**. Both
  toolchains coexist and the worker's tools are unshadowed:
  `automd-saxs` ✅ · default `python` → `/opt/envs/openmm` ✅ ·
  `carbonara-python` + `CarbonaraDataTools`/`biobox`/`torch` ✅ · `pyfoxs` ✅ ·
  `convert_cg2all_carbonara` ✅ · C++ engine compiled at
  `/opt/carbonara/build/bin/{predictStructureQvary,generate_structure,single_fit}`
  (exactly where the runner resolves `CARBONARA_ROOT/build/bin/…`) ✅ ·
  `multi_foxs` ✅.
- **Build-time caveat (same shape as AutoMD-SAXS):** the Carbonara **library
  source is not in this branch** — only the 4 wrapper scripts (`carbonara_*.py`)
  are tracked. The `Carbonara/` library + `setupPython.sh` + `CarbonaraDataTools.py`
  + C++ sources come from the external `/home/kri42825/carbonara-pseudoWaxsis` as
  build context (see `infra/carbonara/README.md`). You need that source when you
  *build* the image; the cluster needs nothing from it at runtime.
- **9b — k8s-Job-per-task** remains an alternative (reuse the standalone Carbonara
  image, worker creates a k8s Job per step) but is **not needed** now that 9a is
  done; it would add a ServiceAccount + RBAC + a `k8sjob` exec path and cannot be
  validated without a cluster. Revisit only if the ~23 GB image size or per-job
  isolation later warrants it.

**Verdict:** a first k8s deploy of **BOTH pipelines** works from this branch. The
worker image built per runbook §4.1 (all three steps) contains AutoMD-SAXS **and**
Carbonara, both proven to run in one image as the deployed non-root user. Remaining
work is cluster-side values (registry, storage classes, GPU) + the one end-to-end
job run once deployed — no more packaging gaps.

---

## 7. Local-development assumptions that must be removed/parameterised

Grouped by k8s severity. "Committed code" = must be handled by image/config;
"env/compose only" = already environment-specific, no code change.

### BLOCKERS (break in a k8s pod unless addressed) **[CONFIRMED]**

1. **`CARBONARA_EXEC` / `CARBONARA_CONTAINER_BIN` default to `podman`**
   (`config.ts:134,128`). In k8s must be `CARBONARA_EXEC=inprocess` — now set via the
   ConfigMap `pipelines` block on Diamond, and all 6 handlers honor it (§1a). **[✅]**
2. **Same-absolute-path bind mount** for Carbonara nested runs (job dir mounted
   1:1 host↔container; `carbonara-functions.ts` `-v <jobdir>:/job`). Moot under
   `inprocess`; fatal under `podman`-in-pod.
3. **`REDIS_HOST` defaults to `localhost`** (`queues/redisConn.ts`). Must be set to
   the Redis Service name via ConfigMap (the Helm ConfigMap already sets it — so
   this is only a blocker if the ConfigMap is not wired; **[VERIFY]** the worker
   reads it).
4. **Worker must share the job volume with the backend** (backend serves what the
   worker writes) → requires a **RWX PVC** at `DATA_VOL=/bilbomd/uploads` (§8.2).

### HIGH (must exist in the image, or override via env) **[CONFIRMED]**

5. Hardcoded in-image tool paths default in `config.ts`: `OPENMM_PYTHON_BIN`
   (`/opt/envs/openmm/bin/python`), `BASE_PYTHON_BIN`, `CARBONARA_ROOT`
   (`/opt/carbonara`), `CARBONARA_RUNNER/INITFOXS/AUTOFLEX/RESULTS`,
   `CARBONARA_MULTIFOXS_BIN` (`/usr/bin/multi_foxs`). These are fine **iff** the
   worker image actually contains them — i.e. both pipelines are baked in. Today
   the worker image does **not** bake either (`apps/worker/*.dockerfile` reference
   neither automd nor carbonara). **This is the core image-build task.**

### LOW / already-safe **[CONFIRMED]**

6. GPU is **optional** in code — AutoMD-SAXS/OpenMM fall back CUDA→OpenCL→CPU
   (`automd_saxs/openmm/md.py`); GPU only affects speed.
7. Service-to-service uses **DNS names** already (`colabfold-service`, `of3-service`,
   `mongo`, `redis`) — k8s-compatible.
8. `apps/ui/vite.config.ts` proxy ports are **dev-server only** (not shipped in the
   built UI image) — ignore for k8s.
9. `/home/kri42825`, `/scratch/kri42825`, `/dls_sw` paths appear only in **local
   shims / compose / the dev `automd-saxs-run` wrapper**, not in the app images.

---

## 8. Security, storage, networking, scaling

### 8.1 Security **[CONFIRMED]** — in good shape for a shared cluster

- Backend/worker: `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`,
  `privileged: false`, non-root `runAsUser`. Once de-nested, **no privileged pods
  or runtime sockets are needed** — this is the key reassurance for the admin.
- `readOnlyRootFilesystem: false` is intentional (worker writes results to the PVC
  and scratch to `/tmp`). Keeping root FS writable is acceptable; a stricter
  posture (RO root + explicit `emptyDir` for `/tmp`) is a future hardening.

### 8.2 Storage **[CONFIRMED / VERIFY with admin]**

- Every job is a directory under `DATA_VOL=/bilbomd/uploads`, **written by the
  worker and read by the backend** → a **ReadWriteMany** PVC is required (NFS/CephFS
  class). NERSC used hostPath onto CFS; Diamond needs an RWX storage class. **[VERIFY:
  which RWX class + quota]**
- Mongo and Redis each need a (RWO is fine) PVC; the chart assumes `mongodb-volume`
  and `redis-volume` **already exist**.
- **Sizing:** explicit-solvent MD output is large even after the protein-only frame
  optimisation. The local 8 GB home quota already caused a real job failure. Diamond
  PVC must be multi-GB-per-job × many jobs, with a **retention/cleanup** policy (the
  worker has a cleanup step). **[VERIFY capacity]**

### 8.3 Networking **[CONFIRMED]**

- Internal traffic uses Service DNS — fine. External: UI via Ingress + TLS.
- **UID/fsGroup:** the **published** base image `ghcr.io/bl1231/bilbomd-worker:2.10.0`
  runs as **`uid=62704(bilbo) gid=1001(bilbomd)`** — which **matches** the Helm
  `runAsUser: 62704`. (An earlier draft flagged an image-1000-vs-Helm-62704
  mismatch based on the *local* Dockerfile's `ARG USER_ID=1000` default; the
  published image was built with 62704, so **there is no mismatch** — corrected
  after building/inspecting the image directly.) Still **[VERIFY]** the allowed
  UID/fsGroup range on Diamond and that `fsGroup: 104818` matches the PVC's
  supplemental group.
- **Combined-image runs as ROOT (small finding, M3):** the AutoMD-SAXS layer
  (`infra/automd-saxs/Dockerfile:19`) does `USER root` for the pip install and does
  **not** switch back, so the built combined worker image defaults to `uid=0`. Helm's
  `securityContext.runAsUser: 62704` overrides this at runtime (so **not a blocker**,
  and it satisfies a `runAsNonRoot`/restricted PodSecurity policy *because* an
  explicit non-root UID is set). Best-practice fix: append `USER 62704` at the end of
  that Dockerfile so the image itself defaults non-root. **[CONFIRMED by building the
  image]**
- **Image size (M3):** the combined worker image is **~12 GB** (CUDA + OpenMM +
  FoXS + the automd-saxs layer). Confirm the Diamond registry has no smaller image
  cap. **[CONFIRMED locally; VERIFY registry limit]**
- **Outbound:** ORCID OAuth + email (SMTP) + image pulls. **[VERIFY egress policy]**

### 8.4 Scaling **[CONFIRMED / INFERRED]**

- One worker process drains one queue and does all job types. Scaling = more worker
  replicas (BullMQ handles multiple consumers), but **each replica needs a GPU +
  the shared RWX PVC**.
- **Independent per-pipeline scaling is NOT the current architecture** — Carbonara
  and AutoMD-SAXS share the one worker/queue. If independent scaling is later
  required, it needs separate queues + separate worker Deployments (a real change,
  not needed for first deploy). Note this to the admin so expectations are set.
- **Rollback** is per-image-tag via `helm rollback`; MongoDB + the PVC persist
  across rollouts. **[INFERRED, standard Helm]**

---

## 9. Recommended target architecture

**Option A (recommended for first deploy): MD inside k8s GPU pods.**

- One combined **worker image** = current `bilbomd-worker` + AutoMD-SAXS CLI baked
  in (the existing `infra/automd-saxs/Dockerfile` layer, rebased on the current
  worker) + Carbonara tools baked in (or, initially, Carbonara left running via the
  existing image as k8s-Jobs — see below).
- Worker Deployment requests `nvidia.com/gpu: 1`; both pipelines run **in-process**
  in the worker pod (`AUTOMD_SAXS_BIN` → in-image CLI; `CARBONARA_EXEC=inprocess`).
- Shared **RWX PVC** at `/bilbomd/uploads` mounted by backend + worker.
- Everything else (Mongo, Redis, backend, UI, ingress) as the chart already defines.

**Carbonara execution — 9a is now DONE; 9b kept only as a future alternative:**

- **9a. Bake-in + `inprocess` (chosen — fewest moving parts at run time). ✅ DONE.**
  The `inprocess` wiring is done (6/6, §1a) and the Carbonara runtime is now baked
  into the worker image by `infra/carbonara/bilbomd-worker-carbonara.dockerfile`
  (build step 3, runbook §4.1). Built + validated locally as the k8s non-root user
  — both toolchains coexist in one ~23 GB image (§6.3).
- **9b. k8s-Job-per-task (keeps Carbonara modular) — NOT needed now.** The worker
  would create a k8s Job from the standalone `carbonara-allatom-runtime` image per
  step, mounting the RWX PVC. Cost: a ServiceAccount + RBAC (create/watch Jobs) and
  a net-new submit/await code path. Deferred; revisit only if the image size or
  per-job isolation later warrants it.

> **Recommendation:** **Both pipelines via bake-in — DONE.** AutoMD-SAXS (§1a) and
> Carbonara (9a, §6.3) are baked into the single worker image built per runbook
> §4.1, proven to run together as the deployed non-root user. First k8s deploy can
> ship **both** pipelines; no Carbonara image work remains. **[CONFIRMED locally]**

**Option B (later, if GPU-in-k8s is unavailable): k8s web tier + Diamond HPC/Slurm
compute** — mirrors NERSC, but needs a Diamond SFAPI-equivalent submission bridge
(net-new). Keep as fallback. **[VERIFY with admin whether Diamond has GPU k8s
nodes; that single fact chooses A vs B.]**

---

## 10. Recommended Git strategy (audit question #2) — ✅ EXECUTED

> The recommendation below was carried out: branch
> `integration/k8s-carbonara-automdsaxs` created off `feature/automd-saxs-worker`,
> fixes committed, `914769d3` cherry-picked, `AutoMD-SAXS` tagged `v0.1.1`,
> `values-diamond.yaml` added — all pushed to `origin`. See §1a and
> `K8S_GIT_INTEGRATION_PROCEDURE.md`.

Options considered against the actual repo:

| Option | Verdict |
| --- | --- |
| (a) New integration branch with both workers | **Recommended**, but note it is *cheap* because (b) is 99% true already. |
| (b) Existing AutoMD-SAXS branch + latest Carbonara | Effectively what we do — the integration branch is **based on** it. |
| (c) Two separately deployed branches/variants | **Rejected.** Both pipelines share the entire stack (backend/ui/schema/worker/queue) and run in one worker; two deployments would duplicate everything and cannot cleanly share the single worker/queue. |
| (d) Other | n/a |

**Recommendation:** create **one integration branch off `feature/automd-saxs-worker`**
(which already holds all Carbonara history + the k8s de-nesting switch + the
AutoMD-SAXS worker), then:

1. commit the pending legitimate fixes (exclude `vite.config.ts`);
2. cherry-pick the single missing Carbonara commit `914769d3`;
3. tag the AutoMD-SAXS repo at a pinned version and build the combined worker image
   against it;
4. add a `values-diamond.yaml` (Helm environment config kept **separate** from app
   code).

Proposed name: **`integration/k8s-carbonara-automdsaxs`** (or `deploy/k8s-diamond`).
This answers the sub-considerations: same frontend/backend/DB/queue = **yes**
(shared); container image ownership = one worker image + optional carbonara image,
pinned tags; independent worker scaling = not now (documented); upstream updates =
still merge from `upstream/main` into this branch as usual; rollback a faulty worker
= image tag + `helm rollback`; avoid long-lived divergence = converge the two
feature branches into this one. **Exact commands are in the separate Git procedure
deliverable.** Do **not** run them until you approve.

---

## 11. Prioritised action list (status updated)

**P0 — before the meeting (mostly local, cluster-independent):**

1. ✅ **Settle the source of truth** — fixes committed; `AutoMD-SAXS` tagged `v0.1.1`.
2. ✅ **Create the integration branch** off `automd-saxs-worker` + cherry-pick
   `914769d3` — done and pushed.
3. ✅ **Build one combined worker image** — built + verified (`automd-saxs --help`,
   FoXS, `v0.1.1`); ⚠ must use the **three-step** build (branch worker → +automd →
   +carbonara; §1a / runbook §4.1). Pushing to the Diamond registry is admin-gated.
4. ✅ **Draft `values-diamond.yaml`** — committed, placeholder-driven.
5. ✅ **Assemble the meeting facts list** (`K8S_MEETING_CHECKLIST.md`).

**P1 — should do if time permits:**

6. ✅ **Finish Carbonara `inprocess`** for the 2 preview/autoflex handlers — done
   (6/6). *(9a bake-in — Carbonara runtime baked into the worker image — now DONE +
   validated locally, §6.3; 9b k8s-Job deferred as unnecessary.)*
7. ✅ **Liveness/readiness probes + resource requests** — added to the Helm templates.
8. ✅ **Reconcile the worker image version** — one pinned tag + the two-step build
   documented (S3). *(Dev/prod/compose NERSC tags left as-is; the Diamond build uses
   one `<IMAGE_TAG>`.)*

**Also done beyond the original list (Diamond-deployability, gated on `persistence`):**
- ✅ uploads hostPath → RWX PVC; ✅ optional PVC templates w/ `resource-policy: keep`;
- ✅ ConfigMap `CARBONARA_EXEC`/`AUTOMD_SAXS_BIN` + `USE_NERSC=false`;
- ✅ de-NERSC blockers fixed (sfapi optional, logs/scripts emptyDir, postStart off).

**Still to do (admin-gated) before an actual deploy:**
- ☐ Fill `values-diamond.yaml` placeholders; build+push images (two-step); `helm upgrade`; smoke-test.

**P2 — after first deploy (unchanged):**

9. Storage retention/cleanup + Mongo/PVC backup policy.
10. Carbonara path 9b (k8s-Job-per-task) if image size/isolation warrants.
11. Independent per-pipeline scaling (separate queues + Deployments) if needed.
12. Stricter security (RO root FS + explicit scratch volume); monitoring; MPS for
    >1 job/GPU if the admin allows.

---

## 12. Open questions requiring the Kubernetes administrator

(Full list with rationale in `K8S_MEETING_CHECKLIST.md`.) The decisive ones:

1. **GPU in k8s?** Are there GPU nodes + the NVIDIA device plugin/operator? (Chooses
   Option A vs B — everything downstream depends on this.)
2. **RWX storage class** + capacity/quota for the shared job volume?
3. **Registry** to push/pull from, and any image-size limit (Carbonara ~5 GB)?
4. **Ingress controller + TLS/cert mechanism + DNS** for the UI?
5. **PodSecurity level**, allowed **UID/fsGroup** range, and confirmation that
   non-privileged pods suffice (they do once de-nested)?
6. **Secret management** policy (plain Secrets / sealed-secrets / vault)?
7. **Deploy mechanism** — manual `helm upgrade` or GitOps (ArgoCD/Flux)?

---

## 13. Confidence ledger

Note: several original [VERIFY]/[INFERRED] items are now **[RESOLVED]** by the
Phase-2/3 work in §1a.

- **[CONFIRMED]:** repo/branch topology; divergence counts; the single missing
  Carbonara commit; Helm chart contents and branch-identity; the worker being a
  single multi-pipeline process; AutoMD-SAXS direct-spawn vs the dev-only podman
  shim; hardcoded config defaults; image version skew; security contexts;
  NERSC-specific storage/registry.
- **[RESOLVED since audit]:** the `914769d3` cherry-pick was clean; the combined
  worker image builds + runs `automd-saxs`; Carbonara `inprocess` is now 6/6; the
  Carbonara runtime is now baked into the worker image (9a) and validated locally
  as the k8s non-root user — both pipelines run in one image (§6.3); all Helm
  changes render NERSC-unchanged + Diamond-startable (verified with `helm template`).
- **[INFERRED]:** recommended branch strategy (now executed); Option A over B.
- **[VERIFY — still open]:** whether the worker actually consumes the Helm ConfigMap
  `REDIS_HOST` at runtime; Diamond GPU/storage/registry/ingress/UID facts; whether
  Carbonara steps genuinely need GPU (its Dockerfile is CPU-base); the exact
  `bilbomd-secrets` key names the app expects.
