import { v4 as uuid } from 'uuid'
import path from 'path'
import fs from 'fs-extra'
import multer from 'multer'
import { Request, Response } from 'express'
import { logger } from '../../middleware/loggers.js'
import { getEnvVar } from '../../config/config.js'
import { queueGuinierJob } from '../../queues/carbonaraGuinier.js'

const uploadFolder = path.join(getEnvVar('DATA_VOL'))

/**
 * POST /jobs/carbonara-guinier
 *
 * Accepts dat_file (multipart). Saves it to DATA_VOL/carbonara_guinier/<uuid>,
 * queues a carbonara-guinier job (AutoRg-style Guinier analysis, no data
 * mutation), responds { previewId }. Mirrors createCarbonaraPdbfixer.
 */
export const createCarbonaraGuinier = async (
  req: Request,
  res: Response
): Promise<void> => {
  const previewId = uuid()
  const workDir = path.join(uploadFolder, 'carbonara_guinier', previewId)

  try {
    await fs.ensureDir(workDir)

    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, workDir),
      filename: (_req, file, cb) => cb(null, file.originalname.toLowerCase())
    })
    const upload = multer({ storage }).fields([
      { name: 'dat_file', maxCount: 1 }
    ])

    upload(req, res, async (err) => {
      if (err) {
        logger.error(`createCarbonaraGuinier upload error: ${err}`)
        fs.remove(workDir).catch(() => undefined)
        res.status(500).json({ message: 'Failed to upload SAXS data for Guinier' })
        return
      }
      try {
        const files = req.files as
          | Record<string, Express.Multer.File[]>
          | undefined
        const datFiles = files?.['dat_file']
        if (!datFiles || datFiles.length === 0) {
          fs.remove(workDir).catch(() => undefined)
          res.status(400).json({ message: 'dat_file is required' })
          return
        }
        const datFile = datFiles[0]!.originalname.toLowerCase()

        try {
          await queueGuinierJob({ previewId, datFile })
          res.status(202).json({ previewId })
        } catch (queueErr) {
          const msg =
            queueErr instanceof Error ? queueErr.message : String(queueErr)
          logger.error(`createCarbonaraGuinier queue error: ${msg}`)
          fs.remove(workDir).catch(() => undefined)
          res.status(500).json({ message: 'Failed to queue Guinier analysis' })
        }
      } catch (innerErr) {
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr)
        logger.error(`createCarbonaraGuinier inner error: ${msg}`)
        fs.remove(workDir).catch(() => undefined)
        res.status(500).json({ message: 'Failed to process Guinier request' })
      }
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`createCarbonaraGuinier: ${msg}`)
    res.status(500).json({ message: 'Failed to create Guinier directory' })
  }
}

/**
 * GET /jobs/carbonara-guinier/:id
 *
 * Reads DATA_VOL/carbonara_guinier/:id/result.json. Returns { status: 'pending' }
 * until the worker writes it.
 */
export const getCarbonaraGuinier = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId
  if (!id) {
    res.status(400).json({ message: 'Missing guinier id' })
    return
  }
  const resultPath = path.join(
    uploadFolder,
    'carbonara_guinier',
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
    logger.error(`getCarbonaraGuinier ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to read Guinier result' })
  }
}
