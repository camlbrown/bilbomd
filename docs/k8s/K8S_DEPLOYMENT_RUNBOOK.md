# BilboMD on Kubernetes — Deployment Runbook

**Audience:** you (limited Kubernetes/Git experience), usable live during the
deployment meeting. **Companion to `K8S_READINESS_AUDIT.md`.**

### How to read this runbook

- Commands are in fenced blocks. Above each, a plain-English "**What:**" line.
- **Placeholders look like `<THIS>`** — replace before running. The table in §1
  lists every placeholder and who provides it.
- **`# RUN IN:`** at the top of a block tells you which directory to run it in.
- **Lines beginning `# ⚠ DESTRUCTIVE`** change or delete cluster/data state —
  read twice, run deliberately.
- Nothing here should be run until the branch/image prep (§3–§4) is done and the
  admin has filled in the placeholders (§1–§2).

> **Golden rule:** Kubernetes runs **images**, not source. "Deploying new code" =
> build image → push to a registry the cluster can pull → tell Helm to use that
> tag (`helm upgrade`). The cluster never compiles your code.

---

## 1. Prerequisites & placeholders

**Access you need before starting:**

- A **kubeconfig** for the Diamond cluster (grants `kubectl`/`helm` access).
- Push access to a **container registry** the cluster can pull from.
- `kubectl`, `helm` (v3), and `git` installed locally; `podman` (or `docker`) to
  build images.

**Placeholders — get these from the Kubernetes admin (see `K8S_MEETING_CHECKLIST.md`):**

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `<KUBECONFIG_PATH>` | path to the cluster kubeconfig file | `~/.kube/diamond-config` |
| `<CONTEXT>` | kube context name inside that file | `diamond-bilbomd` |
| `<NAMESPACE>` | your namespace on the cluster | `bilbomd` |
| `<DIAMOND_REGISTRY>` | registry host to push/pull images | `registry.diamond.ac.uk/bilbomd` |
| `<REGISTRY_OWNER>` | path segment after the registry host (or `null`) | `bilbomd` |
| `<PULL_SECRET_NAME>` | image-pull secret name (from admin) | `diamond-registry` |
| `<IMAGE_TAG>` | the version tag you build & deploy | `2.15.0-diamond.1` |
| `<RWX_STORAGE_CLASS>` | ReadWriteMany storage class for job files | `nfs-client` |
| `<RWO_STORAGE_CLASS>` | storage class for Mongo/Redis | `ceph-rbd` |
| `<UPLOADS_SIZE>` / `<MONGO_SIZE>` / `<REDIS_SIZE>` | PVC sizes | `500Gi` / `50Gi` / `5Gi` |
| `<WORKER_MEM_REQUEST>` / `<WORKER_MEM_LIMIT>` | worker memory | `8Gi` / `16Gi` |
| `<INGRESS_CLASS>` | ingress controller class | `nginx` |
| `<UI_HOST>` / `<UI_INGRESS_HOST>` | public DNS / internal ingress host for the UI | `bilbomd.diamond.ac.uk` |
| `<TLS_SECRET>` | k8s secret holding the UI TLS cert | `bilbomd-ui-tls` |
| `<ORCID_CLIENT_ID>` | ORCID OAuth client id | `APP-XXXXXXXX` |
| `<RUN_AS_UID>` / `<FS_GROUP>` | allowed UID / fsGroup (chart default 62704 / 104818) | `62704` / `104818` |
| `<GPU_COUNT>` | GPUs per worker pod (delete the line if none) | `1` |

> The chart's built-in security context uses `runAsUser: 62704` and
> `fsGroup: 104818` (matching the published worker image). Only change these if
> Diamond's PodSecurity requires a different range.

---

## 2. Information to obtain from the Kubernetes admin

Ask these first — they decide the shape of the deploy (details/rationale in
`K8S_MEETING_CHECKLIST.md`):

1. Are there **GPU nodes + the NVIDIA device plugin**? (If no → MD cannot run in
   k8s pods; we deploy the web tier only and plan HPC/Slurm for MD — "Option B".)
