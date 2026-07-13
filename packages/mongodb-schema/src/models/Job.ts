import { Schema, model } from 'mongoose'
import { assetsSchema } from './Assets'
import { resultsSchema } from './Results'
import { stepsSchema } from './JobSteps'
import {
  IJob,
  IBilboMDPDBJob,
  IBilboMDCRDJob,
  IBilboMDAutoJob,
  IBilboMDScoperJob,
  IBilboMDAlphaFoldJob,
  IBilboMDOpenFoldJob,
  IBilboMDSANSJob,
  IBilboMDCarbonaraJob,
  IBilboMDAutoMDSAXSJob,
  IAlphaFoldEntity,
  IOpenFoldEntity,
  IFeedbackData,
  INerscInfo,
  IBilboMDSteps,
  IResidueRange,
  ISegment,
  IFixedBody,
  IRigidBody,
  IMDConstraints
} from '../interfaces'
import { openmmParametersSchema } from './OpenMM'
import { charmmParametersSchema } from './CHARMM'

// Enum for simulation engines (MD/minimize/heat implementation)
const mdEngineEnum = ['CHARMM', 'OpenMM'] as const

const alphaFoldEntitySchema = new Schema<IAlphaFoldEntity>({
  name: { type: String, required: true },
  sequence: { type: String, required: true },
  type: { type: String, required: true },
  copies: { type: Number, required: true }
})

const openFoldEntitySchema = new Schema<IOpenFoldEntity>({
  name: { type: String, required: true },
  sequence: { type: String, required: true },
  type: { type: String, enum: ['Protein', 'DNA', 'RNA'], required: true },
  copies: { type: Number, required: true }
})

const feedbackSchema = new Schema<IFeedbackData>({
  mw_saxs: { type: Number, required: true },
  mw_model: { type: Number, required: true },
  mw_err: { type: Number, required: true },
  best_model_dat_file: { type: String, required: true },
  best_ensemble_pdb_file: { type: String, required: true },
  overall_chi_square: { type: Number, required: true },
  q_ranges: [{ type: Number, required: true }],
  chi_squares_of_regions: [{ type: Number, required: true }],
  residuals_of_regions: [{ type: Number, required: true }],
  mw_feedback: { type: String, required: true },
  overall_chi_square_feedback: { type: String, required: true },
  highest_chi_square_feedback: { type: String, required: true },
  second_highest_chi_square_feedback: { type: String, required: true },
  regional_chi_square_feedback: { type: String, required: true },
  timestamp: { type: Date, default: () => new Date(Date.now()) }
})

const nerscInfoSchema = new Schema<INerscInfo>({
  jobid: { type: String, required: false },
  state: { type: String, required: false },
  qos: { type: String, required: false },
  time_submitted: { type: Date, default: () => new Date(Date.now()) },
  time_started: { type: Date, required: false },
  time_completed: { type: Date, required: false }
})

const residueRangeSchema = new Schema<IResidueRange>({
  start: { type: Number, required: true },
  stop: { type: Number, required: true }
})

const segmentSchema = new Schema<ISegment>({
  chain_id: { type: String, required: true },
  residues: { type: residueRangeSchema, required: true }
})

const fixedBodySchema = new Schema<IFixedBody>({
  name: { type: String, required: true },
  segments: [{ type: segmentSchema, required: true }]
})

const rigidBodySchema = new Schema<IRigidBody>({
  name: { type: String, required: true },
  segments: [{ type: segmentSchema, required: true }]
})

const mdConstraintsSchema = new Schema<IMDConstraints>({
  fixed_bodies: [{ type: fixedBodySchema, required: false }],
  rigid_bodies: [{ type: rigidBodySchema, required: false }]
})

