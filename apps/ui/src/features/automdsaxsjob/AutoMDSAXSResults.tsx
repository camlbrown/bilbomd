import { useState } from 'react'
import {
  Box,
  Paper,
  Typography,
  Chip,
  Alert,
  CircularProgress,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableRow,
  TableCell,
  ToggleButton,
  ToggleButtonGroup
} from '@mui/material'
import Grid from '@mui/material/Grid'
import {
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts'
import { useGetAutoMDSAXSAnalysisQuery } from 'slices/jobsApiSlice'
import AutoMDSAXSTrajectoryViewer from './AutoMDSAXSTrajectoryViewer'
import InitialFitChart from '../carbonarajob/InitialFitChart'
import type {
  AutoMDSAXSPerFrame,
  AutoMDSAXSTimePoint,
  AutoMDSAXSPcaPoint,
  AutoMDSAXSClustering,
  AutoMDSAXSMultiFoxs
} from 'slices/jobsApiSlice'

interface AutoMDSAXSResultsProps {
  jobId: string
}

const REPEAT_COLORS = ['#1f77b4', '#d2691e', '#2ca02c', '#9467bd', '#8c564b']

// Categorical palette for cluster colouring (distinct, colour-blind friendly).
const CLUSTER_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
]
const clusterColor = (c: number | null): string =>
  c == null || c < 0 ? '#bbbbbb' : CLUSTER_COLORS[c % CLUSTER_COLORS.length]!

// Viridis anchor colours (reversed: low χ² = yellow/good fit, high = purple),
// mirroring the original AutoMD-SAXS `cmap='viridis_r'` PCA colouring.
const VIRIDIS_R = ['#fde725', '#5ec962', '#21918c', '#3b528b', '#440154']
const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)
const hexToRgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16)
]
const viridisR = (t: number): string => {
  const clamped = Math.max(0, Math.min(1, t))
  const seg = clamped * (VIRIDIS_R.length - 1)
  const i = Math.min(VIRIDIS_R.length - 2, Math.floor(seg))
  const f = seg - i
  const [r1, g1, b1] = hexToRgb(VIRIDIS_R[i]!)
  const [r2, g2, b2] = hexToRgb(VIRIDIS_R[i + 1]!)
  return `rgb(${lerp(r1, r2, f)},${lerp(g1, g2, f)},${lerp(b1, b2, f)})`
}

const fmtNumber = (value: unknown, digits = 3): string => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

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
  { key: 'boxPaddingNm', label: 'Box padding (nm)' },
  { key: 'timestepFs', label: 'Timestep (fs)' },
  { key: 'hmr', label: 'Fast mode (HMR)' },
  { key: 'frameIntervalNs', label: 'Frame interval (ns)' }
]

// HMR ('hmr' param, else inferred from a 4 fs timestep) as a Yes/No string.
const hmrUsed = (params: Record<string, unknown>): boolean =>
  params.hmr === true || params.timestepFs === 4 || params.timestepFs === 4.0

