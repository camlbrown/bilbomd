# BilboMD (Carbonara + AutoMD-SAXS) — Docker deploy kit

Run the full BilboMD web app + the Carbonara/AutoMD-SAXS worker on a **single
Linux host with Docker** — no Kubernetes. This kit is for a colleague who
receives the container images as a file transfer (e.g. OneDrive) because they
cannot pull from our private registry.

**This profile runs Carbonara (CPU-only).** AutoMD-SAXS needs a GPU + the NVIDIA
Container Toolkit — see the last section to switch it on.

---

## 0. What you received

A single file: **`bilbomd-docker-deploy.tar`**. Extract it and `cd` in:
```bash
tar -xf bilbomd-docker-deploy.tar
cd bilbomd-docker-deploy
```
Inside you'll find this README, the compose file, the scripts, and an `images/`
folder containing **all five** container images (worker, backend, ui, mongo,
redis) as `.tar.gz`. **Everything is bundled — you do NOT need internet access
to pull anything.**

## 1. Prerequisites (on the host)

- **Docker Engine** and **Docker Compose v2**. Check:
  ```bash
  docker --version
  docker compose version      # must work (v2). 'docker-compose' v1 also tolerated.
  ```
- `openssl`, `curl`, `gzip` (standard on most Linux).
- Disk: the worker image is ~23 GB once loaded, plus space for job data.
- No GPU needed for Carbonara.

## 2. Load the images

```bash
./load-images.sh            # loads ALL of images/*.tar.gz and normalises names
```
You should end up with `bilbomd-worker:carbonara`, `bilbomd-backend:carbonara`,
`bilbomd-ui:carbonara`, `mongo:8.3.2` and `redis:8.8.0` in `docker images`.

## 3. Configure

```bash
./setup-env.sh              # creates .env with freshly generated secrets
```
Then open `.env` and check:
- `BILBOMD_UI_PORT` (default `8080`) — the port you'll browse.
- `BILBOMD_URL` / `CORS_ALLOWED_ORIGINS` — leave as `http://localhost:8080` for
  local testing. If you'll reach it from another machine, set both to the URL
  you actually use (e.g. `http://<host>:8080`), or logins/CORS will be rejected.

## 4. Launch

```bash
./launch.sh
```
This starts all five containers, waits for them to be healthy, mints a one-time
login code, and opens your browser at `http://localhost:8080/auth/<code>`
(logged straight in — email is disabled, so this is how you sign in).

Re-run `./launch.sh --no-up` any time to get a fresh login link without
restarting the stack. Codes last 1 hour.

## 5. Run a test Carbonara job

In the UI: pick **Carbonara**, upload a structure (PDB/mmCIF) + a SAXS `.dat`,
choose settings (start with a small `fit_n_times`, e.g. 4–8), submit. The live
convergence plot updates as the fits run; results (χ² fit, optional all-atom
reconstruction, mixture weighting) appear when it finishes.

> **Memory note:** Carbonara launches ALL fits at once, so RAM scales with the
> fit count, not CPUs. If a big-fit job gets killed and restarts from step 0,
> the worker hit its memory limit — raise `worker.deploy.resources.limits.memory`
> in `docker-compose.yml` (and/or use fewer fits) and `docker compose up -d`.

## 6. Everyday commands

```bash
docker compose ps                 # status/health
docker compose logs -f worker     # follow worker logs
docker compose logs -f backend
docker compose restart worker
docker compose down               # stop (keeps data)
docker compose down -v            # stop + WIPE database/uploads volumes
```

## 7. Troubleshooting

- **UI loads but "error loading configuration data"** — backend not up yet;
  `docker compose logs backend`. Usually a missing/megatyped `.env` value.
- **Login says expired / no server response** — `BILBOMD_URL`/`CORS_ALLOWED_ORIGINS`
  don't match the URL in your browser. Fix them in `.env`, `docker compose up -d`.
- **Worker unhealthy** — `docker compose logs worker`. A permissions error on
  `/tmp` means the `tmpfs: /tmp` line is missing; on `/bilbomd/uploads` means the
  `user: "0:0"` line was removed.
- **Job dies and restarts at step 0** — out-of-memory; see the memory note above.

## Enabling AutoMD-SAXS (GPU) — later

AutoMD-SAXS runs MD on the GPU. To turn it on:
1. Install the **NVIDIA Container Toolkit** on the host and verify:
   ```bash
   docker run --rm --gpus all nvidia/cuda:12.9.1-base-ubuntu22.04 nvidia-smi
   ```
2. Add a GPU reservation to the `worker` service in `docker-compose.yml`:
   ```yaml
       deploy:
         resources:
           reservations:
             devices:
               - driver: nvidia
                 count: 1
                 capabilities: [gpu]
   ```
3. `docker compose up -d worker`. The same image already contains the
   AutoMD-SAXS toolchain; no new download.
