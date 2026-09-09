# Carbonara upstream re-base — Phase 0 findings

Investigation of the new Carbonara upstream
(`https://github.com/Prior-Lab-Durham-University/carbonara`, pinned at **`614d099`**)
against our baked source (baseline commit `eeb2226` in `~/carbonara-pseudoWaxsis`,
= what's in worker image `chi2fix-20260810`). Read-only investigation; **no app code
changed.** For review before Phase 1.

---

## 1. What changed (high level)

- **C++ engine (feature A):** substantial edits across 7 files — `experimentalData`,
  `helpers`, `ktlMoleculeRandom`, `mainPredictionFinalQvar`, `moleculeFitAndState`
  (`.cpp/.h`). The "object-copy virtual-memory" optimisation. No public API change.
  ⚠️ Upstream also ships `src/*.stage2..6.bak` (the dev's incremental refactor backups) —
  **must NOT be baked into our image.**
- **Python setup consolidated into a new all-in-one:** `setup_carbonara_allAtom.py`
  (**49 args**) now performs setup **plus** all of features D/E/F/G. The plain
  `setup_carbonara.py` (which *our* wrapper currently calls) gained only the richer
  mixture controls. New file `setup_carbonara_update.py` also exists.
- **`CarbonaraDataTools.py`:** many new functions (disulfides, pdbfixer, guinier, linker
  splitting). ⚠️ It has **duplicate `def`s** (e.g. `auto_select_varying_linker`,
  `find_non_varying_linkers`, `get_secondary`, `find_missing_residues` defined twice) —
  Python uses the **last** definition; the newer ones carry the new behaviour.
- **Notebooks:** `runCarbonara`, `runCarbonaraMultimer`, `runCarbonaraUserflex` changed;
  new `runCarbonaraMultimerMultiStructure.ipynb`; `runCarbonaraBreakLink.ipynb` (in
  `~/Downloads`). These are *reference* for how the features are meant to be invoked.
- New helpers: `watch_and_backmap.py`, `install_cg2all_local.sh`,
  `backmapping_funcs_with_cg2all_v2.py`.

## 2. Feature → where it lives → default → impact

All of D/E/F/G are exposed as **flags on `setup_carbonara_allAtom.py`** and implemented
either there or in `CarbonaraDataTools.py`. **All four default ON** in that script.

| Feat | Flags (setup_carbonara_allAtom.py) | Default | Implementation | Our impact |
|---|---|---|---|---|
| **B** Mixtures (n distinct fingerprints) | `--mixture_n --max_mixture_combos(30) --mixture_step(0.1) --mixture_dirichlet_alpha(1.0) --mixture_snap(0.05)` | — | `write_mixture_file` + setup | **Revisit our workaround** (`merge_mixture_structures`, `apply_merges`) — engine may now make the *n* fingerprints natively. Highest-risk. |
| **D** Guinier low-q trim | `--guinier_trim/--no_guinier_trim` + 7 tuning flags | **ON** | `guinier_trim_saxs_file_inplace` (+ `_guinier_fit_for_window`, `_select_internal_guinier_interval`, `_write_guinier_trim_report`) | **Rewrites `Saxs.dat` in place** (backs up `Saxs.dat.pre_guinier_trim`). Self-contained (no ATSAS). Downstream reads the trimmed file → our IMP-FoXS single + mixture scoring **and the setup preview** must use the *same trimmed* SAXS for consistency. UI: expose an optional low-q cutoff. |
| **E** Disulfide-safe linkers | `--no_disulfide_linker_check`, `--disulfide_constraints_file` | check **ON** | `find_disulfide_bonds_from_pdb`, `disulfide_safe_linkers`, `set_disulfide_constraints_for_run`; `auto_select_varying_linker(…, pdb_path=…)` | Backward-compatible: passing `pdb_path` enables disulfide-aware filtering (drops linkers that would stretch a real S–S bond). Two user modes: **rigid** (keep S–S) vs **flexible-with-penalty** (constraints file). Interacts with our R0 backmap-disulfide handling. UI: mode choice. |
| **F** Split long linkers ("pseudo-helices") | `--split_long_linkers/--no_split_long_linkers --max_linker_len(25) --long_linker_fake_helix_len(3)` | **ON** | `split_long_linkers_in_secondary_structure` | Breaks `-` sections longer than 25 res with short artificial `H` separators for better sampling of long tags. UI: optional toggle + threshold. |
| **G** PDBFixer missing atoms/residues | `--fix_missing_residues/--no_fix_missing_residues --fix_missing_residue_name(GLY) --fix_missing_residue_max_gap(80)` | **ON** | `pdbfixer_prepare_structure_before_carbonara`, `_pdbfixer_with_safe_platform` | Repairs internal missing-residue gaps before setup. Needs `pdbfixer` in the env (it's in the openmm env already for automd-saxs — to confirm). UI: optional toggle. |
| **A** C++ perf | — | — | 7 src files | Rebuild engine. Re-verify our `max_q` segfault-clamp still needed + RNG-seed behaviour unchanged (regression). |
| **C** their cheap FoXS | — | — | — | **SKIP.** We keep IMP FoXS/MultiFoXS (χ² Stage 1–2). Just ensure `--no_foxs` when using their setup so their FoXS never runs. |

## 3. The pivotal design decision: how to adopt D/E/F/G

Our wrapper (`carbonara_bilbomd_runner_refined.py`) currently calls **`setup_carbonara.py`**
and then orchestrates the rest itself (mixture handling, our cg2all backmap via
`backmap_cli.py`, IMP FoXS, results). Two ways to get the new features:

- **Option A — adopt `setup_carbonara_allAtom.py`** as our setup entry (with
  `--no_foxs`, `--backend cg2all`, and the D/E/F/G flags). *Pro:* all features "for free",
  the dev-supported path, defaults sensible. *Con:* it also generates a RunMe that does its
  **own concurrent backmapping** (`watch_and_backmap.py`, `--defer_backmap_seconds 600`,
  `--backend modeller` default) — a different model from our fit-then-cg2all-then-IMP-FoXS
  flow. We'd have to carefully disable/replace the parts we already own, and we inherit its
  orchestration coupling.
- **Option B — cherry-pick the new CDT/allAtom functions** into our own wrapper: keep
  calling `setup_carbonara.py`, and call `guinier_trim_saxs_file_inplace`,
  `pdbfixer_prepare_structure_before_carbonara`, `disulfide_safe_linkers` /
  `auto_select_varying_linker(pdb_path=…)`, and `split_long_linkers_in_secondary_structure`
  ourselves at the right points. *Pro:* keeps our proven, de-nested, IMP-FoXS orchestration;
  minimal behavioural surprise; feature-by-feature rollout. *Con:* more glue code; some
  functions live in `setup_carbonara_allAtom.py` (not CDT) so we import from there or refactor.

**Recommendation: Option B.** It preserves everything we already validated (inprocess
de-nesting, IMP-FoXS χ² unification, our cg2all backmap + results) and lets us add D/E/F/G
one at a time behind our own flags — matching the "phased, verify each" plan. Option A risks
regressing the χ²/backmap work we just shipped.

## 4. Cross-cutting concerns

1. **SAXS filename/trim contract (D).** Guinier trim overwrites `Saxs.dat` and backs up
   `Saxs.dat.pre_guinier_trim`. Everything downstream (fits, our IMP `foxs`/`multi_foxs`,
   the setup preview `carbonara_initfoxs.py`) must score against the **trimmed** file, or the
   χ² numbers we just unified will diverge again. The UI must also make clear which q-range
   is in play. This is the trickiest wiring.
2. **Backmap backend.** allAtom defaults `--backend modeller`; **we use cg2all.** If we ever
   touch allAtom, force cg2all; under Option B this is a non-issue (we keep our backmap).
3. **Mixture workaround (B).** Must test whether the new engine makes *n* distinct
   fingerprints natively; if so, remove/adjust our `merge_mixture_structures`/`apply_merges`.
4. **`pdbfixer` availability (G).** Confirm it's importable in the baked carbonara/openmm env.
5. **Don't bake `*.stage*.bak`** and beware CDT duplicate defs (last wins).
6. **Both deploy paths.** Every engine change → one ~23 GB worker rebuild → update the k8s
   chart tag AND the docker-deploy-kit image in lockstep.

## 5. Refined phase plan (unchanged shape, now concrete)

- **Phase 1 — engine re-base (A,B):** rebuild worker on pinned `614d099` (excluding `.bak`);
  regression-test existing Carbonara + AutoMD-SAXS jobs; verify/adjust the mixture-fingerprint
  workaround; re-check max_q clamp + RNG seeding.
- **Phase 2 — additive features via Option B, one at a time:** suggested order **G → E → F → D**
  (prep/correctness first; D last because of the SAXS-trim wiring). Each: wrapper call + a
  worker/pipeline flag + a UI control + a validated round-trip on the real inprocess path.
- **Phase 3 — ship to k8s + docker kit** in one rebuild, tags bumped together.

## 6. Open questions for review

1. **Option A vs B** for adopting D/E/F/G (recommendation: **B**).
2. **Feature order** in Phase 2 (suggested G→E→F→D).
3. **Defaults for our users:** upstream defaults D/F/G **ON**. Do we want them on-by-default in
   bilbomd too, or opt-in via UI (safer for reproducibility of existing jobs)?
4. Confirm with the dev: is `setup_carbonara_allAtom.py` the intended integration entry point,
   or are the CDT functions meant to be called individually (validates Option B)?
