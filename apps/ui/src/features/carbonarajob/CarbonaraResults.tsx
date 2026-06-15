import { Box, Typography, Alert, CircularProgress, Paper } from '@mui/material'
import { useGetCarbonaraAnalysisQuery } from 'slices/jobsApiSlice'
import InitialFitChart from './InitialFitChart'
import CarbonaraConvergenceChart from './CarbonaraConvergenceChart'
import CarbonaraPredictionsTable from './CarbonaraPredictionsTable'
import CarbonaraHistogramsPanel from './CarbonaraHistogramsPanel'
import CarbonaraDownloadPanel from './CarbonaraDownloadPanel'

interface CarbonaraResultsProps {
  jobId: string
}

const CarbonaraResults = ({ jobId }: CarbonaraResultsProps) => {
  const {
    data: analysis,
    isLoading,
    isError,
    error
  } = useGetCarbonaraAnalysisQuery(jobId)

  if (isLoading) return <CircularProgress />

  if (isError) {
    const msg =
      error && typeof error === 'object' && 'error' in error
        ? String((error as { error: unknown }).error)
        : 'Unknown error'
    return (
      <Alert severity="error">
        Failed to load Carbonara analysis: {msg}
      </Alert>
    )
  }

  if (!analysis || analysis.status === 'pending') {
    return (
      <Alert severity="info">
        Carbonara analysis is still being prepared. Please check back shortly.
      </Alert>
    )
  }

  if (analysis.status === 'error') {
    return (
      <Alert severity="warning">
        Carbonara analysis completed with errors. Some results may be missing.
      </Alert>
    )
  }

  // --- Summary ---
  // Two distinct chi² measures are reported on this page:
  //  * Carbonara χ² — the fitting objective on the coarse-grained model, shown
  //    on the convergence plot (analysis.convergence ScatterFitFirst).
  //  * FoXS χ² — recomputed with FoXS on each all-atom reconstruction; this is
  //    the predictions-table χ² and analysis.best.chi2.
  const bestFoxsChi2 = analysis.best?.chi2 ?? null
  const carbonaraChi2s = analysis.convergence.flatMap((r) =>
    r.points.map((p) => p.chi2)
  )
  const bestCarbonaraChi2 =
    carbonaraChi2s.length > 0 ? Math.min(...carbonaraChi2s) : null
  const nPredictions = analysis.n_predictions ?? analysis.predictions.length

  // --- Best FoXS fit ---
  const foxsPoints = analysis.best?.fit?.foxs ?? []
  const iqData = foxsPoints.map((p) => ({
    q: p.q,
    exp_intensity: p.exp,
    model_intensity: p.model,
    error: p.error
  }))
  const residualsData = foxsPoints.map((p) => ({
    q: p.q,
    res: p.error > 0 ? (p.exp - p.model) / p.error : 0
  }))

  return (
    <Box>
      {/* Summary */}
      <Paper
        variant="outlined"
        sx={{ p: 2, mb: 2 }}
      >
        <Typography
          variant="h6"
          gutterBottom
        >
          Summary
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 1
          }}
        >
          <Box>
            <Typography
              variant="caption"
              color="text.secondary"
            >
              Predictions
            </Typography>
            <Typography variant="body1">{nPredictions}</Typography>
          </Box>
          <Box>
            <Typography
              variant="caption"
              color="text.secondary"
            >
              Best Carbonara χ² (fit)
            </Typography>
            <Typography variant="body1">
              {bestCarbonaraChi2 !== null
                ? bestCarbonaraChi2.toFixed(4)
                : '—'}
            </Typography>
          </Box>
          <Box>
            <Typography
              variant="caption"
              color="text.secondary"
            >
              Best FoXS χ² (all-atom)
            </Typography>
            <Typography variant="body1">
              {bestFoxsChi2 !== null ? bestFoxsChi2.toFixed(4) : '—'}
            </Typography>
          </Box>
          <Box>
            <Typography
              variant="caption"
              color="text.secondary"
            >
              FoXS χ² threshold
            </Typography>
            <Typography variant="body1">{analysis.chi2_threshold}</Typography>
          </Box>
          <Box>
            <Typography
              variant="caption"
              color="text.secondary"
            >
              Best model
            </Typography>
            <Typography
              variant="body1"
              sx={{ wordBreak: 'break-all' }}
            >
              {analysis.best?.id ?? '—'}
            </Typography>
          </Box>
        </Box>
        {analysis.warnings && analysis.warnings.length > 0 && (
          <Alert
            severity="warning"
            sx={{ mt: 1 }}
          >
            {analysis.warnings.join('; ')}
          </Alert>
        )}
      </Paper>

      {/* Convergence plot */}
      <Paper
        variant="outlined"
        sx={{ p: 2, mb: 2 }}
      >
        <Typography variant="h6">Convergence</Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 1 }}
        >
          Carbonara fitting χ² (coarse-grained model) per fit run — not the
          all-atom FoXS χ² shown in the summary and predictions table.
        </Typography>
        <CarbonaraConvergenceChart convergence={analysis.convergence} />
      </Paper>

      {/* Best-model FoXS fit */}
      {iqData.length > 0 && (
        <Paper
          variant="outlined"
          sx={{ p: 2, mb: 2 }}
        >
          <Typography
            variant="h6"
            gutterBottom
          >
            Best-model FoXS fit (
            {analysis.best?.id ?? ''}, FoXS χ² ={' '}
            {bestFoxsChi2 !== null ? bestFoxsChi2.toFixed(4) : '—'})
          </Typography>
          <InitialFitChart
            data={iqData}
            residualsData={residualsData}
          />
        </Paper>
      )}

      {/* Predictions table (R4) */}
      <CarbonaraPredictionsTable
        jobId={jobId}
        predictions={analysis.predictions}
        bestId={analysis.best?.id}
      />

      {/* Histograms (R5) */}
      <CarbonaraHistogramsPanel
        histograms={analysis.histograms}
        predictions={analysis.predictions}
        chi2Threshold={analysis.chi2_threshold}
      />

      {/* Download bundle (R6) */}
      <Paper
        variant="outlined"
        sx={{ p: 2, mb: 2 }}
      >
        <Typography
          variant="h6"
          gutterBottom
        >
          Download
        </Typography>
        <CarbonaraDownloadPanel
          jobId={jobId}
          mongoId={jobId}
          predictions={analysis.predictions}
        />
      </Paper>
    </Box>
  )
}

export default CarbonaraResults
