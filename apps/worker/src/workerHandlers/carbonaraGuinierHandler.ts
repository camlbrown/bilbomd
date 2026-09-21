import { Job } from 'bullmq'
import path from 'node:path'
import fs from 'fs-extra'
import { logger } from '../helpers/loggers.js'
import { config } from '../config/config.js'
import {
  buildGuinierContainerArgs,
  runCarbonaraContainer,
  CARBONARA_JOB_MOUNT
} from '../services/functions/carbonara-functions.js'

export interface CarbonaraGuinierJobData {
  previewId: string
  datFile: string
}

/**
 * BullMQ processor for the 'carbonara-guinier' preview queue (feature D preview).
 *
 * Runs carbonara_guinier.py inside the Carbonara container to compute the
 * AutoRg-style Guinier analysis (no data mutation), then ensures a result.json
 * exists in the work dir ({rg, i0, r2, qrg_*, slope, intercept, trim_*, points}).
 * Never throws uncaught — a failure is { status: 'error', message }. Output goes
 * to guinier.log. Mirrors processCarbonaraPdbfixer.
 */
export const processCarbonaraGuinier = async (
  job: Job<CarbonaraGuinierJobData>
): Promise<void> => {
  const { previewId, datFile } = job.data

  const workDir = path.join(config.uploadDir, 'carbonara_guinier', previewId)
  const resultJson = path.join(workDir, 'result.json')
  const logFile = path.join(workDir, 'guinier.log')

  logger.info(`carbonara-guinier ${previewId}: starting`, { previewId, datFile })

  const writeError = async (message: string): Promise<void> => {
    try {
      await fs.outputJson(resultJson, { status: 'error', message })
    } catch (writeErr) {
      logger.error(
        `carbonara-guinier ${previewId}: could not write error result.json: ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }`
      )
    }
  }

  let logStream: fs.WriteStream | undefined
  try {
    await fs.ensureDir(workDir)
    logStream = fs.createWriteStream(logFile, { flags: 'a' })

    const args = buildGuinierContainerArgs({
      image: config.carbonara.image,
      hostDir: workDir,
      datFileName: datFile,
      pythonBin: config.carbonara.pythonBin,
      guinierPath: config.carbonara.guinierPath,
      carbonaraRoot: config.carbonara.carbonaraRoot,
      guinierMount: config.carbonara.guinierMount || undefined,
      // inprocess (k8s): no /job bind mount — use the real work dir so paths are
      // valid in-pod. podman mode keeps '/job'.
      jobMount:
        config.carbonara.exec === 'inprocess' ? workDir : CARBONARA_JOB_MOUNT
    })

    logger.info(`carbonara-guinier ${previewId}: running container`, {
      args: [config.carbonara.containerBin, ...args].join(' ')
    })

    try {
      await runCarbonaraContainer({
        containerBin: config.carbonara.containerBin,
        args,
        cwd: workDir,
        execMode: config.carbonara.exec,
        image: config.carbonara.image,
        // Cap the run so a wedged analysis can't hold the BullMQ slot forever
        // (backmapTimeoutMs defaults to 0 = no cap). Guinier is normally seconds.
        timeoutMs: config.carbonara.backmapTimeoutMs || 5 * 60 * 1000,
        onStdoutLine: (line) => logStream?.write(line + '\n'),
        onStderrLine: (line) => logStream?.write(line + '\n')
      })
    } finally {
      await new Promise<void>((resolve) => {
        if (logStream) logStream.end(resolve)
        else resolve()
      })
    }

    if (!(await fs.pathExists(resultJson))) {
      await writeError('Guinier analysis did not produce a result.')
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`carbonara-guinier ${previewId}: ${msg}`)
    await writeError(msg)
  }
}
