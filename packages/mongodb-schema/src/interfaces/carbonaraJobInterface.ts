import { IJob } from './jobInterface.js'

interface IBilboMDCarbonaraJob extends IJob {
  __t: 'BilboMdCarbonara'
  pdb_file: string
  // Optional full experimental sequence (FASTA) for missing-residue checking.
  fasta_file?: string
  // Multi-structure mixture: additional structure files (species 2..n). Empty/
  // absent for a single-structure job or a same-structure mixture_n mixture.
  mixture_pdb_files?: string[]
  fit_n_times: number
  min_q: number
  max_q: number
  max_q_start: number
  max_fit_steps: number
  // Mixture/ensemble refinement: mixture_n species fit together, with up to
  // max_mixture_combos weight combinations sampled (only used when mixture_n > 1).
  mixture_n: number
  max_mixture_combos?: number
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
  // B8: multimer mode (default false) and sequential chain-merge pairs.
  // chain_merges shape: [[i, j], ...] — 1-based pairs applied in order;
  // chain indices renumber after each merge.
  multimer?: boolean
  chain_merges?: number[][]
}

export { IBilboMDCarbonaraJob }
