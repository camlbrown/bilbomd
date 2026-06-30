import React from 'react'
import type {
  BilboMDJobDTO,
  BilboMDAutoDTO,
  BilboMDSANSDTO,
  BilboMDPDBDTO,
  BilboMDCRDDTO,
  BilboMDScoperDTO,
  BilboMDAlphaFoldDTO,
  BilboMDOpenFoldDTO,
  BilboMDCarbonaraDTO,
  BilboMDAutoMDSAXSDTO
} from '@bilbomd/bilbomd-types'
import type { JobHandler, MongoDBProperty } from '../types'
import { ConstraintFileChip } from '../components/ConstraintFileChip'

const getMdRunCount = (job: BilboMDJobDTO): number => {
  if (job.mongo.md_engine === 'CHARMM') {
    return job.mongo.charmm_parameters?.md?.rgyr?.length ?? 0
  }

  return job.mongo.openmm_parameters?.md?.rgyr?.length ?? 0
}

const getRgValues = (job: BilboMDJobDTO): string | undefined => {
  const engine = job.mongo.md_engine ?? 'CHARMM'
  const rgyr =
    engine === 'CHARMM'
      ? job.mongo.charmm_parameters?.md?.rgyr
      : job.mongo.openmm_parameters?.md?.rgyr

  if (!rgyr || rgyr.length === 0) {
    return undefined
  }

  return rgyr.map((value) => `${value} Å`).join(', ')
}

const getConformationCount = (job: BilboMDJobDTO): number => {
  const engine = job.mongo.md_engine ?? 'CHARMM'

  if (engine === 'CHARMM') {
    const mdParams = job.mongo.charmm_parameters?.md
    const nsteps = mdParams?.nsteps
    const rgyrLength = mdParams?.rgyr?.length
    const reportInterval = mdParams?.pdb_report_interval

    if (!nsteps || !rgyrLength || !reportInterval || reportInterval <= 0) {
      return 0
    }

    return (nsteps * rgyrLength) / reportInterval
  }

  if (engine === 'OpenMM') {
    const mdParams = job.mongo.openmm_parameters?.md
    const nsteps = mdParams?.nsteps
    const rgyrLength = mdParams?.rgyr?.length
    const reportInterval = mdParams?.pdb_report_interval

    if (!nsteps || !rgyrLength || !reportInterval || reportInterval <= 0) {
      return 0
    }

    return (nsteps * rgyrLength) / reportInterval
  }

  return 0
}

export const createAutoJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD Auto',

  getJobSpecificProperties: (
    job: BilboMDJobDTO,
    onOpenModal?: () => void
  ): MongoDBProperty[] => {
    const specificJob = job.mongo as BilboMDAutoDTO

    return [
      { label: 'PDB file', value: specificJob.pdb_file },
      { label: 'PSF file', value: specificJob.psf_file },
      { label: 'CRD file', value: specificJob.crd_file },
      ...(job.mongo.md_engine === 'CHARMM'
        ? [
            {
              label: 'MD constraint file',
              render: () =>
                React.createElement(ConstraintFileChip, {
                  job: specificJob,
                  onOpenModal
                })
            }
          ]
        : []),
      { label: 'Number of MD Runs', value: getMdRunCount(job) },
      { label: 'Rg values', value: getRgValues(job) },
      { label: 'Number of conformations', value: getConformationCount(job) }
    ]
  }
})

export const createSansJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD SANS',

  getJobSpecificProperties: (
    job: BilboMDJobDTO,
    onOpenModal?: () => void
  ): MongoDBProperty[] => {
    const specificJob = job.mongo as BilboMDSANSDTO

    return [
      { label: 'PDB file', value: specificJob.pdb_file },
      {
        label: 'Solvent D20 Fraction',
        value: specificJob.d2o_fraction,
        suffix: '%'
      },
      ...(job.mongo.md_engine === 'CHARMM'
        ? [
            {
              label: 'MD constraint file',
              render: () =>
                React.createElement(ConstraintFileChip, {
                  job: specificJob,
                  onOpenModal
                })
            }
          ]
        : []),
      { label: 'Rg min', value: specificJob.rg_min, suffix: 'Å' },
      { label: 'Rg max', value: specificJob.rg_max, suffix: 'Å' },
      { label: 'Number of MD Runs', value: getMdRunCount(job) },
      { label: 'Rg values', value: getRgValues(job) },
      { label: 'Number of conformations', value: getConformationCount(job) }
    ]
  }
})

