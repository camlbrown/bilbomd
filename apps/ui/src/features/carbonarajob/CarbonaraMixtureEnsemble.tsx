import { useState, useEffect } from 'react'
import {
  Box,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  CircularProgress,
  Alert,
  Chip,
  Stack,
  FormControlLabel,
  Switch
} from '@mui/material'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LabelList
} from 'recharts'
import CarbonaraStructureViewer from './CarbonaraStructureViewer'
import { carbonaraChainColorHex } from './carbonaraChainPalette'
import {
  useLazyGetCarbonaraAaPdbQuery,
  useLazyGetCarbonaraOriginalPdbBySubQuery,
  type CarbonaraMixtureState
} from 'slices/jobsApiSlice'

interface CarbonaraMixtureEnsembleProps {
  jobId: string
  state: CarbonaraMixtureState
  method?: 'multi_foxs' | 'estimated'
  // Resolve the source-structure filename for a species' sub index.
  structureNameForSub?: (sub: number) => string | undefined
}

// Presents the best mixture ensemble: a weight bar chart (relative contribution
// of each species) plus a 3D viewer with a per-species toggle. The all-atom
// model for the active species is fetched on demand and cached.
const CarbonaraMixtureEnsemble = ({
  jobId,
  state,
  method,
  structureNameForSub
}: CarbonaraMixtureEnsembleProps) => {
  const species = state.species
  const [active, setActive] = useState(0)
  const [pdbCache, setPdbCache] = useState<Record<number, string>>({})
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [fetchAaPdb] = useLazyGetCarbonaraAaPdbQuery()
  // Overlay of the structure each species derived from (grey ghost), fetched
  // per source-structure sub index and cached.
  const [overlayEnabled, setOverlayEnabled] = useState(false)
  const [originalCache, setOriginalCache] = useState<Record<number, string>>({})
  const [overlayFetching, setOverlayFetching] = useState(false)
  const [overlayError, setOverlayError] = useState(false)
  const [fetchOriginal] = useLazyGetCarbonaraOriginalPdbBySubQuery()

  useEffect(() => {
    const sp = species[active]
    if (!sp) return
    if (pdbCache[active] !== undefined) {
      setStatus('idle')
      return
    }
    let cancelled = false
    setStatus('loading')
    fetchAaPdb({ jobId, pdbPath: sp.aa_pdb })
      .unwrap()
      .then((text) => {
        if (cancelled) return
        setPdbCache((c) => ({ ...c, [active]: text }))
        setStatus('idle')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [active, species, jobId, fetchAaPdb, pdbCache])

  // Fetch the original structure for the active species' source (by sub) when
  // the overlay is enabled; cache per sub so toggling species is instant.
  useEffect(() => {
    if (!overlayEnabled) return
    const sp = species[active]
    if (!sp || originalCache[sp.sub] !== undefined) return
    const sub = sp.sub
    let cancelled = false
    setOverlayFetching(true)
    setOverlayError(false)
    fetchOriginal({ jobId, sub })
      .unwrap()
      .then((text) => {
        if (!cancelled) setOriginalCache((c) => ({ ...c, [sub]: text }))
      })
      .catch(() => {
        if (!cancelled) setOverlayError(true)
      })
      .finally(() => {
        if (!cancelled) setOverlayFetching(false)
      })
    return () => {
      cancelled = true
    }
  }, [overlayEnabled, active, species, jobId, fetchOriginal, originalCache])

  if (species.length === 0) return null

  // Bar-chart rows: relative weight (%) per species, in species order. `label`
  // is a precomputed string so the chart needs no (awkwardly-typed) formatter.
  const chartData = species.map((s) => ({
    name: `Species ${s.sub + 1}`,
    weight: Number((s.weight * 100).toFixed(1)),
    label: `${(s.weight * 100).toFixed(1)}%`,
    idx: s.sub
  }))

  const activeSpecies = species[active]
  const activePdb = pdbCache[active]

  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mb: 1.5 }}
      >
        The best{' '}
        {method === 'multi_foxs' ? 'MultiFoXS' : 'estimated-weight'} ensemble
        combines these {species.length} all-atom structures. The bars show each
        structure&apos;s relative contribution (weight); toggle a species to view
        its model in 3D.
      </Typography>

      {/* Relative-contribution bar chart */}
      <Box sx={{ width: '100%', height: 48 + species.length * 40, mb: 2 }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
        >
          <BarChart
            layout="vertical"
            data={chartData}
            margin={{ top: 4, right: 56, bottom: 4, left: 8 }}
          >
            <XAxis
              type="number"
              domain={[0, 100]}
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fontSize: 12 }}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={92}
              tick={{ fontSize: 12 }}
            />
            <Tooltip formatter={(value) => [`${value}%`, 'Weight']} />
            <Bar
              dataKey="weight"
              radius={[0, 4, 4, 0]}
            >
              {chartData.map((d) => (
                <Cell
                  key={d.idx}
                  fill={carbonaraChainColorHex(d.idx)}
                  fillOpacity={d.idx === active ? 1 : 0.5}
                />
              ))}
              <LabelList
                dataKey="label"
                position="right"
                style={{ fontSize: 12, fill: '#555' }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Box>

      {/* Per-species toggle */}
      <ToggleButtonGroup
        exclusive
        size="small"
        value={active}
        onChange={(_e, v) => {
          if (v !== null) setActive(v)
        }}
        sx={{ mb: 1, flexWrap: 'wrap' }}
      >
        {species.map((s, i) => (
          <ToggleButton
            key={s.id}
            value={i}
          >
            <Box
              component="span"
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: carbonaraChainColorHex(s.sub),
                display: 'inline-block',
                mr: 0.75
              }}
            />
            Species {s.sub + 1} · {(s.weight * 100).toFixed(0)}%
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {/* Active species metadata */}
      {activeSpecies && (
        <Stack
          direction="row"
          sx={{ gap: 1, flexWrap: 'wrap', mb: 1, alignItems: 'center' }}
        >
          <Chip
            size="small"
            variant="outlined"
            label={`Weight ${(activeSpecies.weight * 100).toFixed(1)}%`}
          />
          {structureNameForSub?.(activeSpecies.sub) && (
            <Chip
              size="small"
              variant="outlined"
              color="primary"
              label={`from ${structureNameForSub(activeSpecies.sub)}`}
            />
          )}
          {activeSpecies.chi2 != null && (
            <Chip
              size="small"
              variant="outlined"
              label={`FoXS χ² ${activeSpecies.chi2.toFixed(2)} (this structure alone)`}
            />
          )}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
          >
            {activeSpecies.id}
          </Typography>
        </Stack>
      )}

      {/* Overlay toggle */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 1
        }}
      >
        {overlayFetching && <CircularProgress size={16} />}
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={overlayEnabled}
              disabled={overlayFetching}
              onChange={(e) => setOverlayEnabled(e.target.checked)}
            />
          }
          label="Overlay original structure (transparent grey)"
          slotProps={{ typography: { variant: 'body2' } }}
        />
      </Box>
      {overlayError && (
        <Alert
          severity="warning"
          sx={{ mb: 1 }}
        >
          Could not load the original structure to overlay.
        </Alert>
      )}

      {/* 3D model of the active species */}
      {status === 'error' ? (
        <Alert severity="warning">
          Could not load this structure&apos;s all-atom model.
        </Alert>
      ) : status === 'loading' || activePdb === undefined ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            py: 4,
            justifyContent: 'center'
          }}
        >
          <CircularProgress size={20} />
          <Typography
            variant="body2"
            color="text.secondary"
          >
            Loading model…
          </Typography>
        </Box>
      ) : (
        <CarbonaraStructureViewer
          key={active}
          structureFile={activePdb}
          overlayStructure={
            overlayEnabled && activeSpecies
              ? originalCache[activeSpecies.sub]
              : undefined
          }
          height={360}
        />
      )}
    </Box>
  )
}

export default CarbonaraMixtureEnsemble
