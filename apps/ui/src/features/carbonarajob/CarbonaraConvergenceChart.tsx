import { useState } from 'react'
import { Box, Typography, ToggleButton, ToggleButtonGroup } from '@mui/material'
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

interface CarbonaraConvergenceChartProps {
  convergence: CarbonaraConvergenceRun[]
  height?: number
}

// Shared chi²-vs-step (or vs-time) convergence chart, used both on the final
// results page and in the live fitting-progress panel while a job is running.
const CarbonaraConvergenceChart = ({
  convergence,
  height = 260
}: CarbonaraConvergenceChartProps) => {
  const [xAxis, setXAxis] = useState<'step' | 'elapsed_min'>('step')

  const convergenceData = buildConvergenceData(convergence, xAxis)
  // Legend labels: each fitLog{N}.dat is one fit replica, so show "Fit N",
  // adding the run prefix only when more than one Carbonara run is present.
  const multipleRuns = new Set(convergence.map((r) => r.run)).size > 1
  const runSeries = convergence.map((r) => {
    const fitNum = /(\d+)/.exec(String(r.log))?.[1] ?? String(r.log)
    return {
      key: `run${r.run}_log${r.log}`,
      name: multipleRuns ? `Run ${r.run} · Fit ${fitNum}` : `Fit ${fitNum}`
    }
  })

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          mb: 1
        }}
      >
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
      {convergenceData.length === 0 ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ py: 4, textAlign: 'center' }}
        >
          No fitting data yet.
        </Typography>
      ) : (
        <ResponsiveContainer
          width="100%"
          height={height}
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
                value: 'Carbonara χ²',
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
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </Box>
  )
}

export default CarbonaraConvergenceChart
