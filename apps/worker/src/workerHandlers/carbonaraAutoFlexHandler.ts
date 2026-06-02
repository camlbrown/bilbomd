import { Job } from 'bullmq'
import path from 'node:path'
import fs from 'fs-extra'
import { logger } from '../helpers/loggers.js'
import { config } from '../config/config.js'
import {
  buildAutoFlexContainerArgs,
  runCarbonaraContainer
} from '../services/functions/carbonara-functions.js'

export interface CarbonaraAutoFlexJobData {
  previewId: string
  pdbFile: string
  datFile: string
  minQ?: number | null
  maxQ?: number | null
  // Optional PAE-guided selection (Carbonara --alphaFoldFlex getFlexibility).
  paeFile?: string | null
  paeFlexThreshold?: number | null
}

/**
 * BullMQ job processor for the 'carbonara-autoflex' queue (B2.4).
 *
 * Reads job.data { previewId, pdbFile, datFile, minQ, maxQ }, resolves the host
 * autoflex directory, runs carbonara_autoflex.py inside the Carbonara container
 * (which runs setup_carbonara.py to obtain the auto-selected varying sections
 * and maps them to per-chain residue ranges), and ensures a result.json exists
 * in the directory on exit. Writes all stdout/stderr to autoflex.log. Never
 * throws uncaught — a failed run is represented by { status: 'error', message }.
 */
export const processCarbonaraAutoFlex = async (
  job: Job<CarbonaraAutoFlexJobData>
): Promise<void> => {
  const { previewId, pdbFile, datFile, minQ, maxQ, paeFile, paeFlexThreshold } =
    job.data

  const workDir = path.join(config.uploadDir, 'carbonara_autoflex', previewId)
  const resultJson = path.join(workDir, 'result.json')
  const logFile = path.join(workDir, 'autoflex.log')

  logger.info(`carbonara-autoflex ${previewId}: starting`, {
    previewId,
    pdbFile,
    datFile,
    minQ,
    maxQ,
    paeFile: paeFile ?? null
  })

  const writeError = async (message: string): Promise<void> => {
    try {
      await fs.outputJson(resultJson, { status: 'error', message })
    } catch (writeErr) {
      logger.error(
        `carbonara-autoflex ${previewId}: could not write error result.json: ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }`
      )
    }
  }

  let logStream: fs.WriteStream | undefined
  try {
    await fs.ensureDir(workDir)
    logStream = fs.createWriteStream(logFile, { flags: 'a' })

    const args = buildAutoFlexContainerArgs({
      image: config.carbonara.image,
      hostDir: workDir,
      pdbFileName: pdbFile,
      datFileName: datFile,
      pythonBin: config.carbonara.pythonBin,
      autoFlexPath: config.carbonara.autoFlexPath,
      carbonaraRoot: config.carbonara.carbonaraRoot,
      minQ: minQ ?? null,
      maxQ: maxQ ?? null,
      paeFileName: paeFile ?? null,
      paeFlexThreshold: paeFlexThreshold ?? null,
      autoFlexMount: config.carbonara.autoFlexMount || undefined
    })

    logger.info(`carbonara-autoflex ${previewId}: running container`, {
      args: [config.carbonara.containerBin, ...args].join(' ')
    })

    const { code } = await runCarbonaraContainer({
      containerBin: config.carbonara.containerBin,
      args,
      cwd: workDir,
      // Setup runs the C++ generate_structure many times; give it room but cap.
      timeoutMs: 12 * 60 * 1000,
      onStdoutLine: (line) => {
        logStream?.write(line + '\n')
        logger.debug(`carbonara-autoflex ${previewId} stdout: ${line}`)
      },
      onStderrLine: (line) => {
        logStream?.write(line + '\n')
        logger.warn(`carbonara-autoflex ${previewId} stderr: ${line}`)
      }
    })

    const resultExists = await fs.pathExists(resultJson)
    if (!resultExists) {
      await writeError(
        `auto-flexibility failed (container exit code ${code ?? 'unknown'})`
      )
    } else {
      logger.info(`carbonara-autoflex ${previewId}: result.json written`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`carbonara-autoflex ${previewId}: unexpected error: ${message}`)
    await writeError(`auto-flexibility error: ${message}`)
  } finally {
    logStream?.end()
  }
}
