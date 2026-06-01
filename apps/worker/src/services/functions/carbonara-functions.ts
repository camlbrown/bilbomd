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
