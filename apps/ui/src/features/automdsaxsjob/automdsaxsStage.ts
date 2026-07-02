// Map an AutoMD-SAXS pipeline stage key (from progress.json) to a human label
// and an ordered position, for the stepper / progress display.

export const AUTOMD_SAXS_STAGES: { key: string; label: string }[] = [
  { key: 'prepare_structure', label: 'Preparing structure' },
  { key: 'solvate', label: 'Solvating (water + ions)' },
  { key: 'minimize', label: 'Energy minimisation' },
  { key: 'equilibrate', label: 'Equilibration (NVT/NPT)' },
  { key: 'production', label: 'Production MD' },
  { key: 'analyse', label: 'Analysing results' }
]

// The three post-production stages (frame extraction, FoXS/MultiFoXS, and
// clustering) collapse into a single 'analyse' step to save horizontal space.
const ANALYSE_STAGES = new Set(['extract_frames', 'foxs', 'cluster'])

// production_rep1, production_rep2 ... collapse to the 'production' stage; the
// post-processing stages collapse to 'analyse'.
const normalize = (stage: string): string => {
  if (stage.startsWith('production_rep')) return 'production'
  if (ANALYSE_STAGES.has(stage)) return 'analyse'
  return stage
}

export const stageLabel = (stage?: string | null): string => {
  if (!stage) return 'Starting…'
  const norm = normalize(stage)
  const found = AUTOMD_SAXS_STAGES.find((s) => s.key === norm)
  return found ? found.label : stage
}

export const stageIndex = (stage?: string | null): number => {
  if (!stage) return -1
  return AUTOMD_SAXS_STAGES.findIndex((s) => s.key === normalize(stage))
}
