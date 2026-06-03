import { useState, useMemo } from 'react'
import {
  Box,
  Paper,
  Typography,
  Slider,
  ToggleButton,
  ToggleButtonGroup
} from '@mui/material'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine
} from 'recharts'
import type {
  CarbonaraHistograms,
  CarbonaraAnalysisPrediction
} from 'slices/jobsApiSlice'

type MetricKey = 'rmsd' | 'tm'

// Build a simple frequency histogram from an array of values.
// Returns { bin, count } where bin is the lower edge of each interval.
const buildHistogram = (
  values: number[],
  nBins = 20
): { bin: number; count: number }[] => {
  if (values.length === 0) return []
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  if (lo === hi) return [{ bin: lo, count: values.length }]
  const step = (hi - lo) / nBins
  const counts = new Array<number>(nBins).fill(0)
  values.forEach((v) => {
    const idx = Math.min(Math.floor((v - lo) / step), nBins - 1)
    counts[idx]! += 1
  })
  return counts.map((count, i) => ({
    bin: Number((lo + i * step).toFixed(4)),
    count
  }))
}

// Overlay two histogram datasets into a single array for Recharts.
const buildOverlaid = (
  a: number[],
  b: number[],
  nBins = 20
): { bin: number; pairwise: number; vs_original: number }[] => {
  const all = [...a, ...b]
  if (all.length === 0) return []
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  if (lo === hi)
    return [{ bin: lo, pairwise: a.length, vs_original: b.length }]
  const step = (hi - lo) / nBins
  const pairwiseCounts = new Array<number>(nBins).fill(0)
  const vsOrigCounts = new Array<number>(nBins).fill(0)
  a.forEach((v) => {
    const idx = Math.min(Math.floor((v - lo) / step), nBins - 1)
    pairwiseCounts[idx]! += 1
  })
  b.forEach((v) => {
    const idx = Math.min(Math.floor((v - lo) / step), nBins - 1)
    vsOrigCounts[idx]! += 1
  })
  return pairwiseCounts.map((pw, i) => ({
    bin: Number((lo + i * step).toFixed(4)),
    pairwise: pw,
    vs_original: vsOrigCounts[i]!
  }))
}

interface CarbonaraHistogramsPanelProps {
  histograms: CarbonaraHistograms
  predictions: CarbonaraAnalysisPrediction[]
  chi2Threshold: number
}

const CarbonaraHistogramsPanel = ({
  histograms,
  predictions,
  chi2Threshold
}: CarbonaraHistogramsPanelProps) => {
  const [metric, setMetric] = useState<MetricKey>('rmsd')
  const [chi2Filter, setChi2Filter] = useState<number>(chi2Threshold)

  // The slider max is derived from the worst chi2 in predictions
  const maxChi2 = useMemo(
    () =>
      predictions.length > 0
        ? Math.ceil(Math.max(...predictions.map((p) => p.chi2)) * 10) / 10
        : chi2Threshold * 2,
    [predictions, chi2Threshold]
  )

  const filtered = useMemo(
    () => predictions.filter((p) => p.chi2 <= chi2Filter),
    [predictions, chi2Filter]
  )

  // Structural metric histograms (from pre-computed analysis.json values)
  const metricData = histograms[metric]
  const overlaidData = buildOverlaid(
    metricData.pairwise,
    metricData.vs_original
  )

  // Rg histogram for filtered predictions
  const filteredRg = filtered.map((p) => p.rg)
  const rgData = buildHistogram(filteredRg)
  const rgOriginal = histograms.rg.original

  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, mb: 2 }}
    >
      <Typography
        variant="h6"
        gutterBottom
      >
        Distributions
      </Typography>

      {/* χ² filter slider */}
      <Box sx={{ mb: 3 }}>
        <Typography
          variant="subtitle2"
          gutterBottom
        >
          Filter predictions by χ² ≤ {chi2Filter.toFixed(2)} (
          {filtered.length} / {predictions.length} shown)
        </Typography>
        <Slider
          value={chi2Filter}
          min={0.5}
          max={maxChi2}
          step={0.1}
          marks={[
            { value: 1, label: '1' },
            { value: chi2Threshold, label: `${chi2Threshold} (threshold)` }
          ]}
          valueLabelDisplay="auto"
          onChange={(_e, val) => setChi2Filter(Array.isArray(val) ? val[0]! : val)}
          sx={{ maxWidth: 480 }}
        />
      </Box>

      {/* Metric selector */}
      <Box sx={{ mb: 2 }}>
        <ToggleButtonGroup
          value={metric}
          exclusive
          onChange={(_e, val) => {
            if (val !== null) setMetric(val)
          }}
          size="small"
        >
          <ToggleButton value="rmsd">RMSD (Å)</ToggleButton>
          <ToggleButton value="tm">TM-score</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Structural metric overlaid histogram */}
      <Typography
        variant="subtitle2"
        sx={{ mb: 0.5 }}
      >
        {metric === 'rmsd' ? 'RMSD (Å)' : 'TM-score'} — pairwise vs vs-original
      </Typography>
      <ResponsiveContainer
        width="100%"
        height={220}
      >
        <BarChart
          data={overlaidData}
          margin={{ top: 5, right: 20, bottom: 32, left: 20 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="bin"
            type="number"
            tickFormatter={(v: number) => v.toFixed(2)}
            label={{
              value: metric === 'rmsd' ? 'RMSD (Å)' : 'TM-score',
              position: 'insideBottom',
              offset: -16
            }}
          />
          <YAxis
            label={{ value: 'Count', angle: -90, position: 'insideLeft' }}
          />
          <Tooltip />
          <Legend
            verticalAlign="bottom"
            height={22}
            wrapperStyle={{ bottom: 0 }}
          />
          <Bar
            dataKey="pairwise"
            name="Pairwise"
            fill="#8884d8"
            opacity={0.7}
          />
          <Bar
            dataKey="vs_original"
            name="vs Original"
            fill="#82ca9d"
            opacity={0.7}
          />
        </BarChart>
      </ResponsiveContainer>

      {/* Rg histogram */}
      <Typography
        variant="subtitle2"
        sx={{ mt: 2, mb: 0.5 }}
      >
        Radius of gyration (Å) — filtered predictions
      </Typography>
      <ResponsiveContainer
        width="100%"
        height={200}
      >
        <BarChart
          data={rgData}
          margin={{ top: 5, right: 20, bottom: 32, left: 20 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="bin"
            type="number"
            tickFormatter={(v: number) => v.toFixed(1)}
            label={{
              value: 'Rg (Å)',
              position: 'insideBottom',
              offset: -16
            }}
          />
          <YAxis
            label={{ value: 'Count', angle: -90, position: 'insideLeft' }}
          />
          <Tooltip />
          <Legend
            verticalAlign="bottom"
            height={22}
            wrapperStyle={{ bottom: 0 }}
          />
          <ReferenceLine
            x={rgOriginal}
            stroke="#e76f51"
            strokeDasharray="4 2"
            label={{
              value: `Original ${rgOriginal.toFixed(1)}`,
              position: 'top',
              fontSize: 11
            }}
          />
          <Bar
            dataKey="count"
            name="Rg predictions"
            fill="#2ec4b6"
            opacity={0.8}
          />
        </BarChart>
      </ResponsiveContainer>
    </Paper>
  )
}

export default CarbonaraHistogramsPanel
