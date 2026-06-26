import { IJob } from './jobInterface.js'

// AutoMD-SAXS: explicit-solvent OpenMM all-atom MD + FoXS SAXS refinement,
// executed by the external `automd-saxs` CLI. Fields map onto the automd-saxs
// OpenMMConfig JSON the worker writes before invoking the CLI.
interface IBilboMDAutoMDSAXSJob extends IJob {
  __t: 'BilboMdAutoMDSAXS'
  pdb_file: string
  // Optional experimental SAXS curve (.dat). Without it, SAXS fitting is skipped.
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
}

export { IBilboMDAutoMDSAXSJob }
