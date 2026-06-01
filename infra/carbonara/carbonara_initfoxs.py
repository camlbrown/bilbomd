"""
carbonara_initfoxs.py — BilboMD integration artifact.

Runs a lightweight pyfoxs preview on a single structure + SAXS file and writes
result.json to --outdir. Intended to be called from the Carbonara container via
the BilboMD worker (carbonaraPreviewHandler.ts).

Usage:
    python carbonara_initfoxs.py \\
        --pdb  /job/model.pdb \\
        --saxs /job/saxs.dat  \\
        --outdir /job         \\
        [--max_q 0.3]

Output (outdir/result.json):
    {"status": "done", "chi2": <float>,
     "foxs": [{"q": <f>, "exp": <f>, "model": <f>, "error": <f>}, ...]}
or on failure:
    {"status": "error", "message": "<reason>"}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


# ---------------------------------------------------------------------------
# CIF -> PDB conversion
# ---------------------------------------------------------------------------

def _convert_cif_to_pdb(cif_path: Path, out_pdb: Path) -> None:
    """
    Convert a CIF/mmCIF file to PDB format.

    Strategy:
    1. Try CarbonaraDataTools._convert_cif_to_pdb_for_foxs (Carbonara helper).
    2. Fall back to openmm.app PDBxFile -> PDBFile (always present in image).
    """
    # Strategy 1: Carbonara helper (preferred — same conversion used internally)
    try:
        import CarbonaraDataTools as cdt  # type: ignore[import-untyped]
        if hasattr(cdt, '_convert_cif_to_pdb_for_foxs'):
            cdt._convert_cif_to_pdb_for_foxs(str(cif_path), str(out_pdb))
            if out_pdb.exists() and out_pdb.stat().st_size > 0:
                return
    except Exception:
        pass

    # Strategy 2: openmm PDBxFile -> PDBFile
    try:
        from openmm.app import PDBxFile, PDBFile  # type: ignore[import-untyped]
        pdbx = PDBxFile(str(cif_path))
        with open(str(out_pdb), 'w') as fh:
            PDBFile.writeFile(pdbx.topology, pdbx.positions, fh)
        if out_pdb.exists() and out_pdb.stat().st_size > 0:
            return
    except Exception:
        pass

    raise RuntimeError(
        f'Could not convert CIF to PDB: {cif_path}. '
        'Neither CarbonaraDataTools nor openmm.app was able to convert it.'
    )


# ---------------------------------------------------------------------------
# .fit file parser
# ---------------------------------------------------------------------------

CHI2_RE = re.compile(r'Chi\^?2\s*=\s*([0-9.eE+\-]+)', re.IGNORECASE)


def _parse_fit_file(fit_path: Path) -> tuple[float, list[dict]]:
    """
    Parse a pyfoxs .fit file.

    Header line: '# ... Chi^2 = <value>'
    Data columns (whitespace-separated, skip '#' lines):
        q  exp_intensity  error  model_intensity
    NOTE: column order in .fit is q/exp/ERROR/model — not q/exp/model/error.

    Returns (chi2, [{q, exp, model, error}, ...]).
    """
    chi2: float | None = None
    rows: list[dict] = []

    with open(fit_path, 'r') as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped:
                continue

            if stripped.startswith('#'):
                m = CHI2_RE.search(stripped)
                if m:
                    try:
                        chi2 = float(m.group(1))
                    except ValueError:
                        pass
                continue

            parts = stripped.split()
            if len(parts) < 4:
                continue

            try:
                q = float(parts[0])
                exp = float(parts[1])
                error = float(parts[2])
                model = float(parts[3])
                rows.append({'q': q, 'exp': exp, 'model': model, 'error': error})
            except ValueError:
                continue

    if chi2 is None:
        raise RuntimeError(
            f'Could not find Chi^2 value in {fit_path}'
        )

    return chi2, rows


# ---------------------------------------------------------------------------
# .fit file locator
# ---------------------------------------------------------------------------

def _find_fit_file(outdir: Path, pdb_stem: str, dat_stem: str) -> Path:
    """
    Locate '<pdbstem>_<datstem>.fit' in outdir.
    Falls back to any *.fit file in outdir if the expected name is absent.
    """
    expected = outdir / f'{pdb_stem}_{dat_stem}.fit'
    if expected.exists():
        return expected

    fits = list(outdir.glob('*.fit'))
    if fits:
        return fits[0]

    raise RuntimeError(
        f'No .fit file found in {outdir} '
        f'(expected {pdb_stem}_{dat_stem}.fit)'
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Run pyfoxs preview and write result.json'
    )
    parser.add_argument('--pdb', required=True, help='Path to PDB or CIF file')
    parser.add_argument('--saxs', required=True, help='Path to SAXS .dat file')
    parser.add_argument('--outdir', required=True, help='Output directory')
    parser.add_argument('--max_q', type=float, default=None,
                        help='Maximum q value (optional)')
    args = parser.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    result_json = outdir / 'result.json'

    def write_error(msg: str) -> None:
        payload = {'status': 'error', 'message': msg}
        result_json.write_text(json.dumps(payload))

    pdb_path = Path(args.pdb)
    saxs_path = Path(args.saxs)

    tmp_dir = None
    try:
        # Step 1: convert CIF -> PDB if needed
        suffix = pdb_path.suffix.lower()
        if suffix in ('.cif', '.mmcif'):
            # Convert directly into outdir so pyfoxs (run with cwd=outdir and
            # basename args) writes its .fit alongside, in outdir.
            converted_pdb = outdir / (pdb_path.stem + '_initfoxs.pdb')
            _convert_cif_to_pdb(pdb_path, converted_pdb)
            pdb_path = converted_pdb

        # Step 2: run pyfoxs. Use basenames with cwd=outdir so the output
        # <pdbstem>_<datstem>.fit lands in outdir (both inputs live there).
        cmd = ['pyfoxs', pdb_path.name, saxs_path.name]
        if args.max_q is not None:
            cmd += ['--max_q', str(args.max_q)]

        log_path = outdir / 'initfoxs.log'
        with open(log_path, 'w') as log_fh:
            proc = subprocess.run(
                cmd,
                cwd=str(outdir),
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                text=True
            )

        if proc.returncode != 0:
            write_error(
                f'pyfoxs exited with code {proc.returncode}; '
                f'see initfoxs.log for details'
            )
            sys.exit(1)

        # Step 3: locate and parse .fit file
        pdb_stem = pdb_path.stem
        dat_stem = saxs_path.stem
        fit_path = _find_fit_file(outdir, pdb_stem, dat_stem)
        chi2, foxs_rows = _parse_fit_file(fit_path)

        # Step 4: write result.json
        payload = {
            'status': 'done',
            'chi2': chi2,
            'foxs': foxs_rows
        }
        result_json.write_text(json.dumps(payload))

    except Exception as exc:
        write_error(str(exc))
        sys.exit(1)
    finally:
        # Clean up temp dir (CIF conversion artefact)
        if tmp_dir is not None:
            import shutil
            try:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            except Exception:
                pass


if __name__ == '__main__':
    main()
