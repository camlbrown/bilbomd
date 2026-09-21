"""
carbonara_guinier.py — BilboMD integration artifact.

Runs the Carbonara AutoRg-style Guinier analysis on an uploaded SAXS curve and
writes result.json to --outdir, WITHOUT modifying the data (preview mode). Called
by the BilboMD worker's carbonara-guinier preview queue (the UI "Run Guinier
analysis" panel).

It imports the SAME upstream helpers that the job's feature-D low-q trim uses
(_load_numeric_saxs_table + _select_internal_guinier_interval from
setup_carbonara_allAtom), so the previewed Rg / I(0) / selected interval / trim
point are exactly what `guinier_trim` would apply at run time.

Usage:
    python carbonara_guinier.py --dat /job/saxs.dat --outdir /job \\
        [--carbonara-root /opt/carbonara] [--max-trim-fraction 0.25]

Output (outdir/result.json):
    {"status":"done","success":true,"rg":..,"i0":..,"r2":..,"quality":..,
     "qrg_min":..,"qrg_max":..,"slope":..,"intercept":..,
     "window_q2_min":..,"window_q2_max":..,"trim_q":..,"trimmed_points":..,
     "will_trim":bool,"trim_status":"..","points_total":..,
     "first_q_before":..,"first_q_after":..,
     "points":[{"q2":..,"lnI":..}, ...]}
or on failure:
    {"status":"error","message":"<reason>"}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

# Keep the plotted scatter small enough for a JSON round-trip; SAXS curves are
# usually a few hundred points, so this rarely triggers.
MAX_PLOT_POINTS = 2000


def _json_sanitize(obj):
    """Replace non-finite floats (NaN/Inf) with None so json.dumps emits valid
    JSON (a bare NaN token is invalid JSON and hangs the UI's JSON.parse)."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _json_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_sanitize(v) for v in obj]
    return obj


def load_saxs_robust(path: str):
    """Load q/I[/sigma] from a SAXS file, skipping any non-numeric header/comment
    lines (e.g. REMARK banners on raw uploads). The numeric rows are identical to
    what Carbonara reads once its own header stripping has run, so the Guinier
    result matches the job's feature-D trim."""
    import numpy as np
    # IMPORTANT: this row-keep rule MUST match the client parser
    # (apps/ui/.../carbonaraGuinierMath.ts parseSaxsDat) exactly, because the UI
    # maps this loader's selected point indices back onto its own parsed array. A
    # row is kept iff q and I are finite and positive; the sigma column NEVER
    # affects keep/drop (a bad/absent sigma just means "no sigma" for that row),
    # and non-finite q/I (nan/inf) are dropped. Divergence here shifts the
    # auto-selected Guinier window onto the wrong points.
    rows = []
    with open(path) as fh:
        for line in fh:
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            parts = s.split()
            if len(parts) < 2:
                continue
            try:
                q = float(parts[0])
                inten = float(parts[1])
            except ValueError:
                continue  # header / non-numeric q or I
            if not (math.isfinite(q) and math.isfinite(inten) and q > 0 and inten > 0):
                continue
            sigma = math.nan
            if len(parts) >= 3:
                try:
                    sv = float(parts[2])
                    if math.isfinite(sv) and sv > 0:
                        sigma = sv
                except ValueError:
                    pass  # tolerate a non-numeric sigma token — keep the row
            rows.append((q, inten, sigma))
    if len(rows) < 3:
        raise ValueError('SAXS file has too few numeric q/I rows')
    # Provide sigma only when at least one row has a usable one (missing -> NaN,
    # which the upstream selector handles per-window); otherwise 2 columns.
    if any(math.isfinite(r[2]) for r in rows):
        return np.asarray([[r[0], r[1], r[2]] for r in rows], dtype=float)
    return np.asarray([[r[0], r[1]] for r in rows], dtype=float)


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Preview the Carbonara Guinier analysis; write result.json'
    )
    parser.add_argument('--dat', required=True, help='Path to input SAXS .dat file')
    parser.add_argument('--outdir', required=True, help='Output directory')
    parser.add_argument('--carbonara-root', default='/opt/carbonara',
                        help='Carbonara checkout root (default: /opt/carbonara)')
    parser.add_argument('--max-trim-fraction', dest='max_trim_fraction',
                        type=float, default=0.25,
                        help='Cap on the low-q fraction the trim may remove '
                             '(default: 0.25, matching the job default)')
    args = parser.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    result_json = outdir / 'result.json'

    def write_error(msg: str) -> None:
        result_json.write_text(json.dumps({'status': 'error', 'message': msg}))

    try:
        if args.carbonara_root not in sys.path:
            sys.path.insert(0, args.carbonara_root)
        import numpy as np
        from setup_carbonara_allAtom import (  # type: ignore[import-not-found]
            _select_internal_guinier_interval,
        )

        arr0 = load_saxs_robust(args.dat)
        # Same preprocessing as guinier_trim_saxs_file_inplace: keep positive
        # (q, I), sort by q.
        positive = (arr0[:, 0] > 0) & (arr0[:, 1] > 0)
        arr = arr0[positive]
        if arr.shape[0] < 3:
            write_error('Not enough positive SAXS points for Guinier analysis.')
            return
        arr = arr[np.argsort(arr[:, 0])]
        n = int(arr.shape[0])

        try:
            selected = _select_internal_guinier_interval(
                arr, max_trim_fraction=float(args.max_trim_fraction)
            )
        except Exception as exc:  # no acceptable interval
            write_error(f'No acceptable Guinier interval found: {exc}')
            return

        q = arr[:, 0]
        intensity = arr[:, 1]
        start = int(selected['start'])
        end = int(selected['end'])
        slope = float(selected['slope'])
        intercept = float(selected['intercept'])
        rg = float(selected['rg'])
        i0 = float(math.exp(intercept))

        # Replicate the trim cap: guinier_trim only removes the leading `start`
        # points when start <= floor(max_trim_fraction * n).
        max_trim_points = int(math.floor(float(args.max_trim_fraction) * n))
        will_trim = bool(start > 0 and start <= max_trim_points)
        if start == 0:
            trim_status = 'already_good_no_trim_needed'
        elif start <= max_trim_points:
            trim_status = 'trim_applied'
        else:
            trim_status = 'selected_interval_exceeds_max_trim_fraction_no_trim_applied'

        window_q = q[start:end]
        first_q_after = float(q[start]) if will_trim else float(q[0])

        # Build the scatter (ln I vs q^2); subsample if unusually large.
        stride = max(1, int(math.ceil(n / MAX_PLOT_POINTS)))
        points = []
        for i in range(0, n, stride):
            iq = float(intensity[i])
            if iq > 0:
                points.append({'q2': float(q[i]) ** 2, 'lnI': float(math.log(iq))})

        result = {
            'status': 'done',
            'success': True,
            'rg': rg,
            'i0': i0,
            'r2': float(selected['r2']),
            'quality': float(selected['quality']),
            'qrg_min': float(selected['qrg_min']),
            'qrg_max': float(selected['qrg_max']),
            'slope': slope,
            'intercept': intercept,
            'window_q2_min': float(np.min(window_q) ** 2),
            'window_q2_max': float(np.max(window_q) ** 2),
            'trim_q': float(q[start]),
            'trimmed_points': int(start) if will_trim else 0,
            'will_trim': will_trim,
            'trim_status': trim_status,
            'selection_status': selected.get('selection_status'),
            'points_total': n,
            'first_q_before': float(q[0]),
            'first_q_after': first_q_after,
            'first_point_1_indexed': int(selected['first_point']),
            'last_point_1_indexed': int(selected['last_point']),
            'points': points,
        }
        result_json.write_text(json.dumps(_json_sanitize(result), allow_nan=False))
    except Exception as exc:  # pragma: no cover - defensive
        write_error(f'{type(exc).__name__}: {exc}')


if __name__ == '__main__':
    main()
