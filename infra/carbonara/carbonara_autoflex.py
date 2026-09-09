"""
carbonara_autoflex.py — BilboMD integration artifact (Block 2.4).

Runs Carbonara's *setup* phase on a structure + SAXS file to obtain the
auto-selected flexible (varying) linker sections, then maps those sections to
per-chain PDB residue ranges so the BilboMD UI can highlight them in the 3D
viewer BEFORE a fit is submitted. Writes result.json to --outdir.

This intentionally reuses the validated upstream pipeline rather than
re-implementing the science:
  1. setup_carbonara.py  -> writes carbonara_runs/<name>/varyingSectionSecondary1.dat
     (the auto-selected global SS-section indices) + fingerPrint1.dat.
  2. CarbonaraDataTools.possibleLinkerList_all_chains(fp, pdb) -> maps every '-'
     (linker) section to 'Chain <n> ResID: <start>-<end>'.
  3. Keep only the sections that appear in varyingSectionSecondary1.dat.

setup_carbonara.py's auto-selection runs the C++ generate_structure binary via
os.getcwd()+'/build/bin/generate_structure', so (mirroring the wrapper's
prepare_runtime_layout) we symlink build/ and probabilityInterpolation/ into the
work dir and run setup with cwd=work dir.

Usage:
    python carbonara_autoflex.py \\
        --pdb  /job/model.pdb \\
        --saxs /job/saxs.dat  \\
        --outdir /job         \\
        [--carbonara-root /opt/carbonara] [--min_q 0.01] [--max_q 0.2]

Output (outdir/result.json):
    {"status": "done",
     "flex_ranges": [{"chain": 1, "ranges": [[start, stop], ...]}, ...],
     "sections": [<global section index>, ...],
     "all_linkers": [{"segment": n, "chain": c, "start": s, "stop": e,
                      "selected": true/false}, ...]}
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
from pathlib import Path


LINKER_LABEL_RE = re.compile(r"Chain\s+(\d+)\s+ResID:\s*(-?\d+)-(-?\d+)")


def _convert_cif_to_pdb(cif_path: Path, out_pdb: Path) -> None:
    """Convert CIF/mmCIF -> PDB using openmm.app (fast, ~0.1s).

    Mirrors carbonara_initfoxs._convert_cif_to_pdb: avoids importing the heavy
    CarbonaraDataTools/torch/biobox stack just to change file format. Auth
    residue numbering is preserved, which the residue-range mapping relies on.
    """
    from openmm.app import PDBxFile, PDBFile  # type: ignore[import-untyped]
    pdbx = PDBxFile(str(cif_path))
    with open(str(out_pdb), 'w') as fh:
        PDBFile.writeFile(pdbx.topology, pdbx.positions, fh)
    if not (out_pdb.exists() and out_pdb.stat().st_size > 0):
        raise RuntimeError(f'CIF -> PDB conversion produced no output for: {cif_path}')


def _link_runtime_layout(carbonara_root: Path, workroot: Path) -> None:
    """Symlink build/ + probabilityInterpolation/ into workroot.

    setup's auto-selection invokes <cwd>/build/bin/generate_structure, so the
    work dir must look enough like the Carbonara repo root.
    """
    for name in ('build', 'probabilityInterpolation'):
        target = carbonara_root / name
        if not target.exists():
            raise RuntimeError(f'Carbonara {name} directory not found: {target}')
        link = workroot / name
        if link.is_symlink() or link.exists():
            continue
        os.symlink(str(target), str(link))


def _read_sections(vs_file: Path) -> list[int]:
    """Read varyingSectionSecondary1.dat -> sorted unique global section ints."""
    if not vs_file.exists():
        return []
    out: set[int] = set()
    for tok in vs_file.read_text().split():
        tok = tok.strip()
        if not tok:
            continue
        try:
            out.add(int(float(tok)))
        except ValueError:
            continue
    return sorted(out)


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Compute Carbonara auto-flexible linker ranges; write result.json'
    )
    parser.add_argument('--pdb', required=True, help='Path to PDB or CIF file')
    parser.add_argument('--saxs', required=True, help='Path to SAXS .dat file')
    parser.add_argument('--outdir', required=True, help='Output directory')
    parser.add_argument('--carbonara-root', default='/opt/carbonara',
                        help='Carbonara checkout root (default: /opt/carbonara)')
    parser.add_argument('--name', default='autoflex', help='Scenario name')
    parser.add_argument('--min_q', type=float, default=0.01)
    parser.add_argument('--max_q', type=float, default=0.2)
    # Optional PAE-guided selection (Carbonara's --alphaFoldFlex getFlexibility
    # path). When --pae is given, setup selects flexible linkers from the PAE
    # matrix instead of the sheet-breaking auto heuristic. The downstream
    # varyingSectionSecondary -> residue-range mapping is identical either way.
    parser.add_argument('--pae', default=None, help='Optional PAE JSON file')
    parser.add_argument('--pae_flex_threshold', type=float, default=16.0,
                        help='Absolute Å PAE threshold (default 16)')
    # Feature E (a): disulfide-safe linker selection. Detect Cys SG-SG bonds and,
    # unless disabled, drop auto-selected linkers whose reshaping would break a
    # real disulfide (akin to not breaking beta sheets). On by default when S-S
    # bonds are present; --no-disulfide-check restores the S-S-unaware suggestions.
    parser.add_argument('--no-disulfide-check', dest='no_disulfide_check',
                        action='store_true',
                        help='Do not exclude linkers that would break disulfide bonds')
    args = parser.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    result_json = outdir / 'result.json'
    log_path = outdir / 'autoflex.log'

    def write_error(msg: str) -> None:
        result_json.write_text(json.dumps({'status': 'error', 'message': msg}))

    try:
        carbonara_root = Path(args.carbonara_root)
        setup_script = carbonara_root / 'setup_carbonara.py'
        if not setup_script.exists():
            write_error(f'setup_carbonara.py not found under {carbonara_root}')
            sys.exit(1)

        # Convert CIF -> PDB up front so both setup and the residue mapping use a
        # PDB (biobox residue extraction is most reliable with PDB).
        pdb_path = Path(args.pdb)
        if pdb_path.suffix.lower() in ('.cif', '.mmcif'):
            converted = outdir / (pdb_path.stem + '_autoflex.pdb')
            _convert_cif_to_pdb(pdb_path, converted)
            pdb_path = converted

        workroot = outdir / 'work'
        workroot.mkdir(parents=True, exist_ok=True)
        _link_runtime_layout(carbonara_root, workroot)

        # Clamp max_q to just inside the experimental SAXS range: setup runs the
        # C++ generator, which segfaults if max_q exceeds the data's largest q
        # (mirrors the wrapper's clamp). Clamp to the second-largest q point.
        effective_max_q = args.max_q
        try:
            qs = []
            with open(args.saxs, errors='replace') as fh:
                for line in fh:
                    parts = line.split()
                    if len(parts) < 2:
                        continue
                    try:
                        q = float(parts[0])
                        float(parts[1])
                    except ValueError:
                        continue
                    qs.append(q)
            qs = sorted(set(qs))
            if len(qs) >= 2 and effective_max_q > qs[-2]:
                effective_max_q = qs[-2]
        except Exception:  # noqa: BLE001
            pass

        cmd = [
            sys.executable, str(setup_script),
            '--pdb', str(pdb_path),
            '--saxs', str(args.saxs),
            '--name', args.name,
            '--dir', str(workroot),
            '--min_q', str(args.min_q),
            '--max_q', str(effective_max_q)
        ]
        if args.pae:
            pae_path = Path(args.pae)
            if not pae_path.exists():
                write_error(f'PAE file not found: {pae_path}')
                sys.exit(1)
            cmd += [
                '--alphaFoldFlex',
                '--pae', str(pae_path),
                '--pae_flex_threshold', str(args.pae_flex_threshold)
            ]
        proc = subprocess.run(
            cmd, cwd=str(workroot),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        log_path.write_text(proc.stdout or '')
        if proc.returncode != 0:
            write_error(
                f'setup_carbonara.py exited with code {proc.returncode}; '
                f'see autoflex.log for details'
            )
            sys.exit(1)

        refine_dir = workroot / 'carbonara_runs' / args.name
        vs_file = refine_dir / 'varyingSectionSecondary1.dat'
        fp_file = refine_dir / 'fingerPrint1.dat'
        if not fp_file.exists():
            write_error(f'fingerPrint1.dat not produced by setup ({fp_file})')
            sys.exit(1)

        sections = _read_sections(vs_file)
        section_set = set(sections)

        # Map every linker section to its per-chain residue range.
        sys.path.insert(0, str(carbonara_root))
        import CarbonaraDataTools as cdt  # noqa: E402  (heavy import, after setup)
        rows = cdt.possibleLinkerList_all_chains(str(fp_file), str(pdb_path))

        # Feature E (a): detect disulfides and, unless disabled, restrict the
        # auto-selected linkers to the disulfide-safe subset. All defensive: any
        # failure falls back to the S-S-unaware selection so the preview never
        # breaks. No-op (returns input unchanged) when the structure has no S-S.
        disulfide_bonds: list[dict] = []
        disulfide_check_applied = False
        safe_section_set = set(section_set)
        try:
            raw_bonds = cdt.find_disulfide_bonds_from_pdb(str(pdb_path)) or []
            for a, b in raw_bonds:
                disulfide_bonds.append({
                    'chain_a': str(a[0]), 'res_a': int(a[1]),
                    'chain_b': str(b[0]), 'res_b': int(b[1])
                })
        except Exception as exc:  # noqa: BLE001
            print(f'[autoflex] disulfide detection failed: {exc}', flush=True)

        if disulfide_bonds and not args.no_disulfide_check:
            try:
                coords_file = refine_dir / 'coordinates1.dat'
                safe = cdt.disulfide_safe_linkers(
                    list(sections), str(pdb_path), str(coords_file), str(fp_file)
                )
                safe_section_set = {int(x) for x in safe}
                disulfide_check_applied = True
            except Exception as exc:  # noqa: BLE001
                print(f'[autoflex] disulfide_safe_linkers failed: {exc}', flush=True)
                safe_section_set = set(section_set)

        all_linkers: list[dict] = []
        by_chain: dict[int, list[list[int]]] = {}
        if rows is not None and len(rows) > 0:
            for row in rows:
                seg = int(row[0])
                m = LINKER_LABEL_RE.search(str(row[1]))
                if not m:
                    continue
                chain = int(m.group(1))
                start = int(m.group(2))
                stop = int(m.group(3))
                selected = seg in safe_section_set
                # Was auto-selected by setup but dropped by the disulfide check.
                disulfide_excluded = seg in section_set and seg not in safe_section_set
                all_linkers.append({
                    'segment': seg, 'chain': chain,
                    'start': start, 'stop': stop, 'selected': selected,
                    'disulfide_excluded': disulfide_excluded
                })
                if selected:
                    by_chain.setdefault(chain, []).append([start, stop])

        flex_ranges = [
            {'chain': c, 'ranges': by_chain[c]} for c in sorted(by_chain)
        ]

        result_json.write_text(json.dumps({
            'status': 'done',
            'flex_ranges': flex_ranges,
            # Post-disulfide-check selected sections (the recommended set).
            'sections': sorted(safe_section_set & set(sections)),
            'all_linkers': all_linkers,
            'disulfide_bonds': disulfide_bonds,
            'disulfide_check_applied': disulfide_check_applied
        }))

    except Exception as exc:  # noqa: BLE001 — surface any failure as result.json
        write_error(str(exc))
        sys.exit(1)


if __name__ == '__main__':
    main()
