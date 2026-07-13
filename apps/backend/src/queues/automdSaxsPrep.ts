import { Queue } from 'bullmq'
import { logger } from '../middleware/loggers.js'
import { redis } from './redisConn.js'

export interface AutoMDSaxsPrepJobData {
  previewId: string
  pdbFile: string
  system?: string
  forceField?: string
  waterModel?: string
  ph?: number
  ionicConcentrationM?: number
  disulfide?: boolean
  keepIons?: boolean
  keepCrystallisationAgents?: boolean
  keepWaters?: boolean
  ligandResnames?: string[]
  ligandSmiles?: Record<string, string>
  protonationOverrides?: Record<string, string>
}

let prepQueue: Queue

const getQueue = (): Queue => {
  if (!prepQueue) {
    prepQueue = new Queue('automd-saxs-prep', {
      connection: redis,
      // Previews are ephemeral — the UI polls prep_audit.json, not the BullMQ
      // record — so prune jobs to avoid accumulating Redis keys.
      defaultJobOptions: { removeOnComplete: true, removeOnFail: 20 }
    })
  }
  return prepQueue
}

export const queueAutoMDSaxsPrep = async (
  data: AutoMDSaxsPrepJobData
): Promise<string | undefined> => {
  try {
    const bullJob = await getQueue().add('automd-saxs-prep', data)
    logger.info('AutoMD-SAXS prep job queued', {
      previewId: data.previewId,
      bullmqId: bullJob.id
    })
    return bullJob.id
  } catch (error) {
    logger.error('Error queuing AutoMD-SAXS prep job', {
      previewId: data.previewId,
      error: String(error)
    })
    throw error
  }
}
