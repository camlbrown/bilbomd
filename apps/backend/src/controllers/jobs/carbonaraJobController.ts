import { v4 as uuid } from 'uuid'
import path from 'path'
import fs from 'fs-extra'
import { logger } from '../../middleware/loggers.js'
import multer from 'multer'
import { User } from '@bilbomd/mongodb-schema'
import { Request, Response } from 'express'
import { BilboMDDispatchContext } from '../../types/bilbomd.js'
import { handleBilboMDCarbonaraJob } from './handleBilboMDCarbonaraJob.js'
import { getEnvVar } from '../../config/config.js'

const uploadFolder = path.join(getEnvVar('DATA_VOL'))

const createCarbonaraJob = async (req: Request, res: Response) => {
  const UUID = uuid()
  const jobDir = path.join(uploadFolder, UUID)
  logger.info(`createCarbonaraJob ${UUID}`)
  try {
    await fs.mkdir(jobDir, { recursive: true })
    logger.info(`Created directory: ${jobDir}`)

    const storage = multer.diskStorage({
      destination: function (req, file, cb) {
        cb(null, jobDir)
      },
      filename: function (req, file, cb) {
        cb(null, file.originalname.toLowerCase())
      }
    })

    const upload = multer({ storage: storage })
    upload.fields([
      { name: 'pdb_file', maxCount: 1 },
      { name: 'dat_file', maxCount: 1 }
    ])(req, res, async (err) => {
      if (err) {
        logger.error(`Failed to upload one or more files: ${err}`)
        await fs.remove(jobDir)
        res.status(500).json({ message: 'Failed to upload one or more files' })
        return
      }

      try {
        const { bilbomd_mode } = req.body
        const email = req.email

        const foundUser = await User.findOne({ email })
          .select('_id username email')
          .lean()
          .exec()

        if (!foundUser) {
          res.status(401).json({ message: 'No user found with that email' })
          return
        }

        if (!bilbomd_mode) {
          res.status(400).json({ message: 'No job type provided' })
          return
        }

        // Update jobCount and jobTypes
        const jobTypeField = `jobTypes.${bilbomd_mode}`
        await User.findByIdAndUpdate(foundUser._id, {
          $inc: { jobCount: 1, [jobTypeField]: 1 }
        })

        const dispatchUser = {
          ...foundUser,
          _id: foundUser._id.toString()
        }

        await dispatchBilboMDCarbonaraJob({
          req,
          res,
          bilbomd_mode,
          UUID,
          user: dispatchUser,
          accessMode: 'user'
        })
      } catch (error) {
        logger.error(`Error occurred during job creation: ${error}`)
        await fs.remove(jobDir)
        res.status(500).json({ message: 'Internal server error' })
      }
    })
  } catch (error) {
    logger.error(`Failed to create job directory: ${error}`)
    res.status(500).json({ message: 'Failed to create job directory' })
  }
}

const dispatchBilboMDCarbonaraJob = async (ctx: BilboMDDispatchContext) => {
  const { req, res, bilbomd_mode, user, UUID, accessMode, publicId, client_ip_hash } =
    ctx
  logger.info(`Starting BilboMDJob mode: ${bilbomd_mode} (${accessMode})`)
  await handleBilboMDCarbonaraJob(req, res, user, UUID, {
    accessMode,
    publicId,
    client_ip_hash
  })
}

export { createCarbonaraJob }
