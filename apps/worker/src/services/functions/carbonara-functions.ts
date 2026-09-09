import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { once } from 'node:events'

// ---------------------------------------------------------------------------
// Carbonara worker helpers.
//
// These functions implement the BilboMD side of the validated Carbonara
// wrapper contract (carbonara_bilbomd_runner_refined.py). The worker mounts an
// isolated job directory at /job inside the Carbonara container, writes a
// job.json describing inputs/outputs, and launches the wrapper. The wrapper
// writes results/wrapper_summary.json which we parse to decide success.
//
// The pure builder/parser functions deliberately take all values as arguments
// (no config import) so they can be unit tested without a worker environment.
// ---------------------------------------------------------------------------

// Path inside the container where the host job directory is mounted.
export const CARBONARA_JOB_MOUNT = '/job'

export interface CarbonaraJobParameters {
  fit_n_times: number
  min_q: number
  max_q: number
  max_q_start: number
  max_fit_steps: number
  mixture_n: number
  max_mixture_combos?: number
  rotation?: boolean
  alphaFoldFlex?: boolean
  pae?: string
  pae_flex_threshold?: number
  constraints_file?: string
  // B7: manual flexibility — object form {"1": [[start,stop],...]}
  flex_ranges?: Record<string, number[][]>
  // B8: chain merges — [[i,j],...] 1-based sequential pairs
  chain_merges?: number[][]
  // Feature G (opt-in): PDBFixer missing-residue repair before setup. Emitted
  // only when enabled so existing jobs stay byte-identical.
  fix_missing_residues?: boolean
  fix_missing_residue_name?: string
  fix_missing_residue_max_gap?: number
}

export interface CarbonaraJobJson {
  job_name: string
  carbonara_root: string
  pdb: string
  saxs: string
  // Multi-structure mixture: in-container paths to additional structures
  // (species 2..n). Omitted for single-structure / same-structure-mixture jobs.
  mixture_pdbs?: string[]
  workdir: string
  outdir: string
  parameters: CarbonaraJobParameters
}

export interface BuildCarbonaraJobJsonOptions {
  jobName: string
  carbonaraRoot: string
  // Basenames of the structure and SAXS files as they sit in the job mount.
  pdbFileName: string
  saxsFileName: string
  parameters: CarbonaraJobParameters
  // Optional PAE-guided flexibility. When alphaFoldFlex is true and
  // paeFileName is set the wrapper receives alphaFoldFlex/pae/pae_flex_threshold.
  paeFileName?: string
  alphaFoldFlex?: boolean
  paeFlexThreshold?: number
  // Optional constraints file basename (in job mount). When set, emits
  // parameters.constraints_file as an in-container path.
  constraintsFileName?: string
  // B7: 3-way flexibility mode and manual residue ranges.
  // When flexMode==='manual' and flexRanges has entries, emits flex_ranges as
  // an object { "1": [[start,stop],...] } and does NOT emit alphaFoldFlex.
  flexMode?: string
  flexRanges?: { chain: number; ranges: number[][] }[]
  // B8: multimer mode and sequential chain-merge pairs.
  // chain_merges is emitted ONLY when multimer===true AND chainMerges.length>0.
  multimer?: boolean
  chainMerges?: number[][]
  // Multi-structure mixture: basenames of the additional structure files in the
  // job mount (species 2..n). Emitted as job.json mixture_pdbs when present.
  mixturePdbFileNames?: string[]
  // Feature G (opt-in): PDBFixer missing-residue repair. When fixMissingResidues
  // is true, emits parameters.fix_missing_residues (+ optional name/max_gap).
  fixMissingResidues?: boolean
  fixMissingResidueName?: string
  fixMissingResidueMaxGap?: number
  // In-container prefix for the job dir. Defaults to CARBONARA_JOB_MOUNT ('/job')
  // for podman mode (bind mount). In inprocess/k8s mode there is no bind mount, so
  // the caller passes the REAL host job dir here and every emitted path is absolute
  // and directly valid in the worker pod.
  jobMount?: string
}

/**
 * Build the job.json object consumed by carbonara_bilbomd_runner_refined.py.
 * Inputs are expressed as absolute in-container paths under the /job mount.
 *
 * Flexibility modes (mutually exclusive — B7):
 *   - auto (default): no extra parameters emitted (byte-identical to Phase-1).
 *   - pae: emits alphaFoldFlex/pae/pae_flex_threshold when alphaFoldFlex is
 *     true AND paeFileName is set.
 *   - manual: emits parameters.flex_ranges as an object
 *     { "<chain>": [[start,stop],...] } and does NOT emit alphaFoldFlex.
 *
 * When alphaFoldFlex is false or paeFileName is absent, PAE keys are not
 * emitted, keeping Phase-1 output byte-identical.
 */
