import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Request, Response } from 'express'
import { handleBilboMDCarbonaraJob } from '../handleBilboMDCarbonaraJob.js'
import { queueJob } from '../../../queues/bilbomd.js'
import { ValidationError } from 'yup'

vi.mock('../../middleware/loggers.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('../../../queues/bilbomd.js', () => ({
  queueJob: vi.fn(async () => 'bull-carbonara-id-1')
}))

vi.mock('../../config/config.js', () => ({
  config: { uploadDir: '/tmp/uploads' }
}))

vi.mock('../utils/jobUtils.js', () => ({
  getFileStats: vi.fn(() => ({ size: 1024 }))
}))

vi.mock('../../../validation/index.js', () => ({
  carbonaraJobSchema: {
    validate: vi.fn(async () => {})
  }
}))

vi.mock('@bilbomd/mongodb-schema', () => {
  class BilboMdCarbonaraJobMock {
    public id = 'mongo-carbonara-1'
    public _id = { toString: () => 'mongo-carbonara-1' }
    public uuid = 'uuid-123'
    public title!: string
    static lastData: Record<string, unknown> | undefined
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data)
      BilboMdCarbonaraJobMock.lastData = data
    }
    async save() {
      return this
    }
  }
  return {
    BilboMdCarbonaraJob: BilboMdCarbonaraJobMock,
    StepStatus: { Waiting: 'Waiting' }
  }
})

const makeReqRes = (
  bodyOverrides: Partial<Record<string, unknown>> = {},
  filesOverrides: unknown = {}
) => {
  const req = {
    body: {
      title: 'Carbonara job',
      bilbomd_mode: 'carbonara',
      ...bodyOverrides
    },
    files: {
      pdb_file: [{ originalname: 'model.pdb' }],
      dat_file: [{ originalname: 'saxs.dat' }],
      ...(filesOverrides as object)
    },
    get: vi.fn((name: string) =>
      name === 'origin' ? 'http://localhost:3002' : undefined
    ),
    protocol: 'http'
  } as unknown as Request

  const json = vi.fn()
  const status = vi.fn(() => ({ json })) as unknown as Response['status']
  const res = { status, json } as unknown as Response

  return { req, res }
}

const user = {
  _id: 'user-1',
  username: 'user1',
  email: 'u@example.com'
}

const UUID = 'uuid-123'

