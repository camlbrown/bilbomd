import { OpenMMParametersDTO } from './openmm.js'
import { CHARMMParametersDTO } from './charmm.js'
import { AlphafoldEntityDTO } from './alphafold.js'
import { OpenFoldEntityDTO } from './openfold.js'
import { UserSummaryDTO } from '../users/user.js'
import { MDConstraintsDTO } from './mdConstraints.js'
import { JobStepsDTO } from './jobSteps.js'
import { JobFeedbackDTO } from './feedback.js'
import { JobAssetsDTO } from './mdMovie.js'
import { NerscInfoDTO } from './nersc.js'
import { JobResultsDTO } from './results.js'

export type JobType =
  | 'pdb'
  | 'crd'
  | 'auto'
  | 'alphafold'
  | 'openfold'
  | 'sans'
  | 'scoper'
  | 'carbonara'
  | 'automd-saxs'
  | 'multi'

export type MDEngine = 'CHARMM' | 'OpenMM'

export const JOB_STATUSES = [
  'Submitted',
  'Pending',
  'Running',
  'Completed',
  'Error',
  'Failed',
  'Cancelled'
] as const

export type JobStatusEnum = (typeof JOB_STATUSES)[number]

export interface BaseJobDTO {
  id: string
  jobType: JobType
  title: string
  uuid: string
  access_mode: 'user' | 'anonymous'
  public_id?: string
  status: JobStatusEnum
  data_file: string
  md_engine?: MDEngine
  openmm_parameters?: OpenMMParametersDTO
  charmm_parameters?: CHARMMParametersDTO
  md_constraints?: MDConstraintsDTO
  time_submitted: Date
  time_started?: Date
  time_completed?: Date
  user?: UserSummaryDTO
  resubmitted_from?: string
  steps?: JobStepsDTO
  progress: number
  feedback?: JobFeedbackDTO
  assets?: JobAssetsDTO
  nersc?: NerscInfoDTO
  cleanup_in_progress: boolean
  results_ready?: boolean
  results?: JobResultsDTO
}

export interface BilboMDPDBDTO extends BaseJobDTO {
  pdb_file: string
  const_inp_file: string
  psf_file?: string
  crd_file?: string
  conformational_sampling: number
  rg: number
  rg_min: number
  rg_max: number
}

export interface BilboMDCRDDTO extends BaseJobDTO {
  psf_file: string
  crd_file: string
  const_inp_file: string
  pdb_file?: string
  conformational_sampling: number
  rg: number
  rg_min: number
  rg_max: number
}

export interface BilboMDAutoDTO extends BaseJobDTO {
  pdb_file: string
  pae_file: string
  psf_file?: string
  crd_file?: string
  const_inp_file?: string
  conformational_sampling: number
  rg?: number
  rg_min?: number
  rg_max?: number
}

export interface BilboMDAlphaFoldDTO extends BaseJobDTO {
  alphafold_entities: AlphafoldEntityDTO[]
  fasta_file: string
  pdb_file?: string
  psf_file?: string
  crd_file?: string
  pae_file?: string
  const_inp_file?: string
  conformational_sampling: number
  rg?: number
  rg_min?: number
  rg_max?: number
}

export interface BilboMDOpenFoldDTO extends BaseJobDTO {
  openfold_entities: OpenFoldEntityDTO[]
  query_json_file: string
  pdb_file?: string
  psf_file?: string
  crd_file?: string
  pae_file?: string
  const_inp_file?: string
  conformational_sampling: number
  rg?: number
  rg_min?: number
  rg_max?: number
}

export interface BilboMDSANSDTO extends BaseJobDTO {
  pdb_file: string
  psf_file?: string
  crd_file?: string
  const_inp_file: string
  conformational_sampling: number
  d2o_fraction: number
  rg: number
  rg_min: number
  rg_max: number
  deuteration_fractions: { label: string; fraction: number }[]
}

export interface BilboMDScoperDTO extends BaseJobDTO {
  pdb_file: string
  fixc1c2: boolean
  foxs_top_file?: string
}

export interface BilboMDCarbonaraDTO extends BaseJobDTO {
  pdb_file: string
  // Optional full experimental sequence (FASTA) used to flag residues missing
  // from the uploaded structure. Advisory only in phase 1.
  fasta_file?: string
  // Mixture/ensemble: additional structure files (multi-structure mixture) and
  // the number of weight combinations MultiFoXS samples per ensemble size.
  mixture_pdb_files?: string[]
  max_mixture_combos?: number
  fit_n_times: number
  min_q: number
  max_q: number
  max_q_start: number
  max_fit_steps: number
  mixture_n: number
  rotation?: boolean
  all_atom?: boolean
  do_foxs?: boolean
  pae_file?: string
  alphafold_flex?: boolean
  pae_flex_threshold?: number
  constraints_file?: string
  // B7: 3-way flexibility mode and manual residue ranges
  flex_mode?: string
  flex_ranges?: { chain: number; ranges: number[][] }[]
  // B8: multimer mode and sequential chain-merge pairs (1-based)
  multimer?: boolean
  chain_merges?: number[][]
}

export interface BilboMDMultiDTO extends BaseJobDTO {
  bilbomd_uuids: string[]
  data_file_from: string
  bilbomd_jobs?: []
}

// AutoMD-SAXS: explicit-solvent OpenMM refinement, executed by the external
// `automd-saxs` CLI. Fields map onto the automd-saxs OpenMMConfig JSON.
export interface BilboMDAutoMDSAXSDTO extends BaseJobDTO {
  pdb_file: string
  dat_file?: string
  system?: string
  force_field?: string
  water_model?: string
  simulation_time_ns: number
  n_repeats: number
  temperature_K?: number
  ionic_concentration_M?: number
  ph?: number
  disulfide?: boolean
  box_padding_nm?: number
  seed?: number
  hmr?: boolean
  // Structure-content + protonation controls (Task 2/3/4 setup UI).
  keep_ions?: boolean
  keep_crystallisation_agents?: boolean
  keep_waters?: boolean
  ligand_resnames?: string[]
  ligand_smiles?: Record<string, string>
  protonation_overrides?: Record<string, string>
}

export type BilboMDMongoJobDTO =
  | BilboMDPDBDTO
  | BilboMDCRDDTO
  | BilboMDAutoDTO
  | BilboMDAlphaFoldDTO
  | BilboMDOpenFoldDTO
  | BilboMDSANSDTO
  | BilboMDScoperDTO
  | BilboMDCarbonaraDTO
  | BilboMDAutoMDSAXSDTO
  | BilboMDMultiDTO

export interface BilboMDJobDTO {
  id: string
  username: string
  mongo: BilboMDMongoJobDTO
}