export const buildCarbonaraJobJson = (
  opts: BuildCarbonaraJobJsonOptions
): CarbonaraJobJson => {
  const jobMount = opts.jobMount ?? CARBONARA_JOB_MOUNT
  const baseParameters: CarbonaraJobParameters = {
    fit_n_times: opts.parameters.fit_n_times,
    min_q: opts.parameters.min_q,
    max_q: opts.parameters.max_q,
    max_q_start: opts.parameters.max_q_start,
    max_fit_steps: opts.parameters.max_fit_steps,
    mixture_n: opts.parameters.mixture_n,
    rotation: opts.parameters.rotation ?? false
  }

  // Only forward max_mixture_combos for real mixtures (the wrapper passes it to
  // the setup script only when present).
  if (
    opts.parameters.mixture_n > 1 &&
    opts.parameters.max_mixture_combos !== undefined
  ) {
    baseParameters.max_mixture_combos = opts.parameters.max_mixture_combos
  }

  if (opts.flexMode === 'manual' && opts.flexRanges && opts.flexRanges.length > 0) {
    // Manual residue-range flexibility: convert [{chain, ranges}] to
    // {"<chain>": [[start,stop],...]} object form for the wrapper.
    const flexRangesObj: Record<string, number[][]> = {}
    for (const entry of opts.flexRanges) {
      flexRangesObj[String(entry.chain)] = entry.ranges
    }
    baseParameters.flex_ranges = flexRangesObj
    // Do NOT emit alphaFoldFlex in manual mode (mutual exclusion).
  } else if (opts.alphaFoldFlex === true && opts.paeFileName) {
    // PAE-guided flexibility: pass flags through to setup_carbonara.py.
    baseParameters.alphaFoldFlex = true
    baseParameters.pae = `${jobMount}/${opts.paeFileName}`
    baseParameters.pae_flex_threshold = opts.paeFlexThreshold ?? 16.0
  }
  // auto mode: no extra keys emitted (Phase-1 byte-identical).

  if (opts.constraintsFileName) {
    baseParameters.constraints_file = `${jobMount}/${opts.constraintsFileName}`
  }

  // B8: emit chain_merges only when multimer mode is on and merges are present.
  if (opts.multimer === true && opts.chainMerges && opts.chainMerges.length > 0) {
    baseParameters.chain_merges = opts.chainMerges
  }

  // Feature G (opt-in): PDBFixer missing-residue repair. Only emit the keys when
  // enabled, so an un-opted job stays byte-identical to before.
  if (opts.fixMissingResidues === true) {
    baseParameters.fix_missing_residues = true
    if (opts.fixMissingResidueName) {
      baseParameters.fix_missing_residue_name = opts.fixMissingResidueName
    }
    if (opts.fixMissingResidueMaxGap !== undefined) {
      baseParameters.fix_missing_residue_max_gap = opts.fixMissingResidueMaxGap
    }
  }

  const jobJson: CarbonaraJobJson = {
    job_name: opts.jobName,
    carbonara_root: opts.carbonaraRoot,
    pdb: `${jobMount}/${opts.pdbFileName}`,
    saxs: `${jobMount}/${opts.saxsFileName}`,
    workdir: `${jobMount}/work`,
    outdir: `${jobMount}/results`,
    parameters: baseParameters
  }

  // Multi-structure mixture: additional structure paths in the job mount.
  if (opts.mixturePdbFileNames && opts.mixturePdbFileNames.length > 0) {
    jobJson.mixture_pdbs = opts.mixturePdbFileNames.map(
      (name) => `${jobMount}/${name}`
    )
  }

  return jobJson
}

export interface BuildCarbonaraContainerArgsOptions {
  image: string
  // Host directory to bind-mount at /job.
  hostJobDir: string
  // In-container path to the job.json (defaults under the mount).
  jobJsonContainerPath?: string
  runnerPath: string
  pythonBin: string
  // Optional host path to bind-mount over the in-container wrapper for local
  // dev iteration without an image rebuild. When non-empty, inserts
  // -v <runnerMountHost>:<runnerPath>:ro,Z before the image arg.
  runnerMountHost?: string
  // Optional host path + in-container path to overlay an updated
  // CarbonaraDataTools.py (mount-to-validate before an image rebuild).
  dataToolsMountHost?: string
  dataToolsPath?: string
}

/**
 * Build the argument vector for the container engine (e.g. podman). Matches the
 * locally validated invocation:
 *   podman run --rm -v <hostJobDir>:/job:Z [runnerMount] <image> \
 *     python <runnerPath> --job-json /job/job.json --clean
 *
 * When opts.runnerMountHost is non-empty, an additional bind-mount is inserted
 * before the image arg so the host wrapper overlays the baked-in copy without
 * requiring an image rebuild (CARBONARA_RUNNER_MOUNT dev workflow). The same
 * applies to opts.dataToolsMountHost for CarbonaraDataTools.py.
 */
