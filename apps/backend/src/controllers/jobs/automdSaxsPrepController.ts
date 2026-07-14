import { v4 as uuid } from 'uuid'
import path from 'path'
import fs from 'fs-extra'
import multer from 'multer'
import { Request, Response } from 'express'
import { logger } from '../../middleware/loggers.js'
import { getEnvVar } from '../../config/config.js'
import {
  queueAutoMDSaxsPrep,
  AutoMDSaxsPrepJobData
} from '../../queues/automdSaxsPrep.js'

const uploadFolder = path.join(getEnvVar('DATA_VOL'))
const PREP_SUBDIR = 'automd_saxs_prep'

const toBool = (v: unknown): boolean | undefined =>
  v === undefined ? undefined : v === 'true' || v === '1' || v === true
const toNum = (v: unknown): number | undefined => {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const toJson = <T>(v: unknown): T | undefined => {
  if (typeof v !== 'string' || v.trim() === '') return undefined
  try {
    return JSON.parse(v) as T
  } catch {
    return undefined
  }
}

/**
 * POST /jobs/automd-saxs-prep
 *
 * Accepts a pdb_file (multipart) + structure-prep settings (pH, keep_ions,
 * ligand_smiles, protonation_overrides, ...). Saves to
 * DATA_VOL/automd_saxs_prep/<uuid>, queues an automd-saxs-prep job, responds
 * { previewId }. The prep-preview runs ONLY structure preparation (no MD) so the
 * review page can show the prepared structure before the full job is submitted.
 */
export const createAutoMDSaxsPrep = async (
  req: Request,
  res: Response
): Promise<void> => {
  const previewId = uuid()
  const previewDir = path.join(uploadFolder, PREP_SUBDIR, previewId)

  try {
    await fs.ensureDir(previewDir)
    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, previewDir),
      filename: (_req, file, cb) => cb(null, file.originalname.toLowerCase())
    })
    const upload = multer({ storage }).fields([{ name: 'pdb_file', maxCount: 1 }])

    upload(req, res, async (err) => {
      if (err) {
        logger.error(`createAutoMDSaxsPrep upload error: ${err}`)
        fs.remove(previewDir).catch(() => undefined)
        res.status(500).json({ message: 'Failed to upload PDB for prep preview' })
        return
      }
      try {
        const files = req.files as Record<string, Express.Multer.File[]> | undefined
        const pdbFiles = files?.['pdb_file']
        if (!pdbFiles || pdbFiles.length === 0) {
          fs.remove(previewDir).catch(() => undefined)
          res.status(400).json({ message: 'pdb_file is required' })
          return
        }
        const data: AutoMDSaxsPrepJobData = {
          previewId,
          pdbFile: pdbFiles[0]!.originalname.toLowerCase(),
          system: (req.body?.system as string) || undefined,
          forceField: (req.body?.force_field as string) || undefined,
          waterModel: (req.body?.water_model as string) || undefined,
          ph: toNum(req.body?.ph),
          ionicConcentrationM: toNum(req.body?.ionic_concentration_M),
          disulfide: toBool(req.body?.disulfide),
          keepIons: toBool(req.body?.keep_ions),
          keepCrystallisationAgents: toBool(req.body?.keep_crystallisation_agents),
          keepWaters: toBool(req.body?.keep_waters),
          ionResnames: toJson<string[]>(req.body?.ion_resnames),
          ligandResnames: toJson<string[]>(req.body?.ligand_resnames),
          ligandSmiles: toJson<Record<string, string>>(req.body?.ligand_smiles),
          protonationOverrides: toJson<Record<string, string>>(
            req.body?.protonation_overrides
          )
        }
        try {
          await queueAutoMDSaxsPrep(data)
          res.status(202).json({ previewId })
        } catch (queueErr) {
          logger.error(`createAutoMDSaxsPrep queue error: ${String(queueErr)}`)
          fs.remove(previewDir).catch(() => undefined)
          res.status(500).json({ message: 'Failed to queue prep preview' })
        }
      } catch (innerErr) {
        logger.error(`createAutoMDSaxsPrep inner error: ${String(innerErr)}`)
        fs.remove(previewDir).catch(() => undefined)
        res.status(500).json({ message: 'Failed to process prep preview' })
      }
    })
  } catch (error) {
    logger.error(`createAutoMDSaxsPrep: ${String(error)}`)
    res.status(500).json({ message: 'Failed to create prep preview directory' })
  }
}

