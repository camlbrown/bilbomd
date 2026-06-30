import {
  Box,
  Paper,
  Typography,
  Chip,
  Alert,
  CircularProgress,
  Divider,
  Table,
  TableBody,
  TableRow,
  TableCell
} from '@mui/material'
import Grid from '@mui/material/Grid'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts'
import { useGetAutoMDSAXSAnalysisQuery } from 'slices/jobsApiSlice'
import type { AutoMDSAXSPerFrame } from 'slices/jobsApiSlice'

interface AutoMDSAXSResultsProps {
  jobId: string
}

const fmtNumber = (value: unknown, digits = 3): string => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

// Human-friendly labels for the manifest parameter keys we surface.
const PARAM_LABELS: { key: string; label: string }[] = [
  { key: 'system', label: 'System' },
  { key: 'forceField', label: 'Force field' },
  { key: 'waterModel', label: 'Water model' },
  { key: 'simulationTimeNs', label: 'Simulation length (ns)' },
  { key: 'productionSteps', label: 'Production steps' },
  { key: 'nRepeats', label: 'Repeats' },
  { key: 'temperatureK', label: 'Temperature (K)' },
  { key: 'ionicConcentrationM', label: 'Ionic concentration (M)' },
  { key: 'pH', label: 'pH' },
  { key: 'disulfide', label: 'Disulfides' },
  { key: 'boxPaddingNm', label: 'Box padding (nm)' }
]

const MetricCard = ({ label, value }: { label: string; value: string }) => (
  <Paper
    variant="outlined"
    sx={{ p: 2, textAlign: 'center', minWidth: 140 }}
  >
    <Typography
      variant="h5"
      sx={{ fontWeight: 600 }}
    >
      {value}
    </Typography>
    <Typography
      variant="caption"
      color="text.secondary"
    >
      {label}
    </Typography>
  </Paper>
)

const AutoMDSAXSResults = ({ jobId }: AutoMDSAXSResultsProps) => {
  const { data, isLoading, isError } = useGetAutoMDSAXSAnalysisQuery(jobId)

  if (isLoading) {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }

  if (isError || !data) {
    return (
      <Alert
        severity="info"
        sx={{ my: 2 }}
      >
        AutoMD-SAXS analysis is not available yet.
      </Alert>
    )
  }

  if (data.status === 'pending') {
    return (
      <Alert
        severity="info"
        sx={{ my: 2 }}
      >
        AutoMD-SAXS analysis is still being prepared. This page will update when
        results are ready.
      </Alert>
    )
  }

  const metrics = data.metrics ?? {}
  const params = data.parameters ?? {}
  const outputs = data.outputs ?? {}
  const usesSaxs = Boolean(data.inputs?.saxs)
  const perFrame: AutoMDSAXSPerFrame[] = Array.isArray(params.perFrame)
    ? params.perFrame
    : []
  // Top fits = lowest chi^2 frames (chi^2 may be null for unparsed frames).
  const topFits = perFrame
    .filter((f) => typeof f.chi2 === 'number')
    .sort((a, b) => (a.chi2 as number) - (b.chi2 as number))
    .slice(0, 5)

  return (
    <Paper sx={{ p: 2, my: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="h6">AutoMD-SAXS Results</Typography>
        <Chip
          size="small"
          label={data.status}
          color={data.status === 'completed' ? 'success' : 'default'}
        />
      </Box>

      {/* Headline metrics */}
      {usesSaxs ? (
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', my: 2 }}>
          <MetricCard
            label="Best χ²"
            value={fmtNumber(metrics.bestChi2)}
          />
          <MetricCard
            label="Best frame"
            value={
              typeof metrics.bestFrame === 'number'
                ? String(metrics.bestFrame)
                : '—'
            }
          />
          <MetricCard
            label="Mean Rg (Å)"
            value={fmtNumber(metrics.rgMean, 2)}
          />
        </Box>
      ) : (
        <Alert
          severity="info"
          sx={{ my: 2 }}
        >
          No experimental SAXS data was provided, so χ² fitting was skipped. The
          MD trajectories and structural clustering are still available below.
        </Alert>
      )}

      {/* Per-frame chi^2 / Rg across the combined trajectory */}
      {usesSaxs && perFrame.length > 0 && (
        <Box sx={{ my: 2 }}>
          <Typography
            variant="subtitle2"
            sx={{ mb: 1 }}
          >
            Per-frame fit (χ² and Rg across all production frames)
          </Typography>
          <ResponsiveContainer
            width="100%"
            height={260}
          >
            <LineChart data={perFrame} margin={{ top: 5, right: 30, left: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="frame"
                label={{ value: 'frame', position: 'insideBottom', offset: -2 }}
              />
              <YAxis
                yAxisId="chi2"
                label={{ value: 'χ²', angle: -90, position: 'insideLeft' }}
              />
              <YAxis
                yAxisId="rg"
                orientation="right"
                label={{ value: 'Rg (Å)', angle: 90, position: 'insideRight' }}
              />
              <Tooltip />
              <Legend />
              <Line
                yAxisId="chi2"
                type="monotone"
                dataKey="chi2"
                name="χ²"
                stroke="#d2691e"
                dot={false}
              />
              <Line
                yAxisId="rg"
                type="monotone"
                dataKey="rg"
                name="Rg (Å)"
                stroke="#1f77b4"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>

          {/* Top fits by chi^2 */}
          <Typography
            variant="subtitle2"
            sx={{ mt: 2, mb: 1 }}
          >
            Best-fitting frames
          </Typography>
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary' }}>Frame</TableCell>
                <TableCell sx={{ color: 'text.secondary' }}>χ²</TableCell>
                <TableCell sx={{ color: 'text.secondary' }}>Rg (Å)</TableCell>
              </TableRow>
              {topFits.map((f) => (
                <TableRow key={f.frame}>
                  <TableCell>{f.frame}</TableCell>
                  <TableCell>{fmtNumber(f.chi2)}</TableCell>
                  <TableCell>{fmtNumber(f.rg, 2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}

      <Divider sx={{ my: 2 }} />

      <Grid
        container
        spacing={2}
      >
        {/* Parameters */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Typography
            variant="subtitle2"
            sx={{ mb: 1 }}
          >
            Effective parameters
          </Typography>
          <Table size="small">
            <TableBody>
              {PARAM_LABELS.filter(({ key }) => key in params).map(
                ({ key, label }) => (
                  <TableRow key={key}>
                    <TableCell sx={{ color: 'text.secondary' }}>
                      {label}
                    </TableCell>
                    <TableCell>{String(params[key])}</TableCell>
                  </TableRow>
                )
              )}
            </TableBody>
          </Table>
        </Grid>

        {/* Outputs */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Typography
            variant="subtitle2"
            sx={{ mb: 1 }}
          >
            Outputs
          </Typography>
          <Table size="small">
            <TableBody>
              {Object.entries(outputs).map(([category, files]) => (
                <TableRow key={category}>
                  <TableCell sx={{ color: 'text.secondary' }}>
                    {category}
                  </TableCell>
                  <TableCell>{(files as string[]).length}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1 }}
          >
            Use the Download Results button to retrieve all output files.
          </Typography>
        </Grid>
      </Grid>

      {data.notes && data.notes.length > 0 && (
        <Alert
          severity="warning"
          sx={{ mt: 2 }}
        >
          {data.notes.join('; ')}
        </Alert>
      )}
    </Paper>
  )
}

export default AutoMDSAXSResults
