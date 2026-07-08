import { processAutoMDSaxsPrep } from '../workerHandlers/automdSaxsPrepHandler.js'
import { Worker, WorkerOptions } from 'bullmq'
import { logger } from '../helpers/loggers.js'

/**
 * AutoMD-SAXS prep-preview worker (Task 4): runs `automd-saxs prepare` on the
 * 'automd-saxs-prep' queue so the setup UI can show the prepared structure
 * before the full MD run is submitted.
 */
export const createAutoMDSaxsPrepWorker = (options: WorkerOptions): Worker => {
  const prepWorker = new Worker('automd-saxs-prep', processAutoMDSaxsPrep, options)
  logger.info('AutoMD-SAXS Prep Worker started')

  let activeJobsCount = 0
  prepWorker.on('active', () => {
    activeJobsCount++
    logger.info(`AutoMD-SAXS Prep Worker Active Jobs: ${activeJobsCount}`)
  })
  prepWorker.on('completed', () => {
    activeJobsCount--
    logger.info(`AutoMD-SAXS Prep Worker Active Jobs after completion: ${activeJobsCount}`)
  })
  prepWorker.on('failed', () => {
    activeJobsCount--
    logger.info(`AutoMD-SAXS Prep Worker Active Jobs after failure: ${activeJobsCount}`)
  })
  return prepWorker
}