2. What **RWX storage class** exists, and what **quota**?
3. Which **registry** do we push to, any **image size limit**?
4. **Ingress class + TLS/cert mechanism + DNS** for the UI?
5. **PodSecurity level**, allowed **UID/fsGroup**, image-pull secret name?
6. **Secret policy** (plain Secret / sealed-secrets / vault)?
7. **Manual `helm upgrade`** or **GitOps** (ArgoCD/Flux)?

---

## 3. Git preparation — ALREADY DONE

The integration branch is built and **pushed** (per `K8S_GIT_INTEGRATION_PROCEDURE.md`):

- ✅ `integration/k8s-carbonara-automdsaxs` on `origin` (`camlbrown/bilbomd`) — the
  single deployment branch (both workers, de-nested, plus the Diamond Helm work).
- ✅ `AutoMD-SAXS` repo committed + tagged **`v0.1.1`** (what the worker image pins to).
- ✅ backup tags in both repos; the one missing Carbonara commit cherry-picked.

You just need to be **on that branch** to build/deploy:

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: switch to the deployment branch and confirm state
git fetch origin
git switch integration/k8s-carbonara-automdsaxs
git branch --show-current      # expect: integration/k8s-carbonara-automdsaxs
git status                     # only apps/ui/vite.config.ts may show (local-only; ignore)
git remote -v                  # origin = camlbrown/bilbomd ; upstream push = DISABLED
```

---

## 4. Build, tag, and push the images

BilboMD is ~5 images: **ui, backend, worker, mongo, redis** (mongo/redis are
stock images — no build). Only **worker** carries the science tools; that is where
both pipelines attach.

**4.1 Build the combined worker image — up to THREE steps (build the BRANCH
worker, layer AutoMD-SAXS, then — if deploying Carbonara — layer Carbonara).**

> Steps 1–2 produce the AutoMD-SAXS-capable worker. Step 3 (task "9a") bakes the
> Carbonara runtime **into that same worker image** so Carbonara runs
> `inprocess` in the worker pod (no nested container). Do step 3 only if you are
> deploying the Carbonara pipeline; otherwise tag step 2's output as the registry
> worker image and skip to 4.2. Built + validated locally 2026-08 (see §6.3 of
> the readiness audit).

> ⚠ **Critical (S3).** `infra/automd-saxs/Dockerfile` only *layers* AutoMD-SAXS onto
> an existing worker image — it does **not** rebuild the worker JS. If you layer it
> onto the *published* `ghcr.io/bl1231/bilbomd-worker:2.10.0`, you get the **old
> published worker code** (no Carbonara de-nesting, no AutoMD-SAXS handlers) with
> AutoMD-SAXS bolted on — NOT this branch's worker. So you must first build the
> worker image **from this branch**, then layer AutoMD-SAXS onto *that*.

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs   (build CONTEXT = repo root)
# STEP 1: build the worker image from THIS BRANCH's code.
# Needs ghcr.io/bl1231/bilbomd-worker-base:0.0.8 (pulled automatically if you have
# registry access). This is a multi-stage build (pnpm build) — a few minutes.
podman build -f apps/worker/bilbomd-worker.dockerfile \
  -t localhost/bilbomd-worker-branch:<IMAGE_TAG> .
```

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs   (build CONTEXT = the AutoMD-SAXS repo)
# STEP 2: layer AutoMD-SAXS v0.1.1 onto the BRANCH worker from step 1.
# Check out the AutoMD-SAXS repo at the pinned tag first for reproducibility:
#   git -C /home/kri42825/AutoMD-SAXS switch --detach v0.1.1
# If NOT deploying Carbonara, replace the -t below with the registry worker tag
# (<DIAMOND_REGISTRY>/bilbomd-worker:<IMAGE_TAG>) and skip step 3.
podman build -f infra/automd-saxs/Dockerfile \
  --build-arg BASE_IMAGE=localhost/bilbomd-worker-branch:<IMAGE_TAG> \
  -t localhost/bilbomd-worker-combined:<IMAGE_TAG> \
  /home/kri42825/AutoMD-SAXS
