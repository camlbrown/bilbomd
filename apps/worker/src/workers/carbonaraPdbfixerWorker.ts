import { processCarbonaraPdbfixer } from '../workerHandlers/carbonaraPdbfixerHandler.js'
import { Worker, WorkerOptions } from 'bullmq'
import { logger } from '../helpers/loggers.js'

export const createCarbonaraPdbfixerWorker = (
  options: WorkerOptions
): Worker => {
  const pdbfixerWorker = new Worker(
    'carbonara-pdbfixer',
    processCarbonaraPdbfixer,
    options
  )
  logger.info('Carbonara PDBFixer Worker started')

  let activeJobsCount = 0

  pdbfixerWorker.on('active', () => {
    activeJobsCount++
    logger.info(`Carbonara PDBFixer Worker Active Jobs: ${activeJobsCount}`)
  })

  pdbfixerWorker.on('completed', () => {
    activeJobsCount--
    logger.info(
      `Carbonara PDBFixer Worker Active Jobs after completion: ${activeJobsCount}`
    )
  })

  pdbfixerWorker.on('failed', () => {
    activeJobsCount--
    logger.info(
      `Carbonara PDBFixer Worker Active Jobs after failure: ${activeJobsCount}`
    )
  })

  return pdbfixerWorker
}
