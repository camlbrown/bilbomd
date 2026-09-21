import { Queue } from 'bullmq'
import { logger } from '../middleware/loggers.js'
import { redis } from './redisConn.js'

export interface CarbonaraPdbfixerJobData {
  previewId: string
  pdbFile: string
  residueName?: string | null
  maxGap?: number | null
}

let carbonaraPdbfixerQueue: Queue

const getQueue = (): Queue => {
  if (!carbonaraPdbfixerQueue) {
    carbonaraPdbfixerQueue = new Queue('carbonara-pdbfixer', {
      connection: redis,
      // Preview results are ephemeral — the UI reads result.json, not the BullMQ
      // record — so prune jobs to avoid accumulating Redis keys.
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 20
      }
    })
  }
  return carbonaraPdbfixerQueue
}

export const queuePdbfixerJob = async (
  data: CarbonaraPdbfixerJobData
): Promise<string | undefined> => {
  try {
    const queue = getQueue()
    logger.info('Carbonara pdbfixer job about to be added to queue', {
      previewId: data.previewId
    })
    const bullJob = await queue.add('carbonara-pdbfixer', data)
    logger.info('Carbonara pdbfixer job added to queue', {
      previewId: data.previewId,
      bullmqId: bullJob.id
    })
    return bullJob.id
  } catch (error) {
    logger.error('Error adding carbonara pdbfixer job to queue', {
      previewId: data.previewId,
      error: String(error)
    })
    throw error
  }
}
