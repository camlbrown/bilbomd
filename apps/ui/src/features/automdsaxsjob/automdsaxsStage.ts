// Map an AutoMD-SAXS pipeline stage key (from progress.json) to a human label
// and an ordered position, for the stepper / progress display.

export const AUTOMD_SAXS_STAGES: { key: string; label: string }[] = [
  { key: 'prepare_structure', label: 'Preparing structure' },
  { key: 'solvate', label: 'Solvating (water + ions)' },
  { key: 'minimize', label: 'Energy minimisation' },
  { key: 'equilibrate', label: 'Equilibration (NVT/NPT)' },
  { key: 'production', label: 'Production MD' },
  { key: 'extract_frames', label: 'Extracting frames' },
  { key: 'foxs', label: 'SAXS fitting (FoXS/MultiFoXS)' },
  { key: 'cluster', label: 'Structural clustering' }
]

// production_rep1, production_rep2 ... collapse to the 'production' stage.
const normalize = (stage: string): string =>
  stage.startsWith('production_rep') ? 'production' : stage

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
