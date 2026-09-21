import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Label
} from 'recharts'

// Guinier plot (ln I(q) vs q²) over the SELECTED region only, with the linear fit
// overlaid, plus the classic residuals panel below it. Only the points inside the
// Guinier window are drawn — the user adjusts the window and watches the residuals
// flatten, exactly like a manual Guinier fit in the Carbonara notebooks.

export interface GuinierChartProps {
  // Points inside the Guinier window, in Guinier coordinates.
  points: { q2: number; lnI: number }[]
  // Fit line (ln I = intercept + slope·q²) drawn across the window.
  slope: number
  intercept: number
  // Residuals (Δ/σ, or raw ln-residual) across the window.
  residuals: { q2: number; z: number }[]
  residualsWeighted: boolean
}

const topMargin = { top: 8, right: 24, bottom: 24, left: 16 }
const resMargin = { top: 4, right: 24, bottom: 40, left: 16 }
const expFmt = (v: number) => v.toExponential(1)

const GuinierChart = ({
  points,
  slope,
  intercept,
  residuals,
  residualsWeighted
}: GuinierChartProps) => {
  const yAt = (x: number): number => intercept + slope * x
  const xs = points.map((p) => p.q2)
  const xMin = xs.length ? Math.min(...xs) : 0
  const xMax = xs.length ? Math.max(...xs) : 1
  return (
    <>
      <ResponsiveContainer
        width="100%"
        height={260}
      >
        <ScatterChart margin={topMargin}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="q2"
            type="number"
            scale="linear"
            domain={['dataMin', 'dataMax']}
            tickFormatter={expFmt}
          >
            <Label
              value="q² (Å⁻²)"
              position="insideBottom"
              offset={-4}
            />
          </XAxis>
          <YAxis
            dataKey="lnI"
            type="number"
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => v.toFixed(1)}
          >
            <Label
              value="ln I(q)"
              angle={-90}
              position="insideLeft"
            />
          </YAxis>
          <Tooltip
            formatter={(v) => (typeof v === 'number' ? v.toPrecision(4) : v)}
          />
          <Scatter
            name="ln I vs q²"
            data={points}
            fill="#8884d8"
            line={false}
            shape="circle"
            isAnimationActive={false}
          />
          <ReferenceLine
            stroke="#d32f2f"
            strokeWidth={2}
            ifOverflow="extendDomain"
            segment={[
              { x: xMin, y: yAt(xMin) },
              { x: xMax, y: yAt(xMax) }
            ]}
          />
        </ScatterChart>
      </ResponsiveContainer>

      <ResponsiveContainer
        width="100%"
        height={170}
      >
        <ScatterChart margin={resMargin}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="q2"
            type="number"
            scale="linear"
            domain={['dataMin', 'dataMax']}
            tickFormatter={expFmt}
          >
            <Label
              value="q² (Å⁻²)"
              position="insideBottom"
              offset={-20}
            />
          </XAxis>
          <YAxis
            dataKey="z"
            type="number"
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => v.toFixed(1)}
          >
            <Label
              value={residualsWeighted ? 'Δ / σ' : 'Δ ln I'}
              angle={-90}
              position="insideLeft"
            />
          </YAxis>
          <Tooltip
            formatter={(v) => (typeof v === 'number' ? v.toPrecision(3) : v)}
          />
          <ReferenceLine
            y={0}
            stroke="#000"
          />
          <Scatter
            name="residual"
            data={residuals}
            fill="#2e7d32"
            line={false}
            shape="circle"
            isAnimationActive={false}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </>
  )
}

export default GuinierChart
