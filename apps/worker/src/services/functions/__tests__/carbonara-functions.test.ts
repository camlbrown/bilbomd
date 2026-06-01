import { describe, it, expect } from 'vitest'
import {
  buildCarbonaraJobJson,
  buildCarbonaraContainerArgs,
  parseCarbonaraSummary,
  CARBONARA_JOB_MOUNT,
  fingerprintForCoords,
  backmapNameForCoords,
  buildReconstructionPlan,
  buildBackmapLoopCommand,
  buildBackmapContainerArgs,
  parseFoxsResultsSummary,
  selectBestAaModel
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

// ---------------------------------------------------------------------------
// A2 helper tests
// ---------------------------------------------------------------------------

describe('fingerprintForCoords', () => {
  it('returns fingerPrint1.dat for _sub_0_', () => {
    expect(fingerprintForCoords('mol1_sub_0_end_xyz.dat')).toBe(
      'fingerPrint1.dat'
    )
  })

  it('returns fingerPrint4.dat for _sub_3_', () => {
    expect(fingerprintForCoords('mol2_sub_3_step_10_xyz.dat')).toBe(
      'fingerPrint4.dat'
    )
  })

  it('falls back to fingerPrint1.dat when no _sub_ token', () => {
    expect(fingerprintForCoords('mol1_end_xyz.dat')).toBe('fingerPrint1.dat')
  })

  it('handles large sub indices', () => {
    expect(fingerprintForCoords('mol1_sub_9_end_xyz.dat')).toBe(
      'fingerPrint10.dat'
    )
  })
})

describe('backmapNameForCoords', () => {
  it('strips _xyz.dat suffix', () => {
    expect(backmapNameForCoords('mol1_sub_0_end_xyz.dat')).toBe(
      'mol1_sub_0_end'
    )
  })

  it('strips _xyz.dat from a longer basename', () => {
    expect(backmapNameForCoords('mol2_sub_3_step_10_xyz.dat')).toBe(
      'mol2_sub_3_step_10'
    )
  })

  it('returns the input unchanged when there is no _xyz.dat suffix', () => {
    expect(backmapNameForCoords('mol1_end.dat')).toBe('mol1_end.dat')
  })
})

describe('buildReconstructionPlan', () => {
  const scenarioRoot = '/job/work/uuid/carbonara_runs/uuid'
  const outRoot = '/job/results/all_atom'

  it('produces one task per coords file', () => {
    const files = [
      `${scenarioRoot}/fitdata/mol1_sub_0_end_xyz.dat`,
      `${scenarioRoot}/fitdata/mol1_sub_1_end_xyz.dat`
    ]
    const tasks = buildReconstructionPlan({
      coordsFiles: files,
      scenarioRoot,
      outRoot,
      maxModels: 5
    })
    expect(tasks).toHaveLength(2)
    expect(tasks[0].coords).toBe(files[0])
    expect(tasks[0].name).toBe('mol1_sub_0_end')
    expect(tasks[0].fingerprint).toBe(`${scenarioRoot}/fingerPrint1.dat`)
    expect(tasks[0].outdir).toBe(`${outRoot}/mol1_sub_0_end`)
    expect(tasks[1].fingerprint).toBe(`${scenarioRoot}/fingerPrint2.dat`)
  })

  it('caps at maxModels and drops excess files', () => {
    const files = [
      '/job/a_xyz.dat',
      '/job/b_xyz.dat',
      '/job/c_xyz.dat'
    ]
    const tasks = buildReconstructionPlan({
      coordsFiles: files,
      scenarioRoot,
      outRoot,
      maxModels: 2
    })
    expect(tasks).toHaveLength(2)
  })

  it('returns empty array for empty coords list', () => {
    expect(
      buildReconstructionPlan({
        coordsFiles: [],
        scenarioRoot,
        outRoot,
        maxModels: 5
      })
    ).toEqual([])
  })
})

describe('buildBackmapLoopCommand', () => {
  const scenarioRoot = '/job/work/uuid/carbonara_runs/uuid'
  const tasks = [
    {
      coords: `${scenarioRoot}/fitdata/mol1_sub_0_end_xyz.dat`,
      fingerprint: `${scenarioRoot}/fingerPrint1.dat`,
      name: 'mol1_sub_0_end',
      outdir: '/job/results/all_atom/mol1_sub_0_end'
    }
  ]
  const baseOpts = {
    pythonBin: 'python',
    carbonaraRoot: '/opt/carbonara',
    cg2allExec: 'convert_cg2all_carbonara',
    doFoxs: false,
    foxsCmd: 'pyfoxs',
    saxs: `${scenarioRoot}/Saxs.dat`,
    maxQ: 0.2
  }

  it('includes set +e preamble', () => {
    const cmd = buildBackmapLoopCommand(tasks, baseOpts)
    expect(cmd).toMatch(/^set \+e/)
  })

  it('includes --backend cg2all', () => {
    const cmd = buildBackmapLoopCommand(tasks, baseOpts)
    expect(cmd).toContain('--backend cg2all')
  })

  it('includes --cg2all-exec', () => {
    const cmd = buildBackmapLoopCommand(tasks, baseOpts)
    expect(cmd).toContain(`--cg2all-exec 'convert_cg2all_carbonara'`)
  })

  it('includes per-task --coords, --fingerprint, --scenario-root, --outdir, --name', () => {
    const cmd = buildBackmapLoopCommand(tasks, baseOpts)
    expect(cmd).toContain(`--coords '${tasks[0].coords}'`)
    expect(cmd).toContain(`--fingerprint '${tasks[0].fingerprint}'`)
    expect(cmd).toContain(`--outdir '${tasks[0].outdir}'`)
    expect(cmd).toContain(`--name '${tasks[0].name}'`)
  })

  it('omits --disulfide-file when not provided', () => {
    const cmd = buildBackmapLoopCommand(tasks, baseOpts)
    expect(cmd).not.toContain('--disulfide-file')
  })

  it('includes --disulfide-file when provided', () => {
    const cmd = buildBackmapLoopCommand(tasks, {
      ...baseOpts,
      disulfideFile: `${scenarioRoot}/fixedDistanceConstraints1.dat`
    })
    expect(cmd).toContain('--disulfide-file')
    expect(cmd).toContain('fixedDistanceConstraints1.dat')
  })

  it('omits FoXS flags when doFoxs is false', () => {
    const cmd = buildBackmapLoopCommand(tasks, { ...baseOpts, doFoxs: false })
    expect(cmd).not.toContain('--do-foxs')
    expect(cmd).not.toContain('--foxs-py')
    expect(cmd).not.toContain('--saxs')
  })

  it('includes FoXS flags when doFoxs is true', () => {
    const cmd = buildBackmapLoopCommand(tasks, { ...baseOpts, doFoxs: true })
    expect(cmd).toContain('--do-foxs')
    expect(cmd).toContain(`--foxs-py 'pyfoxs'`)
    expect(cmd).toContain(`--saxs '${scenarioRoot}/Saxs.dat'`)
    expect(cmd).toContain(`--max-q '0.2'`)
    expect(cmd).toContain(
      `--foxs-out '${tasks[0].outdir}/foxs_results.txt'`
    )
  })
})

describe('buildBackmapContainerArgs', () => {
  it('builds a podman run vector with /bin/bash -lc', () => {
    const args = buildBackmapContainerArgs({
      image: 'carbonara-allatom-runtime:dev',
      hostJobDir: '/data/jobs/uuid',
      loopBody: 'set +e\npython /opt/carbonara/backmap_cli.py ...'
    })
    expect(args[0]).toBe('run')
    expect(args[1]).toBe('--rm')
    expect(args[2]).toBe('-v')
    expect(args[3]).toBe(`/data/jobs/uuid:${CARBONARA_JOB_MOUNT}:Z`)
    expect(args[4]).toBe('carbonara-allatom-runtime:dev')
    expect(args[5]).toBe('/bin/bash')
    expect(args[6]).toBe('-lc')
    expect(args[7]).toContain('backmap_cli.py')
  })
})

describe('parseFoxsResultsSummary', () => {
  it('parses a line with a valid chi2', () => {
    const entries = parseFoxsResultsSummary(
      '/job/results/all_atom/mol1_sub_0_end/mol1_sub_0_end_AA.pdb 1.234\n'
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].aaPdb).toBe(
      '/job/results/all_atom/mol1_sub_0_end/mol1_sub_0_end_AA.pdb'
    )
    expect(entries[0].chi2).toBeCloseTo(1.234)
  })

  it('returns null chi2 for ERROR token', () => {
    const entries = parseFoxsResultsSummary(
      '/job/results/all_atom/mol1/mol1_AA.pdb ERROR\n'
    )
    expect(entries[0].chi2).toBeNull()
  })

  it('returns null chi2 for non-numeric token', () => {
    const entries = parseFoxsResultsSummary('/job/aa.pdb NaN\n')
    expect(entries[0].chi2).toBeNull()
  })

  it('skips empty lines', () => {
    const entries = parseFoxsResultsSummary('\n\n/job/aa.pdb 2.5\n\n')
    expect(entries).toHaveLength(1)
  })

  it('handles multiple entries', () => {
    const text =
      '/job/a_AA.pdb 1.1\n/job/b_AA.pdb 0.9\n/job/c_AA.pdb ERROR\n'
    const entries = parseFoxsResultsSummary(text)
    expect(entries).toHaveLength(3)
    expect(entries[2].chi2).toBeNull()
  })
})

describe('selectBestAaModel', () => {
  it('returns the entry with minimum chi2', () => {
    const entries = [
      { aaPdb: '/a.pdb', chi2: 2.5 },
      { aaPdb: '/b.pdb', chi2: 0.8 },
      { aaPdb: '/c.pdb', chi2: 1.2 }
    ]
    const best = selectBestAaModel(entries)
    expect(best?.aaPdb).toBe('/b.pdb')
    expect(best?.chi2).toBeCloseTo(0.8)
  })

  it('ignores entries with null chi2', () => {
    const entries = [
      { aaPdb: '/a.pdb', chi2: null },
      { aaPdb: '/b.pdb', chi2: 1.5 }
    ]
    const best = selectBestAaModel(entries)
    expect(best?.aaPdb).toBe('/b.pdb')
  })

  it('returns null when all chi2 values are null', () => {
    const entries = [
      { aaPdb: '/a.pdb', chi2: null },
      { aaPdb: '/b.pdb', chi2: null }
    ]
    expect(selectBestAaModel(entries)).toBeNull()
  })

  it('returns null for an empty array', () => {
    expect(selectBestAaModel([])).toBeNull()
  })
})
