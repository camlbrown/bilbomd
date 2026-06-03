#!/usr/bin/env python3
"""
Carbonara command-line wrapper for future BilboMD worker integration.

This wrapper provides a stable, non-interactive execution contract around the
current Carbonara command-line workflow:

    JSON job description
        -> isolated job directory
        -> setup_carbonara.py
        -> generated RunMe_<job>.sh
        -> patched RunMe script with PID tracking
        -> collected outputs and wrapper_summary.json

The wrapper deliberately keeps Carbonara's generated background execution style
using '&', because the fitting executable appears to expect that behaviour.
The patch adds process tracking, interrupt cleanup, and meaningful non-zero exit
codes for failures such as segmentation faults.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


RUNME_WAIT_MARKER = "# BilboMD wrapper: wait for Carbonara background jobs"
RUNME_TRAP_MARKER = "# BilboMD wrapper: stop Carbonara background jobs on interrupt"


class WrapperError(RuntimeError):
    """Raised for wrapper-level validation or setup errors."""


def safe_name(name: str) -> str:
    """
    Carbonara uses the job name in filenames and generated shell scripts.
    Keep this conservative so paths are predictable and shell-safe.
    """
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name).strip())
    if not cleaned:
        raise WrapperError("job_name became empty after sanitisation")
    return cleaned


def resolve_path(value: str | os.PathLike[str], base: Path | None = None) -> Path:
    """
    Resolve a path. Relative paths are resolved relative to `base` when supplied,
    otherwise relative to the current working directory.
    """
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = (base or Path.cwd()) / path
    return path.resolve()


def require_file(path: Path, label: str) -> Path:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"{label} does not exist or is not a file: {path}")
    return path


def require_dir(path: Path, label: str) -> Path:
    path = path.expanduser().resolve()
    if not path.is_dir():
        raise FileNotFoundError(f"{label} does not exist or is not a directory: {path}")
    return path


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def update_summary(summary_path: Path, summary: dict[str, Any], **updates: Any) -> None:
    summary.update(updates)
    summary["updated_at"] = datetime.now().isoformat(timespec="seconds")
    write_json(summary_path, summary)


def run_logged(cmd: list[str], cwd: Path, log_file: Path) -> int:
    """
    Run a command, streaming stdout/stderr to both terminal and log file.

    The subprocess is started in its own process group. If the wrapper receives
    Ctrl+C, the whole child process group is terminated rather than leaving
    Carbonara fitting processes behind.
    """
    log_file.parent.mkdir(parents=True, exist_ok=True)

    with log_file.open("a", encoding="utf-8") as log:
        log.write("\n" + "=" * 80 + "\n")
        log.write(f"Timestamp: {datetime.now().isoformat(timespec='seconds')}\n")
        log.write(f"CWD: {cwd}\n")
        log.write("Command:\n")
        log.write(" ".join(cmd) + "\n")
        log.write("=" * 80 + "\n\n")
        log.flush()

        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
        )

        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                print(line, end="")
                log.write(line)
                log.flush()
            return proc.wait()

        except KeyboardInterrupt:
            message = "\nWrapper interrupted; terminating Carbonara subprocess group.\n"
            print(message, file=sys.stderr)
            log.write(message)
            log.flush()

            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                return 130

            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()

            return 130


def replace_path_with_symlink(link_path: Path, target_path: Path) -> None:
    """
    Replace an existing file/directory/symlink with a symlink to target_path.
    """
    if link_path.exists() or link_path.is_symlink():
        if link_path.is_symlink() or link_path.is_file():
            link_path.unlink()
        elif link_path.is_dir():
            shutil.rmtree(link_path)
        else:
            raise WrapperError(f"Refusing to replace unexpected path type: {link_path}")

    link_path.symlink_to(target_path, target_is_directory=target_path.is_dir())


def prepare_runtime_layout(carbonara_root: Path, run_root: Path) -> None:
    """
    Make an isolated job directory look enough like the Carbonara repository root
    for the current Carbonara setup code and C++ executable.

    Required layout learned during testing:
        run_root/build -> carbonara_root/build
        run_root/probabilityInterpolation -> carbonara_root/probabilityInterpolation
    """
    real_build_dir = require_dir(carbonara_root / "build", "Carbonara build directory")
    require_file(
        real_build_dir / "bin" / "predictStructureQvary",
        "Carbonara binary build/bin/predictStructureQvary",
    )
    require_file(
        real_build_dir / "bin" / "generate_structure",
        "Carbonara binary build/bin/generate_structure",
    )

    replace_path_with_symlink(run_root / "build", real_build_dir)

    probability_dir = require_dir(
        carbonara_root / "probabilityInterpolation",
        "Carbonara probabilityInterpolation directory",
    )
    replace_path_with_symlink(run_root / "probabilityInterpolation", probability_dir)


def expose_probability_interpolation_files(carbonara_root: Path, target_dir: Path) -> None:
    """
    Also expose probabilityInterpolation *CumDist.dat files inside fileLocs.

    The generated RunMe script passes fileLocs as carbonara_runs/<job_name>/.
    Keeping these symlinks as a defensive compatibility layer is useful because
    some Carbonara code paths appear to look up files relative to fileLocs.
    """
    probability_dir = carbonara_root / "probabilityInterpolation"
    if not probability_dir.is_dir():
        print(f"Warning: probabilityInterpolation directory not found: {probability_dir}")
        return

    cumdist_files = sorted(probability_dir.glob("*CumDist.dat"))
    if not cumdist_files:
        print(f"Warning: no *CumDist.dat files found in {probability_dir}")
        return

    target_dir.mkdir(parents=True, exist_ok=True)

    for src in cumdist_files:
        replace_path_with_symlink(target_dir / src.name, src)

    # Carbonara has been observed requesting this filename with a lower-case
    # 'linker', while the distributed file uses 'Linker'.
    aliases = {
        "joinlinkerToStrandxCumDist.dat": "joinLinkerToStrandxCumDist.dat",
        "joinlinkerToStrandYfromXCumDist.dat": "joinLinkerToStrandYfromXCumDist.dat",
    }

    for alias_name, real_name in aliases.items():
        real_path = probability_dir / real_name
        if real_path.exists():
            replace_path_with_symlink(target_dir / alias_name, real_path)


def patch_runme_for_bilbomd(run_script: Path) -> None:
    """
    Patch Carbonara's generated RunMe script.

    Carbonara launches fitting jobs in the background using '&'. We preserve that
    behaviour, but add:
        - a pids array
        - Ctrl+C/TERM cleanup
        - wait loop
        - non-zero exit if any Carbonara subprocess fails
    """
    text = run_script.read_text(encoding="utf-8")

    # If a previously patched script is supplied, remove our wait/trap block.
    text = text.split(RUNME_WAIT_MARKER)[0].rstrip() + "\n"
    text = text.replace("set -e\n", "").replace("set -o pipefail\n", "")

    text = re.sub(r"^#!.*\n", "#!/bin/bash\n", text, count=1)
    if not text.startswith("#!/bin/bash"):
        text = "#!/bin/bash\n" + text

    lines: list[str] = []
    inserted_pids_init = False

    for line in text.splitlines():
        if not inserted_pids_init and re.match(r"^\s*for\s+i\s+in\s+", line):
            lines.extend(
                [
                    "pids=()",
                    "",
                    RUNME_TRAP_MARKER,
                    "cleanup() {",
                    '    echo "Caught interrupt; stopping Carbonara subprocesses" >&2',
                    '    for pid in "${pids[@]}"; do',
                    '        kill "$pid" 2>/dev/null || true',
                    "    done",
                    "    wait 2>/dev/null || true",
                    "    exit 130",
                    "}",
                    "",
                    "trap cleanup INT TERM",
                    "",
                ]
            )
            inserted_pids_init = True

        if "predictStructureQvary" in line and "pids+=" not in line:
            stripped = line.rstrip()
            if not stripped.endswith("&"):
                stripped = stripped + " &"
            lines.append(stripped)
            lines.append('    pids+=("$!")')
        else:
            lines.append(line)

    if not inserted_pids_init:
        raise WrapperError(f"Could not find the main 'for i in ...' loop in {run_script}")

    patched = "\n".join(lines).rstrip()
    patched += f"""