export const buildCarbonaraContainerArgs = (
  opts: BuildCarbonaraContainerArgsOptions
): string[] => {
  const jobJson =
    opts.jobJsonContainerPath ?? `${CARBONARA_JOB_MOUNT}/job.json`
  const args = ['run', '--rm', '-v', `${opts.hostJobDir}:${CARBONARA_JOB_MOUNT}:Z`]
  if (opts.runnerMountHost) {
    args.push('-v', `${opts.runnerMountHost}:${opts.runnerPath}:ro,Z`)
  }
  if (opts.dataToolsMountHost && opts.dataToolsPath) {
    args.push('-v', `${opts.dataToolsMountHost}:${opts.dataToolsPath}:ro,Z`)
  }
  args.push(opts.image, opts.pythonBin, opts.runnerPath, '--job-json', jobJson, '--clean')
  return args
}

export interface CarbonaraWrapperSummary {
  status?: string
  return_code?: number
  validation_error?: string
  n_nonempty_fit_logs?: number
  n_nonempty_final_model_files?: number
  n_nonempty_model_like_files?: number
  final_model_files?: string[]
  fitdata_dir?: string
  [key: string]: unknown
}

export interface CarbonaraResult {
  succeeded: boolean
  status: string
  returnCode: number | null
  finalModelCount: number
  fitLogCount: number
  message: string
  summary: CarbonaraWrapperSummary
}

/**
 * Parse the wrapper_summary.json text and derive a BilboMD-facing result.
 * A run is considered successful only when the wrapper reports status
 * "completed" with return_code 0.
 */
