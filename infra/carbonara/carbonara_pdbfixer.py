"""
carbonara_pdbfixer.py — BilboMD integration artifact.

Runs PDBFixer to build INTERNAL missing residues into an uploaded structure and
writes result.json to --outdir. Called by the BilboMD worker's carbonara-pdbfixer
preview queue (the UI "Build missing residues" button). Reuses the upstream
pdbfixer_prepare_structure_before_carbonara (from setup_carbonara_allAtom), which
repairs internal missing-residue gaps with internal_only=True and writes a report
JSON. We surface the repaired PDB text + the number of residues built so the UI
can swap it in as the structure to submit.

Usage:
    python carbonara_pdbfixer.py --pdb /job/model.pdb --outdir /job \\
        [--carbonara-root /opt/carbonara] [--residue-name GLY] [--max-gap 80]

Output (outdir/result.json):
    {"status":"done","success":true,"residues_built":<int>,
     "fixed_pdb":"<PDB text>","report":{...}}
or on failure:
    {"status":"error","message":"<reason>"}
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Build internal missing residues with PDBFixer; write result.json'
    )
    parser.add_argument('--pdb', required=True, help='Path to input PDB file')
    parser.add_argument('--outdir', required=True, help='Output directory')
    parser.add_argument('--carbonara-root', default='/opt/carbonara',
                        help='Carbonara checkout root (default: /opt/carbonara)')
    parser.add_argument('--residue-name', dest='residue_name', default='GLY',
                        help='3-letter residue used for number-gap inference when '
                             'no SEQRES identity is available (default: GLY)')
    parser.add_argument('--max-gap', dest='max_gap', type=int, default=80,
                        help='Do not auto-build any single gap longer than this '
                             '(default: 80)')
    args = parser.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    result_json = outdir / 'result.json'

    def write_error(msg: str) -> None:
        result_json.write_text(json.dumps({'status': 'error', 'message': msg}))

    try:
        if args.carbonara_root not in sys.path:
            sys.path.insert(0, args.carbonara_root)
        from setup_carbonara_allAtom import (  # type: ignore[import-not-found]
            pdbfixer_prepare_structure_before_carbonara,
        )

        out = pdbfixer_prepare_structure_before_carbonara(
            str(args.pdb),
            str(outdir),
            enabled=True,
            residue_name=args.residue_name,
            max_gap=args.max_gap,
            internal_only=True,
        )
        out_path = Path(out)

        # The upstream fn writes this report next to the output.
        report: dict = {}
        report_path = outdir / 'missing_residue_pdbfixer_report.json'
        if report_path.exists():
            try:
                report = json.loads(report_path.read_text())
            except Exception:  # noqa: BLE001
                report = {}
        built = int(report.get('total_inserted_residues', 0)) if report else 0

        fixed_text = None
        if out_path.exists() and out_path.stat().st_size > 0:
            fixed_text = out_path.read_text()

        result_json.write_text(json.dumps({
            'status': 'done',
            'success': fixed_text is not None,
            'residues_built': built,
            'fixed_pdb': fixed_text,
            'report': report,
        }))

    except Exception as exc:  # noqa: BLE001 — surface any failure as result.json
        write_error(str(exc))
        sys.exit(1)


if __name__ == '__main__':
    main()
