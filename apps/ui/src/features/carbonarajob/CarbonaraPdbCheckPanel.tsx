import { useEffect, useState } from 'react'
import {
  Box,
  Alert,
  AlertTitle,
  Button,
  Typography,
  CircularProgress
} from '@mui/material'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import {
  checkCarbonaraStructure,
  renumberStructureFromOne,
  stripHetatms,
  type PdbCheckResult
} from './carbonaraPdbCheck'

interface CarbonaraPdbCheckPanelProps {
  // The uploaded structure: a Formik File value, or '' when none selected.
  pdbFile: File | string
  // Called with a rewritten File when the user applies a fix, so the form can
  // replace the uploaded structure.
  onFix?: (file: File) => void
}

const findingList = (items: { code: string; message: string }[]) => (
  <Box
    component="ul"
    sx={{ m: 0, pl: 2.5 }}
  >
    {items.map((f) => (
      <li key={f.code + f.message}>
        <Typography variant="body2">{f.message}</Typography>
      </li>
    ))}
  </Box>
)

// Runs the client-side Carbonara compatibility check whenever the uploaded
// structure changes and shows any errors/warnings inline in Block 1. Offers a
// one-click fix for issues that have one (currently: renumber from residue 1).
const CarbonaraPdbCheckPanel = ({
  pdbFile,
  onFix
}: CarbonaraPdbCheckPanelProps) => {
  const [result, setResult] = useState<PdbCheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [fixing, setFixing] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!(pdbFile instanceof File)) {
      setResult(null)
      return
    }
    setLoading(true)
    pdbFile
      .text()
      .then((text) => {
        if (cancelled) return
        setResult(checkCarbonaraStructure(pdbFile.name, text))
      })
      .catch(() => {
        if (!cancelled) setResult(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [pdbFile])

  // Apply a pure (text -> {text}) fixer and feed the rewritten file back to the
  // form. Keeps the original filename so the rest of the form/job is unaffected.
  const applyFix = async (
    fixer: (text: string) => { text: string } | null
  ) => {
    if (!(pdbFile instanceof File) || !onFix) return
    setFixing(true)
    try {
      const text = await pdbFile.text()
      const fixed = fixer(text)
      if (fixed) {
        onFix(
          new File([fixed.text], pdbFile.name, {
            type: pdbFile.type || 'chemical/x-pdb'
          })
        )
      }
    } finally {
      setFixing(false)
    }
  }

  if (!(pdbFile instanceof File)) return null
  if (loading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 2 }}>
        <CircularProgress size={16} />
        <Typography variant="body2">Checking structure…</Typography>
      </Box>
    )
  }
  if (!result) return null

  const { ran, errors, warnings, info } = result
  const clean = ran && errors.length === 0 && warnings.length === 0
  const canRenumber =
    !!onFix && errors.some((e) => e.code === 'not-start-1')
  const canStripHet = !!onFix && warnings.some((w) => w.code === 'hetatm')

  return (
    <Box sx={{ my: 2 }}>
      <Typography
        variant="subtitle2"
        sx={{ mb: 1, fontWeight: 600 }}
      >
        Carbonara compatibility check
      </Typography>

      {errors.length > 0 && (
        <Alert
          severity="error"
          sx={{ mb: 1 }}
        >
          <AlertTitle>
            Likely to fail Carbonara — fix before submitting
          </AlertTitle>
          {findingList(errors)}
          {canRenumber && (
            <Button
              size="small"
              variant="contained"
              color="primary"
              startIcon={<AutoFixHighIcon />}
              disabled={fixing}
              onClick={() => void applyFix(renumberStructureFromOne)}
              sx={{ mt: 1 }}
            >
              {fixing ? 'Working…' : 'Fix: renumber from residue 1'}
            </Button>
          )}
        </Alert>
      )}

      {warnings.length > 0 && (
        <Alert
          severity="warning"
          sx={{ mb: 1 }}
        >
          <AlertTitle>May change or drop data</AlertTitle>
          {findingList(warnings)}
          {canStripHet && (
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              startIcon={<AutoFixHighIcon />}
              disabled={fixing}
              onClick={() => void applyFix(stripHetatms)}
              sx={{ mt: 1 }}
            >
              {fixing ? 'Working…' : 'Fix: remove HETATM (waters/ligands)'}
            </Button>
          )}
        </Alert>
      )}

      {clean && (
        <Alert
          severity="success"
          sx={{ mb: 1 }}
        >
          No compatibility issues detected.
        </Alert>
      )}

      {info.length > 0 && (
        <Alert
          severity="info"
          sx={{ mb: 1 }}
        >
          {findingList(info)}
        </Alert>
      )}
    </Box>
  )
}

export default CarbonaraPdbCheckPanel
