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
