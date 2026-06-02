import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ErrorBar
} from 'recharts'

// Dedicated chart for the Carbonara "initial scattering check" panel.
// Kept separate from the shared scoperjob/FoXSChart (used by Scoper and the
// generic FoXS analysis) so its presentation can differ without affecting them:
// no plot titles, no chi2/c1/c2 chart labels, error-weighted residuals, no
// residuals legend, and labelled axes on both plots.

interface IqPoint {
  q: number
  exp_intensity: number
  model_intensity: number
  error: number
}

interface ResidualPoint {
  q: number
  res: number
}

// Explicit, valid log-scale Y domain computed from the POSITIVE intensities
// only. SAXS I(q) and its error bars dip to/below zero at high q (noise); on a
// log axis a single non-positive value breaks the whole domain so nothing — not
// even the axis ticks — renders. We clamp to decade bounds and clip overflow,
// so the curve still draws and the negative high-q tail just drops out.
const logYDomain = (data: IqPoint[]): [number, number] => {
  const pos = data
    .flatMap((d) => [d.exp_intensity, d.model_intensity])
    .filter((v) => Number.isFinite(v) && v > 0)
  if (pos.length === 0) return [0.001, 1]
  const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...pos))))
  const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...pos))))
  return [lo, hi <= lo ? lo * 10 : hi]
}

// Tick labels for the log axis (e.g. 0.01, 0.1, 1, 10) without float noise.
const fmtLog = (v: number): string =>
  v >= 1 ? String(Math.round(v)) : Number(v.toPrecision(1)).toString()

// The I(q) plot carries a bottom legend, so it needs extra bottom room to keep
// the legend clear of the q-axis label. The residuals plot has no legend.
const iqMargin = { top: 5, right: 20, bottom: 56, left: 20 }
const resMargin = { top: 5, right: 20, bottom: 28, left: 20 }

const InitialFitChart = ({
  data,
  residualsData
}: {
  data: IqPoint[]
  residualsData: ResidualPoint[]
}) => {
  const [yLo, yHi] = logYDomain(data)
  return (
  <>
    <ResponsiveContainer
      width="100%"
      height={300}
    >
      <LineChart
        data={data}
        margin={iqMargin}
      >
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="q"
          scale="linear"
          type="number"
          label={{ value: 'q (Å⁻¹)', position: 'insideBottom', offset: -18 }}
        />
        <YAxis
          scale="log"
          type="number"
          domain={[yLo, yHi]}
          allowDataOverflow
          tickFormatter={fmtLog}
          label={{ value: 'I(q)', angle: -90, position: 'insideLeft' }}
        />
        <Tooltip />
        <Legend
          iconType="line"
          verticalAlign="bottom"
          height={22}
          wrapperStyle={{ bottom: 0 }}
        />
        <Line
          type="monotone"
          dataKey="exp_intensity"
          name="Experimental intensity"
          stroke="#8884d8"
          dot={false}
          activeDot={{ r: 6 }}
        >
          <ErrorBar
            dataKey="error"
            direction="y"
            stroke="#8884d8"
            strokeOpacity={0.4}
            strokeWidth={1}
          />
        </Line>
        <Line
          type="monotone"
          dataKey="model_intensity"
          name="Model intensity"
          stroke="#82ca9d"
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
    <ResponsiveContainer
      width="100%"
      height={180}
    >
      <LineChart
        data={residualsData}
        margin={resMargin}
      >
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="q"
          scale="linear"
          type="number"
          label={{ value: 'q (Å⁻¹)', position: 'insideBottom', offset: -12 }}
        />
        <YAxis
          domain={['auto', 'auto']}
          label={{ value: 'Δ / σ', angle: -90, position: 'insideLeft' }}
        />
        <Tooltip />
        <ReferenceLine
          y={0}
          stroke="black"
        />
        <Line
          type="monotone"
          dataKey="res"
          name="residual"
          stroke="#82ca9d"
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  </>
  )
}

export default InitialFitChart
