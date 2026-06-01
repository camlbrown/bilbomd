import { v4 as uuid } from 'uuid'
import path from 'path'
import fs from 'fs-extra'
import multer from 'multer'
import { Request, Response } from 'express'
import { logger } from '../../middleware/loggers.js'
import { getEnvVar } from '../../config/config.js'
import { queuePreviewJob } from '../../queues/carbonaraPreview.js'

const uploadFolder = path.join(getEnvVar('DATA_VOL'))

/**
 * POST /jobs/carbonara-initfoxs
 *
 * Accepts pdb_file + dat_file (multipart), optional max_q in body.
 * Saves files to DATA_VOL/carbonara_initfoxs/<uuid>, queues a
 * carbonara-preview job, responds { previewId }.
 */
export const createCarbonaraInitFoxs = async (
  req: Request,
  res: Response
): Promise<void> => {
  const previewId = uuid()
  const previewDir = path.join(
    uploadFolder,
    'carbonara_initfoxs',
    previewId
  )

  try {
    await fs.ensureDir(previewDir)
    logger.info(`createCarbonaraInitFoxs: created previewDir ${previewDir}`)

    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => {
        cb(null, previewDir)
      },
      filename: (_req, file, cb) => {
        cb(null, file.originalname.toLowerCase())
      }
    })

    const upload = multer({ storage }).fields([
      { name: 'pdb_file', maxCount: 1 },
      { name: 'dat_file', maxCount: 1 }
    ])

    upload(req, res, async (err) => {
      if (err) {
        logger.error(`createCarbonaraInitFoxs upload error: ${err}`)
        // Non-blocking cleanup — don't await before responding
        fs.remove(previewDir).catch(() => undefined)
        res
          .status(500)
          .json({ message: 'Failed to upload files for initfoxs preview' })
        return
      }

      try {
        const files = req.files as
          | Record<string, Express.Multer.File[]>
          | undefined

        const pdbFiles = files?.['pdb_file']
        const datFiles = files?.['dat_file']

        if (!pdbFiles || pdbFiles.length === 0) {
          // Cleanup non-blocking — don't await before responding
          fs.remove(previewDir).catch(() => undefined)
          res.status(400).json({ message: 'pdb_file is required' })
          return
        }
        if (!datFiles || datFiles.length === 0) {
          fs.remove(previewDir).catch(() => undefined)
          res.status(400).json({ message: 'dat_file is required' })
          return
        }

        const pdbFile = pdbFiles[0]!.originalname.toLowerCase()
        const datFile = datFiles[0]!.originalname.toLowerCase()

        const rawMaxQ = req.body?.max_q
        const maxQ =
          rawMaxQ !== undefined && rawMaxQ !== ''
            ? Number(rawMaxQ)
            : null

        logger.info(
          `createCarbonaraInitFoxs: queueing preview ${previewId}`,
          { pdbFile, datFile, maxQ }
        )

        try {
          await queuePreviewJob({ previewId, pdbFile, datFile, maxQ })
          res.status(202).json({ previewId })
        } catch (queueErr) {
          const msg =
            queueErr instanceof Error ? queueErr.message : String(queueErr)
          logger.error(`createCarbonaraInitFoxs queue error: ${msg}`)
          fs.remove(previewDir).catch(() => undefined)
          res.status(500).json({ message: 'Failed to queue initfoxs preview' })
        }
      } catch (innerErr) {
        const msg =
          innerErr instanceof Error ? innerErr.message : String(innerErr)
        logger.error(`createCarbonaraInitFoxs inner error: ${msg}`)
        fs.remove(previewDir).catch(() => undefined)
        res.status(500).json({ message: 'Failed to process initfoxs preview' })
      }
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`createCarbonaraInitFoxs: ${msg}`)
    res.status(500).json({ message: 'Failed to create initfoxs preview directory' })
  }
}

/**
 * GET /jobs/carbonara-initfoxs/:id
 *
 * Reads DATA_VOL/carbonara_initfoxs/:id/result.json.
 * Returns parsed JSON if present, { status: 'pending' } otherwise.
 */
export const getCarbonaraInitFoxs = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId
  if (!id) {
    res.status(400).json({ message: 'Missing preview id' })
    return
  }

  const resultPath = path.join(
    uploadFolder,
    'carbonara_initfoxs',
    id,
    'result.json'
  )

  try {
    const exists = await fs.pathExists(resultPath)
    if (!exists) {
      res.status(200).json({ status: 'pending' })
      return
    }

    const result = await fs.readJson(resultPath)
    res.status(200).json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`getCarbonaraInitFoxs ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to read initfoxs result' })
  }
}