```

```bash
# RUN IN: a build dir containing Carbonara/ + the 4 wrapper scripts + the dockerfile
#   (build CONTEXT = that dir; see infra/carbonara/README.md for the exact layout)
# STEP 3 (only if deploying Carbonara): layer the Carbonara runtime onto the
# combined worker from step 2, so Carbonara runs inprocess in the worker pod.
# This is the FINAL deploy worker image. Large (~23GB); needs several GB of free
# disk + a writable TMPDIR on a non-full filesystem (podman stages layers there):
#   export TMPDIR=/path/on/big/disk/podman-tmp && mkdir -p "$TMPDIR"
podman build -f bilbomd-worker-carbonara.dockerfile \
  --build-arg BASE_IMAGE=localhost/bilbomd-worker-combined:<IMAGE_TAG> \
  -t <DIAMOND_REGISTRY>/bilbomd-worker:<IMAGE_TAG> .
```

```bash
# RUN IN: anywhere
# What: sanity-check BOTH toolchains + that this is the branch worker.
# Run as the k8s non-root user (--user 62704) to match the deployed securityContext.
podman run --rm --user 62704 <DIAMOND_REGISTRY>/bilbomd-worker:<IMAGE_TAG> bash -lc '
  /opt/envs/openmm/bin/automd-saxs --help >/dev/null && echo "automd-saxs OK"
  which python | grep -q /opt/envs/openmm && echo "worker python unshadowed OK"
  cd /opt/carbonara && carbonara-python -c "import CarbonaraDataTools, biobox, torch" && echo "carbonara py OK"
  convert_cg2all_carbonara --help >/dev/null && echo "cg2all OK"
  test -x /opt/carbonara/build/bin/predictStructureQvary && echo "carbonara C++ engine OK"
  grep -rl inProcessCommandFromArgs /app >/dev/null && echo "branch worker (inprocess present) OK"'
# (If you skipped step 3, drop the carbonara/cg2all/C++ lines.)
```

> **One tag, everywhere (S3).** Use the SAME `<IMAGE_TAG>` for steps 1–3 and the
> `worker.image.tag` in `values-diamond.yaml`, so worker code + AutoMD-SAXS layer
> + Carbonara layer + deployed image are in lockstep. (Future simplification:
> install AutoMD-SAXS via `pip install "automd-saxs @ git+…@v0.1.1"` inside
> `bilbomd-worker.dockerfile` to collapse steps 1–2 into one build.)

**4.2 Build backend and UI (unchanged from upstream).**

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: build backend + ui images at the same tag
podman build -f apps/backend/bilbomd-backend.dockerfile -t <DIAMOND_REGISTRY>/bilbomd-backend:<IMAGE_TAG> .
podman build -f apps/ui/bilbomd-ui.dockerfile        -t <DIAMOND_REGISTRY>/bilbomd-ui:<IMAGE_TAG> .
```

**4.3 (Legacy / NOT for k8s) standalone Carbonara runtime image.**
Superseded by **§4.1 step 3**, which bakes Carbonara into the worker image for
`inprocess` mode. The standalone image below is invoked via `podman run` — a
**nested-container anti-pattern on k8s** (a pod launching a container). Build it
only for single-host/local use, never for the Diamond deploy.

```bash
# RUN IN: /home/kri42825/bilbomd
# What: build the standalone carbonara runtime (requires Carbonara/ source in context)
# ⚠ VERIFY the exact context layout the Dockerfile expects (COPY Carbonara ...)
podman build -f infra/carbonara/Dockerfile.carbonara-allatom-runtime \
  -t <DIAMOND_REGISTRY>/carbonara-allatom-runtime:<IMAGE_TAG> \
  <PATH_CONTAINING_Carbonara_SOURCE>
```

**4.4 Log in and push.**

```bash
# RUN IN: anywhere
# What: authenticate to the registry (admin tells you the login method)
podman login <DIAMOND_REGISTRY>
```

```bash
# RUN IN: anywhere
# What: push each image
podman push <DIAMOND_REGISTRY>/bilbomd-worker:<IMAGE_TAG>
podman push <DIAMOND_REGISTRY>/bilbomd-backend:<IMAGE_TAG>
podman push <DIAMOND_REGISTRY>/bilbomd-ui:<IMAGE_TAG>
# and carbonara-allatom-runtime if built
```

> **Use a specific `<IMAGE_TAG>`, never `latest`.** Pinned tags make `helm rollback`
> reliable.

---