const jobSchema = new Schema(
  {
    title: {
      type: String,
      required: true
    },
    uuid: { type: String, required: true },
    access_mode: {
      type: String,
      enum: ['user', 'anonymous'],
      default: 'user',
      required: true
    },
    public_id: {
      type: String,
      required: function (this: any) {
        return this.access_mode === 'anonymous'
      }
    },
    client_ip_hash: {
      type: String,
      required: function (this: any) {
        return this.access_mode === 'anonymous'
      },
      index: true
    },
    data_file: { type: String, required: true },
    md_constraints: { type: mdConstraintsSchema, required: false },
    openmm_parameters: { type: openmmParametersSchema, required: false },
    openmm_forcefield: { type: [String], required: false },
    charmm_parameters: { type: charmmParametersSchema, required: false },
    status: {
      type: String,
      enum: [
        'Submitted',
        'Pending',
        'Running',
        'Completed',
        'Error',
        'Failed',
        'Cancelled'
      ],
      default: 'Submitted'
    },
    time_submitted: { type: Date, default: () => new Date(Date.now()) },
    time_started: Date,
    time_completed: Date,
    user: {
      _id: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: function (this: any) {
          return this.access_mode === 'user'
        }
      },
      username: {
        type: String,
        required: function (this: any) {
          return this.access_mode === 'user'
        }
      },
      email: {
        type: String,
        required: function (this: any) {
          return this.access_mode === 'user'
        }
      }
    },
    resubmitted_from: {
      type: Schema.Types.ObjectId,
      ref: 'Job',
      required: false
    },
    steps: { type: stepsSchema, required: false },
    progress: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    feedback: { type: feedbackSchema, required: false },
    assets: { type: assetsSchema, required: false },
    nersc: { type: nerscInfoSchema, required: false },
    cleanup_in_progress: { type: Boolean, default: false },
    results_ready: { type: Boolean },
    results: { type: resultsSchema, required: false }
  },
  {
    timestamps: true,
    id: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        // Ensure the `user` field includes only minimal details
        if (ret.user && typeof ret.user === 'object' && ret.user._id) {
          ret.user = {
            _id: ret.user._id,
            username: ret.user.username,
            email: ret.user.email
          }
        }

        return ret
      }
    },
    toObject: { virtuals: true }
  }
)

const bilboMdPDBJobSchema = new Schema<IBilboMDPDBJob>({
  pdb_file: { type: String, required: true },
  psf_file: { type: String, required: false },
  crd_file: { type: String, required: false },
  const_inp_file: { type: String, required: true },
  md_engine: {
    type: String,
    enum: mdEngineEnum,
    default: 'CHARMM',
    required: false
  },
  conformational_sampling: {
    type: Number,
    enum: [1, 2, 3, 4],
    default: 1
  },
  rg: { type: Number, required: true, min: 10, max: 100 },
  rg_min: { type: Number, required: true, min: 10, max: 100 },
  rg_max: { type: Number, required: true, min: 10, max: 100 }
})

const bilboMdCRDJobSchema = new Schema<IBilboMDCRDJob>({
  pdb_file: { type: String, required: false },
  psf_file: { type: String, required: true },
  crd_file: { type: String, required: true },
  const_inp_file: { type: String, required: true },
  md_engine: {
    type: String,
    enum: mdEngineEnum,
    default: 'CHARMM',
    required: false
  },
  conformational_sampling: {
    type: Number,
    enum: [1, 2, 3, 4],
    default: 1
  },
  rg: { type: Number, required: true, min: 10, max: 100 },
  rg_min: { type: Number, required: true, min: 10, max: 100 },
  rg_max: { type: Number, required: true, min: 10, max: 100 }
})

const bilboMdAutoJobSchema = new Schema<IBilboMDAutoJob>({
  pdb_file: { type: String, required: true },
  psf_file: { type: String, required: false },
  crd_file: { type: String, required: false },
  pae_file: { type: String, required: true },
  const_inp_file: { type: String, required: false },
  md_engine: {
    type: String,
    enum: mdEngineEnum,
    default: 'CHARMM',
    required: false
  },
  conformational_sampling: {
    type: Number,
    enum: [1, 2, 3, 4],
    default: 1
  },
  rg: { type: Number, required: false, min: 10, max: 100 },
  rg_min: { type: Number, required: false, min: 10, max: 100 },
  rg_max: { type: Number, required: false, min: 10, max: 100 }
})

