import { Job } from 'bullmq'
import path from 'node:path'
import fs from 'fs-extra'
import { logger } from '../helpers/loggers.js'
import { config } from '../config/config.js'
import {
  buildInitFoxsContainerArgs,
  runCarbonaraContainer
} from '../services/functions/carbonara-functions.js'

export interface CarbonaraPreviewJobData {
  previewId: string
  pdbFile: string
  datFile: string
  maxQ?: number | null
}

/**
 * BullMQ job processor for the 'carbonara-preview' queue (B5).
 *
 * Reads job.data { previewId, pdbFile, datFile, maxQ }, resolves the host
 * preview directory, runs carbonara_initfoxs.py inside the Carbonara container,
 * and ensures a result.json exists in the preview directory on exit. Writes all
 * stdout/stderr to previewDir/initfoxs.log. Never throws uncaught — a failed
 * run is represented by { status: 'error', message } in result.json.
 */
export const processCarbonaraInitFoxs = async (
  job: Job<CarbonaraPreviewJobData>
): Promise<void> => {
  const { previewId, pdbFile, datFile, maxQ } = job.data

  const previewDir = path.join(
    config.uploadDir,
    'carbonara_initfoxs',
    previewId
  )
  const resultJson = path.join(previewDir, 'result.json')
  const logFile = path.join(previewDir, 'initfoxs.log')

  logger.info(`carbonara-preview ${previewId}: starting`, {
    previewId,
    pdbFile,
    datFile,
    maxQ
  })

  const writeError = async (message: string): Promise<void> => {
    try {
      await fs.outputJson(resultJson, { status: 'error', message })
    } catch (writeErr) {
      logger.error(
        `carbonara-preview ${previewId}: could not write error result.json: ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }`
      )
    }
  }

  let logStream: fs.WriteStream | undefined
  try {
    await fs.ensureDir(previewDir)
    logStream = fs.createWriteStream(logFile, { flags: 'a' })

    const args = buildInitFoxsContainerArgs({
      image: config.carbonara.image,
      hostDir: previewDir,
      pdbFileName: pdbFile,
      datFileName: datFile,
      maxQ: maxQ ?? null,
      pythonBin: config.carbonara.pythonBin,
      initFoxsPath: config.carbonara.initFoxsPath,
      initFoxsMount: config.carbonara.initFoxsMount || undefined
    })

    logger.info(
      `carbonara-preview ${previewId}: running container`,
      { args: [config.carbonara.containerBin, ...args].join(' ') }
    )

    const { code } = await runCarbonaraContainer({
      containerBin: config.carbonara.containerBin,
      args,
      cwd: previewDir,
      timeoutMs: 5 * 60 * 1000, // 5 min cap for a preview
      onStdoutLine: (line) => {
        logStream?.write(line + '\n')
        logger.debug(`carbonara-preview ${previewId} stdout: ${line}`)
      },
      onStderrLine: (line) => {
        logStream?.write(line + '\n')
        logger.warn(`carbonara-preview ${previewId} stderr: ${line}`)
      }
    })

    const resultExists = await fs.pathExists(resultJson)
    if (!resultExists) {
      await writeError(
        `preview failed (container exit code ${code ?? 'unknown'})`
      )
    } else {
      logger.info(`carbonara-preview ${previewId}: result.json written`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`carbonara-preview ${previewId}: unexpected error: ${message}`)
    await writeError(`preview error: ${message}`)
  } finally {
    logStream?.end()
  }
}