## 5. Point kubectl/helm at the cluster and check context

```bash
# RUN IN: anywhere
# What: use the admin-provided kubeconfig for this shell
export KUBECONFIG=<KUBECONFIG_PATH>
```

```bash
# RUN IN: anywhere
# What: confirm you're on the right cluster and namespace BEFORE any change
kubectl config current-context          # expect <CONTEXT>
kubectl config use-context <CONTEXT>    # if not
kubectl get ns <NAMESPACE>              # confirm namespace exists (admin may create it)
kubectl -n <NAMESPACE> get all          # see what's already there (likely nothing)
```

---

## 6. Secrets & configuration

BilboMD reads non-secret settings from a **ConfigMap** and secrets from **Secrets**
(`infra/HELM_NOTES.md` documents the NERSC set). For Diamond you need at minimum:

- **`bilbomd-secrets`** — backend/worker secret env (token secrets, session secret,
  Mongo user/password, ORCID client secret, etc.).
- **`mongo-secrets`** — Mongo root password.
- **an image-pull secret** for `<DIAMOND_REGISTRY>` (name provided by admin).
- **`<TLS_SECRET>`** — UI TLS cert (or issued by cert-manager).

```bash
# RUN IN: anywhere
# ⚠ Handles credentials. Prefer the admin's secret mechanism (sealed-secrets/vault)
#   if one exists. This plain example creates a Secret from literal values.
# What: create the Mongo root password secret
kubectl -n <NAMESPACE> create secret generic mongo-secrets \
  --from-literal=MONGO_INITDB_ROOT_PASSWORD='<MONGO_ROOT_PASSWORD>'
```

```bash
# RUN IN: anywhere
# ⚠ Handles credentials. The backend + worker read this via `secretRef:
#   {namespace}-secrets` (i.e. `bilbomd-secrets`). Populate the keys BilboMD needs;
#   consult infra/HELM_NOTES.md + apps/backend config for the exact list. Typical:
kubectl -n <NAMESPACE> create secret generic bilbomd-secrets \
  --from-literal=MONGO_USERNAME='bilbomd-backend-user' \
  --from-literal=MONGO_PASSWORD='<MONGO_APP_PASSWORD>' \
  --from-literal=TOKEN_SECRET='<...>' \
  --from-literal=REFRESH_TOKEN_SECRET='<...>' \
  --from-literal=SESSION_SECRET='<...>' \
  --from-literal=HASH_IP_SALT='<...>' \
  --from-literal=ORCID_CLIENT_SECRET='<...>'
# (Names must match what the backend/worker expect — verify against the app config;
#  add/remove keys accordingly. Do NOT commit these values.)
```

```bash
# RUN IN: anywhere
# What: create an image-pull secret so the cluster can pull from the registry
kubectl -n <NAMESPACE> create secret docker-registry <PULL_SECRET_NAME> \
  --docker-server=<DIAMOND_REGISTRY> \
  --docker-username='<REG_USER>' \
  --docker-password='<REG_TOKEN>'