export const parseCarbonaraSummary = (jsonText: string): CarbonaraResult => {
  let summary: CarbonaraWrapperSummary
  try {
    summary = JSON.parse(jsonText) as CarbonaraWrapperSummary
  } catch (error) {
    throw new Error(
      `Could not parse Carbonara wrapper_summary.json: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  const status = typeof summary.status === 'string' ? summary.status : 'unknown'
  const returnCode =
    typeof summary.return_code === 'number' ? summary.return_code : null
  const finalModelCount =
    typeof summary.n_nonempty_final_model_files === 'number'
      ? summary.n_nonempty_final_model_files
      : 0
  const fitLogCount =
    typeof summary.n_nonempty_fit_logs === 'number'
      ? summary.n_nonempty_fit_logs
      : 0

  const succeeded = status === 'completed' && returnCode === 0

  let message: string
  if (succeeded) {
    message = `Carbonara completed: ${finalModelCount} final model(s), ${fitLogCount} fit log(s)`
  } else if (summary.validation_error) {
    message = `Carbonara failed (${status}): ${summary.validation_error}`
  } else {
    message = `Carbonara failed (status=${status}, return_code=${returnCode})`
  }

  return {
    succeeded,
    status,
    returnCode,
    finalModelCount,
    fitLogCount,
    message,
    summary
  }
}

// ---------------------------------------------------------------------------
// A2 — cg2all all-atom reconstruction helpers (pure, no config import)
// ---------------------------------------------------------------------------

/**
 * Derive the fingerprint filename from a coords basename.
 * Matches /_sub_(\d+)_/ and returns fingerPrint{n+1}.dat; falls back to
 * fingerPrint1.dat when no _sub_ token is found.
 * Mirrors monitor_utils.fingerprint_for_dat.
 */
export const fingerprintForCoords = (coordsBasename: string): string => {
  const m = coordsBasename.match(/_sub_(\d+)_/)
  if (m) {
    return `fingerPrint${Number(m[1]) + 1}.dat`
  }
  return 'fingerPrint1.dat'
}

/**
 * Derive the --name argument for backmap_cli.py from a coords basename.
 * Strips the trailing _xyz.dat suffix.
 */
export const backmapNameForCoords = (coordsBasename: string): string =>
  coordsBasename.replace(/_xyz\.dat$/, '')

export interface ReconstructionTask {
  coords: string
  fingerprint: string
  name: string
  outdir: string
}

export interface BuildReconstructionPlanOptions {
  /** Absolute in-container paths to the coords files (from wrapper_summary). */
  coordsFiles: string[]
  /** In-container path to the scenario root (chainLengths.dat lives here). */
  scenarioRoot: string
  /** In-container path for AA output root (e.g. /job/results/all_atom). */
  outRoot: string
  /** Maximum number of tasks to build; excess files are silently dropped. */
  maxModels: number
}

/**
 * Build one ReconstructionTask per coords file, capped at maxModels.
 * The caller should log a warning when the returned array is shorter than the
 * input.
 */
const baseName = (f: string): string => f.split('/').at(-1) ?? f
const speciesIndexOf = (f: string): number => {
  const m = baseName(f).match(/_sub_(\d+)_/)
  return m ? Number(m[1]) : 0
}
const runIndexOf = (f: string): number => {
  const m = baseName(f).match(/mol(\d+)_/)
  return m ? Number(m[1]) : 0
}

export const buildReconstructionPlan = (
  opts: BuildReconstructionPlanOptions
): ReconstructionTask[] => {
  const { coordsFiles, scenarioRoot, outRoot, maxModels } = opts

  // For a mixture (multiple species per run, i.e. some _sub_<j>_ with j>0) the
  // weighted assessment needs COMPLETE per-run species sets, so cap by whole
  // run-groups rather than slicing individual files (which could leave a partial
  // mixture state). Single-structure runs keep the simple flat cap.
  const speciesCount = coordsFiles.reduce(
    (mx, f) => Math.max(mx, speciesIndexOf(f) + 1),
    1
  )
  let selected: string[]
  if (speciesCount > 1) {
    const byRun = new Map<number, string[]>()
    for (const f of coordsFiles) {
      const r = runIndexOf(f)
      const arr = byRun.get(r) ?? []
      arr.push(f)
      byRun.set(r, arr)
    }
    selected = []
    for (const r of [...byRun.keys()].sort((a, b) => a - b)) {
      const grp = byRun.get(r) as string[]
      if (selected.length > 0 && selected.length + grp.length > maxModels) break
      selected.push(...grp)
    }
    if (selected.length === 0) selected = coordsFiles.slice(0, maxModels)
  } else {
    selected = coordsFiles.slice(0, maxModels)
  }

  return selected.map((coords) => {
    const base = baseName(coords)
    const fingerprint = `${scenarioRoot}/${fingerprintForCoords(base)}`
    const name = backmapNameForCoords(base)
    const outdir = `${outRoot}/${name}`
    return { coords, fingerprint, name, outdir }
  })
}

export interface BuildImpFoxsScoreSnippetOptions {
  // Absolute path to the IMP foxs binary (e.g. /usr/bin/foxs).
  foxsBin: string
  // All-atom PDB to score.
  aaPdb: string
  // Experimental SAXS profile.
  saxs: string
  // Clamp scoring to this q (IMP foxs -q/--max_q); match multi_foxs and the job max_q.
  maxQ: number
  // cd here first so foxs byproducts (.fit/.dat) land in the task outdir.
  workdir: string
  // Where to write the backmap-compatible `<aaPdb> <chi2>` result line.
  outFile: string
}

/**
 * Bash snippet that scores ONE all-atom PDB with IMP foxs and writes a
 * backmap-compatible `<aaPdb> <chi2>` line to outFile (or `<aaPdb> ERROR` when
 * the PDB is missing or foxs emits no Chi^2). Using IMP `/usr/bin/foxs` (the same
 * engine as multi_foxs) with `-q <maxQ>` makes the single-structure χ² directly
 * comparable to the mixture χ². foxs prints `... Chi^2 = <val> c1 = ...` to
 * stdout, which we parse. Called by ABSOLUTE path — foxs is a system binary, not
 * on the carbonara micromamba env PATH.
 */
export const buildImpFoxsScoreSnippet = (
  opts: BuildImpFoxsScoreSnippetOptions
): string => {
  const { foxsBin, aaPdb, saxs, maxQ, workdir, outFile } = opts
  const log = `${workdir}/foxs.stdout.log`
  return [
    `if [ -f '${aaPdb}' ]; then`,
    `  ( cd '${workdir}' && '${foxsBin}' '${aaPdb}' '${saxs}' -q '${maxQ}' ) > '${log}' 2>&1`,
    `  _chi2=$(awk -F'Chi.2 = ' 'NF>1{print $2}' '${log}' | awk '{print $1}' | head -1)`,
    `  if [ -n "$_chi2" ]; then printf '%s %s\\n' '${aaPdb}' "$_chi2" > '${outFile}'; else printf '%s %s\\n' '${aaPdb}' ERROR > '${outFile}'; fi`,
    `else`,
    `  printf '%s %s\\n' '${aaPdb}' ERROR > '${outFile}'`,
    `fi`
  ].join('\n')
}

export interface BuildBackmapLoopCommandOptions {
  pythonBin: string
  carbonaraRoot: string
  cg2allExec: string
  doFoxs: boolean
  // Absolute path to IMP foxs used for single-structure scoring (see
  // buildImpFoxsScoreSnippet). Replaces the retired pyfoxs (--foxs-py) path.
  foxsBin: string
  saxs: string
  maxQ: number
  disulfideFile?: string
}

/**
 * Build a single bash -lc body that loops over tasks and runs backmap_cli.py
 * per task. Uses set +e so one failure does not abort the rest.
 *
 * Single-structure FoXS scoring is done AFTER reconstruction with IMP
 * /usr/bin/foxs (buildImpFoxsScoreSnippet) rather than inside backmap_cli.py's
 * pyfoxs, so the per-model χ² comes from the same engine (and same -q window) as
 * the mixture multi_foxs χ² and the two are directly comparable.
 */
export const buildBackmapLoopCommand = (
  tasks: ReconstructionTask[],
  opts: BuildBackmapLoopCommandOptions
): string => {
  const {
    pythonBin,
    carbonaraRoot,
    cg2allExec,
    doFoxs,
    foxsBin,
    saxs,
    maxQ,
    disulfideFile
  } = opts

  const scenarioRoot =
    tasks.length > 0
      ? tasks[0].fingerprint.split('/').slice(0, -1).join('/')
      : ''

  const taskBlocks = tasks.map((t) => {
    // backmap_cli.py now only reconstructs the all-atom PDB (no --do-foxs); FoXS
    // scoring is appended below with IMP foxs.
    const baseArgs = [
      `'${pythonBin}'`,
      `'${carbonaraRoot}/backmap_cli.py'`,
      '--backend cg2all',
      `--cg2all-exec '${cg2allExec}'`,
      `--coords '${t.coords}'`,
      `--fingerprint '${t.fingerprint}'`,
      `--scenario-root '${scenarioRoot}'`,
      `--outdir '${t.outdir}'`,
      `--name '${t.name}'`
    ]

    if (disulfideFile) {
      baseArgs.push(`--disulfide-file '${disulfideFile}'`)
    }

    let block =
      `mkdir -p '${t.outdir}'\n` +
      baseArgs.join(' \\\n  ') +
      `\n_rc_${t.name.replace(/[^a-zA-Z0-9_]/g, '_')}=$?`

    if (doFoxs) {
      block +=
        '\n' +
        buildImpFoxsScoreSnippet({
          foxsBin,
          aaPdb: `${t.outdir}/${t.name}_AA.pdb`,
          saxs,
          maxQ,
          workdir: t.outdir,
          outFile: `${t.outdir}/foxs_results.txt`
        })
    }

    return block
  })

  return `set +e\n${taskBlocks.join('\n')}`
}

export interface FoxsEntry {
  aaPdb: string
  chi2: number | null
}

/**
 * Parse the text of a foxs_results.txt produced by backmap_cli.py.
 * Each non-empty line: first token = AA PDB path, second token = chi2 (or
 * 'ERROR' / unparseable → null).
 * Mirrors monitor_utils.parse_foxs_results_file.
 */
export const parseFoxsResultsSummary = (text: string): FoxsEntry[] => {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const tokens = line.trim().split(/\s+/)
      const aaPdb = tokens[0]
      const raw = tokens[1]
      let chi2: number | null = null
      if (raw && raw !== 'ERROR') {
        const n = Number(raw)
        chi2 = Number.isFinite(n) ? n : null
      }
      return { aaPdb, chi2 }
    })
}

/**
 * Select the entry with the minimum numeric chi2 from a set of FoXS result
 * entries. Returns null when no entry has a finite chi2.
 */
export const selectBestAaModel = (
  entries: FoxsEntry[]
): FoxsEntry | null => {
  let best: FoxsEntry | null = null
  for (const entry of entries) {
    if (entry.chi2 !== null) {
      if (best === null || entry.chi2 < (best.chi2 as number)) {
        best = entry
      }
    }
  }
  return best
}

export interface BuildBackmapContainerArgsOptions {
  image: string
  hostJobDir: string
  loopBody: string
}

/**
 * Build the podman argument vector for the backmap container run.
 * Invokes /bin/bash -lc <loopBody> inside the container.
 */
export const buildBackmapContainerArgs = (
  opts: BuildBackmapContainerArgsOptions
): string[] => [
  'run',
  '--rm',
  '-v',
  `${opts.hostJobDir}:${CARBONARA_JOB_MOUNT}:Z`,
  opts.image,
  '/bin/bash',
  '-lc',
  opts.loopBody
]

// ---------------------------------------------------------------------------
// B5 — initial scattering check (carbonara-preview queue) helpers
// ---------------------------------------------------------------------------

export interface BuildInitFoxsContainerArgsOptions {
  image: string
  /** Absolute host directory that will be mounted at /job inside the container. */
  hostDir: string
  /** Basename of the PDB (or CIF, already converted) file inside hostDir. */
  pdbFileName: string
  /** Basename of the SAXS .dat file inside hostDir. */
  datFileName: string
  /** Optional maximum q value forwarded to pyfoxs via --max_q. */
  maxQ?: number | null
  /** Python binary to invoke inside the container. */
  pythonBin: string
  /** In-container path to carbonara_initfoxs.py. */
  initFoxsPath: string
  /** Optional host path to bind-mount over initFoxsPath for local dev.
   *  When non-empty, inserts -v <initFoxsMount>:<initFoxsPath>:ro,Z. */
  initFoxsMount?: string
  /** In-container prefix for the job dir. Defaults to '/job' (podman bind mount);
   *  in inprocess/k8s mode the caller passes the REAL host dir so the command
   *  paths are valid in-pod without a mount. */
  jobMount?: string
}

/**
 * Build the container argument vector for a carbonara-preview job.
 * Invocation inside the container:
 *   python <initFoxsPath> --pdb /job/<pdbFileName> --saxs /job/<datFileName>
 *                          --outdir /job [--max_q <maxQ>]
 *
 * When initFoxsMount is non-empty an extra bind-mount is inserted before the
 * image arg so the host helper overlays the baked copy (CARBONARA_INITFOXS_MOUNT
 * dev workflow, analogous to CARBONARA_RUNNER_MOUNT).
 */
export const buildInitFoxsContainerArgs = (
  opts: BuildInitFoxsContainerArgsOptions
): string[] => {
  const mount = opts.jobMount ?? CARBONARA_JOB_MOUNT
  const args = ['run', '--rm', '-v', `${opts.hostDir}:${CARBONARA_JOB_MOUNT}:Z`]

  if (opts.initFoxsMount) {
    args.push('-v', `${opts.initFoxsMount}:${opts.initFoxsPath}:ro,Z`)
  }

  args.push(
    opts.image,
    opts.pythonBin,
    opts.initFoxsPath,
    '--pdb', `${mount}/${opts.pdbFileName}`,
    '--saxs', `${mount}/${opts.datFileName}`,
    '--outdir', mount
  )

  if (opts.maxQ != null) {
    args.push('--max_q', String(opts.maxQ))
  }

  return args
}

// ---------------------------------------------------------------------------
// B2.4 — auto-flexibility prepare (carbonara-autoflex queue) helpers
// ---------------------------------------------------------------------------

export interface BuildAutoFlexContainerArgsOptions {
  image: string
  /** Absolute host directory mounted at /job inside the container. */
  hostDir: string
  /** Basename of the structure (PDB or CIF) file inside hostDir. */
  pdbFileName: string
  /** Basename of the SAXS .dat file inside hostDir (setup requires it). */
  datFileName: string
  /** Python binary to invoke inside the container. */
  pythonBin: string
  /** In-container path to carbonara_autoflex.py. */
  autoFlexPath: string
  /** In-container Carbonara checkout root (for setup_carbonara.py + cdt). */
  carbonaraRoot: string
  /** Optional minimum q forwarded to setup. */
  minQ?: number | null
  /** Optional maximum q forwarded to setup. */
  maxQ?: number | null
  /** Optional PAE JSON basename inside hostDir. When set, selection uses
   *  Carbonara's PAE path (--alphaFoldFlex) instead of the sheet-breaking auto. */
  paeFileName?: string | null
  /** Absolute Å PAE threshold (only used when paeFileName is set). */
  paeFlexThreshold?: number | null
  /** Optional host path to bind-mount over autoFlexPath for local dev.
   *  When non-empty, inserts -v <autoFlexMount>:<autoFlexPath>:ro,Z. */
  autoFlexMount?: string
  /** In-container prefix for the job dir. Defaults to '/job' (podman bind mount);
   *  in inprocess/k8s mode the caller passes the REAL host dir. */
  jobMount?: string
}

/**
 * Build the container argument vector for a carbonara-autoflex job.
 * Invocation inside the container:
 *   python <autoFlexPath> --pdb /job/<pdb> --saxs /job/<dat> --outdir /job
 *          --carbonara-root <root> [--min_q <q>] [--max_q <q>]
 *
 * When autoFlexMount is non-empty an extra bind-mount overlays the baked helper
 * (CARBONARA_AUTOFLEX_MOUNT dev workflow, analogous to CARBONARA_INITFOXS_MOUNT).
 */
export const buildAutoFlexContainerArgs = (
  opts: BuildAutoFlexContainerArgsOptions
): string[] => {
  const mount = opts.jobMount ?? CARBONARA_JOB_MOUNT
  const args = ['run', '--rm', '-v', `${opts.hostDir}:${CARBONARA_JOB_MOUNT}:Z`]

  if (opts.autoFlexMount) {
    args.push('-v', `${opts.autoFlexMount}:${opts.autoFlexPath}:ro,Z`)
  }

  args.push(
    opts.image,
    opts.pythonBin,
    opts.autoFlexPath,
    '--pdb', `${mount}/${opts.pdbFileName}`,
    '--saxs', `${mount}/${opts.datFileName}`,
    '--outdir', mount,
    '--carbonara-root', opts.carbonaraRoot
  )

  if (opts.minQ != null) {
    args.push('--min_q', String(opts.minQ))
  }
  if (opts.maxQ != null) {
    args.push('--max_q', String(opts.maxQ))
  }
  if (opts.paeFileName) {
    args.push('--pae', `${mount}/${opts.paeFileName}`)
    if (opts.paeFlexThreshold != null) {
      args.push('--pae_flex_threshold', String(opts.paeFlexThreshold))
    }
  }

  return args
}

// ---------------------------------------------------------------------------
// R1 — results analysis (carbonara_results.py -> analysis.json) helpers
// ---------------------------------------------------------------------------

export interface BuildResultsContainerArgsOptions {
  image: string
  /** Host job directory mounted at /job. */
  hostDir: string
  /** Original structure basename in /job (for Rg of the starting model). */
  pdbFileName: string
  /** Experimental SAXS basename in /job (for the best-model FoXS curve). */
  datFileName: string
  /** Python binary inside the container. */
  pythonBin: string
  /** In-container path to carbonara_results.py. */
  resultsPath: string
  /** In-container Carbonara checkout root (for fittingAnalysis). */
  carbonaraRoot: string
  /** Optional maximum q forwarded to the best-model FoXS curve. */
  maxQ?: number | null
  /** FoXS command used for the best-model curve. */
  foxsCmd?: string
  /** Optional host path to bind-mount over resultsPath for local dev. */
  resultsMount?: string
  /** In-container prefix for the job dir. Defaults to '/job' (podman bind mount);
   *  in inprocess/k8s mode the caller passes the REAL host dir. */
  jobMount?: string
}

/**
 * Build the container argument vector for the results-analysis step.
 * Invocation inside the container:
 *   python <resultsPath> --results-dir /job/results --carbonara-root <root>
 *          --original /job/<pdb> --saxs /job/<dat> --out /job/results/analysis.json
 *          [--foxs-cmd <cmd>] [--max_q <q>]
 *
 * When resultsMount is non-empty an extra bind-mount overlays the baked helper
 * (CARBONARA_RESULTS_MOUNT dev workflow, like CARBONARA_AUTOFLEX_MOUNT).
 */
export const buildResultsContainerArgs = (
  opts: BuildResultsContainerArgsOptions
): string[] => {
  const mount = opts.jobMount ?? CARBONARA_JOB_MOUNT
  const args = ['run', '--rm', '-v', `${opts.hostDir}:${CARBONARA_JOB_MOUNT}:Z`]

  if (opts.resultsMount) {
    args.push('-v', `${opts.resultsMount}:${opts.resultsPath}:ro,Z`)
  }

  args.push(
    opts.image,
    opts.pythonBin,
    opts.resultsPath,
    '--results-dir', `${mount}/results`,
    '--carbonara-root', opts.carbonaraRoot,
    '--original', `${mount}/${opts.pdbFileName}`,
    '--saxs', `${mount}/${opts.datFileName}`,
    '--out', `${mount}/results/analysis.json`
  )

  if (opts.foxsCmd) {
    args.push('--foxs-cmd', opts.foxsCmd)
  }
  if (opts.maxQ != null) {
    args.push('--max_q', String(opts.maxQ))
  }

  return args
}

export interface RunCarbonaraContainerOptions {
  containerBin: string
  args: string[]
  cwd: string
  timeoutMs?: number
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  // k8s de-nesting: 'podman' (default) runs the nested container unchanged;
  // 'inprocess' strips the `podman run … <image>` prefix and runs the remaining
  // command directly in the worker pod. Requires `image` to locate the split
  // point. When execMode is unset/'podman' the behaviour is byte-identical.
  execMode?: string
  image?: string
}

// Split a full `podman run … <image> <cmd…>` argv into the bare command that
// runs in-process (everything after the image). Returns null if it can't split.
export const inProcessCommandFromArgs = (
  args: string[],
  image?: string
): string[] | null => {
  if (!image) return null
  const idx = args.indexOf(image)
  if (idx < 0 || idx + 1 >= args.length) return null
  return args.slice(idx + 1)
}

/**
 * Spawn the container engine and stream output line-by-line. Mirrors the
 * SIGTERM -> SIGKILL escalation used elsewhere in the worker (runPythonStep).
 * Resolves with the exit code/signal; the caller inspects wrapper_summary.json
 * to decide success.
 */
export const runCarbonaraContainer = async (
  opts: RunCarbonaraContainerOptions
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
  const { containerBin, args, cwd, timeoutMs, onStdoutLine, onStderrLine } =
    opts

  // Default (podman): spawn the container engine with the full argv (unchanged).
  // inprocess (k8s): run the command that would have executed inside the
  // container, directly in this pod.
  let spawnBin = containerBin
  let spawnArgs = args
  if (opts.execMode === 'inprocess') {
    const cmd = inProcessCommandFromArgs(args, opts.image)
    if (cmd && cmd.length > 0) {
      spawnBin = cmd[0]
      spawnArgs = cmd.slice(1)
    }
  }

  const child = spawn(spawnBin, spawnArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let rlOut: readline.Interface | undefined
  if (child.stdout) {
    rlOut = readline.createInterface({ input: child.stdout })
    rlOut.on('line', (line) => onStdoutLine?.(line.replace(/\r$/, '')))
  }

  let rlErr: readline.Interface | undefined
  if (child.stderr) {
    rlErr = readline.createInterface({ input: child.stderr })
    rlErr.on('line', (line) => onStderrLine?.(line.replace(/\r$/, '')))
  }

  let termTimer: NodeJS.Timeout | undefined
  let killTimer: NodeJS.Timeout | undefined
  if (timeoutMs && timeoutMs > 0) {
    termTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 5000)
    }, timeoutMs)
  }

  const closeP = once(child, 'close').then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null
  }))
  const errorP = once(child, 'error').then(([err]) => {
    throw err
  })

  try {
    return await Promise.race([closeP, errorP])
  } finally {
    if (termTimer) clearTimeout(termTimer)
    if (killTimer) clearTimeout(killTimer)
    rlOut?.close()
    rlErr?.close()
  }
}

// ---------------------------------------------------------------------------
// MultiFoXS (BilboMD's IMP multi_foxs) — rigorous all-atom mixture weighting.
// Runs in the BilboMD worker image (which ships /usr/bin/multi_foxs) on the
// backmapped per-species PDBs + experimental SAXS, producing ensemble models
// with per-species weights and chi². Used only for mixture jobs; does not touch
// the multi/classic pipeline code — just invokes the same binary on our data.
// ---------------------------------------------------------------------------

export interface BuildMultiFoxsContainerArgsOptions {
  image: string
  multiFoxsBin: string
  hostJobDir: string
  // In-container working dir (under the /job mount) where multi_foxs writes
  // ensembles_size_*.txt / multi_state_model_*.fit.
  outDirContainer: string
  saxsContainer: string
  speciesPdbsContainer: string[]
  numStates: number
  // Clamp scoring to this q via IMP multi_foxs `-q`/`--max_q`. Emitted only when
  // set. Pass the job's max_q so the mixture χ² is computed over the SAME q-window
  // as the per-model single-structure FoXS (buildBackmapLoopCommand's --max-q).
  // Without it multi_foxs defaults to q≤0.5 and scores the full experimental
  // range, inflating χ² whenever the data extends past max_q (e.g. talin to
  // q=0.309) and making the mixture χ² non-comparable to the single-structure χ².
  maxQ?: number
}

/**
 * podman run --rm --user root -v <hostJobDir>:/job:Z <image> \
 *   bash -lc 'cd <outdir> && <multi_foxs> -s <N> [-q <maxQ>] <saxs> <pdb1> <pdb2> ...'
 * --user root is required: the worker image runs as a non-root user, and rootless
 * podman maps container-root to the host user so outputs land in the mounted dir.
 */
export const buildMultiFoxsContainerArgs = (
  opts: BuildMultiFoxsContainerArgsOptions
): string[] => {
  const q = (s: string) => `"${s}"`
  const pdbs = opts.speciesPdbsContainer.map(q).join(' ')
  // Options must precede the positional profile/PDB args for IMP multi_foxs.
  const qFlag = opts.maxQ != null ? ` -q ${opts.maxQ}` : ''
  const inner =
    `mkdir -p ${q(opts.outDirContainer)} && cd ${q(opts.outDirContainer)} && ` +
    `${q(opts.multiFoxsBin)} -s ${opts.numStates}${qFlag} ${q(opts.saxsContainer)} ${pdbs}`
  return [
    'run',
    '--rm',
    '--user',
    'root',
    '-v',
    `${opts.hostJobDir}:${CARBONARA_JOB_MOUNT}:Z`,
    opts.image,
    'bash',
    '-lc',
    inner
  ]
}

export interface MultiFoxsEnsemble {
  chi2: number
  members: { pdb: string; weight: number }[]
}

/**
 * Parse a multi_foxs ensembles_size_<N>.txt file and return the best (rank-1)
 * ensemble. Format:
 *   1 |  1.16 | x1 1.16 (1.05, 0.00)
 *       0   | 0.691 (0.691, 1.000) | sp2.pdb (0.500)
 *       1   | 0.309 (0.309, 1.000) | sp1.pdb (0.500)
 */
export const parseMultiFoxsEnsembles = (
  text: string
): MultiFoxsEnsemble | null => {
  let best: MultiFoxsEnsemble | null = null
  let cur: MultiFoxsEnsemble | null = null
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    // Ensemble header lines start with the rank digit in column 0; species
    // lines are indented.
    if (/^\d/.test(raw)) {
      if (best) break // only the first (best) ensemble is needed
      const chi2 = Number(raw.split('|')[1]?.trim())
      cur = { chi2: Number.isFinite(chi2) ? chi2 : NaN, members: [] }
      best = cur
    } else if (cur) {
      const parts = raw.split('|')
      if (parts.length >= 3) {
        const weight = Number(parts[1]?.trim().split(/\s+/)[0])
        const pdb = parts[2]?.trim().split(/\s+/)[0]
        if (pdb && Number.isFinite(weight)) {
          cur.members.push({ pdb, weight })
        }
      }
    }
  }
  return best && best.members.length > 0 ? best : null
}

/** Parse a multi_foxs .fit file (q, exp_intensity, error, model_intensity). */
export const parseMultiFoxsFit = (
  text: string
): { q: number; exp: number; model: number; error: number }[] => {
  const rows: { q: number; exp: number; model: number; error: number }[] = []
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (!s || s.startsWith('#')) continue
    const p = s.split(/\s+/)
    if (p.length < 4) continue
    const q = Number(p[0])
    const exp = Number(p[1])
    const error = Number(p[2])
    const model = Number(p[3])
    if ([q, exp, error, model].every((v) => Number.isFinite(v))) {
      rows.push({ q, exp, model, error })
    }
  }
  return rows
}
