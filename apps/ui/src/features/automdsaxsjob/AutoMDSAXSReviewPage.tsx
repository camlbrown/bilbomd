import { useParams } from 'react-router'
import {
  Box,
  Paper,
  Typography,
  Alert,
  CircularProgress,
  Table,
  TableBody,
  TableRow,
  TableCell,
  Chip
} from '@mui/material'
import Grid from '@mui/material/Grid'
import HeaderBox from 'components/HeaderBox'
import useTitle from 'hooks/useTitle'
import { useGetAutoMDSaxsPrepQuery } from 'slices/jobsApiSlice'
import AutoMDSAXSStructureViewer from './AutoMDSAXSStructureViewer'

// Task 4 layer 4: review the PREPARED structure before running the MD. The
// protonation-edit table + "Run MD" submission are added in layer 5.
const AutoMDSAXSReviewPage = () => {
  useTitle('BilboMD: Review prepared structure')
  const { previewId } = useParams<{ previewId: string }>()

  const { data, isLoading } = useGetAutoMDSaxsPrepQuery(previewId ?? '', {
    skip: !previewId,
    // poll until the prep worker finishes
    pollingInterval: 4000
  })

  const preparing = isLoading || !data || data.status === 'pending'

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12 }}>
        <HeaderBox>
          <Typography>Review prepared structure</Typography>
        </HeaderBox>
        <Paper sx={{ p: 2 }}>
          <Alert severity="info" sx={{ mb: 2 }}>
            Check the prepared structure below — protonation, kept ions/ligands,
            and stripped content — before running the simulation. Preparation is a
            best-effort automated step and should be verified.
          </Alert>

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
              <Grid size={{ xs: 12, md: 7 }}>
                <AutoMDSAXSStructureViewer
                  url={`/jobs/automd-saxs-prep/${previewId}/prepared`}
                  height={460}
                />
              </Grid>
              <Grid size={{ xs: 12, md: 5 }}>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Preparation summary
                </Typography>
                <Table size="small">
                  <TableBody>
                    <TableRow>
                      <TableCell sx={{ color: 'text.secondary' }}>
                        Protonation
                      </TableCell>
                      <TableCell>
                        {data.protonationMethod} ·{' '}
                        {(data.protonationChanges ?? []).length} adjusted residues
                      </TableCell>
                    </TableRow>
                    {data.ions && Object.keys(data.ions).length > 0 && (
                      <TableRow>
                        <TableCell sx={{ color: 'text.secondary' }}>
                          Ions kept
                        </TableCell>
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
                            <Chip
                              key={l.resname}
                              size="small"
                              label={`${l.resname} (${l.formalCharge >= 0 ? '+' : ''}${l.formalCharge})`}
                              sx={{ mr: 0.5 }}
                            />
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
                    {data.nonstandardResidues &&
                      data.nonstandardResidues.length > 0 && (
                        <TableRow>
                          <TableCell sx={{ color: 'text.secondary' }}>
                            Modified residues
                          </TableCell>
                          <TableCell>
                            {data.nonstandardResidues.length} converted (e.g.
                            MSE→MET)
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
                <Alert severity="info" sx={{ mt: 2 }}>
                  Per-residue protonation editing + &ldquo;Run MD&rdquo; land in the
                  next update.
                </Alert>
              </Grid>
            </Grid>
          )}
        </Paper>
      </Grid>
    </Grid>
  )
}

export default AutoMDSAXSReviewPage
