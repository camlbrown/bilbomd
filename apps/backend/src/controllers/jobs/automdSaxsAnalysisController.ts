import { Request, Response } from 'express'
import path from 'path'
import fs from 'fs-extra'
import { Job } from '@bilbomd/mongodb-schema'
import { logger } from '../../middleware/loggers.js'
import { getEnvVar } from '../../config/config.js'

const uploadFolder = path.join(getEnvVar('DATA_VOL'))

/**
 * GET /jobs/:id/automd-saxs-analysis
 *
 * Reads results/manifest.json for an AutoMD-SAXS job and returns the parsed
 * manifest (status, parameters, outputs, metrics, notes). Returns
 * { status: 'pending' } if the manifest has not been written yet, so the UI can
 * poll. Mirrors getCarbonaraAnalysis.
 */
export const getAutoMDSAXSAnalysis = async (
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

    if (job.__t !== 'BilboMdAutoMDSAXS') {
      res.status(400).json({
        message: 'This endpoint is only available for AutoMD-SAXS jobs.'
      })
      return
    }

    const manifestPath = path.join(
      uploadFolder,
      job.uuid,
      'results',
      'manifest.json'
    )

    const exists = await fs.pathExists(manifestPath)
    if (!exists) {
      res.status(200).json({ status: 'pending' })
      return
    }

    const manifest = await fs.readJson(manifestPath)
    res.status(200).json(manifest)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`getAutoMDSAXSAnalysis ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to read AutoMD-SAXS analysis.' })
  }
}

/**
 * GET /jobs/:id/automd-saxs-trajectory?repeat=N&maxModels=M
 *
 * Builds a solvent-free multi-model PDB for one production repeat by
 * concatenating the per-frame structure_*.pdb files the pipeline extracted
 * (already stripped of water/ions). The frames are numerically ordered and
 * subsampled to at most `maxModels` (default 30) so the browser viewer can
 * animate the trajectory without loading every frame. Each frame becomes one
 * MODEL/ENDMDL block; a single CRYST1 header is preserved and CONECT records
 * are dropped (Molstar derives bonds). Returns text/plain PDB, or 404 if the
 * repeat has no extracted frames yet.
 */
export const getAutoMDSAXSTrajectory = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId
  if (!id) {
    res.status(400).json({ message: 'Job ID required.' })
    return
  }

  const repeat = Math.max(1, parseInt(String(req.query['repeat'] ?? '1'), 10) || 1)
  const maxModels = Math.min(
    200,
    Math.max(2, parseInt(String(req.query['maxModels'] ?? '30'), 10) || 30)
  )

  try {
    const job = await Job.findOne({ _id: id }).exec()
    if (!job) {
      res.status(404).json({ message: `No job matches ID ${id}.` })
      return
    }
    if (job.__t !== 'BilboMdAutoMDSAXS') {
      res.status(400).json({
        message: 'This endpoint is only available for AutoMD-SAXS jobs.'
      })
      return
    }

    const framesDir = path.join(
      uploadFolder,
      job.uuid,
      'results',
      'frames',
      `rep${repeat}`
    )
    if (!(await fs.pathExists(framesDir))) {
      res.status(404).json({ message: `No frames for repeat ${repeat}.` })
      return
    }

    const entries = await fs.readdir(framesDir)
    const frames = entries
      .map((name) => {
        const m = name.match(/^structure_(\d+)\.pdb$/)
        return m ? { name, index: parseInt(m[1], 10) } : null
      })
      .filter((f): f is { name: string; index: number } => f !== null)
      .sort((a, b) => a.index - b.index)

    if (frames.length === 0) {
      res.status(404).json({ message: `No frames for repeat ${repeat}.` })
      return
    }

    // Subsample evenly to at most maxModels frames (always keep first & last).
    const stride = Math.max(1, Math.ceil(frames.length / maxModels))
    const picked = frames.filter((_, i) => i % stride === 0)
    if (picked[picked.length - 1]!.index !== frames[frames.length - 1]!.index) {
      picked.push(frames[frames.length - 1]!)
    }

    const isAtom = (line: string): boolean =>
      line.startsWith('ATOM') || line.startsWith('HETATM') || line.startsWith('TER')

    let cryst = ''
    const blocks: string[] = []
    for (let i = 0; i < picked.length; i++) {
      const text = await fs.readFile(path.join(framesDir, picked[i]!.name), 'utf8')
      const lines = text.split('\n')
      if (!cryst) {
        const c = lines.find((l) => l.startsWith('CRYST1'))
        if (c) cryst = c
      }
      const atomLines = lines.filter(isAtom).join('\n')
      const modelNum = String(i + 1).padStart(8, ' ')
      blocks.push(`MODEL ${modelNum}\n${atomLines}\nENDMDL`)
    }

    const header = cryst ? `${cryst}\n` : ''
    const pdb = `${header}${blocks.join('\n')}\nEND\n`

    res.status(200).type('text/plain').send(pdb)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`getAutoMDSAXSTrajectory ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to build AutoMD-SAXS trajectory.' })
  }
}

// Read the last integration step from an OpenMM StateDataReporter log (CSV with
// a quoted header; first column is Step). Returns null if unreadable/empty.
const lastStepFromLog = async (logPath: string): Promise<number | null> => {
  try {
    const text = await fs.readFile(logPath, 'utf8')
    const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
    if (lines.length === 0) return null
    const first = lines[lines.length - 1].split(',')[0]
    const step = parseInt(first, 10)
    return Number.isFinite(step) ? step : null
  } catch {
    return null
  }
}

/**
 * GET /jobs/:id/automd-saxs-live-progress
 *
 * While an AutoMD-SAXS job runs, report the current stage (from results/progress.json
 * the CLI writes) and a per-repeat ns counter (derived from each production log's
 * last StateDataReporter step). Returns { status: 'pending' } before progress.json
 * exists. Mirrors getCarbonaraLiveProgress.
 */
export const getAutoMDSAXSLiveProgress = async (
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
    if (job.__t !== 'BilboMdAutoMDSAXS') {
      res.status(400).json({
        message: 'This endpoint is only available for AutoMD-SAXS jobs.'
      })
      return
    }

    const jobDir = path.join(uploadFolder, job.uuid, 'results')
    const progressPath = path.join(jobDir, 'progress.json')
    if (!(await fs.pathExists(progressPath))) {
      res.status(200).json({ status: 'pending' })
      return
    }

    const p = await fs.readJson(progressPath)
    const nRepeats: number = p.nRepeats ?? 1
    const stepTotal: number = p.productionSteps ?? 0
    const timestepFs: number = p.timestepFs ?? 2.0
    const nsTotal: number = p.simulationTimeNs ?? 0

    const repeats = []
    for (let i = 1; i <= nRepeats; i++) {
      const logPath = path.join(jobDir, 'production', `rep${i}`, 'production.log')
      const stepDone = await lastStepFromLog(logPath)
      repeats.push({
        repeat: i,
        stepDone: stepDone ?? 0,
        stepTotal,
        nsDone: stepDone != null ? (stepDone * timestepFs) / 1e6 : 0,
        nsTotal
      })
    }

    res.status(200).json({
      status: 'running',
      stage: p.stage ?? null,
      currentRepeat: p.currentRepeat ?? 0,
      nRepeats,
      repeats
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`getAutoMDSAXSLiveProgress ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to read AutoMD-SAXS live progress.' })
  }
}
