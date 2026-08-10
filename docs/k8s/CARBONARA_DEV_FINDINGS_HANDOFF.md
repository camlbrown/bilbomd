# Handoff ← Carbonara-dev chat: findings on the k8s Carbonara discrepancies

This is the reply to `CARBONARA_DEV_HANDOFF.md`. Investigation only — **no code was written or
changed** on any branch. All findings are from reading the code on
`integration/k8s-carbonara-automdsaxs` + the Carbonara library, and from inspecting **real
result artifacts** on disk. Where I say "verified" I mean I checked the actual output files,
not just the code.

---

## TL;DR

1. **§6 (the mixture χ² concern) is a REAL, pre-existing bug — not k8s-specific, not a
   display glitch.** A "100%-single-species" MultiFoXS ensemble χ² is **not** comparable to
   the "single-structure FoXS" χ² shown on the Classic tab, for **two compounding reasons**:
   - **(a) q-range mismatch (dominant for talin).** The single-structure FoXS is run with
     `--max-q 0.2`; **MultiFoXS is run with NO max-q**, so it fits the *entire experimental
     q-range*. **Talin data goes to q=0.309 with 831 points above 0.2** → MultiFoXS fits ~57%
     more (and noisier, high-q) points → much larger χ². This is the big part of 45 vs 27.
   - **(b) Two different FoXS engines (always present).** The single-structure number comes
     from **pyFoXS** (during backmap); the mixture number comes from **IMP `multi_foxs`**.
     They fit c1/c2 (hydration) independently and normalize slightly differently, so even at
     an *identical* q-range they disagree by ~20% (verified below).
   The two numbers were never designed to be equal; the UI just puts them side by side.

2. **§5 (autoflex picked more regions on k8s) is most likely run-to-run nondeterminism, not a
   k8s effect** — *if* the smarcal run used the heuristic (no-PAE) autoflex path, which is
   **nondeterministic by design** (it seeds a C++ structure generator from OS entropy). The
   PAE-guided path *is* deterministic. So this needs a controlled A/B, not a k8s witch-hunt.

3. **§4 (CPU bump 4→12 changing the science) is essentially ruled out.** Each fit seeds its
   RNG from `std::random_device` (OS entropy) independently — **not** from wall-clock or PID.
   Running 12 vs 4 in parallel does not correlate seeds. The fits were **already
   non-reproducible run-to-run** before the bump; the bump only makes them finish faster.

4. **§7 is a genuine risk you can't currently rule out:** the Carbonara library
   (`/home/kri42825/carbonara-pseudoWaxsis`) **has no `.git`** — it's an unversioned source
   tree. The demo image and the k8s image can be baked from *different* states of it with **no
   way to verify which**. Pin this before trusting any podman-vs-k8s comparison.

---

## §6 — The mixture χ² anomaly (PRIMARY finding)

**Your observation (talin, mixture n=4 same structure, 10 fits):** best mixture ensemble = 1
species (`mol1_sub_0_end`), MultiFoXS χ² ≈ **45**; the Classic tab's best single-structure
FoXS χ² for that same model = **27.47**. You expected these to be equal. They aren't, for two
reasons that **compound**:

### Cause (a): MultiFoXS is not clamped to `max_q` — VERIFIED it matters for talin

- Single-structure FoXS (per model, during backmap) **is** passed the job's q cap:
  `carbonara-functions.ts` `buildBackmapLoopCommand()` appends `--max-q '${maxQ}'`
  (`maxQ: foundJob.max_q`, set in `bilbomd-carbonara.ts`). So it fits **q ≤ 0.2**.
- MultiFoXS **is not**: `buildMultiFoxsContainerArgs()` builds
  `multi_foxs -s <N> <saxs.dat> <pdbs...>` with **no q argument**, so IMP `multi_foxs` uses
  the **experimental profile's full q-range**.
