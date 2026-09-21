import { v4 as uuid } from 'uuid'
import path from 'path'
import fs from 'fs-extra'
import multer from 'multer'
import { Request, Response } from 'express'
import { logger } from '../../middleware/loggers.js'
import { getEnvVar } from '../../config/config.js'
import { queuePdbfixerJob } from '../../queues/carbonaraPdbfixer.js'

const uploadFolder = path.join(getEnvVar('DATA_VOL'))

/**
 * POST /jobs/carbonara-pdbfixer
 *
 * Accepts pdb_file (multipart), optional residue_name/max_gap in the body.
 * Saves it to DATA_VOL/carbonara_pdbfixer/<uuid>, queues a carbonara-pdbfixer
 * job (which builds internal missing residues with PDBFixer), responds
 * { previewId }.
 */
export const createCarbonaraPdbfixer = async (
  req: Request,
  res: Response
): Promise<void> => {
  const previewId = uuid()
  const workDir = path.join(uploadFolder, 'carbonara_pdbfixer', previewId)

  try {
    await fs.ensureDir(workDir)

    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, workDir),
      filename: (_req, file, cb) => cb(null, file.originalname.toLowerCase())
    })
    const upload = multer({ storage }).fields([
      { name: 'pdb_file', maxCount: 1 }
    ])

    upload(req, res, async (err) => {
      if (err) {
        logger.error(`createCarbonaraPdbfixer upload error: ${err}`)
        fs.remove(workDir).catch(() => undefined)
        res.status(500).json({ message: 'Failed to upload structure for PDBFixer' })
        return
      }
      try {
        const files = req.files as
          | Record<string, Express.Multer.File[]>
          | undefined
        const pdbFiles = files?.['pdb_file']
        if (!pdbFiles || pdbFiles.length === 0) {
          fs.remove(workDir).catch(() => undefined)
          res.status(400).json({ message: 'pdb_file is required' })
          return
        }
        const pdbFile = pdbFiles[0]!.originalname.toLowerCase()
        const residueName =
          typeof req.body?.residue_name === 'string' && req.body.residue_name
            ? req.body.residue_name
            : null
        const maxGap =
          req.body?.max_gap !== undefined && req.body.max_gap !== ''
            ? Number(req.body.max_gap)
            : null

        try {
          await queuePdbfixerJob({ previewId, pdbFile, residueName, maxGap })
          res.status(202).json({ previewId })
        } catch (queueErr) {
          const msg =
            queueErr instanceof Error ? queueErr.message : String(queueErr)
          logger.error(`createCarbonaraPdbfixer queue error: ${msg}`)
          fs.remove(workDir).catch(() => undefined)
          res.status(500).json({ message: 'Failed to queue PDBFixer' })
        }
      } catch (innerErr) {
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr)
        logger.error(`createCarbonaraPdbfixer inner error: ${msg}`)
        fs.remove(workDir).catch(() => undefined)
        res.status(500).json({ message: 'Failed to process PDBFixer request' })
      }
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`createCarbonaraPdbfixer: ${msg}`)
    res.status(500).json({ message: 'Failed to create PDBFixer directory' })
  }
}

/**
 * GET /jobs/carbonara-pdbfixer/:id
 *
 * Reads DATA_VOL/carbonara_pdbfixer/:id/result.json ({status, residues_built,
 * fixed_pdb}). Returns { status: 'pending' } until the worker writes it.
 */
export const getCarbonaraPdbfixer = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId
  if (!id) {
    res.status(400).json({ message: 'Missing pdbfixer id' })
    return
  }
  const resultPath = path.join(
    uploadFolder,
    'carbonara_pdbfixer',
    id,
    'result.json'
  )
  try {
    if (!(await fs.pathExists(resultPath))) {
      res.status(200).json({ status: 'pending' })
      return
    }
    const result = await fs.readJson(resultPath)
    res.status(200).json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`getCarbonaraPdbfixer ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to read PDBFixer result' })
  }
}
