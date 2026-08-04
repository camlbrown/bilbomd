# Kubernetes Deployment Meeting — Checklist

Concise, meeting-usable. Bring `K8S_READINESS_AUDIT.md` (context) and
`K8S_DEPLOYMENT_RUNBOOK.md` (commands). Goal of the meeting: leave with every
placeholder in the runbook §1 filled and Option A vs B decided.

---

## 0. The one decision that drives everything

☐ **Does the Diamond k8s cluster have GPU nodes + the NVIDIA device plugin/operator?**
  - **Yes →** Option A: run MD inside GPU worker pods (our recommendation).
  - **No →** Option B: k8s runs the web tier only; MD is submitted to Diamond
    HPC/Slurm (needs a NERSC-SFAPI-equivalent bridge — net-new work; deploy web
    tier now, plan compute later).

---

## 1. Questions for the Kubernetes colleague

**Compute / GPU**
- ☐ GPU models and count per node? GPU scheduling available to our namespace?
- ☐ Is **MPS** (multiple jobs per GPU) allowed, or one-job-per-GPU?
- ☐ (Option B) Is there an HPC/Slurm submission API we could target instead?

**Storage**
- ☐ Which **ReadWriteMany** storage class for the shared job/results volume? (both
  backend and worker must mount the *same* volume)
- ☐ Capacity / quota we can have? (MD output is multi-GB per job × many jobs; the
  old 8 GB dev quota already caused a failure)
- ☐ Storage class for Mongo/Redis (RWO is fine)? Are `mongodb-volume`/`redis-volume`
  PVCs pre-created or do we create them?
- ☐ Backup/retention expectations for Mongo + the uploads PVC?

**Registry / images**
- ☐ Which **registry** do we push to and pull from? Auth method for `podman login`?
- ☐ Any **image size limit**? The combined worker image (worker + AutoMD-SAXS +
  Carbonara baked in) is **~23 GB** — flag this; confirm the registry + nodes
  accept it and there's disk headroom for the pull.
- ☐ Pull-through cache of `ghcr.io` available, or must we mirror images?
- ☐ Name to use for the **image-pull secret**?

**Cluster context / permissions**
- ☐ **Namespace** name for us; can we `helm install` / `kubectl apply` in it?
- ☐ Kubeconfig + **context** name to use.
- ☐ Can the **worker ServiceAccount create/watch Jobs**? (only needed if we choose
  Carbonara "k8s-Job-per-task" later, not for first deploy)

**Ingress / DNS / TLS**
- ☐ **Ingress controller / class** name?
- ☐ **DNS hostname** for the UI, and how it's created?
- ☐ **TLS**: cert-manager, or do we supply a cert as a Secret?

**Security**
- ☐ **PodSecurity level** enforced (baseline/restricted)?
- ☐ Allowed **runAsUser / fsGroup** range? (image user is UID 1000; chart currently
  sets 62704/104818 — NERSC values that likely need changing)
- ☐ Confirm **non-privileged pods are sufficient** (they are once we de-nest — no
  runtime socket, no privileged mode). Any pods needing extra capabilities?

**Secrets**
- ☐ Secret-management policy: plain k8s Secrets, **sealed-secrets**, or a **vault**?

**Networking**
- ☐ **Network policies / egress**: can pods reach ORCID (OAuth), SMTP (email), and
  the image registry?

**Delivery**
- ☐ Deploy via **manual `helm upgrade`**, or **GitOps (ArgoCD/Flux)**? If GitOps,
  which repo/structure do they expect?
- ☐ Is there **CI** we can use to build+push images, or do we build locally?

---

## 2. Access & credentials to confirm you have

- ☐ kubeconfig for the cluster (and it works: `kubectl get ns` succeeds)
- ☐ push access to the registry (`podman login` succeeds)
- ☐ permission to create Secrets/PVCs/Helm releases in the namespace

---

## 3. Values we must collect (fill the runbook §1 table)

- ☐ `<NAMESPACE>` ☐ `<CONTEXT>` ☐ `<KUBECONFIG_PATH>`
- ☐ `<DIAMOND_REGISTRY>` ☐ `<PULL_SECRET_NAME>` ☐ `<IMAGE_TAG>` scheme
- ☐ `<RWX_STORAGE_CLASS>` ☐ `<RWO_STORAGE_CLASS>` ☐ `<UPLOADS_SIZE>`
- ☐ `<INGRESS_CLASS>` ☐ `<UI_HOST>` ☐ `<TLS_SECRET>` / cert mechanism
- ☐ `<RUN_AS_UID>` ☐ `<FS_GROUP>` ☐ `<GPU_COUNT>`

---

## 4. What we bring to the table (state plainly)

