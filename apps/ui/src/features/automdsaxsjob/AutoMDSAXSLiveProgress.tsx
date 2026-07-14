import { Box, Typography, Chip, LinearProgress, Stepper, Step, StepLabel } from '@mui/material'
import { useGetAutoMDSAXSLiveProgressQuery } from 'slices/jobsApiSlice'
import {
  AUTOMD_SAXS_STAGES,
  stageLabel,
  stageIndex
} from './automdsaxsStage'

interface Props {
  jobId: string
}

// Human-readable "time remaining" from seconds, or null if unknown.
const formatEta = (s?: number | null): string | null => {
  if (s == null || !Number.isFinite(s) || s <= 0) return null
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `~${h}h ${m}m left`
  if (m > 0) return `~${m}m left`
  return '~<1m left'
}

// Live per-stage + per-repeat MD progress, polled every 10 s while the job runs.
const AutoMDSAXSLiveProgress = ({ jobId }: Props) => {
  const { data, isLoading } = useGetAutoMDSAXSLiveProgressQuery(jobId, {
    pollingInterval: 10000,
    refetchOnMountOrArgChange: true
  })

  if (isLoading || !data || data.status === 'pending') {
    return (
      <Box sx={{ mt: 2 }}>
        <Typography variant="h6">Live progress</Typography>
        <Typography
          variant="body2"
          color="text.secondary"
        >
          Waiting for the job to start…
        </Typography>
        <LinearProgress sx={{ mt: 1 }} />
      </Box>
    )
  }

  const idx = stageIndex(data.stage)
  const repeats = data.repeats ?? []

  return (
    <Box sx={{ mt: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="h6">Live progress</Typography>
        <Chip
          size="small"
          color="primary"
          label={stageLabel(data.stage)}
        />
        {formatEta(data.etaSeconds) && (
          <Chip
            size="small"
            variant="outlined"
            label={formatEta(data.etaSeconds)}
          />
        )}
      </Box>

      {/* Pipeline stage stepper */}
      <Stepper
        activeStep={idx}
        alternativeLabel
        sx={{ my: 2 }}
      >
        {AUTOMD_SAXS_STAGES.map((s) => (
          <Step key={s.key}>
            <StepLabel>{s.label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {/* Per-repeat ns counters (shown during/after production) */}
      {repeats.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography
            variant="subtitle2"
            sx={{ mb: 1 }}
          >
            Production repeats
          </Typography>
          {repeats.map((r) => {
            const pct =
              r.nsTotal > 0
                ? Math.min(100, (r.nsDone / r.nsTotal) * 100)
                : 0
            return (
              <Box
                key={r.repeat}
                sx={{ mb: 1.5 }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    mb: 0.5
                  }}
                >
                  <Typography variant="body2">Repeat {r.repeat}</Typography>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                  >
                    {r.nsDone.toFixed(2)} / {r.nsTotal} ns
                    {r.stepTotal > 0
                      ? ` (${r.stepDone.toLocaleString()} / ${r.stepTotal.toLocaleString()} steps)`
                      : ''}
                    {formatEta(r.etaSeconds) ? ` · ${formatEta(r.etaSeconds)}` : ''}
                  </Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={pct}
                />
              </Box>
            )
          })}
        </Box>
      )}

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 1 }}
      >
        Updates every 10 s.
      </Typography>
    </Box>
  )
}

export default AutoMDSAXSLiveProgress
