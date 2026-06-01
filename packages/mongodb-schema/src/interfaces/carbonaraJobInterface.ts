import { IJob } from './jobInterface.js'

interface IBilboMDCarbonaraJob extends IJob {
  __t: 'BilboMdCarbonara'
  pdb_file: string
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
  // B7: 3-way flexibility mode and manual residue ranges.
  // flex_mode: 'auto' | 'pae' | 'manual' (default 'auto')
  // flex_ranges shape: [{ chain: 1, ranges: [[start, stop], ...] }, ...]
  flex_mode?: string
  flex_ranges?: { chain: number; ranges: number[][] }[]
}

export { IBilboMDCarbonaraJob }