export const createPdbJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD Classic w/PDB',

  getJobSpecificProperties: (
    job: BilboMDJobDTO,
    onOpenModal?: () => void
  ): MongoDBProperty[] => {
    const specificJob = job.mongo as BilboMDPDBDTO

    return [
      { label: 'PDB file', value: specificJob.pdb_file },
      { label: 'PSF file', value: specificJob.psf_file },
      { label: 'CRD file', value: specificJob.crd_file },
      ...(job.mongo.md_engine === 'CHARMM'
        ? [
            {
              label: 'MD constraint file',
              render: () =>
                React.createElement(ConstraintFileChip, {
                  job: specificJob,
                  onOpenModal
                })
            }
          ]
        : []),
      { label: 'Number of MD Runs', value: getMdRunCount(job) },
      { label: 'Rg values', value: getRgValues(job) },
      { label: 'Number of conformations', value: getConformationCount(job) }
    ]
  }
})

export const createCrdJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD Classic w/CRD/PSF',

  getJobSpecificProperties: (
    job: BilboMDJobDTO,
    onOpenModal?: () => void
  ): MongoDBProperty[] => {
    const specificJob = job.mongo as BilboMDCRDDTO

    return [
      { label: 'PDB file', value: specificJob.pdb_file },
      { label: 'PSF file', value: specificJob.psf_file },
      { label: 'CRD file', value: specificJob.crd_file },
      ...(job.mongo.md_engine === 'CHARMM'
        ? [
            {
              label: 'MD constraint file',
              render: () =>
                React.createElement(ConstraintFileChip, {
                  job: specificJob,
                  onOpenModal
                })
            }
          ]
        : []),
      { label: 'Number of MD Runs', value: getMdRunCount(job) },
      { label: 'Rg values', value: getRgValues(job) },
      { label: 'Number of conformations', value: getConformationCount(job) }
    ]
  }
})

export const createScoperJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD Scoper',

  getJobSpecificProperties: (job: BilboMDJobDTO): MongoDBProperty[] => {
    const specificJob = job.mongo as BilboMDScoperDTO

    return [{ label: 'PDB file', value: specificJob.pdb_file }]
  }
})

export const createCarbonaraJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD Carbonara',

  getJobSpecificProperties: (job: BilboMDJobDTO): MongoDBProperty[] => {
    const j = job.mongo as BilboMDCarbonaraDTO
    const flexMode = j.flex_mode
      ? j.flex_mode.charAt(0).toUpperCase() + j.flex_mode.slice(1)
      : 'Auto'

    // A mixture/ensemble run has mixture_n > 1. It is either a multi-structure
    // mixture (different uploaded structures, listed in mixture_pdb_files) or a
    // same-structure mixture (mixture_n copies of the one uploaded structure).
    const extras = j.mixture_pdb_files ?? []
    const isMultiStructure = extras.length > 0
    const isMixture = (j.mixture_n ?? 1) > 1 || isMultiStructure
    const nSpecies = isMultiStructure ? 1 + extras.length : (j.mixture_n ?? 1)

    const props: MongoDBProperty[] = []

    if (isMixture) {
      props.push({
        label: 'Workflow type',
        value: isMultiStructure
          ? 'Mixture — multi-structure ensemble'
          : 'Mixture — same-structure ensemble'
      })
      if (isMultiStructure) {
        props.push({ label: 'Structure 1', value: j.pdb_file })
        extras.forEach((f, i) => {
          props.push({ label: `Structure ${i + 2}`, value: f })
        })
      } else {
        props.push({ label: 'Structure file', value: j.pdb_file })
      }
      props.push({ label: 'Ensemble species', value: nSpecies })
      props.push({
        label: 'Weight combinations sampled',
        value: `Up to ${j.max_mixture_combos ?? 5 * nSpecies} per ensemble size (MultiFoXS optimises the species weights)`
      })
    } else {
      props.push({ label: 'Structure file', value: j.pdb_file })
    }

    props.push(
      { label: 'Flexibility mode', value: flexMode },
      { label: 'q range', value: `${j.min_q}–${j.max_q} Å⁻¹` },
      { label: 'Number of fits', value: j.fit_n_times },
      { label: 'Max fitting steps', value: j.max_fit_steps }
    )
    if (!isMixture) {
      props.push({
        label: 'Oligomeric state',
        value: j.multimer ? 'Multimer' : 'Monomer'
      })
    }

    // Affine rotation applies to a multimer, and to a mixture of multimers
    // (where multimer is false but rotation may be on).
    if (j.multimer || (isMixture && j.rotation)) {
      props.push({
        label: 'Affine rotation',
        value: j.rotation ? 'Enabled' : 'Disabled'
      })
      if (j.chain_merges && j.chain_merges.length > 0) {
        props.push({
          label: 'Chain merges',
          value: j.chain_merges.map((p) => p.join('+')).join(', ')
        })
      }
    }
    if (j.pae_file) {
      props.push({ label: 'PAE file', value: j.pae_file })
    }
    if (j.constraints_file) {
      props.push({ label: 'Constraints file', value: j.constraints_file })
    }
    props.push({
      label: 'Return all-atom (cg2all)',
      value: j.all_atom ? 'Yes' : 'No'
    })

    return props
  }
})

