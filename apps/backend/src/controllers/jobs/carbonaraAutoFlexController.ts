import { v4 as uuid } from 'uuid'
import path from 'path'
import fs from 'fs-extra'
import multer from 'multer'
import { Request, Response } from 'express'
import { logger } from '../../middleware/loggers.js'
import { getEnvVar } from '../../config/config.js'
import { queueAutoFlexJob } from '../../queues/carbonaraAutoFlex.js'

const uploadFolder = path.join(getEnvVar('DATA_VOL'))

/**
 * POST /jobs/carbonara-autoflex
 *
 * Accepts pdb_file + dat_file (multipart), optional min_q/max_q in body.
 * Saves files to DATA_VOL/carbonara_autoflex/<uuid>, queues a
 * carbonara-autoflex job, responds { previewId }.
 */
export const createCarbonaraAutoFlex = async (
  req: Request,
  res: Response
): Promise<void> => {
  const previewId = uuid()
  const workDir = path.join(uploadFolder, 'carbonara_autoflex', previewId)

  try {
    await fs.ensureDir(workDir)
    logger.info(`createCarbonaraAutoFlex: created workDir ${workDir}`)

    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => {
        cb(null, workDir)
      },
      filename: (_req, file, cb) => {
        cb(null, file.originalname.toLowerCase())
      }
    })

    const upload = multer({ storage }).fields([
      { name: 'pdb_file', maxCount: 1 },
      { name: 'dat_file', maxCount: 1 },
      { name: 'pae_file', maxCount: 1 }
    ])

    upload(req, res, async (err) => {
      if (err) {
        logger.error(`createCarbonaraAutoFlex upload error: ${err}`)
        fs.remove(workDir).catch(() => undefined)
        res
          .status(500)
          .json({ message: 'Failed to upload files for autoflex prepare' })
        return
      }

      try {
        const files = req.files as
          | Record<string, Express.Multer.File[]>
          | undefined

        const pdbFiles = files?.['pdb_file']
        const datFiles = files?.['dat_file']

        if (!pdbFiles || pdbFiles.length === 0) {
          fs.remove(workDir).catch(() => undefined)
          res.status(400).json({ message: 'pdb_file is required' })
          return
        }
        if (!datFiles || datFiles.length === 0) {
          fs.remove(workDir).catch(() => undefined)
          res.status(400).json({ message: 'dat_file is required' })
          return
        }

        const pdbFile = pdbFiles[0]!.originalname.toLowerCase()
        const datFile = datFiles[0]!.originalname.toLowerCase()
        const paeFiles = files?.['pae_file']
        const paeFile =
          paeFiles && paeFiles.length > 0
            ? paeFiles[0]!.originalname.toLowerCase()
            : null

        const parseNum = (raw: unknown): number | null =>
          raw !== undefined && raw !== '' ? Number(raw) : null
        const minQ = parseNum(req.body?.min_q)
        const maxQ = parseNum(req.body?.max_q)
        const paeFlexThreshold = parseNum(req.body?.pae_flex_threshold)

        logger.info(`createCarbonaraAutoFlex: queueing autoflex ${previewId}`, {
          pdbFile,
          datFile,
          minQ,
          maxQ,
          paeFile
        })

        try {
          await queueAutoFlexJob({
            previewId,
            pdbFile,
            datFile,
            minQ,
            maxQ,
            paeFile,
            paeFlexThreshold
          })
          res.status(202).json({ previewId })
        } catch (queueErr) {
          const msg =
            queueErr instanceof Error ? queueErr.message : String(queueErr)
          logger.error(`createCarbonaraAutoFlex queue error: ${msg}`)
          fs.remove(workDir).catch(() => undefined)
          res.status(500).json({ message: 'Failed to queue autoflex prepare' })
        }
      } catch (innerErr) {
        const msg =
          innerErr instanceof Error ? innerErr.message : String(innerErr)
        logger.error(`createCarbonaraAutoFlex inner error: ${msg}`)
        fs.remove(workDir).catch(() => undefined)
        res.status(500).json({ message: 'Failed to process autoflex prepare' })
      }
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`createCarbonaraAutoFlex: ${msg}`)
    res
      .status(500)
      .json({ message: 'Failed to create autoflex prepare directory' })
  }
}

/**
 * GET /jobs/carbonara-autoflex/:id
 *
 * Reads DATA_VOL/carbonara_autoflex/:id/result.json.
 * Returns parsed JSON if present, { status: 'pending' } otherwise.
 */
export const getCarbonaraAutoFlex = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId
  if (!id) {
    res.status(400).json({ message: 'Missing autoflex id' })
    return
  }

  const resultPath = path.join(
    uploadFolder,
    'carbonara_autoflex',
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
    logger.error(`getCarbonaraAutoFlex ${id}: ${msg}`)
    res.status(500).json({ message: 'Failed to read autoflex result' })
  }
}