```

> **Never commit secret values to git.** Keep them in the admin's secret store or a
> local `helm-secrets/` folder that is git-ignored (as NERSC does).

---

## 7. Persistent volumes

Three volumes: the **shared RWX** job volume (backend+worker), and **RWO** volumes
for Mongo and Redis.

**The chart now creates all three PVCs for you** (`templates/pvcs.yaml`) when
`persistence.create: true` — which `values-diamond.yaml` sets. So you normally do
**not** create PVCs by hand; `helm install` provisions them. You only need to give
the storage classes + sizes in `values-diamond.yaml` (§8).

```bash
# RUN IN: anywhere
# What: see which storage classes exist (choose an RWX one for uploads, RWO for
#       mongo/redis) and put their names in values-diamond.yaml.
kubectl get storageclass
```

After `helm install` (§9), confirm they bound:

```bash
# RUN IN: anywhere
kubectl -n <NAMESPACE> get pvc   # bilbomd-uploads (RWX) + mongodb-volume + redis-volume => Bound
```

> **Alternative (admin pre-creates PVCs):** if your admin insists on provisioning
> PVCs out of band, set `persistence.create: false` in `values-diamond.yaml` and
> have them create `bilbomd-uploads` (RWX), `mongodb-volume` (RWO), `redis-volume`
> (RWO) with matching names. Do **not** both `kubectl apply` a PVC **and** leave
> `create: true` — that double-creates and conflicts.

> ⚠ **Data-safety note:** the chart-created PVCs are part of the Helm release, so
> `helm uninstall` **will delete them** (and their data) unless the PVC templates
> carry `helm.sh/resource-policy: keep`. See §14 before uninstalling.

---

## 8. Fill in the Diamond Helm values file

`infra/helm/values-diamond.yaml` **already exists on the branch** (committed) — do
**not** recreate it from `values-prod.yaml`; you would lose the Diamond wiring. The
Diamond-specific behaviour is already implemented and **gated on the `persistence`
block** (verified with `helm template`; NERSC renders unchanged):

- uploads volume → **RWX PVC**; logs/scripts → `emptyDir`; sfapi secret → optional;
  NERSC `postStart` hook → off; `USE_NERSC=false`; ConfigMap gains
  `CARBONARA_EXEC=inprocess` + `AUTOMD_SAXS_BIN`; the 3 PVCs are created.

So the only task here is to **replace the `<PLACEHOLDERS>`** in that file with the
admin's values — open it and fill:

- images: `<DIAMOND_REGISTRY>`, `<REGISTRY_OWNER>`, `<IMAGE_TAG>` (worker = the
  combined image from §4.1), `<PULL_SECRET_NAME>` for worker/backend/ui/mongo/redis.
- `persistence`: `<RWX_STORAGE_CLASS>`, `<RWO_STORAGE_CLASS>`, `<UPLOADS_SIZE>`,
  `<MONGO_SIZE>`, `<REDIS_SIZE>`.
- `worker.resources`: `<WORKER_MEM_REQUEST>`, `<WORKER_MEM_LIMIT>`, `<GPU_COUNT>`
  (delete the `nvidia.com/gpu` line for a web-tier-only first deploy).
- `ingress`: `<UI_INGRESS_HOST>`, `<UI_HOST>`, `<TLS_SECRET>`; `auth.orcid_client_id`.

Do **not** put secret values in this file. The header of `values-diamond.yaml`
lists any genuinely-remaining, non-blocking edits (e.g. optional `USER 62704` in the
Dockerfile; the UI `VITE_USE_NERSC` flag).

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs/infra/helm
# What: render templates locally to eyeball them — makes NO cluster changes.
# (Any leftover <PLACEHOLDER> will render literally — a reminder to fill it.)
helm template bilbomd . -f values-diamond.yaml -n <NAMESPACE> | less
```

---

## 9. Install / upgrade

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs/infra/helm
# What: dry-run against the live cluster (validates, changes nothing)
helm upgrade --install bilbomd . \
  -f values-diamond.yaml -n <NAMESPACE> --dry-run
```

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs/infra/helm
# ⚠ This is the real deploy. Creates/updates cluster workloads.
helm upgrade --install bilbomd . \
  -f values-diamond.yaml -n <NAMESPACE> --wait --timeout 10m
```

> Start **web-tier-first**: if GPU/storage is uncertain, deploy with the worker
> **GPU request removed** and only simple job types, prove the platform, then add
> the GPU worker.

---

## 10. Verify the deployment

```bash
# RUN IN: anywhere
# What: pods should be Running/Ready; note any CrashLoopBackOff/Pending
kubectl -n <NAMESPACE> get pods -o wide
kubectl -n <NAMESPACE> get svc,ingress,pvc
```

```bash
# RUN IN: anywhere
# What: watch a specific pod's logs (replace with a real pod name from get pods)
kubectl -n <NAMESPACE> logs deploy/bilbomd-worker -f
kubectl -n <NAMESPACE> logs deploy/bilbomd-backend -f
```

```bash
# RUN IN: anywhere
# What: cluster events (best first stop when a pod won't start/schedule)
kubectl -n <NAMESPACE> get events --sort-by=.lastTimestamp | tail -30
```

**Confirm connectivity (maps to the success definition):**

```bash
# RUN IN: anywhere
# What: backend can reach Mongo/Redis if it's Ready and not logging conn errors
kubectl -n <NAMESPACE> exec deploy/bilbomd-backend -- printenv | grep -E 'REDIS_HOST|MONGO_HOSTNAME|DATA_VOL'
```

