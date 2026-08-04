# Git Integration Procedure — creating the k8s deployment branch

**Do NOT run any of this until you have read it and approved.** These are the
exact, reversible steps to converge the two feature branches into a single, clean
deployment branch and to finalise the AutoMD-SAXS package version, written for
someone not deeply familiar with Git. Every risky step has an "**Undo**".

Nothing here pushes to a remote until the final, explicitly-approved step.

---

## Background (why this is safe and small)

Confirmed by the audit:

- `feature/automd-saxs-worker` already **contains all Carbonara history** up to the
  6-week-ago split point, **plus** the AutoMD-SAXS worker, **plus** the Carbonara
  k8s de-nesting switch that `feature/carbonara-worker` does **not** have.
- The **only** Carbonara change missing from it is **one commit**, `914769d3`
  ("handle mmCIF inputs in setup sanitiser and analysis overlay"), touching 2
  Carbonara-only files that AutoMD-SAXS never touches → expected clean cherry-pick.

So we **base the integration branch on the AutoMD-SAXS branch** and cherry-pick that
one commit. We do **not** merge the Carbonara branch wholesale (that would *remove*
the de-nesting work).

There are two repos to finalise:

- **A. bilbomd** (`/home/kri42825/bilbomd-automd-saxs` worktree) — commit pending
  fixes, create integration branch, cherry-pick the Carbonara commit.
- **B. AutoMD-SAXS** (`/home/kri42825/AutoMD-SAXS`) — commit pending Python fixes,
  tag a version (the worker image is built from this).

---

## Key terms (30-second primer)

