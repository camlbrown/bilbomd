import { useState } from 'react'
import {
  Box,
  Typography,
  Alert,
  CircularProgress,
  Paper,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  Stack
} from '@mui/material'
import { useGetCarbonaraAnalysisQuery } from 'slices/jobsApiSlice'
import InitialFitChart from './InitialFitChart'
import CarbonaraConvergenceChart from './CarbonaraConvergenceChart'
import CarbonaraPredictionsTable from './CarbonaraPredictionsTable'
import CarbonaraHistogramsPanel from './CarbonaraHistogramsPanel'
import CarbonaraDownloadPanel from './CarbonaraDownloadPanel'
import CarbonaraMixtureEnsemble from './CarbonaraMixtureEnsemble'

interface CarbonaraResultsProps {
  jobId: string
  // Primary structure filename + any additional mixture structures, used to
  // label each species by the structure it derived from.
  pdbFile?: string
  mixturePdbFiles?: string[]
}

const CarbonaraResults = ({
  jobId,
  pdbFile,
  mixturePdbFiles
}: CarbonaraResultsProps) => {
  // Which analysis section is shown (mixture: Mixture/Classic/Convergence;
  // non-mixture: Classic/Convergence).
  const [section, setSection] = useState(0)
  // Which mixture ensemble the user has selected from the "Ensembles by size"
  // table; null falls back to the headline best ensemble.
  const [selectedStateIdx, setSelectedStateIdx] = useState<number | null>(null)

  // sub 0 = primary pdb_file, sub i = mixture_pdb_files[i-1]. For a
  // same-structure mixture (no extras) every species comes from the primary.
  const structureNameForSub = (sub: number): string | undefined => {
    const extras = mixturePdbFiles ?? []
    if (extras.length === 0) return pdbFile
    if (sub <= 0) return pdbFile
    return extras[sub - 1] ?? undefined
  }
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

  // Three distinct fit metrics are reported here, on DIFFERENT scales:
  //  * Carbonara fit score — Carbonara's own coarse-grained scattering objective
  //    (the variance of the log-intensity residuals; ScatterFitFirst). NOT a
  //    reduced χ²: it is error-free and scale-free, so a good fit sits near 0.
  //  * FoXS χ² (single all-atom) — a proper error-weighted reduced χ² for ONE
  //    reconstructed structure. For a mixture this is expected to be large (no
  //    single structure fits an ensemble), so it is de-emphasised below.
  //  * Mixture χ² (MultiFoXS) — the error-weighted reduced χ² of the weighted
  //    ensemble. This is the headline metric for a mixture run.
  const bestFoxsChi2 = analysis.best?.chi2 ?? null
  const carbonaraScores = analysis.convergence.flatMap((r) =>
    r.points.map((p) => p.chi2)
  )
  const bestCarbonaraScore =
    carbonaraScores.length > 0 ? Math.min(...carbonaraScores) : null
  const nPredictions = analysis.n_predictions ?? analysis.predictions.length

  // --- Best single-structure FoXS fit ---
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

  // --- Mixture (ensemble) ---
  const mixture = analysis.mixture ?? null
  const isMixture = !!mixture?.best
  const states = mixture?.states ?? []

  // Default to the headline best ensemble; the table can select another.
  let defaultStateIdx = 0
  const bestIdx = states.findIndex((s) => s === mixture?.best)
  if (bestIdx >= 0) {
    defaultStateIdx = bestIdx
  } else {
    let bestChi2 = Infinity
    states.forEach((s, i) => {
      if (s.chi2 < bestChi2) {
        bestChi2 = s.chi2
        defaultStateIdx = i
      }
    })
  }
  const activeStateIdx = selectedStateIdx ?? defaultStateIdx
  const activeState = states[activeStateIdx] ?? mixture?.best ?? null

  // Combined ensemble SAXS fit curve, for the currently-selected ensemble.
  const activeMixturePoints = activeState?.fit?.foxs ?? []
  const activeMixtureIqData = activeMixturePoints.map((p) => ({
    q: p.q,
    exp_intensity: p.exp,
    model_intensity: p.model,
    error: p.error
  }))
  const activeMixtureResidualsData = activeMixturePoints.map((p) => ({
    q: p.q,
    res: p.error > 0 ? (p.exp - p.model) / p.error : 0
  }))

  const summaryStat = (label: string, value: string) => (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
      >
        {label}
      </Typography>
      <Typography
        variant="body1"
        sx={{ wordBreak: 'break-all' }}
      >
        {value}
      </Typography>
    </Box>
  )

  const carbonaraScoreNote =
    "Carbonara's coarse-grained scattering objective (variance of the " +
    'log-intensity residuals) — not a reduced χ², so a good fit is near 0.'

  // ── Section: Classic Carbonara fitting (single-structure metrics) ──────────
  // The per-structure summary stats, the best single-structure FoXS fit, the
  // predictions table and the per-residue histograms. This is the content of a
  // normal (non-mixture) Carbonara run.
  const classicSection = (
    <Box sx={{ mt: 2 }}>
      <Paper
        variant="outlined"
        sx={{ p: 2, mb: 2 }}
      >
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 1,
            mb: 2
          }}
        >
          {summaryStat(
            'Carbonara fit score',
            bestCarbonaraScore !== null ? bestCarbonaraScore.toFixed(4) : '—'
          )}
          {summaryStat(
            isMixture
              ? 'Best single-structure FoXS χ²'
              : 'Best FoXS χ² (all-atom)',
            bestFoxsChi2 !== null ? bestFoxsChi2.toFixed(4) : '—'
          )}
          {summaryStat('Best single model', analysis.best?.id ?? '—')}
        </Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block' }}
        >
          {carbonaraScoreNote}
          {isMixture &&
            ' The best single-structure FoXS χ² is expected to be poor for a ' +
              'mixture — no single structure fits the ensemble; see the mixture ' +
              'χ² in the Mixture Fitting tab.'}
        </Typography>

        {/* Best single-structure FoXS fit */}
        {iqData.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Best single-structure FoXS fit ({analysis.best?.id ?? ''}, χ² ={' '}
              {bestFoxsChi2 !== null ? bestFoxsChi2.toFixed(4) : '—'})
            </Typography>
            <InitialFitChart
              data={iqData}
              residualsData={residualsData}
            />
          </Box>
        )}
      </Paper>

      {/* Predictions table */}
      <CarbonaraPredictionsTable
        jobId={jobId}
        predictions={analysis.predictions}
        bestId={analysis.best?.id}
        structureNameForSub={isMixture ? structureNameForSub : undefined}
      />

      {/* Histograms */}
      <CarbonaraHistogramsPanel
        histograms={analysis.histograms}
        predictions={analysis.predictions}
        chi2Threshold={analysis.chi2_threshold}
      />
    </Box>
  )

  // ── Section: Convergence ───────────────────────────────────────────────────
  const convergenceSection = (
    <Box sx={{ mt: 2 }}>
      <Paper
        variant="outlined"
        sx={{ p: 2, mb: 2 }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Convergence
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mb: 1 }}
        >
          Carbonara coarse-grained fit score per fit run (log-residual variance)
          — not the all-atom FoXS χ².
        </Typography>
        <CarbonaraConvergenceChart convergence={analysis.convergence} />
      </Paper>
    </Box>
  )

  // ── Section: Mixture fitting ───────────────────────────────────────────────
  const mixtureSection =
    isMixture && mixture?.best && activeState ? (
      <Box sx={{ mt: 2 }}>
        <Paper
          variant="outlined"
          sx={{ p: 2, mb: 2 }}
        >
          {/* Ensembles by size — pick which ensemble to inspect, best fit first */}
          {states.length > 1 && (
            <Box sx={{ mb: 2 }}>
              <Typography
                variant="subtitle1"
                sx={{ fontWeight: 600, mb: 0.5 }}
              >
                Ensembles by size
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 1 }}
              >
                Best weighted ensemble at each number of species, ordered
                best-fit first. Click a row to view that ensemble&apos;s weights
                and 3D models below.
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Species in ensemble</TableCell>
                      <TableCell>χ²</TableCell>
                      <TableCell>Composition (weight)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {states
                      .map((st, idx) => ({ st, idx }))
                      .sort((a, b) => a.st.chi2 - b.st.chi2)
                      .map(({ st, idx }) => (
                        <TableRow
                          key={`${st.run}-${idx}`}
                          hover
                          selected={idx === activeStateIdx}
                          onClick={() => setSelectedStateIdx(idx)}
                          sx={{ cursor: 'pointer' }}
                        >
                          <TableCell>{st.species.length}</TableCell>
                          <TableCell>{st.chi2.toFixed(3)}</TableCell>
                          <TableCell>
                            <Stack
                              direction="row"
                              sx={{ gap: 0.5, flexWrap: 'wrap' }}
                            >
                              {st.species.map((s) => {
                                const name = structureNameForSub(s.sub)
                                return (
                                  <Chip
                                    key={s.id}
                                    size="small"
                                    variant="outlined"
                                    label={`${
                                      name ?? `Species ${s.sub + 1}`
                                    } · ${(s.weight * 100).toFixed(0)}%`}
                                  />
                                )
                              })}
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          {/* Selected ensemble: weights + per-species 3D models */}
          <Typography
            variant="h6"
            gutterBottom
          >
            {selectedStateIdx === null ? 'Best ensemble' : 'Selected ensemble'} —{' '}
            {activeState.species.length} species,{' '}
            {mixture.method === 'estimated' ? 'estimated' : 'MultiFoXS'} χ² ={' '}
            {activeState.chi2.toFixed(4)}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mb: 1.5 }}
          >
            {mixture.method === 'multi_foxs'
              ? 'Weighted all-atom ensemble from MultiFoXS (IMP): the per-species weights sum to 100% and minimise χ² against the SAXS data.'
              : 'Weighted combination of the all-atom species (estimated weight fit — MultiFoXS unavailable): FoXS per species with non-negative weights summing to 100%.'}
          </Typography>

          <CarbonaraMixtureEnsemble
            key={activeStateIdx}
            jobId={jobId}
            state={activeState}
            method={mixture.method}
            structureNameForSub={structureNameForSub}
          />

          {/* Combined ensemble SAXS fit curve for the selected ensemble */}
          {activeMixtureIqData.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <Typography
                variant="subtitle1"
                sx={{ fontWeight: 600, mb: 0.5 }}
              >
                Ensemble SAXS fit (all species, weighted)
              </Typography>
              <InitialFitChart
                data={activeMixtureIqData}
                residualsData={activeMixtureResidualsData}
              />
            </Box>
          )}
        </Paper>
      </Box>
    ) : null

  // Section tab definitions — mixture runs add a leading "Mixture Fitting" tab.
  const sections: { label: string; content: React.ReactNode }[] = isMixture
    ? [
        { label: '1. Mixture Fitting', content: mixtureSection },
        { label: '2. Classic Carbonara Fitting', content: classicSection },
        { label: '3. Convergence', content: convergenceSection }
      ]
    : [
        { label: '1. Classic Carbonara Fitting', content: classicSection },
        { label: '2. Convergence', content: convergenceSection }
      ]
  const activeSection = section < sections.length ? section : 0

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
          {isMixture ? (
            <>
              {summaryStat(
                `Mixture χ² (${mixture?.method === 'estimated' ? 'estimated' : 'MultiFoXS'})`,
                mixture?.best ? mixture.best.chi2.toFixed(4) : '—'
              )}
              {summaryStat(
                'Ensemble species',
                String(mixture?.n_species ?? '—')
              )}
              {summaryStat('Candidate models', String(nPredictions))}
              {summaryStat(
                'FoXS χ² threshold',
                String(analysis.chi2_threshold)
              )}
            </>
          ) : (
            <>
              {summaryStat('Predictions', String(nPredictions))}
              {summaryStat(
                'Carbonara fit score',
                bestCarbonaraScore !== null
                  ? bestCarbonaraScore.toFixed(4)
                  : '—'
              )}
              {summaryStat(
                'Best FoXS χ² (all-atom)',
                bestFoxsChi2 !== null ? bestFoxsChi2.toFixed(4) : '—'
              )}
              {summaryStat(
                'FoXS χ² threshold',
                String(analysis.chi2_threshold)
              )}
              {summaryStat('Best model', analysis.best?.id ?? '—')}
            </>
          )}
        </Box>
        {isMixture && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1 }}
          >
            For a mixture, the headline metric is the weighted-ensemble χ²
            above. The coarse-grained Carbonara fit score and the best
            single-structure FoXS χ² are under “Classic Carbonara Fitting”.
          </Typography>
        )}
        {analysis.warnings && analysis.warnings.length > 0 && (
          <Alert
            severity="warning"
            sx={{ mt: 1 }}
          >
            {analysis.warnings.join('; ')}
          </Alert>
        )}
      </Paper>

      {/* Analysis section tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs
          value={activeSection}
          onChange={(_e, v) => setSection(v)}
          aria-label="carbonara analysis sections"
          variant="scrollable"
          scrollButtons="auto"
        >
          {sections.map((s) => (
            <Tab
              key={s.label}
              label={s.label}
            />
          ))}
        </Tabs>
      </Box>
      {sections[activeSection]?.content}

      {/* Download bundle */}
      <Paper
        variant="outlined"
        sx={{ p: 2, mb: 2, mt: 2 }}
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