- ☐ A **working Helm chart** already proven on k8s at NERSC — we adapt, not author.
- ☐ **One combined worker image** (worker + AutoMD-SAXS **+ Carbonara** all baked
  in) — **no nested containers for either pipeline**; both run as normal
  subprocesses in the worker pod. Built + validated locally as the k8s non-root
  user (both toolchains coexist, worker's own OpenMM/automd-saxs unshadowed), incl.
  a **full end-to-end Carbonara `inprocess` job** (real calmodulin fit → completed).
- ☐ Carbonara de-nesting (`CARBONARA_EXEC=inprocess`) implemented on **all 6** call
  sites, and the Carbonara runtime is **baked into the worker image** (task 9a), so
  Carbonara runs in-pod with no separate image.
- ☐ **Non-privileged** pods; no runtime socket needed.
- ☐ Pinned, versioned image tags (reproducible; `helm rollback` works).
- ☐ Both pipelines are **job types in one worker**, not new services — minimal
  cluster surface.

---

## 4b. Prep already done vs still to do (our side, before/at deploy)

All chart changes are gated on the `.Values.persistence` block (the "Diamond /
self-contained" marker), so **NERSC renders unchanged** and Diamond gets the fixes.
Everything below is committed on `integration/k8s-carbonara-automdsaxs` and
verified with `helm template` (helm 3.14.3).

**✅ DONE — application / de-nesting:**
- ☑ Carbonara de-nesting complete — `CARBONARA_EXEC=inprocess` on **all 6** call
  sites (main pipeline + preview + auto-flex).
- ☑ AutoMD-SAXS runs as a direct in-pod subprocess (no nested container).
- ☑ **9a bake-in DONE** — Carbonara runtime (py3.12 env + isolated cg2all py3.10 +
  C++ engine) baked into the worker image via
  `infra/carbonara/bilbomd-worker-carbonara.dockerfile` (build step 3, runbook
  §4.1). Built + validated locally as the k8s non-root user; PATH not reordered so
  the worker's OpenMM/automd-saxs are unshadowed. Both pipelines run from **one**
  image — no separate Carbonara image, no k8s-Job/RBAC needed. A **full end-to-end
  Carbonara `inprocess` job** (real calmodulin mixture fit) ran to `completed` in
  the combined image using the baked tools.

**✅ DONE — Helm chart (Diamond now renders a *startable* deployment):**
- ☑ Liveness/readiness probes (worker `/config:3000`, backend `/healthcheck:3500`).
- ☑ Values-driven `resources` + optional PVC templates (uploads RWX, mongo/redis RWO).
- ☑ Edit #1 — uploads volume: hostPath → **RWX PVC** (worker + backend).
- ☑ Edit #2 — ConfigMap injects `CARBONARA_EXEC=inprocess` + `AUTOMD_SAXS_BIN`.
- ☑ **Former startup BLOCKERS fixed (gated):**
  - ☑ `sfapi-priv-key` secretRef + volume → `optional: true` on Diamond (the NERSC
    secret is absent there, so it no longer blocks pod start).
  - ☑ `vol-logs` / `vol-scripts` → `emptyDir` on Diamond (CFS hostPath `type:
    Directory` would require pre-existing paths).
  - ☑ NERSC CFS-sync `postStart` hook → gated off on Diamond.
  - ☑ `USE_NERSC=false` + `BILBOMD_DEPLOY_SITE=diamond` on Diamond, so the worker
    runs MD **in-pod** instead of submitting to NERSC Slurm.
- ☑ `values-diamond.yaml` draft with all placeholders + a documented remaining list.

**☐ STILL TO DO before/at the deploy:**
- ☐ **Two-step worker image build (S3) — MUST get right:** `infra/automd-saxs/`
  `Dockerfile` only *layers* AutoMD-SAXS; it does **not** rebuild the worker JS.
  Build the worker from **this branch** first (`apps/worker/bilbomd-worker.dockerfile`),
  THEN layer AutoMD-SAXS onto that (`--build-arg BASE_IMAGE=<branch-worker>`), one
  `<IMAGE_TAG>` everywhere. Layering onto the published `bilbomd-worker:2.10.0` gives
  OLD worker code (no de-nesting). See runbook §4.1.
- ☐ **Fill `values-diamond.yaml` placeholders** with the admin (registry, RWX/RWO
  storage classes + sizes, GPU count, ingress host/TLS, UID/fsGroup, ORCID).
- ☐ **Push images** to the Diamond registry; `helm upgrade`.

**☐ Optional / non-blocking (documented, safe to defer):**
- ☐ `USER 62704` at the end of the automd-saxs Dockerfile (Helm `runAsUser`
  overrides at runtime anyway).
- ☐ `VITE_USE_NERSC="true"` in the UI ConfigMap — UI display flag; review if Diamond
  wants it false.

---

## 5. Minimal definition of success for the meeting

Not a perfect production deploy — a **clean, unambiguous starting point**:

1. ☐ Option A vs B decided (GPU-in-k8s answer).
2. ☐ Every runbook placeholder filled (registry, namespace, storage class, ingress,
   UID/fsGroup, GPU count).
3. ☐ Registry + pull-secret mechanism agreed; we can push one image successfully.
4. ☐ RWX storage class + quota agreed for `/bilbomd/uploads`.
5. ☐ Secret mechanism agreed.
6. ☐ Deploy path agreed (manual `helm upgrade` vs GitOps).
7. ☐ Web tier (Mongo, Redis, backend, UI, worker) reachable — even before GPU/MD.

**Stretch (if time):** one **AutoMD-SAXS** smoke job runs end-to-end in a GPU worker
pod and its results persist on the PVC.
