import { Request, Response } from 'express'
import path from 'path'
import fs from 'fs-extra'
import { Job, BilboMdCarbonaraJob } from '@bilbomd/mongodb-schema'
import { logger } from '../../middleware/loggers.js'
import { getEnvVar } from '../../config/config.js'

const uploadFolder = path.join(getEnvVar('DATA_VOL'))

/**
 * GET /jobs/:id/carbonara-analysis
 *
 * Reads results/analysis.json for a completed Carbonara job and returns the
 * parsed JSON. Mirrors the pattern used by getCarbonaraInitFoxs / getCarbonaraAutoFlex.
 */
export const getCarbonaraAnalysis = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId

  if (!id) {
    res.status(400).json({ message: 'Job ID required.' })
    return
  }

  try {
    const job = await Job.findOne({ _id: id }).exec()
    if (!job) {
      res.status(404).json({ message: `No job matches ID ${id}.` })
      return
    }

    if (job.__t !== 'BilboMdCarbonara') {
      res
        .status(400)
        .json({ message: 'This endpoint is only available for Carbonara jobs.' })
      return
    }

    const analysisPath = path.join(
      uploadFolder,
      job.uuid,
      'results',
      'analysis.json'
    )

    const exists = await fs.pathExists(analysisPath)
    if (!exists) {
      // analysis.json not yet written — return pending-style response so the UI
      // can poll, matching the initfoxs/autoflex pattern.
      res.status(200).json({ status: 'pending' })
      return
    }

    const analysis = await fs.readJson(analysisPath)
    res.status(200).json(analysis)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`getCarbonaraAnalysis ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to read Carbonara analysis.' })
  }
}

/**
 * GET /jobs/:id/carbonara-aa-pdb
 *
 * Serves an all-atom PDB from results/all_atom/<model>/<model>_AA.pdb.
 * The `pdbPath` query parameter is the relative path under results/ as stored
 * in analysis.json predictions[].aa_pdb (e.g.
 * "all_atom/mol1_sub_0_end/mol1_sub_0_end_AA.pdb").
 */
export const getCarbonaraAaPdb = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId

  if (!id) {
    res.status(400).json({ message: 'Job ID required.' })
    return
  }

  const rawPdbPath = req.query['pdbPath']
  const pdbPath =
    typeof rawPdbPath === 'string' ? rawPdbPath : undefined

  if (!pdbPath) {
    res.status(400).json({ message: 'pdbPath query parameter required.' })
    return
  }

  try {
    const job = await Job.findOne({ _id: id }).exec()
    if (!job) {
      res.status(404).json({ message: `No job matches ID ${id}.` })
      return
    }

    // Prevent path traversal: only allow paths that stay under results/all_atom
    const normalized = path.normalize(pdbPath)
    if (
      normalized.startsWith('..') ||
      !normalized.startsWith('all_atom') ||
      !normalized.endsWith('.pdb')
    ) {
      res.status(400).json({ message: 'Invalid pdbPath.' })
      return
    }

    const fullPath = path.join(uploadFolder, job.uuid, 'results', normalized)

    const exists = await fs.pathExists(fullPath)
    if (!exists) {
      res.status(404).json({ message: 'PDB file not found.' })
      return
    }

    res.setHeader('Content-Type', 'chemical/x-pdb')
    res.sendFile(fullPath)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`getCarbonaraAaPdb ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to serve AA PDB.' })
  }
}

/**
 * GET /jobs/:id/carbonara-original-pdb
 *
 * Serves the user's ORIGINAL uploaded structure for a Carbonara job (the input
 * the refinement started from), so the results viewer can overlay it on a
 * prediction to show how much the structure changed. The filename is read from
 * the job's pdb_file field — the frontend never supplies a path, so there is no
 * traversal surface (basename is enforced regardless).
 */