const bilboMdAlphaFoldJobSchema = new Schema<IBilboMDAlphaFoldJob>({
  fasta_file: { type: String, required: true },
  alphafold_entities: [alphaFoldEntitySchema],
  pdb_file: { type: String, required: false },
  psf_file: { type: String, required: false },
  crd_file: { type: String, required: false },
  pae_file: { type: String, required: false },
  const_inp_file: { type: String, required: false },
  md_engine: {
    type: String,
    enum: mdEngineEnum,
    default: 'CHARMM',
    required: false
  },
  conformational_sampling: {
    type: Number,
    enum: [1, 2, 3, 4],
    default: 1
  },
  rg: { type: Number, required: false, min: 10, max: 100 },
  rg_min: { type: Number, required: false, min: 10, max: 100 },
  rg_max: { type: Number, required: false, min: 10, max: 100 }
})

const bilboMdOpenFoldJobSchema = new Schema<IBilboMDOpenFoldJob>({
  query_json_file: { type: String, required: true },
  openfold_entities: [openFoldEntitySchema],
  pdb_file: { type: String, required: false },
  psf_file: { type: String, required: false },
  crd_file: { type: String, required: false },
  pae_file: { type: String, required: false },
  const_inp_file: { type: String, required: false },
  md_engine: {
    type: String,
    enum: mdEngineEnum,
    default: 'OpenMM',
    required: false
  },
  conformational_sampling: {
    type: Number,
    enum: [1, 2, 3, 4],
    default: 1
  },
  rg: { type: Number, required: false, min: 10, max: 100 },
  rg_min: { type: Number, required: false, min: 10, max: 100 },
  rg_max: { type: Number, required: false, min: 10, max: 100 }
})

const bilboMdSANSJobSchema = new Schema<IBilboMDSANSJob>({
  pdb_file: { type: String, required: true },
  psf_file: { type: String, required: false },
  crd_file: { type: String, required: false },
  const_inp_file: { type: String, required: true },
  md_engine: {
    type: String,
    enum: mdEngineEnum,
    default: 'CHARMM',
    required: false
  },
  conformational_sampling: {
    type: Number,
    enum: [1, 2, 3, 4],
    default: 1
  },
  rg: { type: Number, required: true, min: 10, max: 100 },
  rg_min: { type: Number, required: true, min: 10, max: 100 },
  rg_max: { type: Number, required: true, min: 10, max: 100 },
  d2o_fraction: { type: Number, required: true },
  deuteration_fractions: {
    type: Schema.Types.Mixed,
    required: true
  }
})

const bilboMdScoperJobSchema = new Schema<IBilboMDScoperJob>({
  pdb_file: { type: String, required: true },
  fixc1c2: { type: Boolean, required: true }
})

const bilboMdCarbonaraJobSchema = new Schema<IBilboMDCarbonaraJob>({
  pdb_file: { type: String, required: true },
  fasta_file: { type: String, required: false },
  mixture_pdb_files: { type: [String], required: false },
  fit_n_times: { type: Number, required: true, default: 4 },
  min_q: { type: Number, required: true, default: 0.01 },
  max_q: { type: Number, required: true, default: 0.2 },
  max_q_start: { type: Number, required: true, default: 0.2 },
  max_fit_steps: { type: Number, required: true, default: 1000 },
  mixture_n: { type: Number, required: true, default: 1 },
  max_mixture_combos: { type: Number, required: false },
  rotation: { type: Boolean, required: false, default: false },
  all_atom: { type: Boolean, default: false },
  do_foxs: { type: Boolean, default: true },
  pae_file: { type: String, required: false },
  alphafold_flex: { type: Boolean, default: false },
  pae_flex_threshold: { type: Number, default: 16.0 },
  constraints_file: { type: String, required: false },
  // B7: 3-way flexibility mode (auto | pae | manual) and manual residue ranges.
  // flex_ranges shape stored as Mixed: [{ chain: 1, ranges: [[start, stop]] }]
  flex_mode: {
    type: String,
    enum: ['auto', 'pae', 'manual'],
    default: 'auto',
    required: false
  },
  flex_ranges: { type: Schema.Types.Mixed, required: false },
  // B8: multimer mode and sequential chain-merge pairs (1-based).
  // chain_merges shape stored as Mixed: [[i, j], ...]
  multimer: { type: Boolean, default: false },
  chain_merges: { type: Schema.Types.Mixed, required: false }
})

