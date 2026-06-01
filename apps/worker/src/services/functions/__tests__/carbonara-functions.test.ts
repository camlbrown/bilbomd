import { describe, it, expect } from 'vitest'
import {
  buildCarbonaraJobJson,
  buildCarbonaraContainerArgs,
  parseCarbonaraSummary,
  CARBONARA_JOB_MOUNT
} from '../carbonara-functions.js'

const baseParams = {
  fit_n_times: 4,
  min_q: 0.01,
  max_q: 0.2,
  max_q_start: 0.2,
  max_fit_steps: 1000,
  mixture_n: 1
}

describe('buildCarbonaraJobJson', () => {
  it('maps inputs to in-container /job paths and the wrapper schema', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'abc-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.cif',
      saxsFileName: 'data.dat',
      parameters: baseParams
    })

    expect(json).toEqual({
      job_name: 'abc-uuid',
      carbonara_root: '/opt/carbonara',
      pdb: `${CARBONARA_JOB_MOUNT}/model.cif`,
      saxs: `${CARBONARA_JOB_MOUNT}/data.dat`,
      workdir: `${CARBONARA_JOB_MOUNT}/work`,
      outdir: `${CARBONARA_JOB_MOUNT}/results`,
      parameters: { ...baseParams, rotation: false }
    })
  })

  it('passes through an explicit rotation flag', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'j',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'm.pdb',
      saxsFileName: 's.dat',
      parameters: { ...baseParams, rotation: true }
    })
    expect(json.parameters.rotation).toBe(true)
  })
})

describe('buildCarbonaraContainerArgs', () => {
  it('builds the validated podman run argument vector', () => {
    const args = buildCarbonaraContainerArgs({
      image: 'carbonara-allatom-runtime:dev',
      hostJobDir: '/data/jobs/abc-uuid',
      runnerPath: '/opt/carbonara/carbonara_bilbomd_runner_refined.py',
      pythonBin: 'python'
    })

    expect(args).toEqual([
      'run',
      '--rm',
      '-v',
      '/data/jobs/abc-uuid:/job:Z',
      'carbonara-allatom-runtime:dev',
      'python',
      '/opt/carbonara/carbonara_bilbomd_runner_refined.py',
      '--job-json',
      '/job/job.json',
      '--clean'
    ])
  })

  it('honours an overridden job.json container path', () => {
    const args = buildCarbonaraContainerArgs({
      image: 'img',
      hostJobDir: '/h',
      jobJsonContainerPath: '/job/custom.json',
      runnerPath: '/opt/carbonara/runner.py',
      pythonBin: 'python3'
    })
    expect(args).toContain('/job/custom.json')
    expect(args[args.indexOf('--job-json') + 1]).toBe('/job/custom.json')
  })
})

describe('parseCarbonaraSummary', () => {
  it('reports success for status completed + return_code 0', () => {
    const result = parseCarbonaraSummary(
      JSON.stringify({
        status: 'completed',
        return_code: 0,
        n_nonempty_fit_logs: 1,
        n_nonempty_final_model_files: 1,
        final_model_files: ['/job/work/x/fitdata/mol1_sub_0_end_xyz.dat']
      })
    )
    expect(result.succeeded).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.returnCode).toBe(0)
    expect(result.finalModelCount).toBe(1)
    expect(result.fitLogCount).toBe(1)
  })

  it('reports failure when the fit failed', () => {
    const result = parseCarbonaraSummary(
      JSON.stringify({ status: 'fit_failed', return_code: 139 })
    )
    expect(result.succeeded).toBe(false)
    expect(result.returnCode).toBe(139)
    expect(result.message).toContain('fit_failed')
  })

  it('includes the validation_error message when present', () => {
    const result = parseCarbonaraSummary(
      JSON.stringify({
        status: 'fit_output_validation_failed',
        return_code: 3,
        validation_error: 'No non-empty fitLog*.dat files were produced'
      })
    )
    expect(result.succeeded).toBe(false)
    expect(result.message).toContain('No non-empty fitLog')
  })

  it('treats missing status/return_code as failure rather than throwing', () => {
    const result = parseCarbonaraSummary(JSON.stringify({}))
    expect(result.succeeded).toBe(false)
    expect(result.status).toBe('unknown')
    expect(result.returnCode).toBeNull()
  })

  it('throws on invalid JSON', () => {
    expect(() => parseCarbonaraSummary('not json')).toThrow(
      /Could not parse Carbonara/
    )
  })
})