export const getCarbonaraOriginalPdb = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId

  if (!id) {
    res.status(400).json({ message: 'Job ID required.' })
    return
  }

  try {
    // Querying the discriminator model auto-filters to Carbonara jobs, so a
    // non-Carbonara id returns null -> 404.
    const job = await BilboMdCarbonaraJob.findOne({ _id: id }).exec()
    if (!job) {
      res.status(404).json({ message: `No Carbonara job matches ID ${id}.` })
      return
    }

    if (!job.pdb_file) {
      res.status(404).json({ message: 'No original structure on this job.' })
      return
    }

    const safeName = path.basename(job.pdb_file)
    const fullPath = path.join(uploadFolder, job.uuid, safeName)

    const exists = await fs.pathExists(fullPath)
    if (!exists) {
      res.status(404).json({ message: 'Original structure file not found.' })
      return
    }

    res.setHeader('Content-Type', 'chemical/x-pdb')
    res.sendFile(fullPath)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`getCarbonaraOriginalPdb ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to serve original structure.' })
  }
}

interface LiveConvergencePoint {
  step: number
  chi2: number
  penalty: number
  elapsed_min: number
}

interface LiveConvergenceRun {
  log: string
  run: number
  points: LiveConvergencePoint[]
}

/**
 * Parse a Carbonara NDJSON fit log (one file per fit run) into a chi² point
 * series. Mirrors fittingAnalysis.read_fitlog_runs (used by carbonara_results.py
 * to build analysis.json's convergence): a `Run` metadata line starts a run, and
 * each `ImprovementIndex` record contributes a chi² (ScatterFitFirst) point at
 * its FitStep. Unparseable lines are skipped so a half-written trailing line
 * during a live read never aborts parsing.
 */
const parseFitLogRuns = (text: string, logName: string): LiveConvergenceRun[] => {
  const runs: LiveConvergenceRun[] = []
  let current: LiveConvergencePoint[] | null = null

  const flush = () => {
    if (current && current.length > 0) {
      runs.push({ log: logName, run: runs.length + 1, points: current })
    }
    current = null
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const hasImprovement = 'ImprovementIndex' in d
    if ('Run' in d && !hasImprovement) {
      flush()
      current = []
      continue
    }
    if (!hasImprovement) continue
    if (current === null) current = []

    // The elapsed-time key carries a unit suffix that varies (µs/μs), so match
    // it case-insensitively by prefix.
    const elapsedKey = Object.keys(d).find((k) =>
      k.toLowerCase().startsWith('elapsedtime')
    )
    const elapsedUs = elapsedKey ? Number(d[elapsedKey]) : NaN

    current.push({
      step: Number(d['FitStep'] ?? -1),
      chi2: Number(d['ScatterFitFirst'] ?? NaN),
      penalty: Number(d['OverlapPenalty'] ?? NaN),
      elapsed_min: Number.isFinite(elapsedUs) ? elapsedUs / 1e6 / 60 : 0
    })
  }
  flush()
  return runs
}

/**
 * Resolve the directory holding the fitLog*.dat files for a Carbonara job.
 *
 * During the run the fitter writes them under the working tree
 * (work/<uuid>/carbonara_runs/<run>/fitdata) and they update incrementally;
 * the collect step later copies them to results/carbonara_run/fitdata. We prefer
 * the live working copy and fall back to the results copy for finished jobs.
 */
const findFitdataDir = async (
  jobDir: string,
  uuid: string
): Promise<string | null> => {
  const runsRoot = path.join(jobDir, 'work', uuid, 'carbonara_runs')
  if (await fs.pathExists(runsRoot)) {
    // The run subdir is normally named after the uuid; glob its children to be
    // robust to naming and pick the first that actually holds a fitdata dir.
    const children = await fs.readdir(runsRoot)
    for (const child of children.sort()) {
      const fd = path.join(runsRoot, child, 'fitdata')
      if (await fs.pathExists(fd)) return fd
    }
  }
  const resultsFd = path.join(jobDir, 'results', 'carbonara_run', 'fitdata')
  if (await fs.pathExists(resultsFd)) return resultsFd
  return null
}

/**
 * GET /jobs/:id/carbonara-live-progress
 *
 * Returns the in-progress fitting convergence (chi² per step, per fit run) for a
 * Carbonara job by parsing the per-run fitLog*.dat NDJSON files live from the
 * working directory. The payload matches analysis.json's `convergence` shape so
 * the UI can reuse the same chart. Returns status 'pending' until the first fit
 * log appears.
 */
export const getCarbonaraLiveProgress = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId

  if (!id) {
    res.status(400).json({ message: 'Job ID required.' })
    return
  }

  try {
    const job = await BilboMdCarbonaraJob.findOne({ _id: id }).exec()
    if (!job) {
      res.status(404).json({ message: `No Carbonara job matches ID ${id}.` })
      return
    }

    const jobDir = path.join(uploadFolder, job.uuid)
    const fitdataDir = await findFitdataDir(jobDir, job.uuid)

    if (!fitdataDir) {
      res.status(200).json({ status: 'pending', convergence: [] })
      return
    }

    const entries = await fs.readdir(fitdataDir)
    const logFiles = entries.filter((f) => /^fitLog.*\.dat$/.test(f)).sort()

    if (logFiles.length === 0) {
      res.status(200).json({ status: 'pending', convergence: [] })
      return
    }

    const convergence: LiveConvergenceRun[] = []
    for (const file of logFiles) {
      try {
        const text = await fs.readFile(path.join(fitdataDir, file), 'utf8')
        convergence.push(...parseFitLogRuns(text, file))
      } catch {
        // Skip a log that can't be read this tick; the next poll will retry.
      }
    }

    res.status(200).json({
      status: convergence.length > 0 ? 'running' : 'pending',
      convergence
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`getCarbonaraLiveProgress ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to read Carbonara live progress.' })
  }
}
