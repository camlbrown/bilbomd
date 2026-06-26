import { useState, useCallback } from 'react'
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  CircularProgress,
  Alert,
  FormControlLabel,
  Switch
} from '@mui/material'
import StarIcon from '@mui/icons-material/Star'
import CarbonaraStructureViewer from './CarbonaraStructureViewer'
import {
  useLazyGetCarbonaraAaPdbQuery,
  useLazyGetCarbonaraOriginalPdbQuery
} from 'slices/jobsApiSlice'
import type { CarbonaraAnalysisPrediction } from 'slices/jobsApiSlice'

type SortKey = keyof Pick<
  CarbonaraAnalysisPrediction,
  'chi2' | 'rg' | 'rmsd_to_original' | 'tm_to_original'
>

interface CarbonaraPredictionsTableProps {
  jobId: string
  predictions: CarbonaraAnalysisPrediction[]
  bestId?: string
  // When set (mixture jobs), adds a "Derived from" column mapping each model's
  // species index to the structure it came from.
  structureNameForSub?: (sub: number) => string | undefined
}

// Recover the species index from a model id like "mol1_sub_0_end".
const subOfModel = (id: string): number | null => {
  const m = id.match(/_sub_(\d+)/)
  return m ? Number(m[1]) : null
}

const CarbonaraPredictionsTable = ({
  jobId,
  predictions,
  bestId,
  structureNameForSub
}: CarbonaraPredictionsTableProps) => {
  const [sortKey, setSortKey] = useState<SortKey>('chi2')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pdbText, setPdbText] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [isFetching, setIsFetching] = useState(false)
  // Original-structure overlay (fetched once per job, then cached).
  const [overlayEnabled, setOverlayEnabled] = useState(false)
  const [originalPdb, setOriginalPdb] = useState<string | null>(null)
  const [overlayFetching, setOverlayFetching] = useState(false)
  const [overlayError, setOverlayError] = useState<string | null>(null)

  const [triggerFetch] = useLazyGetCarbonaraAaPdbQuery()
  const [triggerOriginal] = useLazyGetCarbonaraOriginalPdbQuery()

  const handleToggleOverlay = useCallback(
    async (enabled: boolean) => {
      setOverlayEnabled(enabled)
      setOverlayError(null)
      // Lazily fetch the original structure the first time it's switched on.
      if (enabled && originalPdb === null) {
        setOverlayFetching(true)
        try {
          const result = await triggerOriginal(jobId)
          if (result.data) {
            setOriginalPdb(result.data)
          } else {
            setOverlayError('Could not load the original structure.')
          }
        } catch {
          setOverlayError('Could not load the original structure.')
        } finally {
          setOverlayFetching(false)
        }
      }
    },
    [jobId, originalPdb, triggerOriginal]
  )

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const handleSelect = useCallback(
    async (pred: CarbonaraAnalysisPrediction) => {
      if (selectedId === pred.id) {
        // Deselect
        setSelectedId(null)
        setPdbText(null)
        return
      }
      setSelectedId(pred.id)
      setPdbText(null)
      setFetchError(null)
      setIsFetching(true)
      try {
        const result = await triggerFetch({
          jobId,
          pdbPath: pred.aa_pdb
        })
        if (result.data) {
          setPdbText(result.data)
        } else if (result.error) {
          setFetchError('Could not load PDB for this model.')
        }
      } catch {
        setFetchError('Could not load PDB for this model.')
      } finally {
        setIsFetching(false)
      }
    },
    [jobId, selectedId, triggerFetch]
  )

  const sorted = [...predictions].sort((a, b) => {
    const valA = a[sortKey]
    const valB = b[sortKey]
    return sortDir === 'asc' ? valA - valB : valB - valA
  })

  const columns: { key: SortKey; label: string }[] = [
    { key: 'chi2', label: 'FoXS χ²' },
    { key: 'rg', label: 'Rg (Å)' },
    { key: 'rmsd_to_original', label: 'RMSD to orig (Å)' },
    { key: 'tm_to_original', label: 'TM to orig' }
  ]

  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, mb: 2 }}
    >
      <Typography
        variant="h6"
        gutterBottom
      >
        Predictions — click a row to view in 3D
      </Typography>
      <TableContainer>
        <Table
          size="small"
          sx={{ mb: 1 }}
        >
          <TableHead>
            <TableRow>
              <TableCell>Model</TableCell>
              {structureNameForSub && <TableCell>Derived from</TableCell>}
              {columns.map((col) => (
                <TableCell
                  key={col.key}
                  sortDirection={sortKey === col.key ? sortDir : false}
                >
                  <TableSortLabel
                    active={sortKey === col.key}
                    direction={sortKey === col.key ? sortDir : 'asc'}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.label}
                  </TableSortLabel>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted.map((pred) => {
              const isBest = pred.id === bestId
              const isSelected = pred.id === selectedId
              return (
                <TableRow
                  key={pred.id}
                  selected={isSelected}
                  hover
                  onClick={() => void handleSelect(pred)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.5
                      }}
                    >
                      {isBest && (
                        <StarIcon
                          fontSize="small"
                          sx={{ color: 'gold' }}
                          titleAccess="Best model"
                        />
                      )}
                      <Typography
                        variant="body2"
                        sx={{ fontFamily: 'monospace' }}
                      >
                        {pred.id}
                      </Typography>
                    </Box>
                  </TableCell>
                  {structureNameForSub && (
                    <TableCell>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                      >
                        {(() => {
                          const sub = subOfModel(pred.id)
                          const name =
                            sub != null ? structureNameForSub(sub) : undefined
                          return name ?? (sub != null ? `Species ${sub + 1}` : '—')
                        })()}
                      </Typography>
                    </TableCell>
                  )}
                  <TableCell>{pred.chi2.toFixed(4)}</TableCell>
                  <TableCell>{pred.rg.toFixed(2)}</TableCell>
                  <TableCell>{pred.rmsd_to_original.toFixed(2)}</TableCell>
                  <TableCell>{pred.tm_to_original.toFixed(4)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {/* 3D viewer for selected prediction */}
      {selectedId && (
        <Box sx={{ mt: 2 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 1
            }}
          >
            <Typography
              variant="subtitle2"
              gutterBottom
            >
              3D view — {selectedId}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {overlayFetching && <CircularProgress size={16} />}
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={overlayEnabled}
                    disabled={overlayFetching}
                    onChange={(e) => void handleToggleOverlay(e.target.checked)}
                  />
                }
                label="Overlay original (transparent grey)"
                slotProps={{ typography: { variant: 'body2' } }}
              />
            </Box>
          </Box>
          {overlayError && (
            <Alert
              severity="warning"
              sx={{ mb: 1 }}
            >
              {overlayError}
            </Alert>
          )}
          {isFetching && <CircularProgress size={24} />}
          {fetchError && <Alert severity="error">{fetchError}</Alert>}
          {!isFetching && !fetchError && pdbText && (
            <CarbonaraStructureViewer
              structureFile={pdbText}
              overlayStructure={
                overlayEnabled && originalPdb ? originalPdb : undefined
              }
              height={400}
            />
          )}
        </Box>
      )}
    </Paper>
  )
}

export default CarbonaraPredictionsTable
