import { useState } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router'
import {
  Box,
  Paper,
  Typography,
  Alert,
  Button,
  CircularProgress,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  TextField,
  MenuItem
} from '@mui/material'
import Grid from '@mui/material/Grid'
import HeaderBox from 'components/HeaderBox'
import useTitle from 'hooks/useTitle'
import {
  useGetAutoMDSaxsPrepQuery,
  useReprepareAutoMDSaxsMutation,
  useAddNewAutoMDSaxsJobMutation
} from 'slices/jobsApiSlice'
import AutoMDSAXSStructureViewer from './AutoMDSAXSStructureViewer'

interface ReviewState {
  pdbFile?: File
  datFile?: File
  settings?: Record<string, unknown>
  keepIons?: boolean
  keepAgents?: boolean
  keepWaters?: boolean
  ionResnames?: string[]
  ligandResnames?: string[]
  ligandSmiles?: Record<string, string>
}

// Task 4 layer 5: review the prepared structure, edit per-residue protonation
// (or the pH) and re-prepare to preview, then submit the real MD job.
const AutoMDSAXSReviewPage = () => {
  useTitle('BilboMD: Review prepared structure')
  const { previewId } = useParams<{ previewId: string }>()
  const navigate = useNavigate()
  const state = (useLocation().state as ReviewState) || {}

  const { data, isLoading } = useGetAutoMDSaxsPrepQuery(previewId ?? '', {
    skip: !previewId,
    pollingInterval: 4000
  })
  const [reprepare, { isLoading: isReprepping }] = useReprepareAutoMDSaxsMutation()
  const [addJob, { isLoading: isRunning }] = useAddNewAutoMDSaxsJobMutation()

  // Protonation overrides the user has set ("chain:resSeq:resname" -> variant).
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [ph, setPh] = useState<number>(
    typeof state.settings?.ph === 'number'
      ? (state.settings.ph as number)
      : Number(state.settings?.ph ?? 7)
  )
  const [error, setError] = useState<string | null>(null)

  const preparing = isLoading || !data || data.status === 'pending'
  const table = data?.protonationTable ?? []

  const onReprepare = async (): Promise<void> => {
    if (!previewId) return
    setError(null)
    try {
      await reprepare({ previewId, ph, protonation_overrides: overrides }).unwrap()
    } catch (e) {
      setError(
        (e as { data?: { message?: string } }).data?.message ||
          'Failed to re-prepare.'
      )
    }
  }

  const onRunMD = async (): Promise<void> => {
    setError(null)
    if (!state.pdbFile) {
      setError(
        'The uploaded structure is no longer in memory (did you refresh?). Please restart from the setup page.'
      )
      return
    }
    const s = state.settings || {}
    const form = new FormData()
    form.append('bilbomd_mode', 'automd-saxs')
    form.append('title', String(s.title ?? 'AutoMD-SAXS job'))
    form.append('pdb_file', state.pdbFile)
    // Optional experimental SAXS data — without this the job runs MD only (no
    // FoXS/MultiFoXS analysis).
    if (state.datFile instanceof File) form.append('dat_file', state.datFile)
    form.append('system', String(s.system ?? 'Protein'))
    form.append('force_field', String(s.force_field ?? 'amber14'))
    form.append('water_model', String(s.water_model ?? 'tip3p'))
    form.append('simulation_time_ns', String(s.simulation_time_ns ?? 100))
    form.append('n_repeats', String(s.n_repeats ?? 3))
    form.append('ionic_concentration_M', String(s.ionic_concentration_M ?? 0.15))
    form.append('ph', String(ph))
    form.append('temperature_K', String(s.temperature_K ?? 300))
    if (s.box_padding_nm !== undefined && s.box_padding_nm !== '')
      form.append('box_padding_nm', String(s.box_padding_nm))
    if (s.seed !== undefined && s.seed !== '')
      form.append('seed', String(s.seed))
    form.append('disulfide', String(s.disulfide ?? false))
    form.append('hmr', String(s.hmr ?? false))
    form.append('keep_ions', String(state.keepIons ?? true))
    form.append(
      'keep_crystallisation_agents',
      String(state.keepAgents ?? false)
    )
    form.append('keep_waters', String(state.keepWaters ?? false))
    if (state.ionResnames && state.ionResnames.length > 0)
      form.append('ion_resnames', JSON.stringify(state.ionResnames))
    if (state.ligandResnames && state.ligandResnames.length > 0)
      form.append('ligand_resnames', JSON.stringify(state.ligandResnames))
    if (state.ligandSmiles && Object.keys(state.ligandSmiles).length > 0)
      form.append('ligand_smiles', JSON.stringify(state.ligandSmiles))
    if (Object.keys(overrides).length > 0)
      form.append('protonation_overrides', JSON.stringify(overrides))
    try {
      const job = await addJob(form).unwrap()
      void navigate(`/dashboard/jobs/${job.jobid}`)
    } catch (e) {
      setError(
        (e as { data?: { message?: string } }).data?.message ||
          'Failed to submit the MD job.'
      )
    }
  }

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12 }}>
        <HeaderBox>
          <Typography>Review prepared structure</Typography>
        </HeaderBox>
        <Paper sx={{ p: 2 }}>
          <Alert severity="info" sx={{ mb: 2 }}>
            Check the prepared structure — protonation, kept ions/ligands, stripped
            content — before running. Preparation is best-effort; adjust
            protonation states or pH below and re-prepare, then run the MD.
          </Alert>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {preparing ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 2 }}>
              <CircularProgress size={22} />
              <Typography>Preparing structure…</Typography>
            </Box>
          ) : data.status === 'error' ? (
            <Alert severity="error">
              Preparation failed: {data.message || 'unknown error'}
            </Alert>
          ) : (
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, md: 6 }}>
                <AutoMDSAXSStructureViewer
                  url={`/jobs/automd-saxs-prep/${previewId}/prepared`}
                  height={460}
                />
                <Box sx={{ mt: 1 }}>
                  <Table size="small">
                    <TableBody>
                      {data.ions && Object.keys(data.ions).length > 0 && (
                        <TableRow>
                          <TableCell sx={{ color: 'text.secondary' }}>Ions kept</TableCell>
                          <TableCell>
                            {Object.entries(data.ions).map(([k, v]) => (
                              <Chip key={k} size="small" label={`${k} ×${v}`} sx={{ mr: 0.5 }} />
                            ))}
                          </TableCell>
                        </TableRow>
                      )}
                      {data.ligands && data.ligands.length > 0 && (
                        <TableRow>
                          <TableCell sx={{ color: 'text.secondary' }}>Ligands</TableCell>
                          <TableCell>
                            {data.ligands.map((l) => (
                              <Chip key={l.resname} size="small" label={l.resname} sx={{ mr: 0.5 }} />
                            ))}
                          </TableCell>
                        </TableRow>
                      )}
                      {data.strippedResidues &&
                        Object.keys(data.strippedResidues).length > 0 && (
                          <TableRow>
                            <TableCell sx={{ color: 'text.secondary' }}>Stripped</TableCell>
                            <TableCell>
                              {Object.entries(data.strippedResidues)
                                .map(([k, v]) => `${k}×${v}`)
                                .join(', ')}
                            </TableCell>
                          </TableRow>
                        )}
                    </TableBody>
                  </Table>
                  {(data.ligandWarnings ?? []).map((w, i) => (
                    <Alert key={i} severity="warning" sx={{ mt: 1 }}>
                      {w}
                    </Alert>
                  ))}
                </Box>
              </Grid>

              <Grid size={{ xs: 12, md: 6 }}>
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 1 }}>
                  <Typography variant="subtitle2">
                    Protonation ({data.protonationMethod})
                  </Typography>
                  <TextField
                    size="small"
                    type="number"
                    label="pH"
                    value={ph}
                    onChange={(e) => setPh(Number(e.target.value))}
                    sx={{ width: 90 }}
                    slotProps={{ htmlInput: { step: 0.5, min: 0, max: 14 } }}
                  />
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={onReprepare}
                    disabled={isReprepping}
                  >
                    {isReprepping ? 'Re-preparing…' : 'Re-prepare'}
                  </Button>
                </Box>
                <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell>Residue</TableCell>
                        <TableCell>pKa</TableCell>
                        <TableCell>State</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {table.map((r) => (
                        <TableRow key={r.key}>
                          <TableCell>
                            {r.residue} {r.resSeq}
                            {r.chain ? ` (${r.chain})` : ''}
                          </TableCell>
                          <TableCell>{r.pKa ?? '—'}</TableCell>
                          <TableCell>
                            <TextField
                              select
                              size="small"
                              value={overrides[r.key] ?? r.state}
                              onChange={(e) =>
                                setOverrides((o) => ({ ...o, [r.key]: e.target.value }))
                              }
                              sx={{ minWidth: 110 }}
                            >
                              {r.choices.map((c) => (
                                <MenuItem key={c} value={c}>
                                  {c}
                                </MenuItem>
                              ))}
                            </TextField>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  Change a state and click Re-prepare to preview it, or just Run MD
                  (edits are applied when the job prepares).
                </Typography>

                <Box sx={{ mt: 2, display: 'flex', gap: 2 }}>
                  <Button variant="outlined" onClick={() => navigate('/dashboard/jobs/automd-saxs')}>
                    Back to setup
                  </Button>
                  <Button
                    variant="contained"
                    onClick={onRunMD}
                    disabled={isRunning}
                  >
                    {isRunning ? 'Submitting…' : 'Run MD'}
                  </Button>
                </Box>
              </Grid>
            </Grid>
          )}
        </Paper>
      </Grid>
    </Grid>
  )
}

export default AutoMDSAXSReviewPage
