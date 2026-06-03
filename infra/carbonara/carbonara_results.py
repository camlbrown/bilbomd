"""
carbonara_results.py — BilboMD integration artifact (results analysis, R1).

Runs the Carbonara Stage-2 "Analysis" pipeline on a finished (or in-progress)
job and writes a single structured results/analysis.json that the BilboMD web UI
renders. It reuses the upstream fittingAnalysis module (`fa`) so the numbers
match the notebooks, but does its OWN collection because the BilboMD worker lays
all-atom output out as results/all_atom/<model>/<model>_AA.pdb (one dir per
model) rather than the notebook's allAtomRun<N>/ layout.

Run inside the Carbonara container (fittingAnalysis + MDTraj + pyFoXS live at
/opt/carbonara). Invoked by the BilboMD worker, analogous to carbonara_autoflex.py.

Usage:
    python carbonara_results.py --results-dir /job/results
        [--carbonara-root /opt/carbonara] [--original /job/model.cif]
        [--saxs /job/saxs.dat] [--chi2-threshold 2.5] [--max-pairwise 40]
        [--foxs-cmd pyfoxs] [--out /job/results/analysis.json]

Every section is computed defensively: a failure in one (e.g. metrics needing
all-atom models that don't exist yet) is recorded in analysis.json under
"warnings" and the rest still emit. Always writes analysis.json (status "done"
unless a fatal error, then "error").
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
from pathlib import Path


CHI2_RE = re.compile(r'Chi\^?2\s*=\s*([0-9.eE+\-]+)', re.IGNORECASE)
C1_RE = re.compile(r'\bc1\s*=\s*([0-9.eE+\-]+)')
C2_RE = re.compile(r'\bc2\s*=\s*([0-9.eE+\-]+)')


# ---------------------------------------------------------------------------
# Collection (BilboMD worker layout)
# ---------------------------------------------------------------------------

def _model_id(aa_pdb: Path) -> tuple[str, int, int]:
    """('mol1_sub_0_end', run=1, sub=0) from a *_AA.pdb path."""
    name = aa_pdb.stem[:-3] if aa_pdb.stem.endswith('_AA') else aa_pdb.stem
    m = re.search(r'mol(\d+)_sub_(\d+)', name)
    run = int(m.group(1)) if m else 0
    sub = int(m.group(2)) if m else 0
    return name, run, sub


def _foxs_chi2_for(model_dir: Path, aa_pdb: Path) -> float | None:
    """Read chi^2 for an AA model from its sibling foxs_results.txt
    (lines: '<aa_pdb_path> <chi2>'). Falls back to any line in the file."""
    fr = model_dir / 'foxs_results.txt'
    if not fr.exists():
        return None
    best = None
    for line in fr.read_text().splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            chi2 = float(parts[1])
        except ValueError:
            continue
        if Path(parts[0]).name == aa_pdb.name:
            return chi2
        if best is None:
            best = chi2
    return best


def collect_predictions(results_dir: Path) -> list[dict]:
    """Collect all-atom predictions from results/all_atom/<model>/<model>_AA.pdb."""
    preds: list[dict] = []
    aa_root = results_dir / 'all_atom'
    for aa_pdb in sorted(aa_root.glob('*/*_AA.pdb')):
        name, run, sub = _model_id(aa_pdb)
        preds.append({
            'id': name,
            'run': run,
            'sub': sub,
            'aa_pdb': str(aa_pdb.relative_to(results_dir)),
            'chi2': _foxs_chi2_for(aa_pdb.parent, aa_pdb)
        })
    return preds


# ---------------------------------------------------------------------------
# FoXS fit curve for one model (reuses the initfoxs approach)
# ---------------------------------------------------------------------------

def foxs_curve(model_pdb: Path, saxs: Path, foxs_cmd: str, max_q: float | None,
               workdir: Path) -> dict | None:
    """Run FoXS (model vs experimental SAXS) and parse the .fit into
    {chi2, c1, c2, foxs:[{q,exp,model,error}]}. Returns None on failure."""
    try:
        cmd = foxs_cmd.split() + [model_pdb.name, saxs.name]
        if max_q is not None:
            cmd += ['--max_q', str(max_q)]
        # FoXS writes <pdbstem>_<datstem>.fit in cwd; run in a dir holding both.
        import shutil
        workdir.mkdir(parents=True, exist_ok=True)
        shutil.copy(str(model_pdb), str(workdir / model_pdb.name))
        shutil.copy(str(saxs), str(workdir / saxs.name))
        proc = subprocess.run(cmd, cwd=str(workdir), stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True)
        out = proc.stdout or ''
        fits = list(workdir.glob('*.fit'))
        if not fits:
            return None
        chi2 = None
        rows = []
        for line in fits[0].read_text().splitlines():
            s = line.strip()
            if not s:
                continue
            if s.startswith('#'):
                m = CHI2_RE.search(s)
                if m:
                    try:
                        chi2 = float(m.group(1))
                    except ValueError:
                        pass
                continue
            p = s.split()
            if len(p) < 4:
                continue
            try:
                rows.append({'q': float(p[0]), 'exp': float(p[1]),
                             'error': float(p[2]), 'model': float(p[3])})
            except ValueError:
                continue
        c1 = c2 = None
        m1 = C1_RE.search(out)
        m2 = C2_RE.search(out)
        if m1:
            try:
                c1 = float(m1.group(1))
            except ValueError:
                pass
        if m2:
            try:
                c2 = float(m2.group(1))
            except ValueError:
                pass
        return {'chi2': chi2, 'c1': c1, 'c2': c2, 'foxs': rows}
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description='Carbonara results analysis -> analysis.json')
    ap.add_argument('--results-dir', required=True)
    ap.add_argument('--carbonara-root', default='/opt/carbonara')
    ap.add_argument('--original', default=None, help='Original structure (pdb/cif) for Rg')
    ap.add_argument('--saxs', default=None, help='Experimental SAXS .dat for the best-model FoXS curve')
    ap.add_argument('--chi2-threshold', type=float, default=2.5)
    ap.add_argument('--max-pairwise', type=int, default=40,
                    help='Cap predictions used for pairwise metrics (O(n^2))')
    ap.add_argument('--foxs-cmd', default='pyfoxs')
    ap.add_argument('--max_q', type=float, default=0.2)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    results_dir = Path(args.results_dir)
    out_path = Path(args.out) if args.out else results_dir / 'analysis.json'
    warnings: list[str] = []

    payload: dict = {
        'status': 'done',
        'chi2_threshold': args.chi2_threshold,
        'predictions': [],
        'convergence': [],
        'histograms': {},
        'best': None,
        'warnings': warnings
    }

    try:
        sys.path.insert(0, args.carbonara_root)
        import fittingAnalysis as fa  # noqa: E402 (heavy import)

        scenario_dir = results_dir / 'carbonara_run'
        fitdata_dir = scenario_dir / 'fitdata'

        # --- predictions (all-atom) + chi2 ---
        preds = collect_predictions(results_dir)
        if not preds:
            warnings.append('No all-atom predictions found under results/all_atom.')

        # --- Rg per prediction + original ---
        for p in preds:
            try:
                p['rg'] = float(fa.radius_of_gyration(str(results_dir / p['aa_pdb'])))
            except Exception as e:  # noqa: BLE001
                p['rg'] = None
                warnings.append(f"Rg failed for {p['id']}: {e}")
        original_rg = None
        if args.original and Path(args.original).exists():
            try:
                original_rg = float(fa.radius_of_gyration(args.original))
            except Exception as e:  # noqa: BLE001
                warnings.append(f'Rg failed for original: {e}')

        aa_paths = [str(results_dir / p['aa_pdb']) for p in preds]

        # --- structural variation: pairwise + vs original (capped) ---
        rmsd_pairwise = tm_pairwise = []
        rmsd_vs_orig = tm_vs_orig = []
        capped = aa_paths[: args.max_pairwise]
        if len(capped) < len(aa_paths):
            warnings.append(
                f'Pairwise metrics capped at {args.max_pairwise} of {len(aa_paths)} predictions.')
        if len(capped) >= 2:
            try:
                pw = fa.pairwise_structure_metrics(capped, fa.compare_structures_vals)
                rmsd_pairwise = [r['rmsd'] for r in pw]
                tm_pairwise = [r['tm'] for r in pw]
            except Exception as e:  # noqa: BLE001
                warnings.append(f'Pairwise metrics failed: {e}')
        if capped:
            try:
                vo = fa.structure_metrics_vs_carbonara(
                    pdb_files=capped, carbonara_dir=str(scenario_dir),
                    compare_func=fa.compare_structures_vals_carbonara)
                rmsd_vs_orig = [r['rmsd'] for r in vo]
                tm_vs_orig = [r['tm'] for r in vo]
                # attach per-prediction rmsd/tm vs original
                by_pdb = {Path(r['pdb']).name: r for r in vo}
                for p in preds:
                    r = by_pdb.get(Path(p['aa_pdb']).name)
                    if r:
                        p['rmsd_to_original'] = r['rmsd']
                        p['tm_to_original'] = r['tm']
            except Exception as e:  # noqa: BLE001
                warnings.append(f'vs-original metrics failed: {e}')

        payload['histograms'] = {
            'rmsd': {'pairwise': rmsd_pairwise, 'vs_original': rmsd_vs_orig},
            'tm': {'pairwise': tm_pairwise, 'vs_original': tm_vs_orig},
            'rg': {
                'predictions': [p['rg'] for p in preds if p.get('rg') is not None],
                'original': original_rg
            }
        }

        # --- convergence from fit logs (NDJSON) ---
        for log in sorted(fitdata_dir.glob('fitLog*.dat')):
            try:
                runs = fa.read_fitlog_runs(str(log))
                for ri, df in enumerate(runs):
                    pts = [
                        {
                            'step': int(row.FitStep),
                            'chi2': float(row.ScatterFitFirst),
                            'penalty': float(row.OverlapPenalty),
                            'elapsed_min': float(row.ElapsedTimeMin)
                        }
                        for row in df.itertuples()
                    ]
                    if pts:
                        payload['convergence'].append({
                            'log': log.name, 'run': ri + 1, 'points': pts})
            except Exception as e:  # noqa: BLE001
                warnings.append(f'fit-log parse failed for {log.name}: {e}')

        # --- best model + its FoXS fit curve ---
        scored = [p for p in preds if p.get('chi2') is not None]
        if scored:
            best = min(scored, key=lambda p: p['chi2'])
            payload['best'] = {'id': best['id'], 'chi2': best['chi2']}
            if args.saxs and Path(args.saxs).exists():
                curve = foxs_curve(results_dir / best['aa_pdb'], Path(args.saxs),
                                   args.foxs_cmd, args.max_q,
                                   results_dir / '_foxs_tmp')
                if curve:
                    payload['best']['fit'] = curve
                else:
                    warnings.append('Best-model FoXS curve unavailable.')

        payload['predictions'] = preds
        payload['n_predictions'] = len(preds)

    except Exception as exc:  # noqa: BLE001 — fatal
        payload['status'] = 'error'
        payload['message'] = str(exc)

    out_path.write_text(json.dumps(payload))
    print(f'wrote {out_path} (status={payload["status"]}, '
          f'{len(payload["predictions"])} predictions, '
          f'{len(payload["convergence"])} convergence runs, '
          f'{len(warnings)} warnings)')


if __name__ == '__main__':
    main()
