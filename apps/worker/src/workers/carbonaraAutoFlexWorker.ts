import { processCarbonaraAutoFlex } from '../workerHandlers/carbonaraAutoFlexHandler.js'
import { Worker, WorkerOptions } from 'bullmq'
import { logger } from '../helpers/loggers.js'

export const createCarbonaraAutoFlexWorker = (
  options: WorkerOptions
): Worker => {
  const autoFlexWorker = new Worker(
    'carbonara-autoflex',
    processCarbonaraAutoFlex,
    options
  )
  logger.info('Carbonara AutoFlex Worker started')

  let activeJobsCount = 0

  autoFlexWorker.on('active', () => {
    activeJobsCount++
    logger.info(`Carbonara AutoFlex Worker Active Jobs: ${activeJobsCount}`)
  })

  autoFlexWorker.on('completed', () => {
    activeJobsCount--
    logger.info(
      `Carbonara AutoFlex Worker Active Jobs after completion: ${activeJobsCount}`
    )
  })

  autoFlexWorker.on('failed', () => {
    activeJobsCount--
    logger.info(
      `Carbonara AutoFlex Worker Active Jobs after failure: ${activeJobsCount}`
    )
  })

  return autoFlexWorker
}
