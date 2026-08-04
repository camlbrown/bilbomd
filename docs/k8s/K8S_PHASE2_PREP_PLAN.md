# Phase 2 — Preparation Plan (ordered, per-task)

Expands §11 of `K8S_READINESS_AUDIT.md` into an actionable, ordered plan. This is a
**plan**, not implementation — nothing here is executed until you approve Phase 3.

**Deployment target:** the **Diamond Light Source** local Kubernetes cluster (not
NERSC). The existing Helm chart in `infra/helm/` was *authored* for NERSC's "Spin"
cluster — that is only its provenance. Every task below adapts it **for Diamond**.
The only place the distinction bites: if you later choose "Option B" (submit MD to
HPC instead of running it in k8s GPU pods), the HPC target is a **Diamond** cluster
(e.g. Wilson / SciML), not Perlmutter — which needs a Diamond-specific submission
bridge (out of scope for the first deploy).

Each task states: **Why · Affects · Verify · Reversibility · When (now vs needs
cluster/admin)**. Prefer small, reviewable commits.

---

## MUST — complete before the Kubernetes session

These give you a clean, unambiguous source of truth and a buildable, identifiable
image. All are doable **now**, locally, without the cluster.

### M1. Finalise the source of truth (commit pending work, tag the package)
- **Why.** Reproducible images require a clean, committed tree. Today there are
  uncommitted fixes in two repos, so "which source does the image contain?" is
  currently ambiguous (branch HEADs predate this session's fixes).
- **Affects.** bilbomd worktree `feature/automd-saxs-worker` (8 files, **excluding**
  `apps/ui/vite.config.ts`); AutoMD-SAXS repo (`ligand.py`, `prepare.py`,
  `workflow.py`) + a new tag `v0.1.1`.
- **How to verify.** `git status` clean (bar the deliberately-local
  `vite.config.ts`); `git log --oneline -1` shows the new commits;
  `git tag` lists `v0.1.1`.
- **Reversibility.** Fully reversible — the procedure creates `backup/pre-k8s-*`
  tags first; `git reset --hard <backup-tag>` restores exactly. Nothing pushed.
- **When.** Now. **Exact commands: `K8S_GIT_INTEGRATION_PROCEDURE.md` Parts A1–A3, B1–B3.**
  (Approval-gated because it writes commits, though all local/reversible.)

### M2. Create the integration branch and bring in the one missing Carbonara commit
- **Why.** Single deployment branch with both workers. The AutoMD-SAXS branch is the
  correct base (it already has newer Carbonara-for-k8s); it only lacks Carbonara
  commit `914769d3`.
- **Affects.** New branch `integration/k8s-carbonara-automdsaxs` in the bilbomd repo;
  one cherry-picked commit (2 Carbonara-only files).
- **How to verify.** `git log --oneline integration/…..feature/carbonara-worker`
  returns **nothing** (fully caught up); `pnpm -F @bilbomd/{backend,worker,ui} build`
  all pass on the branch.
- **Reversibility.** `git switch feature/automd-saxs-worker && git branch -D
  integration/…`; cherry-pick has `--abort`. Nothing pushed.
- **When.** Now. **Commands: procedure Parts A4–A8.**

### M3. Build ONE combined worker image (worker + AutoMD-SAXS baked in) and prove it
- **Why.** Removes the AutoMD-SAXS nested-container path — the CLI must exist inside
  the worker pod. The Dockerfile already layers exactly this; its base is a
  **`ARG BASE_IMAGE`**, so we rebase it onto the current worker tag cleanly.
- **Affects.** `infra/automd-saxs/Dockerfile` (build only — no edit needed to build;
  optionally later fold into `apps/worker/bilbomd-worker.dockerfile`). Build context =
  the **AutoMD-SAXS repo** at tag `v0.1.1`.
- **How to build (illustrative).**
  ```bash
  # RUN IN: /home/kri42825/bilbomd-automd-saxs
  podman build -f infra/automd-saxs/Dockerfile \
    --build-arg BASE_IMAGE=ghcr.io/bl1231/bilbomd-worker:<CURRENT_WORKER_TAG> \
    -t <DIAMOND_REGISTRY>/bilbomd-worker:<IMAGE_TAG> \
    /home/kri42825/AutoMD-SAXS
  ```
- **How to verify.**
  `podman run --rm <image> /opt/envs/openmm/bin/automd-saxs --help` prints usage;
  `podman run --rm <image> which multi_foxs` finds FoXS (from the worker base).
- **Reversibility.** Building an image changes nothing else; delete with `podman rmi`.
  Non-destructive.
- **When.** Now (local build). Pushing to `<DIAMOND_REGISTRY>` needs the registry
  from the admin — do at/after the meeting. **[VERIFY the exact current worker base
  tag to rebase on — see S3.]**

### M4. Draft `values-diamond.yaml` (environment config kept OUT of app code)
- **Why.** Keeps Diamond-specific settings (registry, storage, GPU, ingress, UIDs)
  separate from application code, so the same images run anywhere by swapping values.
- **Affects.** New file `infra/helm/values-diamond.yaml` (copy of `values-prod.yaml`),
  and **possibly a small template edit** for the uploads mount (NERSC used hostPath;
  Diamond needs the RWX PVC) — the one likely code touch in the chart. **[VERIFY the
  uploads-mount template shape before editing.]**
- **How to verify.** `helm template bilbomd . -f values-diamond.yaml -n <NS>` renders
  without errors and shows: Diamond image refs, the `bilbomd-uploads` PVC on backend
  **and** worker, `CARBONARA_EXEC=inprocess`, `AUTOMD_SAXS_BIN=/opt/envs/openmm/bin/automd-saxs`,
  and (if GPU) the worker `nvidia.com/gpu` limit.
- **Reversibility.** A new values file changes nothing live (rendering ≠ deploying);
  delete the file to revert.
- **When.** Draft now with placeholders; finalise once the admin gives registry /
  storage class / ingress / UID values.

### M5. Assemble the meeting facts list — **DONE**
- **Why / Verify.** `K8S_MEETING_CHECKLIST.md` captures the admin questions, values
  to collect, and the success definition. Review it before the meeting.

---

## SHOULD — complete if time permits (before or shortly after the session)

Improves robustness and completes Carbonara-on-k8s. Local, non-destructive.

### S1. Finish Carbonara `inprocess` for the 2 remaining call sites (+ decide 9a vs 9b)
- **Why.** `CARBONARA_EXEC=inprocess` is honored by 4 of 6 `runCarbonaraContainer`
  call sites; the **preview** and **auto-flex** handlers still hardcode the container
  path and would `podman run` (fail) in a pod. Also decide Carbonara execution model:
  **9a bake-in** (finish this + merge the ~5 GB micromamba runtime into the worker
  image) vs **9b k8s-Job-per-task** (needs a ServiceAccount + RBAC + new submit/await
  code).
- **Affects.** `apps/worker/src/workerHandlers/carbonaraPreviewHandler.ts:80`,
  `carbonaraAutoFlexHandler.ts:87` (add `execMode: config.carbonara.exec`, mirroring
  the 4 wired call sites). Decision 9a/9b also affects the worker Dockerfile (9a) or
  new k8s-Job code + Helm RBAC (9b).
- **How to verify.** With `CARBONARA_EXEC=inprocess` locally, a preview/auto-flex run
  spawns the python **directly** (logs show no `podman run`); a full Carbonara job
  still completes.
- **Reversibility.** Two-line-ish code change, easily reverted; default stays `podman`
  so local dev is unaffected.
- **When.** Now (the 2-handler fix). The 9a/9b decision needs the admin's answer on
  image-size limits and whether the worker SA may create Jobs. **Not required for an
  AutoMD-SAXS-only first deploy.**

### S2. Add health probes + resource requests to the Helm workloads
- **Why.** k8s needs probes to know a pod is alive/ready and resource requests to
  schedule fairly and protect a long MD job from eviction. Currently every
  Deployment has `resources: {}` and no probes.
- **Affects.** `infra/helm/templates/worker-deployment.yaml`,
  `backend-deployment.yaml` (and optionally ui/mongo/redis). The worker already
  serves **`GET /config` on port 3000** — a ready-made probe target.
- **How to verify.** `helm template … | grep -A5 Probe` shows the probes;
  `kubectl describe pod` after deploy shows probes passing; a deliberately-unready
  pod is held out of the Service.
- **Reversibility.** Template-only; revert the edit. Non-destructive until `helm
  upgrade`.
- **When.** Now (edit + `helm template` render locally). Values like memory size
  benefit from the admin's node sizing.

### S3. Reconcile the worker image version to a single pinned tag
- **Why.** Four different worker versions float around today (`values-dev` 2.13.2,
  `values-prod` 2.8.0, `compose-prod` 2.14.2, and the AutoMD-SAXS image base 2.10.0).
  For a reproducible deploy, worker code and the AutoMD-SAXS layer must be built from
  one known base and referenced by one tag everywhere.
- **Affects.** `infra/automd-saxs/Dockerfile` `BASE_IMAGE` (via `--build-arg`),
  `values-diamond.yaml` worker tag, and the build command in M3.
- **How to verify.** The image the worker Deployment references == the base of the
  AutoMD-SAXS layer == the tag you pushed; `kubectl get deploy bilbomd-worker -o
  jsonpath='{..image}'` matches `<IMAGE_TAG>`.
- **Reversibility.** Choice of tag only; no data impact.
- **When.** Now (decide the tag); ties into M3.

### S4. Decide PVC creation for uploads/mongo/redis (template vs pre-create)
- **Why.** The chart assumes `mongodb-volume`/`redis-volume` PVCs pre-exist and (for
  Diamond) needs the new RWX `bilbomd-uploads`. Deciding now avoids a deploy-time
  stall.
- **Affects.** Either new `PersistentVolumeClaim` templates in `infra/helm/templates/`
  (parameterised by storage class) **or** a documented `kubectl apply` step (runbook §7).
- **How to verify.** `kubectl get pvc` shows all three `Bound` before `helm upgrade`.
- **Reversibility.** PVC creation provisions storage (mildly "destructive" in that it
  allocates); deleting an empty PVC is safe. Deleting a **bound, data-holding** PVC is
  irreversible — flagged in the runbook cleanup section.
- **When.** Decide now; create at deploy time with the admin's storage class.

---

## CAN — complete after the initial deployment

Hardening and scale; none block the first successful deploy.

### C1. Storage retention/cleanup + backups
- **Why.** MD output is large; without cleanup the PVC fills (already caused a local
  failure at 8 GB). Mongo + the uploads PVC need a backup policy.
- **Affects.** The worker's existing cleanup step (tune/enable); a retention CronJob;
  the existing `mongo-backup` CronJob (point at Diamond storage); PVC snapshot policy.
- **How to verify.** Old job dirs are pruned on schedule; a restore test recovers a
  Mongo dump.
- **Reversibility.** Retention **deletes data** by design — introduce conservatively
  (long TTL first), clearly labelled.
- **When.** After first deploy, once real usage/quota is known.

### C2. Carbonara k8s-Job-per-task (Option 9b), if bake-in proves unwieldy
- **Why.** Keeps the ~5 GB Carbonara runtime out of the worker image and isolates
  Carbonara steps; the idiomatic k8s way to run one-shot containerised tasks.
- **Affects.** New worker code to create/await k8s Jobs; a ServiceAccount + RBAC Role
  (create/watch Jobs) in Helm; the carbonara image in the Diamond registry.
- **How to verify.** A Carbonara job spawns child k8s Jobs (`kubectl get jobs`) that
  mount the RWX PVC and complete; results identical to in-process.
- **Reversibility.** Additive (guarded by `CARBONARA_EXEC` mode); revert by switching
  back to `inprocess`.
- **When.** Only if S1's bake-in path is rejected or image size is capped.

### C3. Independent per-pipeline scaling
- **Why.** Today one worker/queue does all job types; Carbonara and AutoMD-SAXS can't
  scale independently. If demand diverges, split them.
- **Affects.** Separate BullMQ queues per pipeline; separate worker Deployments (and
  possibly separate images) in Helm.
- **How to verify.** Scaling one pipeline's Deployment doesn't affect the other;
  each drains only its queue.
- **Reversibility.** Structural change; revert by collapsing back to one worker.
- **When.** Only if load requires it — not for first deploy.

### C4. Security hardening + monitoring + MPS
- **Why.** Tighten posture (read-only root FS + explicit `emptyDir` for `/tmp`),
  add metrics/log aggregation, and (if the admin allows) NVIDIA **MPS** to pack >1 MD
  job per GPU.
- **Affects.** Helm securityContext + volumes; monitoring stack; worker GPU env.
- **How to verify.** Pods run read-only-root without errors; dashboards show
  job/GPU metrics; MPS lets two small jobs share a GPU.
- **Reversibility.** Incremental, each revertible via values.
- **When.** After the platform is proven.

### C5. CI to build/push images (and GitOps if Diamond offers it)
- **Why.** Avoid hand-building ~5 GB images; make "commit → image → deploy"
  repeatable. If Diamond runs ArgoCD/Flux, the deploy becomes "change the tag in git".
- **Affects.** A GitHub Actions (or Diamond CI) workflow; optionally a GitOps
  values repo.
- **How to verify.** A push builds+pushes tagged images; (GitOps) a tag bump auto-syncs
  the cluster.
- **Reversibility.** CI/config only; no runtime data impact.
- **When.** After the manual path is proven end-to-end.

---

## Ordering at a glance

```
BEFORE THE SESSION (local, reversible):
  M1 commit+tag ─► M2 integration branch ─► M3 build combined worker image
                                     └► M4 draft values-diamond.yaml
  (M5 meeting checklist — done)
  optional-if-time: S1 (2-handler fix) · S2 probes/resources · S3 version pin · S4 PVC decision

AT/AFTER THE SESSION (needs admin facts):
  finalise values-diamond.yaml ─► push images to Diamond registry ─► helm upgrade (web tier)
  ─► enable GPU worker ─► AutoMD-SAXS smoke job ─► (Carbonara once S1 + 9a/9b settled)

AFTER FIRST DEPLOY (hardening):
  C1 retention/backup · C2 carbonara Jobs (if needed) · C3 independent scaling
  · C4 security/monitoring/MPS · C5 CI/GitOps
```

## What is safe to do right now vs gated

- **Safe now, non-destructive:** M4 (draft values), S2/S3/S4 (template edits +
  `helm template` renders), M3 image build (local).
- **Local but writes commits (reversible via backup tags, approval-gated):** M1, M2,
  and the S1 code fix.
- **Needs the cluster/admin:** pushing images, creating Secrets/PVCs, `helm upgrade`,
  and any smoke test — all in `K8S_DEPLOYMENT_RUNBOOK.md`, none run without approval.
