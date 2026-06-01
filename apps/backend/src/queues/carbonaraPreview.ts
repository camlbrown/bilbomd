import { Queue } from 'bullmq'
import { logger } from '../middleware/loggers.js'
import { redis } from './redisConn.js'

export interface CarbonaraPreviewJobData {
  previewId: string
  pdbFile: string
  datFile: string
  maxQ?: number | null
}

let carbonaraPreviewQueue: Queue

const getQueue = (): Queue => {
  if (!carbonaraPreviewQueue) {
    carbonaraPreviewQueue = new Queue('carbonara-preview', {
      connection: redis
    })
  }
  return carbonaraPreviewQueue
}

export const queuePreviewJob = async (
  data: CarbonaraPreviewJobData
): Promise<string | undefined> => {
  try {
    const queue = getQueue()
    logger.info('Carbonara preview job about to be added to queue', {
      previewId: data.previewId
    })
    const bullJob = await queue.add('carbonara-preview', data)
    logger.info('Carbonara preview job added to queue', {
      previewId: data.previewId,
      bullmqId: bullJob.id
    })
    return bullJob.id
  } catch (error) {
    logger.error('Error adding carbonara preview job to queue', {
      previewId: data.previewId,
      error: String(error)
    })
    throw error
  }
}
