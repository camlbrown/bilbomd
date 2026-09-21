import { processCarbonaraGuinier } from '../workerHandlers/carbonaraGuinierHandler.js'
import { Worker, WorkerOptions } from 'bullmq'
import { logger } from '../helpers/loggers.js'

export const createCarbonaraGuinierWorker = (
  options: WorkerOptions
): Worker => {
  const guinierWorker = new Worker(
    'carbonara-guinier',
    processCarbonaraGuinier,
    options
  )
  logger.info('Carbonara Guinier Worker started')

  let activeJobsCount = 0

  guinierWorker.on('active', () => {
    activeJobsCount++
    logger.info(`Carbonara Guinier Worker Active Jobs: ${activeJobsCount}`)
  })

  guinierWorker.on('completed', () => {
    activeJobsCount--
    logger.info(
      `Carbonara Guinier Worker Active Jobs after completion: ${activeJobsCount}`
    )
  })

  guinierWorker.on('failed', () => {
    activeJobsCount--
    logger.info(
      `Carbonara Guinier Worker Active Jobs after failure: ${activeJobsCount}`
    )
  })

  return guinierWorker
}
