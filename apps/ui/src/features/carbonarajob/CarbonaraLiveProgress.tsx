import { Box, Typography, Alert, Chip } from '@mui/material'
import { useGetCarbonaraLiveProgressQuery } from 'slices/jobsApiSlice'
import CarbonaraConvergenceChart from './CarbonaraConvergenceChart'

interface CarbonaraLiveProgressProps {
  jobId: string
}

// Live view of the Carbonara fitting process while a job is Running. Polls the
// backend, which parses the in-progress fitLog*.dat files, and reuses the same
// convergence chart shown on the final results page so the picture is
// consistent before and after completion.
const CarbonaraLiveProgress = ({ jobId }: CarbonaraLiveProgressProps) => {
  const { data, isLoading, isError } = useGetCarbonaraLiveProgressQuery(jobId, {
    // Match SingleJobPage's running-job poll cadence.
    pollingInterval: 10000,
    refetchOnMountOrArgChange: true
  })

  const convergence = data?.convergence ?? []
  const hasData = convergence.length > 0

  // Latest fit step and best χ² so far across all runs, for an at-a-glance line.
  const allPoints = convergence.flatMap((run) => run.points)
  const latestStep = allPoints.reduce((m, p) => (p.step > m ? p.step : m), 0)
  const bestChi2: number | null =
    allPoints.length > 0
      ? allPoints.reduce((m, p) => (p.chi2 < m ? p.chi2 : m), Infinity)
      : null

  return (
    <Box sx={{ mt: 2 }}>
      <Typography
        variant="h6"
        gutterBottom
      >
        Live fitting progress
      </Typography>

      {isError && (
        <Alert
          severity="info"
          sx={{ mb: 1 }}
        >
          Live progress is not available yet.
        </Alert>
      )}

      {!isError && !hasData && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ py: 2 }}
        >
          {isLoading
            ? 'Loading fitting progress…'
            : 'Waiting for the fitting process to produce its first results…'}
        </Typography>
      )}

      {hasData && (
        <>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
            <Chip
              size="small"
              label={`Fits running: ${convergence.length}`}
            />
            <Chip
              size="small"
              label={`Latest step: ${latestStep}`}
            />
            {bestChi2 !== null && (
              <Chip
                size="small"
                color="primary"
                label={`Best Carbonara χ² so far: ${bestChi2.toFixed(4)}`}
              />
            )}
          </Box>
          <CarbonaraConvergenceChart
            convergence={convergence}
            height={240}
          />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.5 }}
          >
            Updates every 10 s. Each line is one fit replica; this is the
            Carbonara fitting χ² (coarse-grained). The all-atom FoXS χ² is
            computed afterwards and shown on the results page.
          </Typography>
        </>
      )}
    </Box>
  )
}

export default CarbonaraLiveProgress
