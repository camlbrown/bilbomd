import { Queue } from 'bullmq'
import { logger } from '../middleware/loggers.js'
import { redis } from './redisConn.js'

export interface CarbonaraGuinierJobData {
  previewId: string
  datFile: string
}

let carbonaraGuinierQueue: Queue

const getQueue = (): Queue => {
  if (!carbonaraGuinierQueue) {
    carbonaraGuinierQueue = new Queue('carbonara-guinier', {
      connection: redis,
      // Preview results are ephemeral — the UI reads result.json, not the BullMQ
      // record — so prune jobs to avoid accumulating Redis keys.
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 20
      }
    })
  }
  return carbonaraGuinierQueue
}

export const queueGuinierJob = async (
  data: CarbonaraGuinierJobData
): Promise<string | undefined> => {
  try {
    const queue = getQueue()
    logger.info('Carbonara guinier job about to be added to queue', {
      previewId: data.previewId
    })
    const bullJob = await queue.add('carbonara-guinier', data)
    logger.info('Carbonara guinier job added to queue', {
      previewId: data.previewId,
      bullmqId: bullJob.id
    })
    return bullJob.id
  } catch (error) {
    logger.error('Error adding carbonara guinier job to queue', {
      previewId: data.previewId,
      error: String(error)
    })
    throw error
  }
}
