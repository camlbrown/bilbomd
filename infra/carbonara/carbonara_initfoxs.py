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
    Convert a CIF/mmCIF file to PDB using openmm.app (fast, ~0.1s).

    NOTE: we deliberately do NOT import CarbonaraDataTools here. CDT pulls in
    torch/biobox/openmm and takes tens of seconds to import, which previously made
    the preview exceed the UI poll timeout (~60s). FoXS only needs coordinates, so
    openmm.app PDBxFile -> PDBFile is sufficient and effectively instant.
    """
    from openmm.app import PDBxFile, PDBFile  # type: ignore[import-untyped]
    pdbx = PDBxFile(str(cif_path))
    with open(str(out_pdb), 'w') as fh:
        PDBFile.writeFile(pdbx.topology, pdbx.positions, fh)
    if not (out_pdb.exists() and out_pdb.stat().st_size > 0):
        raise RuntimeError(
            f'CIF -> PDB conversion produced no output for: {cif_path}'
        )


# ---------------------------------------------------------------------------
# .fit file parser
# ---------------------------------------------------------------------------

CHI2_RE = re.compile(r'Chi\^?2\s*=\s*([0-9.eE+\-]+)', re.IGNORECASE)
C1_RE = re.compile(r'\bc1\s*=\s*([0-9.eE+\-]+)')
C2_RE = re.compile(r'\bc2\s*=\s*([0-9.eE+\-]+)')


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
        proc = subprocess.run(
            cmd,
            cwd=str(outdir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )
        combined_output = proc.stdout or ''
        log_path.write_text(combined_output)

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

        # Parse c1/c2 from pyfoxs stdout
        c1: float | None = None
        c2: float | None = None
        m1 = C1_RE.search(combined_output)
        if m1:
            try:
                c1 = float(m1.group(1))
            except ValueError:
                pass
        m2 = C2_RE.search(combined_output)
        if m2:
            try:
                c2 = float(m2.group(1))
            except ValueError:
                pass

        # Step 4: write result.json
        payload = {
            'status': 'done',
            'chi2': chi2,
            'c1': c1,
            'c2': c2,
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
