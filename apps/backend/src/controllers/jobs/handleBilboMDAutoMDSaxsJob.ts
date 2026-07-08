import { logger } from '../../middleware/loggers.js'
import { queueJob } from '../../queues/bilbomd.js'
import {
  BilboMdAutoMDSAXSJob,
  IBilboMDAutoMDSAXSJob,
  IBilboMDSteps,
  StepStatus
} from '@bilbomd/mongodb-schema'
import { Request, Response } from 'express'
import path from 'path'
import { ValidationError } from 'yup'
import { getFileStats } from './utils/jobUtils.js'
import { config } from '../../config/config.js'
import { automdSaxsJobSchema } from '../../validation/index.js'
import { DispatchUser } from '../../types/bilbomd.js'

const uploadFolder = config.uploadDir

// Mirror the Mongoose schema defaults so a minimal form (structure + SAXS only)
// still produces a valid, runnable job.
const AUTOMD_SAXS_DEFAULTS = {
  system: 'Protein',
  force_field: 'amber14',
  water_model: 'tip3p',
  simulation_time_ns: 100,
  n_repeats: 3,
  temperature_K: 300,
  ionic_concentration_M: 0.15,
  ph: 7.0
}

const toNumber = (value: unknown, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const toOptionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

const toBoolean = (value: unknown): boolean =>
  value === true || value === 'true' || value === '1'

// Boolean that may be absent; returns the fallback when not provided so
// server-side defaults (e.g. keep_ions=true) hold.
const toBooleanOr = (value: unknown, fallback: boolean): boolean =>
  value === undefined || value === null || value === ''
    ? fallback
    : toBoolean(value)

// The form sends objects/arrays as JSON strings (multipart); accept a parsed
// value or a JSON string, else undefined.
const toParsed = <T>(value: unknown): T | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

const handleBilboMDAutoMDSaxsJob = async (
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
      `DAT File: ${datFile ? datFile.originalname.toLowerCase() : 'Not provided'}`
    )

    const jobPayload = {
      title,
      bilbomd_mode: bilbomdMode,
      email: req.body.email,
      pdb_file: pdbFile,
      dat_file: datFile,
      system: req.body.system,
      force_field: req.body.force_field,
      water_model: req.body.water_model,
      simulation_time_ns: req.body.simulation_time_ns,
      n_repeats: req.body.n_repeats,
      temperature_K: req.body.temperature_K,
      ionic_concentration_M: req.body.ionic_concentration_M,
      ph: req.body.ph,
      disulfide: req.body.disulfide,
      box_padding_nm: req.body.box_padding_nm,
      seed: req.body.seed,
      hmr: req.body.hmr,
      keep_ions: req.body.keep_ions,
      keep_crystallisation_agents: req.body.keep_crystallisation_agents,
      ligand_resnames: req.body.ligand_resnames,
      ligand_smiles: req.body.ligand_smiles,
      protonation_overrides: req.body.protonation_overrides
    }

    try {
      await automdSaxsJobSchema.validate(jobPayload, { abortEarly: false })
    } catch (validationErr) {
      if (validationErr instanceof ValidationError) {
        logger.warn('AutoMD-SAXS job payload validation failed', validationErr)
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

    if (!pdbFile) {
      return res.status(400).json({ message: 'A PDB file is required' })
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
      data_file: datFile ? datFile.originalname.toLowerCase() : 'none',
      dat_file: datFile ? datFile.originalname.toLowerCase() : undefined,
      system: req.body.system || AUTOMD_SAXS_DEFAULTS.system,
      force_field: req.body.force_field || AUTOMD_SAXS_DEFAULTS.force_field,
      water_model: req.body.water_model || AUTOMD_SAXS_DEFAULTS.water_model,
      simulation_time_ns: toNumber(
        req.body.simulation_time_ns,
        AUTOMD_SAXS_DEFAULTS.simulation_time_ns
      ),
      n_repeats: toNumber(req.body.n_repeats, AUTOMD_SAXS_DEFAULTS.n_repeats),
      temperature_K: toNumber(
        req.body.temperature_K,
        AUTOMD_SAXS_DEFAULTS.temperature_K
      ),
      ionic_concentration_M: toNumber(
        req.body.ionic_concentration_M,
        AUTOMD_SAXS_DEFAULTS.ionic_concentration_M
      ),
      ph: toNumber(req.body.ph, AUTOMD_SAXS_DEFAULTS.ph),
      disulfide: toBoolean(req.body.disulfide),
      box_padding_nm: toOptionalNumber(req.body.box_padding_nm),
      seed: toOptionalNumber(req.body.seed),
      hmr: toBoolean(req.body.hmr),
      keep_ions: toBooleanOr(req.body.keep_ions, true),
      keep_crystallisation_agents: toBoolean(req.body.keep_crystallisation_agents),
      ligand_resnames: toParsed<string[]>(req.body.ligand_resnames),
      ligand_smiles: toParsed<Record<string, string>>(req.body.ligand_smiles),
      protonation_overrides: toParsed<Record<string, string>>(
        req.body.protonation_overrides
      ),
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

    const newJob: IBilboMDAutoMDSAXSJob = new BilboMdAutoMDSAXSJob(jobData)
    await newJob.save()
    logger.info(`${bilbomdMode} Job saved to MongoDB: ${newJob._id.toString()}`)

    // Enqueue on the shared bilbomd queue; the worker routes 'automd-saxs' to the
    // AutoMD-SAXS pipeline via bilboMdHandler.
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
        message: `New BilboMD AutoMD-SAXS Job successfully created`,
        jobid: newJob._id.toString(),
        uuid: newJob.uuid,
        publicId: ctx.publicId,
        resultUrl,
        resultPath
      })
    } else {
      res.status(200).json({
        message: `New BilboMD AutoMD-SAXS Job successfully created`,
        jobid: newJob._id.toString(),
        uuid: newJob.uuid
      })
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error in handleBilboMDAutoMDSaxsJob: ${error.message}`)
      logger.error(`Stack Trace: ${error.stack}`)
    } else {
      logger.error(`Non-standard error object: ${error}`)
    }
    res
      .status(500)
      .json({ message: 'Failed to create handleBilboMDAutoMDSaxsJob job' })
  }
}

export { handleBilboMDAutoMDSaxsJob }
