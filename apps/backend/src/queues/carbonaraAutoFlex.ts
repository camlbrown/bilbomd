import { Queue } from 'bullmq'
import { logger } from '../middleware/loggers.js'
import { redis } from './redisConn.js'

export interface CarbonaraAutoFlexJobData {
  previewId: string
  pdbFile: string
  datFile: string
  minQ?: number | null
  maxQ?: number | null
  paeFile?: string | null
  paeFlexThreshold?: number | null
}

let carbonaraAutoFlexQueue: Queue

const getQueue = (): Queue => {
  if (!carbonaraAutoFlexQueue) {
    carbonaraAutoFlexQueue = new Queue('carbonara-autoflex', {
      connection: redis,
      // Prepare results are ephemeral — the UI reads result.json, not the BullMQ
      // record — so prune jobs to avoid accumulating Redis keys.
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 20
      }
    })
  }
  return carbonaraAutoFlexQueue
}

export const queueAutoFlexJob = async (
  data: CarbonaraAutoFlexJobData
): Promise<string | undefined> => {
  try {
    const queue = getQueue()
    logger.info('Carbonara autoflex job about to be added to queue', {
      previewId: data.previewId
    })
    const bullJob = await queue.add('carbonara-autoflex', data)
    logger.info('Carbonara autoflex job added to queue', {
      previewId: data.previewId,
      bullmqId: bullJob.id
    })
    return bullJob.id
  } catch (error) {
    logger.error('Error adding carbonara autoflex job to queue', {
      previewId: data.previewId,
      error: String(error)
    })
    throw error
  }
}