- **Verified on real data:**
  - `talin.dat` (`carbonara-pseudoWaxsis/saxsFiles/talin.dat`): **q_max = 0.309, 2300 points,
    831 of them above q=0.2.** → MultiFoXS fits to 0.309; single FoXS clamps to 0.2. Fitting
    831 extra, noisy high-q points inflates the MultiFoXS χ². **This is the dominant driver of
    45 vs 27 for talin.**
  - Counter-check on a calmodulin mixture whose data only reaches q≈0.1999: the MultiFoXS
    `.fit` and the single-FoXS `.fit` had **identical** q-ranges (0.00663–0.19991, 249 pts) —
    i.e. when the data doesn't exceed `max_q`, effect (a) vanishes. So this bug **only bites
    when the experimental data extends beyond the configured `max_q`** (talin does; calmodulin
    didn't). That's why it hadn't shown up in earlier calmodulin mixture testing.

### Cause (b): pyFoXS vs IMP multi_foxs — VERIFIED even at identical q-range

Using the calmodulin mixture (where q-ranges match exactly), for the **same** structure
`mol1_sub_0_end`:
- **MultiFoXS** `multi_state_model_1_1_1.fit`: `scaling c = 3.50e-08`, **Chi^2 = 10.03**,
  c1/c2 = `(1.05, -0.50)`.
- **Single-structure pyFoXS** `mol1_sub_0_end_AA_foxs.log`/`foxs_results.txt`:
  `scaling c = 3.99e-08`, **Chi^2 = 8.19** (this is the value that lands in the predictions
  table / "best single structure").

Same structure, same data, same q-range → **10.03 vs 8.19 (~22% higher for MultiFoXS)**,
purely because the two FoXS implementations fit c1/c2 and scale differently. This residual
gap is *always* present and is additive on top of cause (a).

### Putting it together for talin

27.47 (pyFoXS @ q≤0.2) → apply the ~20% engine offset → ~33; then add the high-q points out
to 0.309 → ~45. The two effects together comfortably explain the number. **Nothing is
"wrong" with the structure or the weights** — the 1-species composition shown *does* match the
reported χ² (the results/selection plumbing is correct; verified in `carbonara_results.py` and
the worker mixture block). The problem is that **two non-comparable χ² numbers are presented
as if they should agree.**

### Secondary consequence worth flagging

Because MultiFoXS scores at the *full* q-range while the models were fit/optimized toward
q≤0.2, MultiFoXS may **also mis-rank ensembles** — e.g. decide "1 species is best" when, judged
on the same q≤0.2 window as everything else, a 2+ species ensemble would win. So the q-range
mismatch can affect not just the *number* but the *selection* of the "best mixture."

### Fix direction (for the k8s/dev chat to implement — NOT done here)

- Pass a q cap to `multi_foxs` so it scores on the **same q-window** as the per-model FoXS
  (i.e. thread `maxQ: foundJob.max_q` into `buildMultiFoxsContainerArgs` and add the multi_foxs
  q flag). Check `multi_foxs --help` in the baked image for the exact flag name (`-q` / `--q_max`
  vary by IMP version).
- Longer term, decide whether the "single-structure χ²" and the "mixture χ²" should come from
  the **same engine** so they're directly comparable, or clearly label them as
  "pyFoXS (single)" vs "MultiFoXS (ensemble)" in the UI so users don't expect equality.
- Note the existing `carbonara_results.py` **fallback** path (`mixture_assessment(...)`) *does*
  pass `args.max_q` — only the primary IMP `multi_foxs` path omits it. So the two mixture code
  paths are themselves inconsistent.

---

## §5 — Autoflex selecting MORE flexible regions on k8s

- **PAE-guided path (`--alphaFoldFlex` / `getFlexibility` → `getFlexibleSections`) is
  deterministic**: pure PAE-threshold math + fixed smoothing, no RNG. Same PAE + same settings
  → byte-identical regions on any machine.
- **Heuristic path (no PAE, the default) is NOT deterministic**: `auto_select_varying_linker`
  → `find_non_varying_linkers` invokes the C++ `generate_structure` binary, which seeds from
  `std::random_device` (OS entropy) with **no fixed seed**. It generates random perturbed
  structures to decide which linkers can flex without breaking β-sheets. Different random
  structures → different "allowed" linker set → **different autoflex output run-to-run**, on the
  *same* machine.
- **Therefore:** "more regions on k8s vs podman" is **not evidence of a k8s bug by itself** — the
  heuristic path would give you different selections on two consecutive *local* runs too.
  Before attributing anything to k8s, run the **controlled test**: same input, heuristic path,
  **twice locally** and **twice on k8s**; if local↔local already differs, it's just nondeterminism.
- **If the smarcal run used PAE**, then a difference *would* be meaningful → suspect a **path
  issue**: is the `--pae` file actually being found on k8s (real absolute paths, non-root UID,
  `HOME=/tmp`)? If PAE is silently missing on one side, that side falls back to the
  nondeterministic heuristic path → looks like "more regions." Confirm the PAE file is present
  and passed on both.

---

## §4 — Fits, parallelism, and the CPU 4→12 bump

- Per-fit RNG: `RandomGenerator` (`helpers.h`/`helpers.cpp`) seeds `std::default_random_engine`
  from `std::random_device` in its constructor; one instance per fit process
  (`mainPredictionFinalQvar.cpp`). **No `srand(time())`, no `getpid()`, no shared seed.**
- **Implication:** each fit already gets an independent, high-quality seed regardless of how
  many fits run at once. **Concurrency count does not change per-fit science.** (The original
  handoff's worry that "seed derives from wall-clock/PID" — checked and **false** here.)
- The fits were **already non-reproducible run-to-run** (that's inherent to random_device
  seeding), so the *set* of final models differs every submission, 4-wide or 12-wide. Don't
  chase the CPU bump as a cause of scientific differences; chase the fact that Carbonara fits
  are stochastic and un-seeded.
- No cross-fit shared-state hazard found: outputs are keyed by loop index (`mol$i`,
  `fitLog$i.dat`), inputs are read-only. Running 12 in parallel is safe.

---

## §7 — Which Carbonara build is baked? (do this first)

- `/home/kri42825/carbonara-pseudoWaxsis` **is not a git repo** (no `.git`). There is **no
  commit to pin**. So "the demo image vs the k8s image were built from the same engine" is
  currently **unverifiable**.
- This matters most for §5: if the two images baked *different* engine source (different
  `setup_carbonara.py` / `CarbonaraDataTools.py` / C++), autoflex and setup behaviour can
  legitimately differ between demo and k8s for reasons unrelated to the runtime environment.
- **Recommended:** snapshot/pin the library (git-init it, or record a checksum/manifest of
  `setup_carbonara.py`, `CarbonaraDataTools.py`, and `build/bin/*`) and diff what's inside the
  **demo image** vs the **k8s image** (`sha256sum` those files inside each). If they differ,
  that's a more likely §5 root cause than the environment.

---

## What I could NOT check locally

- The **actual talin k8s result files** (they live on the cluster PVC). All talin-specific
  numbers above are the *mechanism* verified via code + a local calmodulin mixture + the real
  `talin.dat` q-range. To close the loop, pull the talin job's
  `results/multifoxs_mixture/*.fit` and `results/all_atom/mol1_sub_0_end/foxs_results.txt` off
  the PVC and confirm: the multi_foxs `.fit` header q_max ≈ 0.309 while the single-structure
  foxs q_max ≈ 0.2. That's the direct confirmation of cause (a).

---

## §8 — Can we replace pyFoXS with the SAME FoXS that MultiFoXS uses? (follow-up, VERIFIED)

**Short answer: YES, and the binary is already in the deployed image — no new install, no
image bloat.** This is the clean fix and it also fixes cause (a) at the same time. Matching
c1/c2 is *not* the right lever (see below).

### The two engines today

- **Single-structure χ² = `pyfoxs`** — the *standalone pyFoXS reimplementation*, cloned into
  the carbonara micromamba env (`Dockerfile.carbonara-allatom-runtime` "clones pyFoXS";
  `bilbomd-worker-carbonara.dockerfile` builds the carbonara envs on top of the worker base).
  Invoked inline in the backmap loop via `backmap_cli.py --foxs-py 'pyfoxs' --max-q <q>`
  (`carbonara-functions.ts buildBackmapLoopCommand`), and also for the setup-time preview
  (`carbonara_initfoxs.py`, `cmd = ['pyfoxs', pdb, saxs]`). Config: `CARBONARA_FOXS_CMD=pyfoxs`.
- **Mixture χ² = IMP `/usr/bin/multi_foxs`** — from the BilboMD worker image
  (`CARBONARA_MULTIFOXS_BIN=/usr/bin/multi_foxs`).

These are **two different codebases**. That's cause (b) in §6.

### The key fact I verified

IMP ships a standalone **`foxs`** CLI built from the *identical* source as `multi_foxs` —
same form factors, same c1/c2 grid fit, same χ² definition. In the local worker image
(`localhost/bilbomd-worker:diamond`, == the base the carbonara image is layered on):

```
/usr/bin/foxs        (IMP 2.24.0)   <-- same version / same build date (Jan 29 2026)
/usr/bin/multi_foxs  (IMP 2.24.0)
```

`foxs --help` confirms it takes exactly the knobs we need:
`-q/--max_q`, `-s/--profile_size`, `--min_c1/--max_c1/--min_c2/--max_c2`, `-r` (CA-only).

Because the k8s carbonara image is built **ON TOP OF** the worker base (it already calls
`/usr/bin/multi_foxs` from there), **`/usr/bin/foxs` is already present in the deployed image.**
Switching single-structure scoring to it costs **zero extra image size** and needs **no new
dependency**.

### What this fixes

Score single structures with `/usr/bin/foxs <model.pdb> <saxs.dat> -q <max_q>` instead of
`pyfoxs`, and the single-structure χ² and the mixture χ² become **directly comparable**:
- **Cause (b) vanishes** — both numbers come from the same IMP engine / same c1/c2 fit.
- **Cause (a) also vanishes** *if* you pass the same `-q <max_q>` to both `foxs` and
  `multi_foxs` (IMP `foxs` honours `-q`; you'd also add the q flag to the `multi_foxs`
  invocation as noted in §6). Then a 100%-single-species mixture χ² ≈ the single-structure χ²,
  which is what the user expected.

### Why "just match c1/c2" is NOT the fix

- pyFoXS and IMP foxs are **different implementations** (different atomic form-factor tables,
  different excluded-volume/water-layer model, different χ² normalization). Forcing identical
  c1/c2 removes the *dominant* free-parameter difference but **does not guarantee equal χ²** —
  the model curve and the χ² sum are still computed by different code, so a residual gap
  remains and is data-dependent (unpredictable).
- It's also **unnecessary**: the same-engine binary is already sitting in the image, so you get
  exact comparability for free. Matching c1/c2 would be strictly worse (more fragile, still
  approximate). Use it only as a diagnostic, not as the production fix.

### Effort / caveats for whoever implements it (NOT done here)

1. **Not a pure `CARBONARA_FOXS_CMD` swap.** pyFoXS and IMP `foxs` have **different CLIs and
   output formats**. pyFoXS: positional `<pdb> <saxs>`, `--max_q`, prints c1/c2 to stdout,
   writes its own `.fit`. IMP foxs: `foxs <pdb> <profile> -q <maxq>`, writes
   `<pdb>_<profile>.fit` + `.dat`, prints `Chi^2`/c1/c2 to stdout. So `backmap_cli.py`'s FoXS
   wrapper (or its replacement) must speak IMP's format. **Good news:** `carbonara_results.py`
   already parses IMP `multi_foxs` `.fit` output, so the parser to borrow already exists in-tree.
2. **PATH:** `/usr/bin/foxs` is a *system* binary, not in the carbonara micromamba env that the
   backmap loop activates. Call it by **absolute path** (exactly how `/usr/bin/multi_foxs` is
   already called), don't rely on it being on the env `PATH`.
3. **Cleanest architecture:** fold single-structure IMP-`foxs` scoring into the **same
   worker-image step that already runs `multi_foxs`** (same image, same q cap, same engine),
   rather than keeping it inline in the carbonara conda env. Then "best single structure" and
   "mixture" are apples-to-apples *by construction*.
4. **Preview consistency:** the setup-time preview (`carbonara_initfoxs.py`, the "initial FoXS
   chi2 ~26" the user saw) also uses pyFoXS. For end-to-end consistency it should move to IMP
   `foxs` too, otherwise the setup preview number will still differ from the final numbers.
5. **Podman demo path:** the *separate* `carbonara-allatom-runtime:dev` demo image is also
   worker-base-derived, so `/usr/bin/foxs` is there as well — but confirm per image before
   assuming. (On k8s inprocess it's guaranteed by construction.)

**Bottom line:** replace pyFoXS single-structure scoring with IMP `/usr/bin/foxs` (already in
the image, IMP 2.24.0, same engine as `multi_foxs`) and pass `-q max_q` to both. That makes the
single-structure and mixture χ² consistent. Don't pursue c1/c2-matching as the fix.

---

## §9 — Concrete directions the user wants captured (for the k8s/dev chat)

These are agreed follow-up directions. **Not implemented here** — investigation/handoff only.

### 9.1 Make single-structure χ² use IMP `foxs` (the §8 fix, stated as a direction)

Replace the pyFoXS single-structure scoring with IMP **`/usr/bin/foxs`** (already in the image,
IMP 2.24.0, the same engine as `multi_foxs`) and pass `-q <max_q>` to **both** `foxs` and
`multi_foxs`. This is the intended fix for the §6 discrepancy: same engine + same q-window →
single-structure χ² and mixture χ² are directly comparable, and a 100%-single-species mixture
χ² ≈ the single-structure χ². See §8 for the full feasibility, CLI/output-format caveats, and
the "fold single-structure scoring into the same worker-image step as multi_foxs" architecture
recommendation. Do **not** pursue c1/c2-matching as the production fix.

### 9.2 Initial FoXS preview at setup should fit to q_max = 0.2

When the user uploads their PDB + SAXS data in the setup UI, the initial FoXS fit (the
"initial chi2 ~26" preview, produced by `carbonara_initfoxs.py` → `carbonaraPreviewHandler`)
should be run **clamped to q ≤ 0.2** (`--max_q 0.2`), i.e. the same q-window the per-model
backmap FoXS uses. Today the preview passes `--max_q` only when a value is supplied
(`buildInitFoxsContainerArgs` pushes `--max_q` only `if (opts.maxQ != null)`; `carbonara_initfoxs.py`
applies the cap only when given). Default that preview to **0.2** so the setup-time number is
consistent with the rest of the pipeline (and, once 9.1 lands, computed by the same IMP engine).
This keeps the number the user sees at upload directly comparable to the final single-structure
and mixture χ² instead of being a differently-scoped pyFoXS value.

### 9.3 Convergence plot: per-fit visibility toggles

The Carbonara χ²-convergence plot (which currently overlays all N fits) should gain a control
to **toggle which individual fits are shown** — e.g. select "fit 1" only, or any subset. This
is a UI/plot feature (legend-click-to-toggle or a checkbox/multi-select per fit series), letting
the user isolate a single fit's convergence trace from the others. Purely a frontend
enhancement in the convergence-plot component; no worker/engine change required. (Natural home:
the results convergence-plot component that renders the `fitLog*.dat` series.)

---

## One-line answers to the questions in the original handoff

- **§6 "should the multifoxs and single-structure χ² be the same?"** In principle yes for a
  100%-single-species ensemble — but they aren't here because (a) MultiFoXS isn't q-clamped to
  `max_q` (talin data extends to 0.309) and (b) it's a different FoXS engine (IMP vs pyFoXS)
  with its own c1/c2. Both verified. Real bug; fix by q-clamping MultiFoXS and/or unifying the
  engine, and label the two numbers clearly meanwhile.
- **§5 autoflex:** most likely heuristic-path nondeterminism (OS-entropy-seeded C++), not k8s.
  Verify with a local A/B; check PAE-file presence on k8s; and pin the engine build (§7).
- **§4 CPU bump:** not a science factor — fits are independently random_device-seeded.
