import { describe, it, expect } from 'vitest'
import {
  buildAutoMDSaxsConfig,
  buildAutoMDSaxsArgs,
  parseAutoMDSaxsManifest
} from '../automd-saxs-functions.js'

describe('buildAutoMDSaxsConfig', () => {
  it('maps required fields and omits unset optional fields', () => {
    const config = buildAutoMDSaxsConfig({
      jobName: 'abc-uuid',
      pdbPath: '/job/abc/model.pdb',
      simulationTimeNs: 50,
      nRepeats: 3
    })
    expect(config).toEqual({
      job_name: 'abc-uuid',
      pdb: '/job/abc/model.pdb',
      simulation_time_ns: 50,
      n_repeats: 3
    })
    // optional keys absent when not provided
    expect(config.saxs).toBeUndefined()
    expect(config.system).toBeUndefined()
    expect(config.box_padding_nm).toBeUndefined()
    expect(config.seed).toBeUndefined()
  })

  it('includes optional fields when provided (incl. falsy 0 / false)', () => {
    const config = buildAutoMDSaxsConfig({
      jobName: 'j',
      pdbPath: '/job/j/m.pdb',
      saxsPath: '/job/j/d.dat',
      system: 'Protein',
      forceField: 'amber14',
      waterModel: 'tip3p',
      simulationTimeNs: 100,
      nRepeats: 1,
      temperatureK: 300,
      ionicConcentrationM: 0.15,
      ph: 7,
      disulfide: false,
      boxPaddingNm: 2.5,
      seed: 0
    })
    expect(config.saxs).toBe('/job/j/d.dat')
    expect(config.system).toBe('Protein')
    expect(config.force_field).toBe('amber14')
    expect(config.water_model).toBe('tip3p')
    expect(config.temperature_K).toBe(300)
    expect(config.ionic_concentration_M).toBe(0.15)
    expect(config.ph).toBe(7)
    // disulfide false and seed 0 are meaningful and must be emitted
    expect(config.disulfide).toBe(false)
    expect(config.seed).toBe(0)
    expect(config.box_padding_nm).toBe(2.5)
  })
})

describe('buildAutoMDSaxsArgs', () => {
  it('builds the stable CLI contract argv', () => {
    expect(
      buildAutoMDSaxsArgs({ configPath: '/job/j/cfg.json', outDir: '/job/j/out' })
    ).toEqual(['run', '--config', '/job/j/cfg.json', '--out', '/job/j/out'])
  })
})

describe('parseAutoMDSaxsManifest', () => {
  it('treats status "completed" as success and surfaces metrics/outputs', () => {
    const text = JSON.stringify({
      status: 'completed',
      metrics: { bestChi2: 0.98, bestFrame: 1, rgMean: 25.4 },
      outputs: { saxsFits: ['ensemble.dat'] }
    })
    const parsed = parseAutoMDSaxsManifest(text)
    expect(parsed.succeeded).toBe(true)
    expect(parsed.status).toBe('completed')
    expect(parsed.metrics.bestChi2).toBe(0.98)
    expect(parsed.outputs.saxsFits).toEqual(['ensemble.dat'])
  })

  it('treats a non-completed status as failure and includes notes', () => {
    const text = JSON.stringify({
      status: 'failed',
      notes: ['minimisation produced unphysical energy']
    })
    const parsed = parseAutoMDSaxsManifest(text)
    expect(parsed.succeeded).toBe(false)
    expect(parsed.status).toBe('failed')
    expect(parsed.message).toContain('minimisation produced unphysical energy')
  })

  it('fails gracefully on unparseable manifest text', () => {
    const parsed = parseAutoMDSaxsManifest('not json {')
    expect(parsed.succeeded).toBe(false)
    expect(parsed.status).toBe('unknown')
    expect(parsed.metrics).toEqual({})
    expect(parsed.outputs).toEqual({})
  })
})
