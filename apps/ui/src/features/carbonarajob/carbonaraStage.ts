// Human-readable description of what a running Carbonara job is currently doing,
// derived from its progress value. The worker advances progress to 20 before the
// long container run and only jumps to 85 when it exits, so a job sits at 20
// throughout fitting — which is why fitting is called out as the longest step.
export const carbonaraStageLabel = (progress: number): string => {
  if (progress < 20) return 'Preparing inputs'
  if (progress < 85) return 'Fitting (conformational sampling — longest step)'
  if (progress < 86) return 'Collecting fit results'
  if (progress < 98) return 'All-atom reconstruction (cg2all)'
  if (progress < 100) return 'Analysing results'
  return 'Complete'
}
