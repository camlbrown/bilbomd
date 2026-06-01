import { logger } from '../../middleware/loggers.js'
import { queueJob } from '../../queues/bilbomd.js'
import {
  BilboMdCarbonaraJob,
  IBilboMDCarbonaraJob,
  IBilboMDSteps,
  StepStatus
} from '@bilbomd/mongodb-schema'
import { Request, Response } from 'express'
import path from 'path'
import { ValidationError } from 'yup'
import { getFileStats } from './utils/jobUtils.js'
import { config } from '../../config/config.js'
import { carbonaraJobSchema } from '../../validation/index.js'
import { DispatchUser } from '../../types/bilbomd.js'

const uploadFolder = config.uploadDir

// Coarse-grained Carbonara defaults; mirror the Mongoose schema defaults so a
// minimal phase-1 form (structure + SAXS only) still produces a valid job.
const CARBONARA_DEFAULTS = {
  fit_n_times: 4,
  min_q: 0.01,
  max_q: 0.2,
  max_q_start: 0.2,
  max_fit_steps: 1000,
  mixture_n: 1
}

const toNumber = (value: unknown, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const toBoolean = (value: unknown): boolean =>
  value === true || value === 'true' || value === '1'

const handleBilboMDCarbonaraJob = async (
  req: Request,
  res: Response,
  user: DispatchUser | undefined,
  UUID: string,
  ctx: {
    accessMode: 'user' | 'anonymous'
    publicId?: string
    client_ip_hash?: string
  }
) => {
  try {
    const { bilbomd_mode: bilbomdMode, title } = req.body
    const files = req.files as { [fieldname: string]: Express.Multer.File[] }

    // Support example-data fallback (files referenced by name in the body).
    let pdbFile = files?.['pdb_file']?.[0]
    let datFile = files?.['dat_file']?.[0]
    if (!pdbFile && req.body.pdb_file) {
      pdbFile = {
        originalname: req.body.pdb_file,
        path: path.join(uploadFolder, UUID, req.body.pdb_file),
        size: getFileStats(path.join(uploadFolder, UUID, req.body.pdb_file)).size
      } as Express.Multer.File
    }
    if (!datFile && req.body.dat_file) {
      datFile = {
        originalname: req.body.dat_file,
        path: path.join(uploadFolder, UUID, req.body.dat_file),
        size: getFileStats(path.join(uploadFolder, UUID, req.body.dat_file)).size
      } as Express.Multer.File
    }

    logger.info(
      `PDB File: ${pdbFile ? pdbFile.originalname.toLowerCase() : 'Not Found'}`
    )
    logger.info(
      `DAT File: ${datFile ? datFile.originalname.toLowerCase() : 'Not Found'}`
    )

    const jobPayload = {
      title,
      bilbomd_mode: bilbomdMode,
      email: req.body.email,
      dat_file: datFile,
      pdb_file: pdbFile,
      fit_n_times: req.body.fit_n_times,
      min_q: req.body.min_q,
      max_q: req.body.max_q,
      max_q_start: req.body.max_q_start,
      max_fit_steps: req.body.max_fit_steps,
      mixture_n: req.body.mixture_n,
      rotation: req.body.rotation,
      all_atom: req.body.all_atom,
      do_foxs: req.body.do_foxs
    }

    try {
      await carbonaraJobSchema.validate(jobPayload, { abortEarly: false })
    } catch (validationErr) {
      if (validationErr instanceof ValidationError) {
        logger.warn('Carbonara job payload validation failed', validationErr)
        return res.status(400).json({
          message: 'Validation failed',
          errors: validationErr.inner?.map((err) => ({
            path: err.path,
            message: err.message
          }))
        })
      }
      throw validationErr
    }

    const steps: IBilboMDSteps = {
      results: { status: StepStatus.Waiting, message: '' },
      ...(ctx.accessMode === 'user' && {
        email: { status: StepStatus.Waiting, message: '' }
      })
    }

    const jobData = {
      title,
      uuid: UUID,
      pdb_file: pdbFile.originalname.toLowerCase(),
      data_file: datFile.originalname.toLowerCase(),
      fit_n_times: toNumber(req.body.fit_n_times, CARBONARA_DEFAULTS.fit_n_times),
      min_q: toNumber(req.body.min_q, CARBONARA_DEFAULTS.min_q),
      max_q: toNumber(req.body.max_q, CARBONARA_DEFAULTS.max_q),
      max_q_start: toNumber(req.body.max_q_start, CARBONARA_DEFAULTS.max_q_start),
      max_fit_steps: toNumber(
        req.body.max_fit_steps,
        CARBONARA_DEFAULTS.max_fit_steps
      ),
      mixture_n: toNumber(req.body.mixture_n, CARBONARA_DEFAULTS.mixture_n),
      rotation: toBoolean(req.body.rotation),
      all_atom: toBoolean(req.body.all_atom),
      do_foxs: req.body.do_foxs !== undefined ? toBoolean(req.body.do_foxs) : true,
      status: 'Submitted',
      time_submitted: new Date(),
      steps,
      access_mode: ctx.accessMode,
      ...(user ? { user } : {}),
      ...(ctx.accessMode === 'anonymous' && ctx.publicId
        ? { public_id: ctx.publicId }
        : {}),
      ...(ctx.accessMode === 'anonymous' && ctx.publicId
        ? { client_ip_hash: ctx.client_ip_hash }
        : {})
    }

    const newJob: IBilboMDCarbonaraJob = new BilboMdCarbonaraJob(jobData)
    await newJob.save()
    logger.info(`${bilbomdMode} Job saved to MongoDB: ${newJob._id.toString()}`)

    // Enqueue on the shared bilbomd queue; the worker routes 'carbonara' to the
    // Carbonara pipeline via bilboMdHandler.
    const jobDataForQueue = {
      type: bilbomdMode,
      title: newJob.title,
      uuid: newJob.uuid,
      jobid: newJob._id.toString()
    }
    const BullId = await queueJob(jobDataForQueue)

    logger.info(`${bilbomdMode} Job assigned UUID: ${newJob.uuid}`)
    logger.info(`${bilbomdMode} Job assigned BullMQ ID: ${BullId}`)

    if (ctx.accessMode === 'anonymous') {
      const origin = req.get('origin')
      const baseUrl =
        process.env.PUBLIC_BASE_URL ||
        origin ||
        `${req.protocol}://${req.get('host')}`
      const resultPath = `/results/${ctx.publicId}`
      const resultUrl = `${baseUrl}${resultPath}`

      res.status(200).json({
        message: `New BilboMD Carbonara Job successfully created`,
        jobid: newJob._id.toString(),
        uuid: newJob.uuid,
        publicId: ctx.publicId,
        resultUrl,
        resultPath
      })
    } else {
      res.status(200).json({
        message: `New BilboMD Carbonara Job successfully created`,
        jobid: newJob._id.toString(),
        uuid: newJob.uuid
      })
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error in handleBilboMDCarbonaraJob: ${error.message}`)
      logger.error(`Stack Trace: ${error.stack}`)
    } else {
      logger.error(`Non-standard error object: ${error}`)
    }
    res
      .status(500)
      .json({ message: 'Failed to create handleBilboMDCarbonaraJob job' })
  }
}

export { handleBilboMDCarbonaraJob }