- **branch** — a movable name for a line of commits.
- **commit** — a saved snapshot of changes.
- **tag** — an immovable name for one commit (good for "the exact code an image was
  built from").
- **cherry-pick** — copy one commit from another branch onto this one.
- **worktree** — a second working folder for the same repo, on a different branch.
  `/home/kri42825/bilbomd` and `/home/kri42825/bilbomd-automd-saxs` are two
  worktrees of one repo.

---

## Pre-flight: see exactly where you are (read-only, safe to run now)

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
git status                       # which files are modified?
git branch --show-current        # expect: feature/automd-saxs-worker
git log --oneline -1             # expect: fe34372c ...
git remote -v                    # origin=camlbrown/bilbomd ; upstream push=DISABLED
git worktree list                # shows both worktrees + their branches
```

```bash
# RUN IN: /home/kri42825/AutoMD-SAXS
git status                       # expect 3 modified .py + some untracked
git branch --show-current        # expect: AutoMD-SAXS-OpenMM
git log --oneline -1             # expect: 4d4decc ...
```

---

## Part A — bilbomd repo

### A1. Safety net: fetch + make a backup tag (non-destructive)

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: update remote-tracking info (does NOT change your files)
git fetch origin
```

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: an immovable bookmark of the current commit, so you can always return here
git tag backup/pre-k8s-automd-saxs-worker fe34372c
```

> **Undo:** `git tag -d backup/pre-k8s-automd-saxs-worker` (only removes the label).

### A2. Review the pending changes before committing

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: list modified files and read the diff
git status --short
git diff
```

You should see 9 modified files. **8 are legitimate fixes to keep**; **1 is
`apps/ui/vite.config.ts`** — a local-only dev-proxy port change (`3501→3500`) that
must **not** be committed (it would break other developers).

### A3. Commit the 8 legitimate fixes (leaving `vite.config.ts` untouched/local)

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: stage ONLY the 8 real fixes (note: vite.config.ts is deliberately omitted)
git add \
  apps/backend/src/controllers/jobs/automdSaxsJobController.ts \
  apps/backend/src/controllers/jobs/automdSaxsPrepController.ts \
  apps/worker/src/workerHandlers/automdSaxsPrepHandler.ts \
  apps/ui/src/features/automdsaxsjob/AutoMDSAXSResults.tsx \
  apps/ui/src/features/automdsaxsjob/AutoMDSAXSReviewPage.tsx \
  apps/ui/src/features/automdsaxsjob/AutoMDSAXSStructureViewer.tsx \
  apps/ui/src/features/automdsaxsjob/AutoMDSAXSTrajectoryViewer.tsx \
  apps/ui/src/features/automdsaxsjob/NewAutoMDSaxsJobForm.tsx
```

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: confirm vite.config.ts is NOT staged (it should still show as "modified", unstaged)
git status --short
```

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: commit the staged fixes
git commit -m "automd-saxs: SAXS dat_file in Run MD, per-ion toggles, viewer fixes, code-review hardening

- Review page now sends the SAXS .dat on Run MD (was dropped in the two-step flow).
- Per-bound-ion-species keep toggles; path.basename hardening on uploads.
- Molstar viewer unmount guards + trajectory repeat-sync; null-safety in results."
```

> **Undo (keep the file edits, drop the commit):**
> `git reset --soft HEAD~1`
> **Undo (throw the commit away entirely):** `git reset --hard backup/pre-k8s-automd-saxs-worker`
> (this is safe *because* of the backup tag; it discards the just-made commit).

### A4. Create the integration branch from here

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: create + switch to the new branch (carries no uncommitted changes except
#       the still-local vite.config.ts, which stays modified-unstaged — fine)
git switch -c integration/k8s-carbonara-automdsaxs
git branch --show-current        # expect: integration/k8s-carbonara-automdsaxs
```

> **Undo:** switch back and delete the new branch:
> `git switch feature/automd-saxs-worker && git branch -D integration/k8s-carbonara-automdsaxs`

### A5. Compare the two Carbonara implementations (read-only)

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: confirm the ONLY missing Carbonara commit is 914769d3
git log --oneline integration/k8s-carbonara-automdsaxs..feature/carbonara-worker
```
Expected: a single line, `914769d3 fix(carbonara): handle mmCIF inputs ...`.

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: see exactly what that commit changes (2 carbonara-only files)
git show --stat 914769d3
```

### A6. Cherry-pick the one missing Carbonara commit

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: copy that single commit onto the integration branch
git cherry-pick 914769d3
```

- **If it succeeds** (expected): you'll get a new commit. Move on.
- **If it reports a conflict** (not expected — no file overlap): Git pauses and marks
  conflicted files. To **abort and return to a clean state**:

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: cancel the cherry-pick, undo its partial changes
git cherry-pick --abort
```
  Then stop and review with fresh eyes before retrying — do not force it.

### A7. Review the result

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: the integration branch should now be automd-saxs-worker + the 8 fixes + 914769d3
git log --oneline -5
git status
```

### A8. Build + test before trusting it (no deploy)

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# What: typecheck/build the touched apps (use the project's Node/pnpm)
pnpm -F @bilbomd/backend build
pnpm -F @bilbomd/worker build
pnpm -F @bilbomd/ui build
# and the relevant tests if quick:
pnpm -F @bilbomd/worker test
```

> If a build fails, fix on this branch and commit; do not proceed to push.

### A9. Push — ONLY after explicit approval

```bash
# RUN IN: /home/kri42825/bilbomd-automd-saxs
# ⚠ Publishes the branch to your fork. Do NOT run until approved.
git push -u origin integration/k8s-carbonara-automdsaxs
```

> This pushes to **origin (`camlbrown/bilbomd`, your fork)** only. It never touches
> `upstream` (push is DISABLED). `feature/automd-saxs-worker` and
> `feature/carbonara-worker` are left intact as history.

---

## Part B — AutoMD-SAXS repo (finalise the package the worker image bakes in)

The worker image is built from this repo, so its exact commit must be pinned.

### B1. Safety tag + review

```bash
# RUN IN: /home/kri42825/AutoMD-SAXS
git fetch origin
git tag backup/pre-k8s-automd-saxs-openmm 4d4decc     # bookmark current state
git status --short                                     # 3 modified .py + untracked
git diff automd_saxs/openmm/ligand.py automd_saxs/openmm/prepare.py automd_saxs/openmm/workflow.py
```

> The untracked items (`examples/…`, a stray spec `.md`) should stay untracked — do
> not add them.

### B2. Commit the Python fixes

```bash
# RUN IN: /home/kri42825/AutoMD-SAXS
git add automd_saxs/openmm/ligand.py automd_saxs/openmm/prepare.py automd_saxs/openmm/workflow.py
git commit -m "openmm: MultiFoXS unique-frame mapping + code-review fixes

- MultiFoXS members mapped via globally-unique frame filenames (no cross-repeat
  basename collision).
- classify_residues uses a context-managed file; write_ligand_sdf cleans its temp;
  prepare raises clearly on protein-free input."
```

> **Undo commit (keep edits):** `git reset --soft HEAD~1`
> **Undo entirely:** `git reset --hard backup/pre-k8s-automd-saxs-openmm`

### B3. Tag a version (this is what the worker image pins to)

```bash
# RUN IN: /home/kri42825/AutoMD-SAXS
# What: an immovable version label for reproducible image builds
git tag v0.1.1
```

### B4. Push — ONLY after explicit approval

```bash
# RUN IN: /home/kri42825/AutoMD-SAXS
# ⚠ Publishes commit + tag to your fork. Do NOT run until approved.
git push origin AutoMD-SAXS-OpenMM
git push origin v0.1.1
```

---

## Emergency recovery (if anything feels wrong at any point)

- **Return the bilbomd worktree to the exact pre-procedure state:**
  ```bash
  # RUN IN: /home/kri42825/bilbomd-automd-saxs
  git switch feature/automd-saxs-worker
  git reset --hard backup/pre-k8s-automd-saxs-worker    # ⚠ discards later commits on THIS branch
  git branch -D integration/k8s-carbonara-automdsaxs    # remove the integration branch
  ```
  (Your local `vite.config.ts` edit, being unstaged, is untouched by branch
  switches; if it ever gets in the way, `git stash` it.)

- **Return the AutoMD-SAXS repo:**
  ```bash
  # RUN IN: /home/kri42825/AutoMD-SAXS
  git reset --hard backup/pre-k8s-automd-saxs-openmm
  git tag -d v0.1.1
  ```

- Because **nothing is pushed until the final approved steps**, any mistake before
  that is entirely local and reversible with the backup tags above.

---

## What this procedure deliberately does NOT do

- Does **not** merge `feature/carbonara-worker` wholesale (that would remove the k8s
  de-nesting switch).
- Does **not** delete or rewrite the two existing feature branches (kept as history).
- Does **not** commit `apps/ui/vite.config.ts` (local-only).
- Does **not** push anything, or touch `upstream`, until you explicitly approve.
- Does **not** finish the 2 remaining Carbonara preview/autoflex `inprocess`
  wirings — that is a separate, small code change (tracked as P1 in the audit), not
  part of this branch-hygiene step.