/**
 * GET /jobs/automd-saxs-prep/:id
 *
 * Reads DATA_VOL/automd_saxs_prep/:id/prep_audit.json; returns it when ready,
 * else { status: 'pending' }.
 */
export const getAutoMDSaxsPrep = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId
  if (!id) {
    res.status(400).json({ message: 'Missing preview id' })
    return
  }
  const auditPath = path.join(uploadFolder, PREP_SUBDIR, id, 'prep_audit.json')
  try {
    if (!(await fs.pathExists(auditPath))) {
      res.status(200).json({ status: 'pending' })
      return
    }
    res.status(200).json(await fs.readJson(auditPath))
  } catch (error) {
    logger.error(`getAutoMDSaxsPrep ${id}: ${String(error)}`)
    res.status(500).json({ message: 'Failed to read prep result' })
  }
}

/**
 * POST /jobs/automd-saxs-prep/:id/reprepare
 *
 * Re-runs the prep preview for an existing upload with a new pH and/or manual
 * protonation overrides (from the review-page table), reusing the already-
 * uploaded PDB + content settings. Body: { ph?, protonation_overrides? }.
 */
export const reprepareAutoMDSaxsPrep = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId
  if (!id) {
    res.status(400).json({ message: 'Missing preview id' })
    return
  }
  const previewDir = path.join(uploadFolder, PREP_SUBDIR, id)
  const configPath = path.join(previewDir, 'prep_config.json')
  const auditPath = path.join(previewDir, 'prep_audit.json')
  try {
    if (!(await fs.pathExists(configPath))) {
      res.status(404).json({ message: 'No prior prep to re-run' })
      return
    }
    const prior = await fs.readJson(configPath)
    const data: AutoMDSaxsPrepJobData = {
      previewId: id,
      pdbFile: path.basename(String(prior.pdb || '')),
      system: prior.system,
      forceField: prior.force_field,
      waterModel: prior.water_model,
      ph: req.body?.ph !== undefined ? Number(req.body.ph) : prior.ph,
      ionicConcentrationM: prior.ionic_concentration_M,
      disulfide: prior.disulfide,
      keepIons: prior.keep_ions,
      keepCrystallisationAgents: prior.keep_crystallisation_agents,
      keepWaters: prior.keep_waters,
      ionResnames: prior.ion_resnames,
      ligandResnames: prior.ligand_resnames,
      ligandSmiles: prior.ligand_smiles,
      protonationOverrides:
        req.body?.protonation_overrides ?? prior.protonation_overrides
    }
    // Remove the old audit so the UI's poll shows 'pending' until the re-run
    // finishes.
    await fs.remove(auditPath).catch(() => undefined)
    await queueAutoMDSaxsPrep(data)
    res.status(202).json({ previewId: id })
  } catch (error) {
    logger.error(`reprepareAutoMDSaxsPrep ${id}: ${String(error)}`)
    res.status(500).json({ message: 'Failed to re-run prep' })
  }
}

/**
 * GET /jobs/automd-saxs-prep/:id/prepared
 *
 * Serves the prepared.pdb (protein + H + kept ligands/ions) for the review 3D
 * viewer. Returns 404 until preparation has produced it.
 */
export const getAutoMDSaxsPreparedPdb = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawId = req.params['id']
  const id = Array.isArray(rawId) ? rawId[0] : rawId
  if (!id) {
    res.status(400).json({ message: 'Missing preview id' })
    return
  }
  const preparedPath = path.join(uploadFolder, PREP_SUBDIR, id, 'prepared.pdb')
  try {
    if (!(await fs.pathExists(preparedPath))) {
      res.status(404).json({ message: 'prepared.pdb not available yet' })
      return
    }
    res.status(200).type('text/plain').send(await fs.readFile(preparedPath, 'utf8'))
  } catch (error) {
    logger.error(`getAutoMDSaxsPreparedPdb ${id}: ${String(error)}`)
    res.status(500).json({ message: 'Failed to read prepared structure' })
  }
}