// AutoMD-SAXS: explicit-solvent OpenMM refinement run by the external
// `automd-saxs` CLI. Mirrors the automd-saxs OpenMMConfig fields.
const bilboMdAutoMDSAXSJobSchema = new Schema<IBilboMDAutoMDSAXSJob>({
  pdb_file: { type: String, required: true },
  dat_file: { type: String, required: false },
  system: { type: String, default: 'Protein', required: false },
  force_field: { type: String, default: 'amber14', required: false },
  water_model: { type: String, default: 'tip3p', required: false },
  simulation_time_ns: { type: Number, required: true, default: 100 },
  n_repeats: { type: Number, required: true, default: 3 },
  temperature_K: { type: Number, default: 300, required: false },
  ionic_concentration_M: { type: Number, default: 0.15, required: false },
  ph: { type: Number, default: 7.0, required: false },
  disulfide: { type: Boolean, default: false, required: false },
  box_padding_nm: { type: Number, required: false },
  seed: { type: Number, required: false },
  hmr: { type: Boolean, default: false, required: false },
  keep_ions: { type: Boolean, default: true, required: false },
  keep_crystallisation_agents: { type: Boolean, default: false, required: false },
  keep_waters: { type: Boolean, default: false, required: false },
  ligand_resnames: { type: [String], required: false },
  ligand_smiles: { type: Object, required: false },
  protonation_overrides: { type: Object, required: false }
})

jobSchema.index({ uuid: 1 })
jobSchema.index({ client_ip_hash: 1, access_mode: 1, status: 1 })

const Job = model<IJob>('Job', jobSchema)
const BilboMdPDBJob = Job.discriminator('BilboMdPDB', bilboMdPDBJobSchema)
const BilboMdCRDJob = Job.discriminator('BilboMdCRD', bilboMdCRDJobSchema)
const BilboMdJob = Job.discriminator('BilboMd', bilboMdCRDJobSchema)
const BilboMdAutoJob = Job.discriminator('BilboMdAuto', bilboMdAutoJobSchema)
const BilboMdAlphaFoldJob = Job.discriminator(
  'BilboMdAlphaFold',
  bilboMdAlphaFoldJobSchema
)
const BilboMdOpenFoldJob = Job.discriminator(
  'BilboMdOpenFold',
  bilboMdOpenFoldJobSchema
)
const BilboMdSANSJob = Job.discriminator('BilboMdSANS', bilboMdSANSJobSchema)
const BilboMdScoperJob = Job.discriminator(
  'BilboMdScoper',
  bilboMdScoperJobSchema
)
const BilboMdCarbonaraJob = Job.discriminator(
  'BilboMdCarbonara',
  bilboMdCarbonaraJobSchema
)
const BilboMdAutoMDSAXSJob = Job.discriminator(
  'BilboMdAutoMDSAXS',
  bilboMdAutoMDSAXSJobSchema
)

export {
  Job,
  BilboMdJob,
  BilboMdPDBJob,
  BilboMdCRDJob,
  BilboMdAutoJob,
  BilboMdScoperJob,
  BilboMdAlphaFoldJob,
  BilboMdOpenFoldJob,
  BilboMdSANSJob,
  BilboMdCarbonaraJob,
  BilboMdAutoMDSAXSJob,
  nerscInfoSchema,
  mdConstraintsSchema,
  fixedBodySchema,
  rigidBodySchema,
  segmentSchema,
  residueRangeSchema
}
