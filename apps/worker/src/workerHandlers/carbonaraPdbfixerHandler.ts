import { Job } from 'bullmq'
import path from 'node:path'
import fs from 'fs-extra'
import { logger } from '../helpers/loggers.js'
import { config } from '../config/config.js'
import {
  buildPdbfixerContainerArgs,
  runCarbonaraContainer,
  CARBONARA_JOB_MOUNT
} from '../services/functions/carbonara-functions.js'

export interface CarbonaraPdbfixerJobData {
  previewId: string
  pdbFile: string
  residueName?: string | null
  maxGap?: number | null
}

/**
 * BullMQ processor for the 'carbonara-pdbfixer' preview queue (feature G "build").
 *
 * Runs carbonara_pdbfixer.py inside the Carbonara container to build INTERNAL
 * missing residues with PDBFixer, then ensures a result.json exists in the work
 * dir ({status, residues_built, fixed_pdb}). Never throws uncaught — a failure is
 * represented by { status: 'error', message }. All output goes to pdbfixer.log.
 */
export const processCarbonaraPdbfixer = async (
  job: Job<CarbonaraPdbfixerJobData>
): Promise<void> => {
  const { previewId, pdbFile, residueName, maxGap } = job.data

  const workDir = path.join(config.uploadDir, 'carbonara_pdbfixer', previewId)
  const resultJson = path.join(workDir, 'result.json')
  const logFile = path.join(workDir, 'pdbfixer.log')

  logger.info(`carbonara-pdbfixer ${previewId}: starting`, { previewId, pdbFile })

  const writeError = async (message: string): Promise<void> => {
    try {
      await fs.outputJson(resultJson, { status: 'error', message })
    } catch (writeErr) {
      logger.error(
        `carbonara-pdbfixer ${previewId}: could not write error result.json: ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }`
      )
    }
  }

  let logStream: fs.WriteStream | undefined
  try {
    await fs.ensureDir(workDir)
    logStream = fs.createWriteStream(logFile, { flags: 'a' })

    const args = buildPdbfixerContainerArgs({
      image: config.carbonara.image,
      hostDir: workDir,
      pdbFileName: pdbFile,
      pythonBin: config.carbonara.pythonBin,
      pdbfixerPath: config.carbonara.pdbfixerPath,
      carbonaraRoot: config.carbonara.carbonaraRoot,
      residueName: residueName ?? undefined,
      maxGap: maxGap ?? undefined,
      pdbfixerMount: config.carbonara.pdbfixerMount || undefined,
      // inprocess (k8s): no /job bind mount — use the real work dir so paths are
      // valid in-pod. podman mode keeps '/job'.
      jobMount:
        config.carbonara.exec === 'inprocess' ? workDir : CARBONARA_JOB_MOUNT
    })

    logger.info(`carbonara-pdbfixer ${previewId}: running container`, {
      args: [config.carbonara.containerBin, ...args].join(' ')
    })

    try {
      await runCarbonaraContainer({
        containerBin: config.carbonara.containerBin,
        args,
        cwd: workDir,
        execMode: config.carbonara.exec,
        image: config.carbonara.image,
        timeoutMs: config.carbonara.backmapTimeoutMs,
        onStdoutLine: (line) => logStream?.write(line + '\n'),
        onStderrLine: (line) => logStream?.write(line + '\n')
      })
    } finally {
      await new Promise<void>((resolve) => {
        if (logStream) logStream.end(resolve)
        else resolve()
      })
    }

    // The wrapper writes result.json itself; if it didn't (e.g. hard crash),
    // leave a generic error so the UI never polls forever.
    if (!(await fs.pathExists(resultJson))) {
      await writeError('PDBFixer did not produce a result.')
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`carbonara-pdbfixer ${previewId}: ${msg}`)
    await writeError(msg)
  }
}
