import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Request, Response } from 'express'
import {
  createCarbonaraInitFoxs,
  getCarbonaraInitFoxs
} from '../carbonaraInitFoxsController.js'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../middleware/loggers.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('../../config/config.js', () => ({
  getEnvVar: vi.fn(() => '/tmp/uploads')
}))

// We mock multer so the upload callback is invoked synchronously/immediately
// without touching the filesystem, matching the autoRg controller test style.
let multerErrArg: Error | null = null
let multerFilesResult: Record<string, Express.Multer.File[]> = {
  pdb_file: [{ originalname: 'model.pdb' } as Express.Multer.File],
  dat_file: [{ originalname: 'saxs.dat' } as Express.Multer.File]
}
vi.mock('multer', () => {
  const fieldsFn = vi.fn(
    () =>
      (
        req: Request,
        _res: Response,
        cb: (err: Error | null) => void
      ) => {
        req.files = multerFilesResult as unknown as typeof req.files
        cb(multerErrArg)
      }
  )
  const diskStorageFn = vi.fn(() => ({}))
  const multerFn = vi.fn(() => ({ fields: fieldsFn }))
  ;(multerFn as unknown as { diskStorage: typeof diskStorageFn }).diskStorage =
    diskStorageFn
  return { default: multerFn }
})

vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    pathExists: vi.fn(async () => false),
    readJson: vi.fn(async () => ({ status: 'pending' }))
  }
}))

vi.mock('../../../queues/carbonaraPreview.js', () => ({
  queuePreviewJob: vi.fn(async () => 'bullmq-preview-id-1')
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRes = () => {
  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  return { status, json } as unknown as Response
}

const makeReq = (
  bodyOverrides: Record<string, unknown> = {}
): Request =>
  ({
    body: { ...bodyOverrides },
    files: {}
  }) as unknown as Request

// ---------------------------------------------------------------------------
// createCarbonaraInitFoxs
// ---------------------------------------------------------------------------

describe('createCarbonaraInitFoxs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    multerErrArg = null
    multerFilesResult = {
      pdb_file: [{ originalname: 'model.pdb' } as Express.Multer.File],
      dat_file: [{ originalname: 'saxs.dat' } as Express.Multer.File]
    }
  })

  it('responds 202 with a previewId when files are provided', async () => {
    const req = makeReq()
    const res = makeRes()
    await createCarbonaraInitFoxs(req, res)
    expect(res.status).toHaveBeenCalledWith(202)
    const payload = (res.json as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>
    expect(typeof payload['previewId']).toBe('string')
    expect((payload['previewId'] as string).length).toBeGreaterThan(0)
  })

  it('enqueues a preview job with the correct fields', async () => {
    const req = makeReq({ max_q: '0.35' })
    const res = makeRes()
    await createCarbonaraInitFoxs(req, res)

    const { queuePreviewJob } = await import(
      '../../../queues/carbonaraPreview.js'
    )
    expect(queuePreviewJob).toHaveBeenCalledOnce()
    const arg = (queuePreviewJob as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>
    expect(typeof arg['previewId']).toBe('string')
    expect(arg['pdbFile']).toBe('model.pdb')
    expect(arg['datFile']).toBe('saxs.dat')
    expect(arg['maxQ']).toBeCloseTo(0.35)
  })

  it('passes null maxQ when max_q is absent from body', async () => {
    const req = makeReq()
    const res = makeRes()
    await createCarbonaraInitFoxs(req, res)

    const { queuePreviewJob } = await import(
      '../../../queues/carbonaraPreview.js'
    )
    const arg = (queuePreviewJob as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>
    expect(arg['maxQ']).toBeNull()
  })

  it('responds 400 when pdb_file is missing', async () => {
    multerFilesResult = {
      dat_file: [{ originalname: 'saxs.dat' } as Express.Multer.File]
    }
    const req = makeReq()
    const res = makeRes()
    await createCarbonaraInitFoxs(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
    const payload = (res.json as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>
    expect(String(payload['message'])).toMatch(/pdb_file/i)
  })

  it('responds 400 when dat_file is missing', async () => {
    multerFilesResult = {
      pdb_file: [{ originalname: 'model.pdb' } as Express.Multer.File]
    }
    const req = makeReq()
    const res = makeRes()
    await createCarbonaraInitFoxs(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
    const payload = (res.json as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>
    expect(String(payload['message'])).toMatch(/dat_file/i)
  })

  it('responds 500 when multer returns an error', async () => {
    multerErrArg = new Error('disk full')
    const req = makeReq()
    const res = makeRes()
    await createCarbonaraInitFoxs(req, res)
    expect(res.status).toHaveBeenCalledWith(500)
  })
})

// ---------------------------------------------------------------------------
// getCarbonaraInitFoxs
// ---------------------------------------------------------------------------

describe('getCarbonaraInitFoxs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { status: "pending" } when result.json does not exist', async () => {
    const fsExtra = await import('fs-extra')
    vi.mocked(
      (fsExtra.default as { pathExists: (...a: unknown[]) => Promise<boolean> })
        .pathExists
    ).mockResolvedValueOnce(false)

    const req = { params: { id: 'preview-uuid-1' } } as unknown as Request
    const res = makeRes()
    await getCarbonaraInitFoxs(req, res)
    expect(res.status).toHaveBeenCalledWith(200)
    const payload = (res.json as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>
    expect(payload['status']).toBe('pending')
  })

  it('returns parsed result when result.json exists', async () => {
    const fsExtra = await import('fs-extra')
    vi.mocked(
      (fsExtra.default as { pathExists: (...a: unknown[]) => Promise<boolean> })
        .pathExists
    ).mockResolvedValueOnce(true)
    vi.mocked(
      (fsExtra.default as {
        readJson: (...a: unknown[]) => Promise<unknown>
      }).readJson
    ).mockResolvedValueOnce({
      status: 'done',
      chi2: 1.234,
      foxs: [{ q: 0.01, exp: 1.0, model: 0.95, error: 0.02 }]
    })

    const req = { params: { id: 'preview-uuid-2' } } as unknown as Request
    const res = makeRes()
    await getCarbonaraInitFoxs(req, res)
    expect(res.status).toHaveBeenCalledWith(200)
    const payload = (res.json as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>
    expect(payload['status']).toBe('done')
    expect(payload['chi2']).toBeCloseTo(1.234)
    expect(Array.isArray(payload['foxs'])).toBe(true)
  })

  it('responds 400 when id param is absent', async () => {
    const req = { params: {} } as unknown as Request
    const res = makeRes()
    await getCarbonaraInitFoxs(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })
})
