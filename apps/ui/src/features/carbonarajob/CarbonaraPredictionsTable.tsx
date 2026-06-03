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
  Alert
} from '@mui/material'
import StarIcon from '@mui/icons-material/Star'
import CarbonaraStructureViewer from './CarbonaraStructureViewer'
import { useLazyGetCarbonaraAaPdbQuery } from 'slices/jobsApiSlice'
import type { CarbonaraAnalysisPrediction } from 'slices/jobsApiSlice'

type SortKey = keyof Pick<
  CarbonaraAnalysisPrediction,
  'chi2' | 'rg' | 'rmsd_to_original' | 'tm_to_original'
>

interface CarbonaraPredictionsTableProps {
  jobId: string
  predictions: CarbonaraAnalysisPrediction[]
  bestId?: string
}

const CarbonaraPredictionsTable = ({
  jobId,
  predictions,
  bestId
}: CarbonaraPredictionsTableProps) => {
  const [sortKey, setSortKey] = useState<SortKey>('chi2')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pdbText, setPdbText] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [isFetching, setIsFetching] = useState(false)

  const [triggerFetch] = useLazyGetCarbonaraAaPdbQuery()

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
    { key: 'chi2', label: 'χ²' },
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
          <Typography
            variant="subtitle2"
            gutterBottom
          >
            3D view — {selectedId}
          </Typography>
          {isFetching && <CircularProgress size={24} />}
          {fetchError && <Alert severity="error">{fetchError}</Alert>}
          {!isFetching && !fetchError && pdbText && (
            <CarbonaraStructureViewer
              structureFile={pdbText}
              height={400}
            />
          )}
        </Box>
      )}
    </Paper>
  )
}

export default CarbonaraPredictionsTable
