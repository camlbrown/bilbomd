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

const logDomain = (dataMin: number): number => {
  if (!Number.isFinite(dataMin) || dataMin <= 0) return 0.001
  return Math.pow(10, Math.floor(Math.log10(dataMin)))
}

const chartMargin = { top: 5, right: 20, bottom: 28, left: 12 }

const InitialFitChart = ({
  data,
  residualsData
}: {
  data: IqPoint[]
  residualsData: ResidualPoint[]
}) => (
  <>
    <ResponsiveContainer
      width="100%"
      height={300}
    >
      <LineChart
        data={data}
        margin={chartMargin}
      >
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="q"
          scale="linear"
          type="number"
          label={{ value: 'q (Å⁻¹)', position: 'insideBottom', offset: -12 }}
        />
        <YAxis
          scale="log"
          type="number"
          domain={[logDomain, 'auto']}
          label={{ value: 'I(q)', angle: -90, position: 'insideLeft' }}
        />
        <Tooltip />
        <Legend
          iconType="line"
          verticalAlign="bottom"
          height={30}
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
        margin={chartMargin}
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
          label={{
            value: '(Iexp − Imodel) / σ',
            angle: -90,
            position: 'insideLeft'
          }}
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

export default InitialFitChart
