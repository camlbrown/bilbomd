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
  rotation?: boolean
}

export interface CarbonaraJobJson {
  job_name: string
  carbonara_root: string
  pdb: string
  saxs: string
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
}

/**
 * Build the job.json object consumed by carbonara_bilbomd_runner_refined.py.
 * Inputs are expressed as absolute in-container paths under the /job mount.
 */
export const buildCarbonaraJobJson = (
  opts: BuildCarbonaraJobJsonOptions
): CarbonaraJobJson => ({
  job_name: opts.jobName,
  carbonara_root: opts.carbonaraRoot,
  pdb: `${CARBONARA_JOB_MOUNT}/${opts.pdbFileName}`,
  saxs: `${CARBONARA_JOB_MOUNT}/${opts.saxsFileName}`,
  workdir: `${CARBONARA_JOB_MOUNT}/work`,
  outdir: `${CARBONARA_JOB_MOUNT}/results`,
  parameters: {
    fit_n_times: opts.parameters.fit_n_times,
    min_q: opts.parameters.min_q,
    max_q: opts.parameters.max_q,
    max_q_start: opts.parameters.max_q_start,
    max_fit_steps: opts.parameters.max_fit_steps,
    mixture_n: opts.parameters.mixture_n,
    rotation: opts.parameters.rotation ?? false
  }
})

export interface BuildCarbonaraContainerArgsOptions {
  image: string
  // Host directory to bind-mount at /job.
  hostJobDir: string
  // In-container path to the job.json (defaults under the mount).
  jobJsonContainerPath?: string
  runnerPath: string
  pythonBin: string
}

/**
 * Build the argument vector for the container engine (e.g. podman). Matches the
 * locally validated invocation:
 *   podman run --rm -v <hostJobDir>:/job:Z <image> \
 *     python <runnerPath> --job-json /job/job.json --clean
 */
export const buildCarbonaraContainerArgs = (
  opts: BuildCarbonaraContainerArgsOptions
): string[] => {
  const jobJson =
    opts.jobJsonContainerPath ?? `${CARBONARA_JOB_MOUNT}/job.json`
  return [
    'run',
    '--rm',
    '-v',
    `${opts.hostJobDir}:${CARBONARA_JOB_MOUNT}:Z`,
    opts.image,
    opts.pythonBin,
    opts.runnerPath,
    '--job-json',
    jobJson,
    '--clean'
  ]
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
export const buildReconstructionPlan = (
  opts: BuildReconstructionPlanOptions
): ReconstructionTask[] => {
  const { coordsFiles, scenarioRoot, outRoot, maxModels } = opts
  const capped = coordsFiles.slice(0, maxModels)
  return capped.map((coords) => {
    const base = coords.split('/').at(-1) ?? coords
    const fingerprint = `${scenarioRoot}/${fingerprintForCoords(base)}`
    const name = backmapNameForCoords(base)
    const outdir = `${outRoot}/${name}`
    return { coords, fingerprint, name, outdir }
  })
}

export interface BuildBackmapLoopCommandOptions {
  pythonBin: string
  carbonaraRoot: string
  cg2allExec: string
  doFoxs: boolean
  foxsCmd: string
  saxs: string
  maxQ: number
  disulfideFile?: string
}

/**
 * Build a single bash -lc body that loops over tasks and runs backmap_cli.py
 * per task. Uses set +e so one failure does not abort the rest.
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
    foxsCmd,
    saxs,
    maxQ,
    disulfideFile
  } = opts

  const scenarioRoot =
    tasks.length > 0
      ? tasks[0].fingerprint.split('/').slice(0, -1).join('/')
      : ''

  const taskBlocks = tasks.map((t) => {
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

    if (doFoxs) {
      baseArgs.push(
        '--do-foxs',
        `--foxs-py '${foxsCmd}'`,
        `--saxs '${saxs}'`,
        `--max-q '${maxQ}'`,
        `--foxs-out '${t.outdir}/foxs_results.txt'`
      )
    }

    return (
      `mkdir -p '${t.outdir}'\n` +
      baseArgs.join(' \\\n  ') +
      `\n_rc_${t.name.replace(/[^a-zA-Z0-9_]/g, '_')}=$?`
    )
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

export interface RunCarbonaraContainerOptions {
  containerBin: string
  args: string[]
  cwd: string
  timeoutMs?: number
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
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

  const child = spawn(containerBin, args, {
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
