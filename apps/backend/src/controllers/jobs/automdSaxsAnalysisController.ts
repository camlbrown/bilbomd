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