Open `https://<UI_HOST>` — the UI should load and log-in should work.

---

## 11. End-to-end smoke test for each worker

**AutoMD-SAXS (simpler — do first):**

1. In the UI, submit a small **AutoMD-SAXS** job (a small protein, short
   `simulation_time_ns`, 1 repeat; optionally a small SAXS `.dat`).
2. Watch it route to the worker and progress:

```bash
# RUN IN: anywhere
# What: follow the worker running the automd-saxs CLI in-pod (no nested container)
kubectl -n <NAMESPACE> logs deploy/bilbomd-worker -f | grep -i automd
```

3. Job reaches "Completed"; results/manifest visible in the UI; download works.

**Carbonara (only if Carbonara is enabled for this deploy):**

1. Submit a small **Carbonara** job.
2. Confirm it runs **in-process** (`CARBONARA_EXEC=inprocess`) — logs show the
   Carbonara python running, **not** a `podman run`:

```bash
kubectl -n <NAMESPACE> logs deploy/bilbomd-worker -f | grep -iE 'carbonara|cg2all|foxs'
```

3. Job completes; results retrievable.

> **Note:** Carbonara de-nesting is complete — **all 6** call sites (main pipeline +
> preview + auto-flex) honor `CARBONARA_EXEC=inprocess` (fixed in S1). All Carbonara
> steps run in-pod; none should attempt `podman run`. Requires the Carbonara tools
> baked into the worker image (or the k8s-Job path) — confirm that before enabling
> Carbonara.

**Confirm artifacts persist:**

```bash
# RUN IN: anywhere
# What: the job dir should exist on the shared PVC (survives pod restarts)
kubectl -n <NAMESPACE> exec deploy/bilbomd-worker -- ls -la /bilbomd/uploads | tail
```

---

## 12. Common failure modes & diagnostics

| Symptom | Likely cause | Diagnostic |
| --- | --- | --- |
| Pod `Pending` | No node satisfies the GPU request / no PVC bound | `kubectl -n <NAMESPACE> describe pod <pod>` (see Events) |
| `ImagePullBackOff` | Wrong registry/tag or missing pull secret | `kubectl -n <NAMESPACE> describe pod <pod>`; check `<PULL_SECRET_NAME>` |
| Worker `CrashLoopBackOff` at start | `REDIS_HOST`/`MONGO_HOSTNAME` unset → connects to `localhost` | `kubectl logs`; verify ConfigMap env is applied |
| Job stuck "Submitted", never runs | Worker not consuming queue / wrong image | worker logs; `kubectl get pods` worker Ready? |
| Carbonara step errors with `podman: not found` | `CARBONARA_EXEC` not `inprocess` (ConfigMap `pipelines` block unset) | confirm ConfigMap has `CARBONARA_EXEC: inprocess` |
| Pod won't start: missing `sfapi-priv-key`/CFS path | `persistence` block unset → NERSC-mode render (sfapi required, hostPath logs) | ensure `values-diamond.yaml` `persistence` block is present |
| AutoMD-SAXS `automd-saxs: not found` | CLI not baked into worker image / wrong `AUTOMD_SAXS_BIN` | `kubectl exec … which automd-saxs` |
| Results 404 in UI | backend & worker not sharing the RWX PVC | confirm both mount `bilbomd-uploads` at `/bilbomd/uploads` |
| `Permission denied` writing uploads | UID/fsGroup mismatch vs PVC ownership | align `runAsUser`/`fsGroup` with the storage class |

```bash
# RUN IN: anywhere
# What: open a shell in the worker pod to poke at the filesystem/tools
kubectl -n <NAMESPACE> exec -it deploy/bilbomd-worker -- bash
```

---

## 13. Rollback

```bash
# RUN IN: anywhere
# What: list release history (revisions)
helm -n <NAMESPACE> history bilbomd
```

```bash
# RUN IN: anywhere
# ⚠ Changes what's running. Rolls back to a previous good revision.
helm -n <NAMESPACE> rollback bilbomd <REVISION_NUMBER> --wait
```