describe('handleBilboMDCarbonaraJob', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('authenticated (user) mode', () => {
    it('returns 200 with jobid and uuid', async () => {
      const { req, res } = makeReqRes()

      await handleBilboMDCarbonaraJob(req, res, user, UUID, {
        accessMode: 'user'
      })

      expect(res.status).toHaveBeenCalledWith(200)
      const payload = (res.json as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as Record<string, unknown>
      expect(payload.jobid).toBe('mongo-carbonara-1')
      expect(payload.uuid).toBe('uuid-123')
      expect(payload.message).toMatch(/carbonara/i)
    })

    it('queues the job on the bilbomd queue with type carbonara', async () => {
      const { req, res } = makeReqRes()

      await handleBilboMDCarbonaraJob(req, res, user, UUID, {
        accessMode: 'user'
      })

      expect(queueJob).toHaveBeenCalledOnce()
      const queueArg = (queueJob as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as Record<string, unknown>
      expect(queueArg.type).toBe('carbonara')
      expect(queueArg.uuid).toBe('uuid-123')
      expect(queueArg.jobid).toBe('mongo-carbonara-1')
    })

    it('applies coarse-grained defaults when params are omitted', async () => {
      const { req, res } = makeReqRes()

      await handleBilboMDCarbonaraJob(req, res, user, UUID, {
        accessMode: 'user'
      })

      const { BilboMdCarbonaraJob } = (await import(
        '@bilbomd/mongodb-schema'
      )) as unknown as {
        BilboMdCarbonaraJob: { lastData: Record<string, unknown> }
      }
      const data = BilboMdCarbonaraJob.lastData
      expect(data.fit_n_times).toBe(4)
      expect(data.min_q).toBe(0.01)
      expect(data.max_q).toBe(0.2)
      expect(data.max_q_start).toBe(0.2)
      expect(data.max_fit_steps).toBe(1000)
      expect(data.mixture_n).toBe(1)
      expect(data.rotation).toBe(false)
      expect(data.pdb_file).toBe('model.pdb')
      expect(data.data_file).toBe('saxs.dat')
    })

    it('parses provided numeric params and rotation flag', async () => {
      const { req, res } = makeReqRes({
        fit_n_times: '8',
        min_q: '0.02',
        max_q: '0.3',
        max_q_start: '0.25',
        max_fit_steps: '500',
        mixture_n: '2',
        rotation: 'true'
      })

      await handleBilboMDCarbonaraJob(req, res, user, UUID, {
        accessMode: 'user'
      })

      const { BilboMdCarbonaraJob } = (await import(
        '@bilbomd/mongodb-schema'
      )) as unknown as {
        BilboMdCarbonaraJob: { lastData: Record<string, unknown> }
      }
      const data = BilboMdCarbonaraJob.lastData
      expect(data.fit_n_times).toBe(8)
      expect(data.min_q).toBe(0.02)
      expect(data.max_q).toBe(0.3)
      expect(data.max_q_start).toBe(0.25)
      expect(data.max_fit_steps).toBe(500)
      expect(data.mixture_n).toBe(2)
      expect(data.rotation).toBe(true)
    })
  })

  describe('anonymous mode', () => {
    it('returns 200 with publicId and resultUrl', async () => {
      const { req, res } = makeReqRes()

      await handleBilboMDCarbonaraJob(req, res, undefined, UUID, {
        accessMode: 'anonymous',
        publicId: 'pub-abc',
        client_ip_hash: 'hash-123'
      })

      expect(res.status).toHaveBeenCalledWith(200)
      const payload = (res.json as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as Record<string, unknown>
      expect(payload.publicId).toBe('pub-abc')
      expect(payload.resultUrl).toContain('/results/pub-abc')
      expect(payload.resultPath).toBe('/results/pub-abc')
    })
  })

  describe('example data fallback', () => {
    it('uses body pdb_file and dat_file when no uploaded files', async () => {
      const { req, res } = makeReqRes(
        { pdb_file: 'example.pdb', dat_file: 'example-saxs.dat' },
        {}
      )
      ;(req.files as Record<string, unknown>)['pdb_file'] = undefined
      ;(req.files as Record<string, unknown>)['dat_file'] = undefined

      await handleBilboMDCarbonaraJob(req, res, user, UUID, {
        accessMode: 'user'
      })

      expect(res.status).toHaveBeenCalledWith(200)
    })
  })

  describe('error handling', () => {
    it('returns 500 when job save throws', async () => {
      const { req, res } = makeReqRes()

      const { BilboMdCarbonaraJob } = await import('@bilbomd/mongodb-schema')
      vi.spyOn(
        BilboMdCarbonaraJob.prototype as { save: () => Promise<unknown> },
        'save'
      ).mockRejectedValueOnce(new Error('DB connection lost'))

      await handleBilboMDCarbonaraJob(req, res, user, UUID, {
        accessMode: 'user'
      })

      expect(res.status).toHaveBeenCalledWith(500)
      const payload = (res.json as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as Record<string, unknown>
      expect(payload.message).toMatch(/failed/i)
    })

    it('returns 400 when schema validation rejects the payload', async () => {
      const { carbonaraJobSchema } = await import('../../../validation/index.js')
      const err = new ValidationError(
        'A PDB or CIF file is required',
        undefined,
        'pdb_file'
      )
      vi.mocked(carbonaraJobSchema.validate).mockRejectedValueOnce(err)

      const { req, res } = makeReqRes()

      await handleBilboMDCarbonaraJob(req, res, user, UUID, {
        accessMode: 'user'
      })

      expect(res.status).toHaveBeenCalledWith(400)
      const payload = (res.json as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as Record<string, unknown>
      expect(payload.message).toBe('Validation failed')
    })
  })
})