{RUNME_WAIT_MARKER}
status=0
for pid in "${{pids[@]}}"; do
    wait "$pid"
    rc=$?
    if [ "$rc" -ne 0 ]; then
        echo "Carbonara subprocess $pid failed with exit code $rc" >&2
        status=$rc
    fi
done

exit "$status"
"""

    run_script.write_text(patched, encoding="utf-8")
    run_script.chmod(0o755)


def copytree_contents(src: Path, dst: Path) -> None:
    """
    Copy the contents of src into dst. Symlinked files are copied as file data,
    not as links, so the collected results are self-contained.
    """
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.is_dir() and not item.is_symlink():
            shutil.copytree(item, target, dirs_exist_ok=True, symlinks=False)
        elif item.is_symlink():
            resolved = item.resolve()
            if resolved.is_dir():
                shutil.copytree(resolved, target, dirs_exist_ok=True, symlinks=False)
            else:
                shutil.copy2(resolved, target)
        else:
            shutil.copy2(item, target)


def build_setup_command(
    python_exe: str,
    setup_script: Path,
    input_pdb: Path,
    input_saxs: Path,
    job_name: str,
    run_root: Path,
    params: dict[str, Any],
) -> list[str]:
    cmd = [
        python_exe,
        str(setup_script),
        "--pdb",
        str(input_pdb),
        "--saxs",
        str(input_saxs),
        "--name",
        job_name,
        "--dir",
        str(run_root),
        "--fit_n_times",
        str(int(params.get("fit_n_times", 20))),
        "--min_q",
        str(float(params.get("min_q", 0.01))),
        "--max_q",
        str(float(params.get("max_q", 0.2))),
        "--max_q_start",
        str(float(params.get("max_q_start", 0.2))),
        "--max_fit_steps",
        str(int(params.get("max_fit_steps", 10000))),
        "--mixture_n",
        str(int(params.get("mixture_n", 1))),
    ]

    if params.get("rotation", False):
        cmd.append("--rotation")

    if params.get("pairedQ", False):
        cmd.append("--pairedQ")

    if params.get("alphaFoldFlex", False):
        cmd.append("--alphaFoldFlex")
        pae = params.get("pae") or params.get("pae_file")
        if not pae:
            raise WrapperError("alphaFoldFlex=true but no PAE file was supplied in parameters.pae")
        cmd.extend(["--pae", str(require_file(Path(pae), "PAE file"))])

        if "pae_flex_threshold" in params:
            cmd.extend(["--pae_flex_threshold", str(float(params["pae_flex_threshold"]))])

    optional_numeric: dict[str, type] = {
        "max_mixture_combos": int,
        "mixture_step": float,
        "mixture_dirichlet_alpha": float,
        "mixture_snap": float,
    }

    for key, caster in optional_numeric.items():
        if key in params:
            cmd.extend([f"--{key}", str(caster(params[key]))])

    return cmd


def collect_outputs(
    *,
    carbonara_run_dir: Path,
    run_script: Path | None,
    log_file: Path,
    summary_path: Path,
    outdir: Path,
    summary: dict[str, Any],
) -> None:
    """
    Collect complete or partial outputs into a predictable results directory.
    This is called for both successful and failed fitting runs.
    """
    if outdir.exists():
        shutil.rmtree(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    if carbonara_run_dir.exists():
        copytree_contents(carbonara_run_dir, outdir / "carbonara_run")

    if run_script is not None and run_script.exists():
        shutil.copy2(run_script, outdir / run_script.name)

    if log_file.exists():
        shutil.copy2(log_file, outdir / "carbonara_wrapper.log")

    write_json(summary_path, summary)
    shutil.copy2(summary_path, outdir / "wrapper_summary.json")


def summarise_outputs(fitdata_dir: Path) -> dict[str, Any]:
    fit_logs = sorted(fitdata_dir.glob("fitLog*.dat"))
    model_like_files = sorted(fitdata_dir.glob("mol*"))
    final_model_files = sorted(fitdata_dir.glob("mol*_end_xyz.dat"))
    scatter_files = sorted(fitdata_dir.glob("scatter*.dat"))
    initial_scatter_files = sorted(fitdata_dir.glob("mol*_initial_scatter.dat"))

    def nonempty(paths: list[Path]) -> list[Path]:
        return [p for p in paths if p.is_file() and p.stat().st_size > 0]

    return {
        "fitdata_dir": str(fitdata_dir),
        "n_fit_logs": len(fit_logs),
        "n_nonempty_fit_logs": len(nonempty(fit_logs)),
        "n_model_like_files": len(model_like_files),
        "n_nonempty_model_like_files": len(nonempty(model_like_files)),
        "n_final_model_files": len(final_model_files),
        "n_nonempty_final_model_files": len(nonempty(final_model_files)),
        "n_scatter_files": len(scatter_files),
        "n_nonempty_scatter_files": len(nonempty(scatter_files)),
        "n_initial_scatter_files": len(initial_scatter_files),
        "n_nonempty_initial_scatter_files": len(nonempty(initial_scatter_files)),
        "final_model_files": [str(p) for p in final_model_files],
    }


def apply_merges(
    *,
    carbonara_root: Path,
    scenario_dir: Path,
    chain_merges: list[list[int]],
    mixture_n: int,
) -> None:
    """
    Apply sequential chain merges to fingerPrint1.dat / varyingSectionSecondary1.dat
    in-place, then replicate to fingerPrint{2..N}.dat / varyingSectionSecondary{2..N}.dat
    for mixture ensembles.

    Chain indices are 1-based and RENUMBER after each merge (e.g. after merging
    chains (1, 2), the old chain 3 becomes chain 2). Callers must account for
    renumbering when building the pair list.

    Must be called AFTER setup (so fingerPrint1.dat / varyingSectionSecondary1.dat
    already exist in scenario_dir) and AFTER apply_flexibility (which may have
    updated varyingSectionSecondary1.dat), and BEFORE apply_constraints /
    patch_runme_for_bilbomd.

    CDT contract (verified, all 1-based, fingerprint-only — no pdb/chdir needed):
      cdt.parse_structures_with_segments(fp_path) -> chains
      cdt.create_segment_label_arrays_with_merge_v4(chains, highlighted, merge_pair)
        -> (_orig, _edit, remapped_highlighted)
      cdt.merge_chains_only_clean_consistent_segments(chains, merge_pair)
        -> merged_chains
      cdt.export_chains_to_file(merged_chains, fp_path)
      cdt.export_segment_list(remapped_highlighted, vs_path)
    """
    import sys
    import numpy as np

    sys.path.insert(0, str(carbonara_root))
    import CarbonaraDataTools as cdt  # type: ignore[import-not-found]

    fp = scenario_dir / "fingerPrint1.dat"
    vs = scenario_dir / "varyingSectionSecondary1.dat"

    for pair in chain_merges:
        merge_pair = (int(pair[0]), int(pair[1]))
        chains = cdt.parse_structures_with_segments(str(fp))
        # np.atleast_1d is robust to 0-d arrays produced by np.loadtxt on a
        # single-element file; handle empty varyingSection gracefully.
        if vs.exists() and vs.stat().st_size > 0:
            raw = np.loadtxt(str(vs), dtype=int)
            highlighted = np.atleast_1d(raw)
        else:
            highlighted = np.array([], dtype=int)
        _orig, _edit, remapped = cdt.create_segment_label_arrays_with_merge_v4(
            chains, highlighted, merge_pair
        )
        merged = cdt.merge_chains_only_clean_consistent_segments(chains, merge_pair)
        cdt.export_chains_to_file(merged, str(fp))
        cdt.export_segment_list(remapped, str(vs))

    if mixture_n > 1:
        for i in range(2, mixture_n + 1):
            shutil.copyfile(fp, scenario_dir / f"fingerPrint{i}.dat")
            shutil.copyfile(vs, scenario_dir / f"varyingSectionSecondary{i}.dat")


def apply_flexibility(
    *,
    carbonara_root: Path,
    run_root: Path,
    run_name: str,
    scenario_dir: Path,
    pdb_path: Path,
    flex_ranges: dict[str, list[list[int]]],
    mixture_n: int,
) -> None:
    """
    Override varyingSectionSecondary*.dat from user-supplied residue ranges.

    Must be called AFTER setup (so fingerPrint1.dat already exists in
    carbonara_runs/<run_name>/) and BEFORE apply_constraints / patch_runme.

    CDT contract (verified from notebooks):
      cdt.linker_ids_from_ranges(run_name, pdb_name, user_ranges)
        reads RELATIVE "carbonara_runs/<run_name>/fingerPrint1.dat", so it
        MUST run with cwd=run_root.
      cdt.write_varysections_file(indices, working_path, carb_index=i)
        writes working_path/varyingSectionSecondary{i}.dat.

    flex_ranges from job.json is {"1": [[5,56], ...], ...} (string chain keys,
    1-based integer chains). We normalise to {1: [(5,56), ...]}.
    """
    import sys
    import os

    sys.path.insert(0, str(carbonara_root))
    import CarbonaraDataTools as cdt  # type: ignore[import-not-found]

    # Normalise JSON {"1": [[5, 56]]} -> {1: [(5, 56)]}
    user_ranges: dict[int, list[tuple[int, int]]] = {
        int(k): [tuple(r) for r in v]  # type: ignore[misc]
        for k, v in flex_ranges.items()
    }

    cwd = os.getcwd()
    os.chdir(str(run_root))
    try:
        indices, _secs = cdt.linker_ids_from_ranges(
            run_name, str(pdb_path), user_ranges
        )
        for i in range(1, max(1, mixture_n) + 1):
            cdt.write_varysections_file(
                indices, f"carbonara_runs/{run_name}", carb_index=i
            )
    finally:
        os.chdir(cwd)


def chain_first_auth_residues(pdb_path: Path) -> dict[str, int]:
    """
    Map each chain letter to the auth residue number of its FIRST residue, i.e.
    the numbering a user reads off the structure in the 3D viewer.

    Chains with an explicit chain-ID column use that ID. For files with a blank
    chain column (residues numbered continuously, chains delimited by TER) chains
    are assigned sequentially A, B, C, ... per TER block, matching the viewer's
    assignChainsByTer. Only ATOM records are considered so trailing HETATM
    waters/ions do not invent extra chains.
    """
    auto_letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    first_auth: dict[str, int] = {}
    ter_index = 0
    seen_in_block = False
    with open(pdb_path) as fh:
        for line in fh:
            rec = line[:6].strip()
            if rec == "ATOM":
                ch = line[21].strip()
                key = ch if ch else auto_letters[min(ter_index, len(auto_letters) - 1)]
                if key not in first_auth:
                    first_auth[key] = int(line[22:26])
                seen_in_block = True
            elif rec == "TER" and seen_in_block:
                ter_index += 1
                seen_in_block = False
    return first_auth


def translate_constraints_to_local(
    *, constraints_file: Path, input_pdb: Path, out_file: Path
) -> None:
    """
    Rewrite a user constraints file (`res chain res chain value`) from the auth
    numbering shown in the 3D viewer into the per-chain LOCAL numbering the engine
    expects, so the viewer and the engine agree.

    cdt.mapFixedConstraints treats each residue number as a 1-based index WITHIN
    its chain and adds a cumulative chain offset. A user (and the viewer) instead
    reference residues by the structure's auth numbers. Convert with:
        local = auth - first_auth(chain) + 1
    For a per-chain-numbered PDB (each chain restarts at 1) this is the identity;
    for a continuously-numbered / blank-chain PDB it removes the global offset.
    """
    first_auth = chain_first_auth_residues(input_pdb)
    with open(constraints_file) as src, open(out_file, "w") as dst:
        for raw in src:
            parts = raw.split()
            if len(parts) != 5:
                continue
            r1, c1, r2, c2, val = parts
            l1 = int(r1) - first_auth.get(c1, 1) + 1
            l2 = int(r2) - first_auth.get(c2, 1) + 1
            dst.write(f"{l1} {c1} {l2} {c2} {val}\n")


def apply_constraints(
    *,
    carbonara_root: Path,
    scenario_dir: Path,
    run_script: Path,
    constraints_file: Path,
    input_pdb: Path,
    mixture_n: int,
) -> None:
    """
    Apply fixed-distance constraints to a Carbonara scenario directory.

    Must be called AFTER setup (so coordinates1.dat, fingerPrint1.dat, and
    chainLengths.dat already exist) and BEFORE patch_runme_for_bilbomd (both
    edits touch different parts of RunMe so they coexist safely).

    Steps:
      1. Lazy-import CarbonaraDataTools (heavy; skipped for unconstrained jobs).
      2. Load chain-length offsets from chainLengths.dat (pickle).
      3. Translate the user's viewer/auth residue numbers to per-chain local
         numbering (translate_constraints_to_local), then call
         cdt.mapFixedConstraints to convert (res, chain) pairs to global
         segment/element indices.
      4. Load coordinates1.dat with numpy.
      5. Call cdt.translate_distance_constraints to write
         fixedDistanceConstraints1.dat in scenario_dir.
      6. Call cdt.toggle_paired_predictions to flip pairedPredictions=True in
         the RunMe script so the predictor reads the constraint file.
      7. For mixture_n > 1, replicate fixedDistanceConstraints1.dat to
         fixedDistanceConstraints{2..N}.dat.
    """
    import sys
    import pickle
    import numpy as np

    sys.path.insert(0, str(carbonara_root))
    import CarbonaraDataTools as cdt

    chain_lengths_path = scenario_dir / "chainLengths.dat"
    if not chain_lengths_path.is_file():
        raise FileNotFoundError(
            f"chainLengths.dat not found; setup must have run first: {chain_lengths_path}"
        )
    with open(chain_lengths_path, "rb") as fh:
        chain_lengths = pickle.load(fh)

    local_constraints = scenario_dir / "_constraints_local.dat"
    translate_constraints_to_local(
        constraints_file=constraints_file,
        input_pdb=input_pdb,
        out_file=local_constraints,
    )

    contact_preds, fixed_dists = cdt.mapFixedConstraints(
        str(local_constraints), chain_lengths
    )

    coords_path = scenario_dir / "coordinates1.dat"
    if not coords_path.is_file():
        raise FileNotFoundError(
            f"coordinates1.dat not found; setup must have run first: {coords_path}"
        )
    coords = np.genfromtxt(str(coords_path))

    cdt.translate_distance_constraints(
        contact_preds, coords, str(scenario_dir), fixed_dists
    )

    cdt.toggle_paired_predictions(str(run_script))

    if mixture_n > 1:
        src = scenario_dir / "fixedDistanceConstraints1.dat"
        for i in range(2, mixture_n + 1):
            shutil.copyfile(src, scenario_dir / f"fixedDistanceConstraints{i}.dat")


def validate_outputs(fitdata_dir: Path) -> tuple[bool, str]:
    """
    Conservative validation. Do not require a final model because a very short
    exploratory run might complete without writing one, but do require logs and
    at least some model/scatter output.
    """
    if not fitdata_dir.is_dir():
        return False, f"Expected fitdata directory not found: {fitdata_dir}"

    output_summary = summarise_outputs(fitdata_dir)

    if output_summary["n_nonempty_fit_logs"] == 0:
        return False, "No non-empty fitLog*.dat files were produced"

    if output_summary["n_nonempty_model_like_files"] == 0:
        return False, "No non-empty mol* model-like files were produced"

    if (
        output_summary["n_nonempty_scatter_files"] == 0
        and output_summary["n_nonempty_initial_scatter_files"] == 0
    ):
        return False, "No non-empty scatter output files were produced"

    return True, ""


def load_job(job_json: Path) -> dict[str, Any]:
    try:
        job = json.loads(job_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise WrapperError(f"Could not parse job JSON {job_json}: {exc}") from exc

    required = ["job_name", "carbonara_root", "pdb", "saxs", "workdir"]
    missing = [key for key in required if key not in job]
    if missing:
        raise WrapperError(f"Job JSON missing required field(s): {', '.join(missing)}")

    if "parameters" in job and not isinstance(job["parameters"], dict):
        raise WrapperError("Job JSON field 'parameters' must be an object")

    return job


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a Carbonara job from a BilboMD-style JSON file.")
    parser.add_argument("--job-json", required=True, help="Path to Carbonara job JSON file")
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove any previous job working directory before running",
    )
    args = parser.parse_args()

    job_json = require_file(resolve_path(args.job_json), "job JSON")
    job_json_dir = job_json.parent
    job = load_job(job_json)

    job_name = safe_name(job["job_name"])
    carbonara_root = require_dir(resolve_path(job["carbonara_root"], job_json_dir), "Carbonara root")
    setup_script = require_file(carbonara_root / "setup_carbonara.py", "setup_carbonara.py")
    carbonara_binary = require_file(
        carbonara_root / "build" / "bin" / "predictStructureQvary",
        "Carbonara binary build/bin/predictStructureQvary",
    )
    generate_structure_binary = require_file(
        carbonara_root / "build" / "bin" / "generate_structure",
        "Carbonara binary build/bin/generate_structure",
    )

    input_pdb_original = require_file(resolve_path(job["pdb"], job_json_dir), "input PDB/mmCIF")
    input_saxs_original = require_file(resolve_path(job["saxs"], job_json_dir), "input SAXS file")

    base_workdir = resolve_path(job["workdir"], job_json_dir)
    run_root = base_workdir / job_name
    outdir = resolve_path(job.get("outdir", run_root / "results"), job_json_dir)

    if args.clean and run_root.exists():
        shutil.rmtree(run_root)

    run_root.mkdir(parents=True, exist_ok=True)
    prepare_runtime_layout(carbonara_root, run_root)

    log_dir = run_root / "logs"
    log_file = log_dir / "carbonara_wrapper.log"
    input_dir = run_root / "inputs"
    input_dir.mkdir(parents=True, exist_ok=True)

    input_pdb = input_dir / input_pdb_original.name
    input_saxs = input_dir / input_saxs_original.name
    shutil.copy2(input_pdb_original, input_pdb)
    shutil.copy2(input_saxs_original, input_saxs)

    params = job.get("parameters", {})
    carbonara_run_dir = run_root / "carbonara_runs" / job_name
    fitdata_dir = carbonara_run_dir / "fitdata"
    run_script = run_root / f"RunMe_{job_name}.sh"
    summary_path = run_root / "wrapper_summary.json"

    summary: dict[str, Any] = {
        "job_name": job_name,
        "status": "started",
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "python_executable": sys.executable,
        "job_json": str(job_json),
        "carbonara_root": str(carbonara_root),
        "carbonara_binary": str(carbonara_binary),
        "generate_structure_binary": str(generate_structure_binary),
        "run_root": str(run_root),
        "outdir": str(outdir),
        "log_file": str(log_file),
        "parameters": params,
    }
    write_json(summary_path, summary)

    setup_cmd = build_setup_command(
        python_exe=sys.executable,
        setup_script=setup_script,
        input_pdb=input_pdb,
        input_saxs=input_saxs,
        job_name=job_name,
        run_root=run_root,
        params=params,
    )

    print(f"\n[1/4] Running Carbonara setup for job: {job_name}\n")
    update_summary(summary_path, summary, status="running_setup", setup_command=setup_cmd)
    rc = run_logged(setup_cmd, cwd=run_root, log_file=log_file)
    if rc != 0:
        update_summary(summary_path, summary, status="setup_failed", return_code=rc)
        collect_outputs(
            carbonara_run_dir=carbonara_run_dir,
            run_script=run_script if run_script.exists() else None,
            log_file=log_file,
            summary_path=summary_path,
            outdir=outdir,
            summary=summary,
        )
        return rc

    require_file(run_script, "generated RunMe script")
    expose_probability_interpolation_files(carbonara_root, carbonara_run_dir)

    mixture_n = int(params.get("mixture_n", 1))

    # Computed step numbering: build the ordered list of optional apply phases
    # that will actually run (flexibility -> merges -> constraints), then number
    # the fixed phases (setup=1, patch, fit, collect) around them.
    #   total = 4 fixed phases + len(optional_phases)
    optional_phases = []
    flex_ranges_param = params.get("flex_ranges")
    chain_merges_param = params.get("chain_merges")
    constraints_file_param = params.get("constraints_file")
    if flex_ranges_param:
        optional_phases.append("flexibility")
    if chain_merges_param:
        optional_phases.append("merges")
    if constraints_file_param:
        optional_phases.append("constraints")

    total_steps = 4 + len(optional_phases)  # setup + optionals + patch + fit + collect
    next_step = 2  # step 1 was setup

    if "flexibility" in optional_phases:
        step_flex = f"{next_step}/{total_steps}"
        next_step += 1
    else:
        step_flex = None

    if "merges" in optional_phases:
        step_merges = f"{next_step}/{total_steps}"
        next_step += 1
    else:
        step_merges = None

    if "constraints" in optional_phases:
        step_constraints = f"{next_step}/{total_steps}"
        next_step += 1
    else:
        step_constraints = None

    step_patch = f"{next_step}/{total_steps}"
    next_step += 1
    step_fit = f"{next_step}/{total_steps}"
    next_step += 1
    step_collect = f"{next_step}/{total_steps}"

    # --- Optional: manual flexibility (B7) ---
    if flex_ranges_param and step_flex is not None:
        print(f"\n[{step_flex}] Applying manual flexibility\n")
        update_summary(summary_path, summary, status="applying_flexibility")
        try:
            apply_flexibility(
                carbonara_root=carbonara_root,
                run_root=run_root,
                run_name=job_name,
                scenario_dir=carbonara_run_dir,
                pdb_path=input_pdb,
                flex_ranges=flex_ranges_param,
                mixture_n=mixture_n,
            )
        except Exception as exc:
            print(f"\nFlexibility apply step failed: {exc}", file=sys.stderr)
            update_summary(
                summary_path,
                summary,
                status="flexibility_failed",
                flexibility_error=str(exc),
            )
            collect_outputs(
                carbonara_run_dir=carbonara_run_dir,
                run_script=run_script if run_script.exists() else None,
                log_file=log_file,
                summary_path=summary_path,
                outdir=outdir,
                summary=summary,
            )
            return 1

    # --- Optional: chain merges (B8) ---
    if chain_merges_param and step_merges is not None:
        print(f"\n[{step_merges}] Merging chains ...\n")
        update_summary(summary_path, summary, status="applying_merges")
        try:
            apply_merges(
                carbonara_root=carbonara_root,
                scenario_dir=carbonara_run_dir,
                chain_merges=list(chain_merges_param),
                mixture_n=mixture_n,
            )
        except Exception as exc:
            print(f"\nMerges apply step failed: {exc}", file=sys.stderr)
            update_summary(
                summary_path,
                summary,
                status="merges_failed",
                merges_error=str(exc),
            )
            collect_outputs(
                carbonara_run_dir=carbonara_run_dir,
                run_script=run_script if run_script.exists() else None,
                log_file=log_file,
                summary_path=summary_path,
                outdir=outdir,
                summary=summary,
            )
            return 1

    # --- Optional: distance constraints (B6) ---
    if constraints_file_param and step_constraints is not None:
        cf = resolve_path(constraints_file_param, job_json_dir)
        require_file(cf, "constraints file")
        print(f"\n[{step_constraints}] Applying distance constraints from: {cf}\n")
        update_summary(summary_path, summary, status="applying_constraints")
        try:
            apply_constraints(
                carbonara_root=carbonara_root,
                scenario_dir=carbonara_run_dir,
                run_script=run_script,
                constraints_file=cf,
                input_pdb=input_pdb,
                mixture_n=mixture_n,
            )
        except Exception as exc:
            print(f"\nConstraints apply step failed: {exc}", file=sys.stderr)
            update_summary(
                summary_path,
                summary,
                status="constraints_failed",
                constraints_error=str(exc),
            )
            collect_outputs(
                carbonara_run_dir=carbonara_run_dir,
                run_script=run_script if run_script.exists() else None,
                log_file=log_file,
                summary_path=summary_path,
                outdir=outdir,
                summary=summary,
            )
            return 1

    print(f"\n[{step_patch}] Patching generated run script for BilboMD background PID tracking: {run_script}\n")
    update_summary(summary_path, summary, status="patching_run_script", run_script=str(run_script))
    patch_runme_for_bilbomd(run_script)

    print(f"\n[{step_fit}] Running Carbonara fitting script\n")
    update_summary(summary_path, summary, status="running_fit")
    rc = run_logged(["bash", str(run_script)], cwd=run_root, log_file=log_file)
    output_summary = summarise_outputs(fitdata_dir) if fitdata_dir.exists() else {}
    summary.update(output_summary)

    if rc != 0:
        update_summary(summary_path, summary, status="fit_failed", return_code=rc)
        collect_outputs(
            carbonara_run_dir=carbonara_run_dir,
            run_script=run_script,
            log_file=log_file,
            summary_path=summary_path,
            outdir=outdir,
            summary=summary,
        )
        print(f"\nCarbonara fitting failed. Partial outputs collected in: {outdir}")
        print(f"Summary: {outdir / 'wrapper_summary.json'}")
        print(f"Log: {outdir / 'carbonara_wrapper.log'}")
        return rc

    valid, validation_error = validate_outputs(fitdata_dir)
    output_summary = summarise_outputs(fitdata_dir)
    summary.update(output_summary)

    if not valid:
        update_summary(
            summary_path,
            summary,
            status="fit_output_validation_failed",
            return_code=3,
            validation_error=validation_error,
        )
        collect_outputs(
            carbonara_run_dir=carbonara_run_dir,
            run_script=run_script,
            log_file=log_file,
            summary_path=summary_path,
            outdir=outdir,
            summary=summary,
        )
        print(f"\nCarbonara output validation failed: {validation_error}")
        print(f"Partial outputs collected in: {outdir}")
        return 3

    print(f"\n[{step_collect}] Collecting outputs into: {outdir}\n")
    update_summary(summary_path, summary, status="collecting_outputs", return_code=0)
    collect_outputs(
        carbonara_run_dir=carbonara_run_dir,
        run_script=run_script,
        log_file=log_file,
        summary_path=summary_path,
        outdir=outdir,
        summary=summary,
    )

    update_summary(
        summary_path,
        summary,
        status="completed",
        return_code=0,
        completed_at=datetime.now().isoformat(timespec="seconds"),
    )
    shutil.copy2(summary_path, outdir / "wrapper_summary.json")

    print("\nCarbonara wrapper completed successfully.")
    print(f"Results: {outdir}")
    print(f"Summary: {outdir / 'wrapper_summary.json'}")
    print(f"Log: {outdir / 'carbonara_wrapper.log'}")

    return 0


if __name__ == "__main__":
    started = time.time()
    try:
        exit_code = main()
    except Exception as exc:
        print(f"\nWrapper failed before or during job setup: {exc}", file=sys.stderr)
        exit_code = 1

    print(f"\nWrapper elapsed time: {time.time() - started:.1f} s")
    raise SystemExit(exit_code)