MongoDB + the PVC persist across rollbacks — a rollback swaps images/config, it
does **not** wipe data. To undo just a bad image, you can also re-run
`helm upgrade` with the previous `<IMAGE_TAG>`.

---

## 14. Cleanup (⚠ destructive — read carefully)

```bash
# RUN IN: anywhere
# ⚠ DESTRUCTIVE: removes the whole release (Deployments/Services/etc).
# ⚠⚠ DATA LOSS: because the chart CREATES the 3 PVCs (persistence.create), they are
#    part of the release and `helm uninstall` DELETES them (and all job/DB data)
#    UNLESS the PVC templates carry `helm.sh/resource-policy: keep`. If they do not
#    yet, BACK UP first, or detach the PVCs before uninstalling:
#      kubectl -n <NAMESPACE> annotate pvc bilbomd-uploads mongodb-volume redis-volume \
#        helm.sh/resource-policy=keep --overwrite
helm -n <NAMESPACE> uninstall bilbomd
```

```bash
# RUN IN: anywhere
# ⚠ DESTRUCTIVE and IRREVERSIBLE: deletes stored data. Only if you truly mean it
#   (e.g. PVCs survived uninstall via the keep policy and you now want them gone).
kubectl -n <NAMESPACE> delete pvc bilbomd-uploads mongodb-volume redis-volume
```

---

## 15. Compact command checklist (copy during the meeting)

```bash
# 0. context
export KUBECONFIG=<KUBECONFIG_PATH>
kubectl config use-context <CONTEXT>
kubectl -n <NAMESPACE> get all

# 1. build + push (RUN IN repo dirs as noted in §4)
# worker = TWO steps (branch worker, THEN layer AutoMD-SAXS) — see §4.1:
podman build -f apps/worker/bilbomd-worker.dockerfile -t localhost/bilbomd-worker-branch:<IMAGE_TAG> .
podman build -f infra/automd-saxs/Dockerfile --build-arg BASE_IMAGE=localhost/bilbomd-worker-branch:<IMAGE_TAG> -t <DIAMOND_REGISTRY>/bilbomd-worker:<IMAGE_TAG> /home/kri42825/AutoMD-SAXS
podman build -f apps/backend/bilbomd-backend.dockerfile -t <DIAMOND_REGISTRY>/bilbomd-backend:<IMAGE_TAG> .
podman build -f apps/ui/bilbomd-ui.dockerfile -t <DIAMOND_REGISTRY>/bilbomd-ui:<IMAGE_TAG> .
podman login <DIAMOND_REGISTRY>
podman push <DIAMOND_REGISTRY>/bilbomd-worker:<IMAGE_TAG>
podman push <DIAMOND_REGISTRY>/bilbomd-backend:<IMAGE_TAG>
podman push <DIAMOND_REGISTRY>/bilbomd-ui:<IMAGE_TAG>

# 2. secrets (⚠ credentials). PVCs are created by the chart (persistence.create), not here.
kubectl -n <NAMESPACE> create secret generic mongo-secrets --from-literal=MONGO_INITDB_ROOT_PASSWORD='...'
kubectl -n <NAMESPACE> create secret generic bilbomd-secrets --from-literal=...   # see §6 / HELM_NOTES keys
kubectl -n <NAMESPACE> create secret docker-registry <PULL_SECRET_NAME> --docker-server=<DIAMOND_REGISTRY> --docker-username='...' --docker-password='...'

# 3. deploy (RUN IN infra/helm)
helm template bilbomd . -f values-diamond.yaml -n <NAMESPACE> | less
helm upgrade --install bilbomd . -f values-diamond.yaml -n <NAMESPACE> --dry-run
helm upgrade --install bilbomd . -f values-diamond.yaml -n <NAMESPACE> --wait --timeout 10m   # ⚠ real deploy

# 4. verify
kubectl -n <NAMESPACE> get pods,svc,ingress,pvc
kubectl -n <NAMESPACE> logs deploy/bilbomd-worker -f
kubectl -n <NAMESPACE> get events --sort-by=.lastTimestamp | tail -30

# 5. rollback if needed
helm -n <NAMESPACE> history bilbomd
helm -n <NAMESPACE> rollback bilbomd <REVISION_NUMBER> --wait   # ⚠
```
