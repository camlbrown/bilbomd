import { useState } from 'react'
import {
  Box,
  Typography,
  Alert,
  CircularProgress,
  Paper,
  ToggleButton,
  ToggleButtonGroup
} from '@mui/material'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine
} from 'recharts'
import { useGetCarbonaraAnalysisQuery } from 'slices/jobsApiSlice'
import InitialFitChart from './InitialFitChart'
import CarbonaraPredictionsTable from './CarbonaraPredictionsTable'
import CarbonaraHistogramsPanel from './CarbonaraHistogramsPanel'
import CarbonaraDownloadPanel from './CarbonaraDownloadPanel'
import type { CarbonaraConvergenceRun } from 'slices/jobsApiSlice'

// Palette for up to 10 convergence runs
const RUN_COLORS = [
  '#8884d8',
  '#82ca9d',
  '#ff7300',
  '#d0748b',
  '#2ec4b6',
  '#e9c46a',
  '#264653',
  '#e76f51',
  '#a8dadc',
  '#457b9d'
]

interface ConvergencePoint {
  key: number
  [run: string]: number
}

const buildConvergenceData = (
  runs: CarbonaraConvergenceRun[],
  xKey: 'step' | 'elapsed_min'
): ConvergencePoint[] => {
  // Merge all runs into a single array keyed by the x-axis value.
  // Each run contributes its own chi2 series.
  const allKeys = new Set<number>()
  runs.forEach((r) => {
    r.points.forEach((p) => allKeys.add(xKey === 'step' ? p.step : p.elapsed_min))
  })
  const sorted = Array.from(allKeys).sort((a, b) => a - b)

  return sorted.map((xVal) => {
    const row: ConvergencePoint = { key: xVal }
    runs.forEach((r) => {
      const pt = r.points.find(
        (p) => (xKey === 'step' ? p.step : p.elapsed_min) === xVal
      )
      if (pt !== undefined) {
        row[`run${r.run}_log${r.log}`] = pt.chi2
      }
    })
    return row
  })
}

interface CarbonaraResultsProps {
  jobId: string
}

const CarbonaraResults = ({ jobId }: CarbonaraResultsProps) => {
  const [xAxis, setXAxis] = useState<'step' | 'elapsed_min'>('step')

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
  const bestChi2 = analysis.best?.chi2 ?? null
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

  // --- Convergence ---
  const convergenceData = buildConvergenceData(analysis.convergence, xAxis)
  // Legend labels: each fitLog{N}.dat is one fit replica, so show "Fit N",
  // adding the run prefix only when more than one Carbonara run is present.
  const multipleRuns = new Set(analysis.convergence.map((r) => r.run)).size > 1
  const runSeries = analysis.convergence.map((r) => {
    const fitNum = /(\d+)/.exec(String(r.log))?.[1] ?? String(r.log)
    return {
      key: `run${r.run}_log${r.log}`,
      name: multipleRuns ? `Run ${r.run} · Fit ${fitNum}` : `Fit ${fitNum}`
    }
  })

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
              Best χ²
            </Typography>
            <Typography variant="body1">
              {bestChi2 !== null ? bestChi2.toFixed(4) : '—'}
            </Typography>
          </Box>
          <Box>
            <Typography
              variant="caption"
              color="text.secondary"
            >
              χ² threshold
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
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 1
          }}
        >
          <Typography variant="h6">Convergence</Typography>
          <ToggleButtonGroup
            value={xAxis}
            exclusive
            onChange={(_e, val) => {
              if (val !== null) setXAxis(val)
            }}
            size="small"
          >
            <ToggleButton value="step">Step</ToggleButton>
            <ToggleButton value="elapsed_min">Time (min)</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <ResponsiveContainer
          width="100%"
          height={260}
        >
          <LineChart
            data={convergenceData}
            margin={{ top: 5, right: 20, bottom: 32, left: 20 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="key"
              type="number"
              label={{
                value: xAxis === 'step' ? 'Step' : 'Elapsed (min)',
                position: 'insideBottom',
                offset: -16
              }}
            />
            <YAxis
              label={{
                value: 'χ²',
                angle: -90,
                position: 'insideLeft'
              }}
            />
            <Tooltip />
            <Legend
              iconType="line"
              verticalAlign="bottom"
              height={22}
              wrapperStyle={{ bottom: 0 }}
            />
            <ReferenceLine
              y={1}
              stroke="#aaa"
              strokeDasharray="4 2"
            />
            {runSeries.map(({ key, name }, i) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                name={name}
                stroke={RUN_COLORS[i % RUN_COLORS.length]}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
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
            {analysis.best?.id ?? ''}, χ² ={' '}
            {bestChi2 !== null ? bestChi2.toFixed(4) : '—'})
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
