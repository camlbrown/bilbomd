import path from 'path'
import fs from 'fs-extra'
import { Job as BullMQJob } from 'bullmq'
import { logger } from '../helpers/loggers.js'
import { config } from '../config/config.js'
import {
  buildAutoMDSaxsConfig,
  buildAutoMDSaxsPrepArgs,
  runAutoMDSaxs
} from '../services/functions/automd-saxs-functions.js'

export interface AutoMDSaxsPrepJobData {
  previewId: string
  pdbFile: string
  system?: string
  forceField?: string
  waterModel?: string
  ph?: number
  ionicConcentrationM?: number
  disulfide?: boolean
  keepIons?: boolean
  keepCrystallisationAgents?: boolean
  keepWaters?: boolean
  ionResnames?: string[]
  ligandResnames?: string[]
  ligandSmiles?: Record<string, string>
  protonationOverrides?: Record<string, string>
}

/**
 * Prep-preview worker (Task 4): runs ONLY structure preparation
 * (`automd-saxs prepare`) on an uploaded PDB with the user's content/protonation
 * choices, so the review page can show the prepared structure before committing
 * to the full MD run. Writes prep_audit.json into the preview dir; a failure is
 * represented as { status: 'error', message } rather than an uncaught throw.
 */
export const processAutoMDSaxsPrep = async (
  job: BullMQJob<AutoMDSaxsPrepJobData>
): Promise<void> => {
  const d = job.data
  const previewDir = path.join(config.uploadDir, 'automd_saxs_prep', d.previewId)
  const auditPath = path.join(previewDir, 'prep_audit.json')
  const logFile = path.join(previewDir, 'prepare.log')

  const writeError = async (message: string): Promise<void> => {
    try {
      await fs.writeJson(auditPath, { status: 'error', message }, { spaces: 2 })
    } catch (err) {
      logger.error(
        `automd-saxs-prep ${d.previewId}: could not write error prep_audit.json: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  try {
    await fs.ensureDir(previewDir)
    const pdbPath = path.join(previewDir, d.pdbFile)
    const jobConfig = buildAutoMDSaxsConfig({
      jobName: d.previewId,
      pdbPath,
      // one repeat / minimal sim fields — prepare ignores MD settings anyway
      simulationTimeNs: 1,
      nRepeats: 1,
      system: d.system,
      forceField: d.forceField,
      waterModel: d.waterModel,
      ph: d.ph,
      ionicConcentrationM: d.ionicConcentrationM,
      disulfide: d.disulfide,
      keepIons: d.keepIons,
      keepCrystallisationAgents: d.keepCrystallisationAgents,
      keepWaters: d.keepWaters,
      ionResnames: d.ionResnames,
      ligandResnames: d.ligandResnames,
      ligandSmiles: d.ligandSmiles,
      protonationOverrides: d.protonationOverrides
    })
    const configPath = path.join(previewDir, 'prep_config.json')
    await fs.writeJson(configPath, jobConfig, { spaces: 2 })

    const args = buildAutoMDSaxsPrepArgs({ configPath, outDir: previewDir })
    logger.info(`automd-saxs-prep ${d.previewId}: ${config.automdSaxs.bin} ${args.join(' ')}`)
    const logStream = fs.createWriteStream(logFile, { flags: 'a' })
    let result
    try {
      result = await runAutoMDSaxs({
        bin: config.automdSaxs.bin,
        args,
        cwd: previewDir,
        // prep is fast; cap it so a hung preview can't linger.
        timeoutMs: 15 * 60 * 1000,
        onStdoutLine: (line) => logStream.write(line + '\n'),
        onStderrLine: (line) => logStream.write(line + '\n')
      })
    } finally {
      await new Promise<void>((resolve) => logStream.end(resolve))
    }

    if (!(await fs.pathExists(auditPath))) {
      await writeError(
        `preparation did not produce prep_audit.json (exit code ${result?.code}); see prepare.log`
      )
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`automd-saxs-prep ${d.previewId} failed: ${msg}`)
    await writeError(msg)
  }
}