// Render a parameter value: booleans as Yes/No, HMR annotated with the timestep.
const fmtParamValue = (key: string, value: unknown): string => {
  if (key === 'hmr') return value === true ? 'Yes (4 fs)' : 'No (2 fs)'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

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

// Pivot a per-frame array into rows keyed by x (frameInRep or timeNs) with one
// <metric>_<repeat> column per repeat, so repeats overlay on the same plot.
const pivotByRepeat = <T extends Record<string, unknown>>(
  rows: T[],
  xKey: string,
  metrics: string[]
): Record<string, number | null>[] => {
  const byX: Record<string, Record<string, number | null>> = {}
  rows.forEach((r) => {
    const x = r[xKey] as number | null | undefined
    if (x == null) return
    const rep = r.repeat as number | null | undefined
    const key = String(x)
    const row = byX[key] ?? { x }
    metrics.forEach((m) => {
      row[`${m}_${rep}`] = (r[m] as number | null) ?? null
    })
    byX[key] = row
  })
  return Object.values(byX).sort((a, b) => (a.x as number) - (b.x as number))
}

const AutoMDSAXSResults = ({ jobId }: AutoMDSAXSResultsProps) => {
  const { data, isLoading, isError } = useGetAutoMDSAXSAnalysisQuery(jobId)
  const [tab, setTab] = useState(0)
  const [xAxis, setXAxis] = useState<'frame' | 'time'>('frame')
  const [shownRepeats, setShownRepeats] = useState<number[] | null>(null)
  const [selectedPdc, setSelectedPdc] = useState<number | null>(null)
  const [selectedEnsSize, setSelectedEnsSize] = useState<number | null>(null)

  if (isLoading) {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }
  if (isError || !data || data.status === 'pending') {
    return (
      <Alert severity="info" sx={{ my: 2 }}>
        AutoMD-SAXS analysis is not available yet.
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
  const timeSeries: AutoMDSAXSTimePoint[] = Array.isArray(params.timeSeries)
    ? params.timeSeries
    : []
  const pca: AutoMDSAXSPcaPoint[] = Array.isArray(params.pca) ? params.pca : []
  const clusterings: AutoMDSAXSClustering[] = Array.isArray(params.clusterings)
    ? params.clusterings
    : []
  const multifoxs: AutoMDSAXSMultiFoxs | undefined = params.multifoxs
  // frame -> repeat lookup for labelling ensemble members.
  const repeatOfFrame = new Map<number, number | null | undefined>(
    perFrame.map((f) => [f.frame, f.repeat])
  )

  const repeats = Array.from(
    new Set(
      [...perFrame, ...timeSeries]
        .map((f) => f.repeat)
        .filter((r): r is number => typeof r === 'number')
    )
  ).sort((a, b) => a - b)
  const activeRepeats = shownRepeats ?? repeats
  const xKey = xAxis === 'time' ? 'timeNs' : 'frameInRep'
  const xLabel = xAxis === 'time' ? 'time (ns)' : 'frame'

  const toggleRepeat = (r: number) => {
    const cur = shownRepeats ?? repeats
    const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r].sort()
    setShownRepeats(next)
  }

  // ---- FoXS tab chart data (chi2 + Rg vs x, per repeat) ----
  const foxsData = pivotByRepeat(
    perFrame as unknown as Record<string, unknown>[],
    xKey,
    ['chi2', 'rg']
  )
  const topFits = perFrame
    .filter((f) => typeof f.chi2 === 'number')
    .sort((a, b) => (a.chi2 as number) - (b.chi2 as number))
    .slice(0, 5)

  // ---- Structural tab: time-series pivots (x = time ns) ----
  const tsData = pivotByRepeat(
    timeSeries as unknown as Record<string, unknown>[],
    'timeNs',
    ['rg', 'rmsd', 'sasa', 'hbonds', 'energy', 'ligandRmsd', 'ligandContacts']
  )
  const hasHbonds = timeSeries.some((t) => typeof t.hbonds === 'number')
  const hasEnergy = timeSeries.some((t) => typeof t.energy === 'number')
  const hasLigandRmsd = timeSeries.some((t) => typeof t.ligandRmsd === 'number')
  const hasLigandContacts = timeSeries.some(
    (t) => typeof t.ligandContacts === 'number'
  )
  // chi2 colour scale for the PCA scatter
  const chi2vals = pca.map((p) => p.chi2).filter((c): c is number => c != null)
  const chi2min = chi2vals.length ? Math.min(...chi2vals) : 0
  const chi2max = chi2vals.length ? Math.max(...chi2vals) : 1
  const chi2color = (c: number | null) => {
    if (c == null || chi2max === chi2min) return '#888'
    const t = (c - chi2min) / (chi2max - chi2min) // 0 best .. 1 worst
    return viridisR(t)
  }
  // CLoNe pdc sweep: colour the cluster plot by the selected pdc's labels.
  const pdcOptions = clusterings.map((c) => c.pdc).sort((a, b) => a - b)
  const defaultPdc =
    typeof params.defaultPdc === 'number' ? params.defaultPdc : pdcOptions[0]
  const activePdc = selectedPdc ?? defaultPdc ?? null
  const activeClustering = clusterings.find((c) => c.pdc === activePdc)
  // cluster label for pca row i under the active pdc (falls back to pca.cluster).
  const clusterAt = (i: number): number | null => {
    if (activeClustering && i < activeClustering.labels.length)
      return activeClustering.labels[i]!
    return pca[i]?.cluster ?? null
  }
  // pca points tagged with the active-pdc cluster id, for filtering/legend.
  const pcaTagged = pca.map((p, i) => ({ ...p, cl: clusterAt(i) }))
  const clusterIds = Array.from(
    new Set(pcaTagged.map((p) => p.cl).filter((c): c is number => c != null && c >= 0))
  ).sort((a, b) => a - b)
  const activeNClusters = activeClustering?.nClusters ?? clusterIds.length

  // ---- MultiFoXS ensemble (FoXS tab) ----
  const ensembles = multifoxs?.ensembles ?? []
  const activeEnsSize =
    selectedEnsSize ?? multifoxs?.best?.size ?? ensembles[0]?.size ?? null
  const activeEnsemble =
    ensembles.find((e) => e.size === activeEnsSize) ?? ensembles[0]
  const ensembleIqData = (activeEnsemble?.curve ?? []).map((p) => ({
    q: p.q,
    exp_intensity: p.exp,
    model_intensity: p.model,
    error: p.error
  }))
  const ensembleResiduals = (activeEnsemble?.curve ?? []).map((p) => ({
    q: p.q,
    res: p.error > 0 ? (p.exp - p.model) / p.error : 0
  }))

  const RepeatToggles = () =>
    repeats.length > 1 ? (
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="caption" color="text.secondary">
          Repeats:
        </Typography>
        {repeats.map((r) => (
          <Chip
            key={r}
            label={`Rep ${r}`}
            size="small"
            variant={activeRepeats.includes(r) ? 'filled' : 'outlined'}
            onClick={() => toggleRepeat(r)}
            sx={{
              backgroundColor: activeRepeats.includes(r)
                ? REPEAT_COLORS[(r - 1) % REPEAT_COLORS.length]
                : undefined,
              color: activeRepeats.includes(r) ? '#fff' : undefined
            }}
          />
        ))}
      </Box>
    ) : null

  const XAxisToggle = () => (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={xAxis}
      onChange={(_, v) => v && setXAxis(v)}
    >
      <ToggleButton value="frame">Frame</ToggleButton>
      <ToggleButton value="time">Time (ns)</ToggleButton>
    </ToggleButtonGroup>
  )

  const TimeSeriesChart = ({
    metric,
    label
  }: {
    metric: string
    label: string
  }) => (
    <Box sx={{ my: 1 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {label}
      </Typography>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={tsData} margin={{ top: 5, right: 20, left: 5, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="x"
            label={{ value: 'time (ns)', position: 'insideBottom', offset: -2 }}
          />
          <YAxis />
          <Tooltip />
          <Legend />
          {activeRepeats.map((r) => (
            <Line
              key={r}
              type="monotone"
              dataKey={`${metric}_${r}`}
              name={`Rep ${r}`}
              stroke={REPEAT_COLORS[(r - 1) % REPEAT_COLORS.length]}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Box>
  )

  // Vertical χ² gradient legend (recharts has no built-in colorbar). Top = best
  // fit (low χ²), matching the viridis_r scale used to colour the points.
  const ChiColorBar = () => {
    const stops = [0, 0.25, 0.5, 0.75, 1]
      .map((t) => `${viridisR(t)} ${t * 100}%`)
      .join(', ')
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', ml: 1 }}>
        <Typography variant="caption" color="text.secondary">χ²</Typography>
        <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0.5, height: 260 }}>
          <Box
            sx={{
              width: 16,
              borderRadius: 0.5,
              border: '1px solid #ccc',
              background: `linear-gradient(to bottom, ${stops})`
            }}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <Typography variant="caption">{fmtNumber(chi2min, 1)}</Typography>
            <Typography variant="caption" color="text.secondary">best fit ↑</Typography>
            <Typography variant="caption">{fmtNumber(chi2max, 1)}</Typography>
          </Box>
        </Box>
      </Box>
    )
  }

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

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}
      >
        <Tab label="FoXS Analysis" />
        <Tab label="Structural Analysis" />
        <Tab label="MD Movies" />
        <Tab label="MD Parameters" />
      </Tabs>

      {/* ---------------- FoXS Analysis ---------------- */}
      {tab === 0 &&
        (usesSaxs ? (
          <Box>
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
              <MetricCard label="Best χ²" value={fmtNumber(metrics.bestChi2)} />
              <MetricCard
                label="Best frame"
                value={
                  typeof metrics.bestFrame === 'number'
                    ? String(metrics.bestFrame)
                    : '—'
                }
              />
              <MetricCard label="Mean Rg (Å)" value={fmtNumber(metrics.rgMean, 2)} />
            </Box>

            <Box
              sx={{
                display: 'flex',
                gap: 2,
                alignItems: 'center',
                flexWrap: 'wrap',
                mb: 1
              }}
            >
              <Typography variant="subtitle2">χ² and Rg per frame</Typography>
              <XAxisToggle />
              <RepeatToggles />
            </Box>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={foxsData} margin={{ top: 5, right: 30, left: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="x"
                  label={{ value: xLabel, position: 'insideBottom', offset: -2 }}
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
                {activeRepeats.map((r) => (
                  <Line
                    key={`chi2_${r}`}
                    yAxisId="chi2"
                    type="monotone"
                    dataKey={`chi2_${r}`}
                    name={`χ² Rep ${r}`}
                    stroke={REPEAT_COLORS[(r - 1) % REPEAT_COLORS.length]}
                    dot={false}
                  />
                ))}
                {activeRepeats.map((r) => (
                  <Line
                    key={`rg_${r}`}
                    yAxisId="rg"
                    type="monotone"
                    dataKey={`rg_${r}`}
                    name={`Rg Rep ${r}`}
                    stroke={REPEAT_COLORS[(r - 1) % REPEAT_COLORS.length]}
                    strokeDasharray="4 2"
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>

            <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
              Best-fitting frames (MultiFoXS ensemble uses these)
            </Typography>
            <Table size="small">
              <TableBody>
                <TableRow>
                  <TableCell sx={{ color: 'text.secondary' }}>Frame</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>Repeat</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>χ²</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>Rg (Å)</TableCell>
                </TableRow>
                {topFits.map((f) => (
                  <TableRow key={f.frame}>
                    <TableCell>{f.frame}</TableCell>
                    <TableCell>{f.repeat ?? '—'}</TableCell>
                    <TableCell>{fmtNumber(f.chi2)}</TableCell>
                    <TableCell>{fmtNumber(f.rg, 2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {/* ---- MultiFoXS ensemble fit over the MD frames ---- */}
            {ensembles.length > 0 && activeEnsemble ? (
              <Box sx={{ mt: 3 }}>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  MultiFoXS ensemble fit
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  MultiFoXS selects the best-fitting weighted combination of MD
                  frames for each ensemble size. Select a size to view its fit and
                  composition (the FoXS analogue of the original GAJOE step).
                </Typography>
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, md: 5 }}>
                    <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                      Ensembles by size
                    </Typography>
                    <Table size="small">
                      <TableBody>
                        <TableRow>
                          <TableCell sx={{ color: 'text.secondary' }}>Size</TableCell>
                          <TableCell sx={{ color: 'text.secondary' }}>χ²</TableCell>
                          <TableCell sx={{ color: 'text.secondary' }}>
                            Composition (frame · weight)
                          </TableCell>
                        </TableRow>
                        {ensembles.map((e) => (
                          <TableRow
                            key={e.size}
                            hover
                            selected={e.size === activeEnsSize}
                            onClick={() => setSelectedEnsSize(e.size)}
                            sx={{ cursor: 'pointer' }}
                          >
                            <TableCell>{e.size}</TableCell>
                            <TableCell>{fmtNumber(e.chi2)}</TableCell>
                            <TableCell>
                              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                                {e.members.map((m, i) => {
                                  const rep = m.frame != null
                                    ? repeatOfFrame.get(m.frame)
                                    : undefined
                                  return (
                                    <Chip
                                      key={i}
                                      size="small"
                                      variant="outlined"
                                      label={`${
                                        m.frame != null ? `f${m.frame}` : '?'
                                      }${rep ? ` (r${rep})` : ''} · ${(
                                        m.weight * 100
                                      ).toFixed(0)}%`}
                                    />
                                  )
                                })}
                              </Box>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Grid>
                  <Grid size={{ xs: 12, md: 7 }}>
                    <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                      Ensemble fit — size {activeEnsemble.size}, χ²{' '}
                      {fmtNumber(activeEnsemble.chi2)}
                    </Typography>
                    {ensembleIqData.length > 0 ? (
                      <InitialFitChart
                        data={ensembleIqData}
                        residualsData={ensembleResiduals}
                      />
                    ) : (
                      <Alert severity="info">
                        No fit curve available for this ensemble size.
                      </Alert>
                    )}
                  </Grid>
                </Grid>
              </Box>
            ) : (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 1 }}
              >
                MultiFoXS ensemble fit is not available for this job (Download
                Results for the per-frame fit curves).
              </Typography>
            )}
          </Box>
        ) : (
          <Alert severity="info">
            No experimental SAXS data was provided, so FoXS χ² fitting was skipped.
            See the Structural Analysis and MD Movies tabs.
          </Alert>
        ))}

      {/* ---------------- Structural Analysis ---------------- */}
      {tab === 1 && (
        <Box>
          {pca.length > 0 ? (
            <Grid container spacing={3}>
              {/* SAXS-scored PCA (only meaningful with experimental SAXS) */}
              {usesSaxs && (
                <Grid size={{ xs: 12, md: 6 }}>
                  <Typography variant="subtitle2" sx={{ mb: 1 }}>
                    PCA of the Cα trajectory — coloured by SAXS fit (χ²)
                  </Typography>
                  <Box sx={{ display: 'flex' }}>
                    <Box sx={{ flexGrow: 1 }}>
                      <ResponsiveContainer width="100%" height={320}>
                        <ScatterChart margin={{ top: 5, right: 10, left: 5, bottom: 15 }}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis
                            type="number"
                            dataKey="pc1"
                            name="PC1"
                            label={{ value: 'PC1', position: 'insideBottom', offset: -5 }}
                          />
                          <YAxis
                            type="number"
                            dataKey="pc2"
                            name="PC2"
                            label={{ value: 'PC2', angle: -90, position: 'insideLeft' }}
                          />
                          <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                          <Scatter data={pca} fill="#8884d8">
                            {pca.map((p, i) => (
                              <Cell key={i} fill={chi2color(p.chi2)} />
                            ))}
                          </Scatter>
                        </ScatterChart>
                      </ResponsiveContainer>
                    </Box>
                    <ChiColorBar />
                  </Box>
                </Grid>
              )}

              {/* Cluster-coloured PCA (CLoNe clusters) */}
              <Grid size={{ xs: 12, md: usesSaxs ? 6 : 12 }}>
                <Box
                  sx={{
                    display: 'flex',
                    gap: 2,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    mb: 1
                  }}
                >
                  <Typography variant="subtitle2">
                    PCA — coloured by CLoNe cluster ({activeNClusters} clusters)
                  </Typography>
                  {pdcOptions.length > 1 && (
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <Typography variant="caption" color="text.secondary">
                        pdc:
                      </Typography>
                      <ToggleButtonGroup
                        size="small"
                        exclusive
                        value={activePdc}
                        onChange={(_, v) => v != null && setSelectedPdc(v)}
                      >
                        {pdcOptions.map((p) => (
                          <ToggleButton key={p} value={p}>
                            {p}
                          </ToggleButton>
                        ))}
                      </ToggleButtonGroup>
                    </Box>
                  )}
                </Box>
                <ResponsiveContainer width="100%" height={320}>
                  <ScatterChart margin={{ top: 5, right: 10, left: 5, bottom: 15 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      type="number"
                      dataKey="pc1"
                      name="PC1"
                      label={{ value: 'PC1', position: 'insideBottom', offset: -5 }}
                    />
                    <YAxis
                      type="number"
                      dataKey="pc2"
                      name="PC2"
                      label={{ value: 'PC2', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                    <Legend />
                    {pcaTagged.some((p) => p.cl == null || p.cl < 0) && (
                      <Scatter
                        name="Outliers"
                        data={pcaTagged.filter((p) => p.cl == null || p.cl < 0)}
                        fill="#bbbbbb"
                      />
                    )}
                    {clusterIds.map((cid) => (
                      <Scatter
                        key={cid}
                        name={`Cluster ${cid + 1}`}
                        data={pcaTagged.filter((p) => p.cl === cid)}
                        fill={clusterColor(cid)}
                      />
                    ))}
                  </ScatterChart>
                </ResponsiveContainer>
                {pdcOptions.length > 1 && (
                  <Typography variant="caption" color="text.secondary">
                    Lower pdc → more, finer clusters; higher pdc → fewer, broader
                    clusters (CLoNe density cut-off percentile).
                  </Typography>
                )}
              </Grid>
            </Grid>
          ) : (
            <Alert severity="info" sx={{ mb: 2 }}>
              Clustering / PCA output is not available for this job.
            </Alert>
          )}

          {tsData.length > 0 ? (
            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 1 }}>
                <Typography variant="subtitle2">Structural metrics over time</Typography>
                <RepeatToggles />
              </Box>
              <TimeSeriesChart metric="rg" label="Radius of gyration (Å)" />
              <TimeSeriesChart metric="rmsd" label="Cα RMSD to first frame (Å)" />
              <TimeSeriesChart metric="sasa" label="SASA (nm²)" />
              {hasHbonds && (
                <TimeSeriesChart metric="hbonds" label="Solute H-bond count" />
              )}
              {hasLigandRmsd && (
                <TimeSeriesChart
                  metric="ligandRmsd"
                  label="Ligand RMSD (Å, protein-aligned)"
                />
              )}
              {hasLigandContacts && (
                <TimeSeriesChart
                  metric="ligandContacts"
                  label="Protein–ligand contacts (atoms < 4 Å)"
                />
              )}
              {hasEnergy && (
                <TimeSeriesChart metric="energy" label="Total energy (kJ/mol)" />
              )}
            </Box>
          ) : (
            <Alert severity="info" sx={{ mt: 2 }}>
              Per-frame structural time-series is not available for this job.
            </Alert>
          )}
        </Box>
      )}

      {/* ---------------- MD Movies ---------------- */}
      {tab === 2 &&
        (repeats.length > 0 ? (
          <AutoMDSAXSTrajectoryViewer
            jobId={jobId}
            repeats={repeats}
          />
        ) : (
          <Alert severity="info">
            No extracted trajectory frames are available for this job yet.
          </Alert>
        ))}

      {/* ---------------- MD Parameters ---------------- */}
      {tab === 3 && (
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Effective parameters
            </Typography>
            <Table size="small">
              <TableBody>
                {PARAM_LABELS.filter(
                  ({ key }) =>
                    key in params || (key === 'hmr' && 'timestepFs' in params)
                ).map(({ key, label }) => (
                  <TableRow key={key}>
                    <TableCell sx={{ color: 'text.secondary' }}>{label}</TableCell>
                    <TableCell>
                      {fmtParamValue(
                        key,
                        key === 'hmr' ? hmrUsed(params) : params[key]
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Outputs
            </Typography>
            <Table size="small">
              <TableBody>
                {Object.entries(outputs).map(([category, files]) => (
                  <TableRow key={category}>
                    <TableCell sx={{ color: 'text.secondary' }}>{category}</TableCell>
                    <TableCell>{(files as string[]).length}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Use the Download Results button to retrieve all output files.
            </Typography>
          </Grid>
        </Grid>
      )}

      {data.notes && data.notes.length > 0 && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {data.notes.join('; ')}
        </Alert>
      )}
    </Paper>
  )
}

export default AutoMDSAXSResults
