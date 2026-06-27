import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { once } from 'node:events'

/**
 * Helpers for the AutoMD-SAXS worker pathway.
 *
 * AutoMD-SAXS is an EXTERNAL pip-installed dependency exposing a stable CLI:
 *   automd-saxs run --config config.json --out output_dir
 *
 * The worker writes a config.json (the automd-saxs OpenMMConfig), invokes the
 * CLI, streams its logs, then reads the manifest.json the CLI writes into the
 * output directory to determine success. BilboMD does not import any automd-saxs
 * internals — only this command/file contract.
 */

export interface AutoMDSaxsConfigOptions {
  jobName: string
  pdbPath: string
  saxsPath?: string
  system?: string
  forceField?: string
  waterModel?: string
  simulationTimeNs: number
  nRepeats: number
  temperatureK?: number
  ionicConcentrationM?: number
  ph?: number
  disulfide?: boolean
  boxPaddingNm?: number
  seed?: number
}

/**
 * Build the automd-saxs config.json object (OpenMMConfig schema). Only defined
 * fields are emitted; the CLI applies its own defaults for the rest.
 */
export const buildAutoMDSaxsConfig = (
  opts: AutoMDSaxsConfigOptions
): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    job_name: opts.jobName,
    pdb: opts.pdbPath,
    simulation_time_ns: opts.simulationTimeNs,
    n_repeats: opts.nRepeats
  }
  if (opts.saxsPath) config.saxs = opts.saxsPath
  if (opts.system) config.system = opts.system
  if (opts.forceField) config.force_field = opts.forceField
  if (opts.waterModel) config.water_model = opts.waterModel
  if (opts.temperatureK !== undefined) config.temperature_K = opts.temperatureK
  if (opts.ionicConcentrationM !== undefined)
    config.ionic_concentration_M = opts.ionicConcentrationM
  if (opts.ph !== undefined) config.ph = opts.ph
  if (opts.disulfide !== undefined) config.disulfide = opts.disulfide
  if (opts.boxPaddingNm !== undefined) config.box_padding_nm = opts.boxPaddingNm
  if (opts.seed !== undefined) config.seed = opts.seed
  return config
}

/** argv for `automd-saxs run --config <configPath> --out <outDir>`. */
export const buildAutoMDSaxsArgs = (opts: {
  configPath: string
  outDir: string
}): string[] => ['run', '--config', opts.configPath, '--out', opts.outDir]

export interface RunAutoMDSaxsOptions {
  bin: string
  args: string[]
  cwd: string
  timeoutMs: number
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
}

/**
 * Spawn the external `automd-saxs` CLI, streaming stdout/stderr line-by-line.
 * Mirrors the Carbonara runner's spawn/stream/timeout pattern.
 */
export const runAutoMDSaxs = async (
  opts: RunAutoMDSaxsOptions
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
  const { bin, args, cwd, timeoutMs, onStdoutLine, onStderrLine } = opts

  const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

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

export interface AutoMDSaxsManifestSummary {
  status: string
  succeeded: boolean
  metrics: Record<string, unknown>
  outputs: Record<string, unknown>
  message: string
}

/**
 * Parse the manifest.json the CLI writes. Success = status 'completed'.
 */
export const parseAutoMDSaxsManifest = (
  text: string
): AutoMDSaxsManifestSummary => {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch (err) {
    return {
      status: 'unknown',
      succeeded: false,
      metrics: {},
      outputs: {},
      message: `Could not parse automd-saxs manifest.json: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
  }
  const status = typeof parsed.status === 'string' ? parsed.status : 'unknown'
  const notes = Array.isArray(parsed.notes) ? (parsed.notes as string[]) : []
  const succeeded = status === 'completed'
  return {
    status,
    succeeded,
    metrics: (parsed.metrics as Record<string, unknown>) ?? {},
    outputs: (parsed.outputs as Record<string, unknown>) ?? {},
    message: succeeded
      ? `AutoMD-SAXS completed${
          notes.length ? ` (notes: ${notes.join('; ')})` : ''
        }`
      : `AutoMD-SAXS status '${status}'${
          notes.length ? `: ${notes.join('; ')}` : ''
        }`
  }
}
