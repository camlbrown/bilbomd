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
  selectBestAaModel,
  buildInitFoxsContainerArgs,
  buildMultiFoxsContainerArgs
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

  // Phase-B: PAE-guided flexibility
  it('emits alphaFoldFlex/pae/pae_flex_threshold when alphaFoldFlex is true', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'pae-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      alphaFoldFlex: true,
      paeFileName: 'pae.json',
      paeFlexThreshold: 12
    })
    expect(json.parameters.alphaFoldFlex).toBe(true)
    expect(json.parameters.pae).toBe(`${CARBONARA_JOB_MOUNT}/pae.json`)
    expect(json.parameters.pae_flex_threshold).toBe(12)
  })

  it('uses the default pae_flex_threshold of 16 when not specified', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'pae-uuid-default',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      alphaFoldFlex: true,
      paeFileName: 'pae.json'
    })
    expect(json.parameters.pae_flex_threshold).toBe(16.0)
  })

  it('does NOT emit alphaFoldFlex/pae/pae_flex_threshold when alphaFoldFlex is false', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'no-pae-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      alphaFoldFlex: false,
      paeFileName: 'pae.json',
      paeFlexThreshold: 12
    })
    expect(json.parameters).not.toHaveProperty('alphaFoldFlex')
    expect(json.parameters).not.toHaveProperty('pae')
    expect(json.parameters).not.toHaveProperty('pae_flex_threshold')
  })

  it('does NOT emit PAE keys when alphaFoldFlex is true but paeFileName is absent', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'no-pae-file-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      alphaFoldFlex: true
    })
    expect(json.parameters).not.toHaveProperty('alphaFoldFlex')
    expect(json.parameters).not.toHaveProperty('pae')
    expect(json.parameters).not.toHaveProperty('pae_flex_threshold')
  })

  it('Phase-1 output is byte-identical (no PAE keys) when neither flag is set', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'phase1-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams
    })
    // Must match the exact Phase-1 shape
    expect(Object.keys(json.parameters).sort()).toEqual(
      [
        'fit_n_times',
        'min_q',
        'max_q',
        'max_q_start',
        'max_fit_steps',
        'mixture_n',
        'rotation'
      ].sort()
    )
  })

  // B7: manual flexibility — flex_ranges object + no alphaFoldFlex
  it('manual mode emits flex_ranges object and does NOT emit alphaFoldFlex', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'manual-flex-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      flexMode: 'manual',
      flexRanges: [
        { chain: 1, ranges: [[100, 200], [300, 400]] },
        { chain: 2, ranges: [[50, 80]] }
      ]
    })
    // flex_ranges emitted as object with string chain keys
    expect(json.parameters.flex_ranges).toEqual({
      '1': [[100, 200], [300, 400]],
      '2': [[50, 80]]
    })
    // alphaFoldFlex must NOT be emitted in manual mode
    expect(json.parameters).not.toHaveProperty('alphaFoldFlex')
    expect(json.parameters).not.toHaveProperty('pae')
    expect(json.parameters).not.toHaveProperty('pae_flex_threshold')
  })

  it('manual mode with a single chain and single range emits correctly', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'manual-single-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      flexMode: 'manual',
      flexRanges: [{ chain: 1, ranges: [[5, 56]] }]
    })
    expect(json.parameters.flex_ranges).toEqual({ '1': [[5, 56]] })
    expect(json.parameters).not.toHaveProperty('alphaFoldFlex')
  })

  it('auto mode does NOT emit flex_ranges (Phase-1 byte-identical regression)', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'auto-flex-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      flexMode: 'auto',
      flexRanges: [{ chain: 1, ranges: [[5, 56]] }]
    })
    expect(json.parameters).not.toHaveProperty('flex_ranges')
    expect(json.parameters).not.toHaveProperty('alphaFoldFlex')
  })

  it('pae mode (flexMode=pae) still emits alphaFoldFlex and NOT flex_ranges', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'pae-flex-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      flexMode: 'pae',
      alphaFoldFlex: true,
      paeFileName: 'pae.json',
      paeFlexThreshold: 14,
      flexRanges: [{ chain: 1, ranges: [[5, 56]] }]
    })
    expect(json.parameters.alphaFoldFlex).toBe(true)
    expect(json.parameters.pae).toBe(`${CARBONARA_JOB_MOUNT}/pae.json`)
    expect(json.parameters).not.toHaveProperty('flex_ranges')
  })

  it('manual mode with empty flexRanges falls through to PAE branch (no flex_ranges emitted)', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'manual-empty-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      flexMode: 'manual',
      flexRanges: []
    })
    expect(json.parameters).not.toHaveProperty('flex_ranges')
  })

  // B6: constraints_file
  it('emits constraints_file as in-container path when constraintsFileName is set', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'constrained-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      constraintsFileName: 'constraints.dat'
    })
    expect(json.parameters.constraints_file).toBe(
      `${CARBONARA_JOB_MOUNT}/constraints.dat`
    )
  })

  it('does NOT emit constraints_file when constraintsFileName is absent (no-constraints regression)', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'no-constraints-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams
    })
    expect(json.parameters).not.toHaveProperty('constraints_file')
    // exact same keys as Phase-1 output
    expect(Object.keys(json.parameters).sort()).toEqual(
      [
        'fit_n_times',
        'min_q',
        'max_q',
        'max_q_start',
        'max_fit_steps',
        'mixture_n',
        'rotation'
      ].sort()
    )
  })

  // B8: multimer chain merges
  it('emits chain_merges when multimer is true and chainMerges is non-empty', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'multimer-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'dimer.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      multimer: true,
      chainMerges: [[1, 2], [1, 2]]
    })
    expect(json.parameters.chain_merges).toEqual([[1, 2], [1, 2]])
  })

  it('does NOT emit chain_merges when multimer is false (non-multimer regression)', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'non-multimer-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      multimer: false,
      chainMerges: [[1, 2]]
    })
    expect(json.parameters).not.toHaveProperty('chain_merges')
  })

  it('does NOT emit chain_merges when multimer is true but chainMerges is empty', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'multimer-no-merges-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams,
      multimer: true,
      chainMerges: []
    })
    expect(json.parameters).not.toHaveProperty('chain_merges')
  })

  it('does NOT emit chain_merges when multimer is absent (Phase-1 regression)', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'phase1-regression-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: baseParams
    })
    expect(json.parameters).not.toHaveProperty('chain_merges')
    // Phase-1 exact key set must be unchanged
    expect(Object.keys(json.parameters).sort()).toEqual(
      [
        'fit_n_times',
        'min_q',
        'max_q',
        'max_q_start',
        'max_fit_steps',
        'mixture_n',
        'rotation'
      ].sort()
    )
  })

  it('multimer emits chain_merges alongside rotation without contaminating other keys', () => {
    const json = buildCarbonaraJobJson({
      jobName: 'multimer-rotation-uuid',
      carbonaraRoot: '/opt/carbonara',
      pdbFileName: 'model.pdb',
      saxsFileName: 'saxs.dat',
      parameters: { ...baseParams, rotation: true },
      multimer: true,
      chainMerges: [[2, 3]]
    })
    expect(json.parameters.rotation).toBe(true)
    expect(json.parameters.chain_merges).toEqual([[2, 3]])
    expect(json.parameters).not.toHaveProperty('alphaFoldFlex')
    expect(json.parameters).not.toHaveProperty('flex_ranges')
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

  // 2a runner mount: CARBONARA_RUNNER_MOUNT dev workflow
  it('inserts runnerMount bind before image when runnerMountHost is set', () => {
    const runnerPath = '/opt/carbonara/carbonara_bilbomd_runner_refined.py'
    const args = buildCarbonaraContainerArgs({
      image: 'carbonara-allatom-runtime:dev',
      hostJobDir: '/data/jobs/uuid',
      runnerPath,
      pythonBin: 'python',
      runnerMountHost: '/home/user/carbonara/carbonara_bilbomd_runner_refined.py'
    })
    // job mount
    expect(args[2]).toBe('-v')
    expect(args[3]).toBe(`/data/jobs/uuid:${CARBONARA_JOB_MOUNT}:Z`)
    // runner mount inserted before image
    expect(args[4]).toBe('-v')
    expect(args[5]).toBe(
      `/home/user/carbonara/carbonara_bilbomd_runner_refined.py:${runnerPath}:ro,Z`
    )
    // image is next
    expect(args[6]).toBe('carbonara-allatom-runtime:dev')
    // runner path argument is still the in-container path
    expect(args[8]).toBe(runnerPath)
  })

  it('does NOT insert runnerMount when runnerMountHost is empty string', () => {
    const args = buildCarbonaraContainerArgs({
      image: 'img',
      hostJobDir: '/data/jobs/uuid',
      runnerPath: '/opt/carbonara/runner.py',
      pythonBin: 'python',
      runnerMountHost: ''
    })
    // empty string: no extra -v; image immediately after job-mount -v pair
    expect(args[4]).toBe('img')
  })

  it('does NOT insert runnerMount when runnerMountHost is absent', () => {
    const args = buildCarbonaraContainerArgs({
      image: 'img',
      hostJobDir: '/data/jobs/uuid',
      runnerPath: '/opt/carbonara/runner.py',
      pythonBin: 'python'
    })
    expect(args[4]).toBe('img')
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

// ---------------------------------------------------------------------------
// B5 — buildInitFoxsContainerArgs
// ---------------------------------------------------------------------------

describe('buildInitFoxsContainerArgs', () => {
  const baseOpts = {
    image: 'carbonara-allatom-runtime:dev',
    hostDir: '/data/carbonara_initfoxs/preview-uuid',
    pdbFileName: 'model.pdb',
    datFileName: 'saxs.dat',
    pythonBin: 'python',
    initFoxsPath: '/opt/carbonara/carbonara_initfoxs.py'
  }

  it('builds the correct argument vector without maxQ or mount', () => {
    const args = buildInitFoxsContainerArgs(baseOpts)
    expect(args).toEqual([
      'run', '--rm',
      '-v', `${baseOpts.hostDir}:/job:Z`,
      baseOpts.image,
      baseOpts.pythonBin,
      baseOpts.initFoxsPath,
      '--pdb', `/job/${baseOpts.pdbFileName}`,
      '--saxs', `/job/${baseOpts.datFileName}`,
      '--outdir', '/job'
    ])
  })

  it('appends --max_q when maxQ is provided', () => {
    const args = buildInitFoxsContainerArgs({ ...baseOpts, maxQ: 0.35 })
    const mqIdx = args.indexOf('--max_q')
    expect(mqIdx).toBeGreaterThan(-1)
    expect(args[mqIdx + 1]).toBe('0.35')
  })

  it('does NOT append --max_q when maxQ is null', () => {
    const args = buildInitFoxsContainerArgs({ ...baseOpts, maxQ: null })
    expect(args).not.toContain('--max_q')
  })

  it('does NOT append --max_q when maxQ is undefined', () => {
    const args = buildInitFoxsContainerArgs({ ...baseOpts })
    expect(args).not.toContain('--max_q')
  })

  it('inserts initFoxsMount bind before image when initFoxsMount is set', () => {
    const mount = '/home/user/bilbomd/infra/carbonara/carbonara_initfoxs.py'
    const args = buildInitFoxsContainerArgs({
      ...baseOpts,
      initFoxsMount: mount
    })
    // job mount
    expect(args[2]).toBe('-v')
    expect(args[3]).toBe(`${baseOpts.hostDir}:/job:Z`)
    // initfoxs mount before image
    expect(args[4]).toBe('-v')
    expect(args[5]).toBe(`${mount}:${baseOpts.initFoxsPath}:ro,Z`)
    // image is next
    expect(args[6]).toBe(baseOpts.image)
  })

  it('does NOT insert mount when initFoxsMount is empty string', () => {
    const args = buildInitFoxsContainerArgs({
      ...baseOpts,
      initFoxsMount: ''
    })
    // No extra -v: image immediately after job-mount pair
    expect(args[4]).toBe(baseOpts.image)
  })

  it('does NOT insert mount when initFoxsMount is absent', () => {
    const args = buildInitFoxsContainerArgs(baseOpts)
    expect(args[4]).toBe(baseOpts.image)
  })

  it('correctly combines mount + maxQ', () => {
    const mount = '/home/user/initfoxs.py'
    const args = buildInitFoxsContainerArgs({
      ...baseOpts,
      initFoxsMount: mount,
      maxQ: 0.5
    })
    expect(args).toContain('--max_q')
    expect(args[args.indexOf('--max_q') + 1]).toBe('0.5')
    expect(args).toContain('-v')
    // mount present
    const mountArg = args.find((a) => a.startsWith(mount))
    expect(mountArg).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// buildMultiFoxsContainerArgs — mixture χ² q-clamp (Stage 1)
// ---------------------------------------------------------------------------

describe('buildMultiFoxsContainerArgs', () => {
  const baseOpts = {
    image: 'bilbomd-worker:latest',
    multiFoxsBin: '/usr/bin/multi_foxs',
    hostJobDir: '/data/job-uuid',
    outDirContainer: '/job/results/multifoxs_mixture',
    saxsContainer: '/job/saxs.dat',
    speciesPdbsContainer: [
      '/job/results/all_atom/mol1_sub_0_end/mol1_sub_0_end_AA.pdb',
      '/job/results/all_atom/mol1_sub_1_end/mol1_sub_1_end_AA.pdb'
    ],
    numStates: 2
  }

  it('builds the container arg vector (run as root, job mount, bash -lc)', () => {
    const args = buildMultiFoxsContainerArgs(baseOpts)
    expect(args.slice(0, 6)).toEqual([
      'run',
      '--rm',
      '--user',
      'root',
      '-v',
      `${baseOpts.hostJobDir}:/job:Z`
    ])
    expect(args[6]).toBe(baseOpts.image)
    expect(args[7]).toBe('bash')
    expect(args[8]).toBe('-lc')
  })

  it('omits -q when maxQ is not provided', () => {
    const inner = buildMultiFoxsContainerArgs(baseOpts).at(-1) as string
    expect(inner).toContain('-s 2')
    expect(inner).not.toContain(' -q ')
  })

  it('appends -q <maxQ> right after -s when maxQ is provided', () => {
    const inner = buildMultiFoxsContainerArgs({
      ...baseOpts,
      maxQ: 0.2
    }).at(-1) as string
    expect(inner).toContain('-s 2 -q 0.2')
  })

  it('places -q before the positional saxs/pdb args (IMP requires options first)', () => {
    const inner = buildMultiFoxsContainerArgs({
      ...baseOpts,
      maxQ: 0.2
    }).at(-1) as string
    expect(inner.indexOf(' -q 0.2')).toBeLessThan(inner.indexOf(baseOpts.saxsContainer))
  })

  it('omits -q when maxQ is null', () => {
    const inner = buildMultiFoxsContainerArgs({
      ...baseOpts,
      maxQ: null as unknown as number
    }).at(-1) as string
    expect(inner).not.toContain(' -q ')
  })
})
