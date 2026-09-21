import { useRef, useState } from 'react'
import { Box, Button, Alert, CircularProgress } from '@mui/material'
import BuildIcon from '@mui/icons-material/Build'
import {
  useAddCarbonaraPdbfixerMutation,
  useLazyGetCarbonaraPdbfixerQuery
} from 'slices/jobsApiSlice'

interface CarbonaraPdbfixerButtonProps {
  // The form stores the uploaded structure in a string-typed field but assigns a
  // File at runtime; accept both and render nothing unless it's a real File.
  pdbFile: File | string
  // Which source(s) detected the gaps (for the label).
  sources: string[]
  // Called with the repaired structure so the form swaps it in as pdb_file.
  onFixed: (fixed: File) => void
  disabled?: boolean
}

const POLL_MS = 2000
const MAX_POLLS = 60 // ~2 min

// A single "Build missing residues (PDBFixer)" action: uploads the structure,
// runs PDBFixer on the worker, and (on success) hands the repaired structure back
// to the form. Reports success/failure inline.
const CarbonaraPdbfixerButton = ({
  pdbFile,
  sources,
  onFixed,
  disabled
}: CarbonaraPdbfixerButtonProps) => {
  const [addPdbfixer] = useAddCarbonaraPdbfixerMutation()
  const [triggerGet] = useLazyGetCarbonaraPdbfixerQuery()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{
    severity: 'success' | 'error'
    text: string
  } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const handleClick = async () => {
    if (!(pdbFile instanceof File)) return
    setMessage(null)
    setBusy(true)
    try {
      const form = new FormData()
      form.append('pdb_file', pdbFile)
      const { previewId } = await addPdbfixer(form).unwrap()

      let polls = 0
      pollRef.current = setInterval(async () => {
        polls += 1
        try {
          const data = await triggerGet(previewId).unwrap()
          if (data.status === 'pending') {
            if (polls >= MAX_POLLS) {
              stopPoll()
              setBusy(false)
              setMessage({ severity: 'error', text: 'PDBFixer timed out.' })
            }
            return
          }
          stopPoll()
          setBusy(false)
          if (data.status === 'done' && data.success && data.fixed_pdb) {
            const fixed = new File([data.fixed_pdb], pdbFile.name, {
              type: 'chemical/x-pdb'
            })
            onFixed(fixed)
            const n = data.residues_built ?? 0
            setMessage({
              severity: 'success',
              text: `Built in ${n} missing residue${
                n === 1 ? '' : 's'
              } — the structure has been updated for this job.`
            })
          } else {
            setMessage({
              severity: 'error',
              text: `PDBFixer failed: ${data.message ?? 'unknown error'}`
            })
          }
        } catch {
          // transient fetch error: keep polling until the cap
          if (polls >= MAX_POLLS) {
            stopPoll()
            setBusy(false)
            setMessage({ severity: 'error', text: 'PDBFixer timed out.' })
          }
        }
      }, POLL_MS)
    } catch (err) {
      setBusy(false)
      setMessage({
        severity: 'error',
        text: `Could not start PDBFixer: ${
          err instanceof Error ? err.message : String(err)
        }`
      })
    }
  }

  // Hooks above run unconditionally; only the render is gated on a real File.
  if (!(pdbFile instanceof File)) return null

  return (
    <Box sx={{ mt: 1 }}>
      <Button
        variant="contained"
        color="warning"
        size="small"
        startIcon={
          busy ? <CircularProgress size={16} color="inherit" /> : <BuildIcon />
        }
        disabled={busy || disabled}
        onClick={() => void handleClick()}
      >
        {busy
          ? 'Building missing residues…'
          : `Build in the missing residues with PDBFixer (detected via ${sources.join(
              ' and '
            )})`}
      </Button>
      {message && (
        <Alert
          severity={message.severity}
          sx={{ mt: 1 }}
        >
          {message.text}
        </Alert>
      )}
    </Box>
  )
}

export default CarbonaraPdbfixerButton
