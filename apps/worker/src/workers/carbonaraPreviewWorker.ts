import { processCarbonaraInitFoxs } from '../workerHandlers/carbonaraPreviewHandler.js'
import { Worker, WorkerOptions } from 'bullmq'
import { logger } from '../helpers/loggers.js'

export const createCarbonaraPreviewWorker = (options: WorkerOptions): Worker => {
  const previewWorker = new Worker(
    'carbonara-preview',
    processCarbonaraInitFoxs,
    options
  )
  logger.info('Carbonara Preview Worker started')

  let activeJobsCount = 0

  previewWorker.on('active', () => {
    activeJobsCount++
    logger.info(`Carbonara Preview Worker Active Jobs: ${activeJobsCount}`)
  })

  previewWorker.on('completed', () => {
    activeJobsCount--
    logger.info(
      `Carbonara Preview Worker Active Jobs after completion: ${activeJobsCount}`
    )
  })

  previewWorker.on('failed', () => {
    activeJobsCount--
    logger.info(
      `Carbonara Preview Worker Active Jobs after failure: ${activeJobsCount}`
    )
  })

  return previewWorker
}
