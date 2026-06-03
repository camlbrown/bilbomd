import { Request, Response } from 'express'
import path from 'path'
import fs from 'fs-extra'
import { Job } from '@bilbomd/mongodb-schema'
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