export const createAlphaFoldJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD AlphaFold',

  getJobSpecificProperties: (
    job: BilboMDJobDTO,
    onOpenModal?: () => void
  ): MongoDBProperty[] => {
    const specificJob = job.mongo as BilboMDAlphaFoldDTO

    return [
      { label: 'FASTA file', value: specificJob.fasta_file },
      { label: 'PDB file', value: specificJob.pdb_file },
      { label: 'PSF file', value: specificJob.psf_file },
      { label: 'CRD file', value: specificJob.crd_file },
      { label: 'PAE file', value: specificJob.pae_file },
      ...(job.mongo.md_engine === 'CHARMM'
        ? [
            {
              label: 'MD constraint file',
              render: () =>
                React.createElement(ConstraintFileChip, {
                  job: specificJob,
                  onOpenModal
                })
            }
          ]
        : []),
      { label: 'Number of MD Runs', value: getMdRunCount(job) },
      { label: 'Rg values', value: getRgValues(job) },
      { label: 'Number of conformations', value: getConformationCount(job) }
    ]
  }
})

export const createMultiJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD MultiMD',

  getJobSpecificProperties: (): MongoDBProperty[] => {
    return []
  }
})

export const createOpenFoldJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD OpenFold3',

  getJobSpecificProperties: (
    job: BilboMDJobDTO,
    onOpenModal?: () => void
  ): MongoDBProperty[] => {
    const specificJob = job.mongo as BilboMDOpenFoldDTO

    return [
      { label: 'Query JSON file', value: specificJob.query_json_file },
      { label: 'PDB file', value: specificJob.pdb_file },
      { label: 'PSF file', value: specificJob.psf_file },
      { label: 'CRD file', value: specificJob.crd_file },
      { label: 'PAE file', value: specificJob.pae_file },
      ...(job.mongo.md_engine === 'CHARMM'
        ? [
            {
              label: 'MD constraint file',
              render: () =>
                React.createElement(ConstraintFileChip, {
                  job: specificJob,
                  onOpenModal
                })
            }
          ]
        : []),
      { label: 'Number of MD Runs', value: getMdRunCount(job) },
      { label: 'Rg values', value: getRgValues(job) },
      { label: 'Number of conformations', value: getConformationCount(job) }
    ]
  }
})

export const createAutoMDSaxsJobHandler = (): JobHandler => ({
  getJobTypeDisplayName: () => 'BilboMD AutoMD-SAXS',

  getJobSpecificProperties: (job: BilboMDJobDTO): MongoDBProperty[] => {
    const j = job.mongo as BilboMDAutoMDSAXSDTO
    const props: MongoDBProperty[] = [
      { label: 'Structure file', value: j.pdb_file },
      { label: 'System', value: j.system ?? 'Protein' },
      { label: 'Force field', value: j.force_field ?? 'amber14' },
      { label: 'Water model', value: j.water_model ?? 'tip3p' },
      { label: 'Simulation length', value: j.simulation_time_ns, suffix: ' ns' },
      { label: 'Production repeats', value: j.n_repeats },
      { label: 'Temperature', value: j.temperature_K ?? 300, suffix: ' K' },
      {
        label: 'Ionic concentration',
        value: j.ionic_concentration_M ?? 0.15,
        suffix: ' M'
      },
      { label: 'pH', value: j.ph ?? 7 },
      { label: 'Disulfides', value: j.disulfide ? 'Yes' : 'No' }
    ]
    if (j.box_padding_nm) {
      props.push({ label: 'Box padding', value: j.box_padding_nm, suffix: ' nm' })
    }
    return props
  }
})
