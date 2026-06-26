import { useEffect, useRef, useState, useCallback } from 'react'
import { Box, Typography, CircularProgress, Alert } from '@mui/material'
import {
  useAddCarbonaraInitFoxsMutation,
  useLazyGetCarbonaraInitFoxsQuery
} from 'slices/jobsApiSlice'
import InitialFitChart from './InitialFitChart'

interface CarbonaraInitFitCheckProps {
  // The structure to fit. For Structure 1 this is the Formik pdb_file value;
  // for additional mixture structures it is the uploaded File.
  pdbFile: File | string
  datFile: File | string
  maxQ: number
  // Optional header label (e.g. "Structure 2") so a mixture run can show one
  // labelled check per uploaded structure.
  label?: string
}

// Self-contained initial scattering check: submits an initfoxs preview for one
// structure + SAXS curve, polls for the result and renders the χ²/fit chart.
// Fires (debounced) whenever the inputs change. Rendering one of these per
// uploaded structure gives every mixture structure its own labelled check.
const CarbonaraInitFitCheck = ({
  pdbFile,
  datFile,
  maxQ,
  label
}: CarbonaraInitFitCheckProps) => {
  const [addCarbonaraInitFoxs] = useAddCarbonaraInitFoxsMutation()
  const [triggerGetPreview] = useLazyGetCarbonaraInitFoxsQuery()

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>(
    'idle'
  )
  const [chi2, setChi2] = useState<number | null>(null)
  const [c1, setC1] = useState<number | null>(null)
  const [c2, setC2] = useState<number | null>(null)
  const [foxs, setFoxs] = useState<
    { q: number; exp: number; model: number; error: number }[] | null
  >(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPreview = useCallback(
    async (pdb: File | string, dat: File | string, q: number) => {
      setStatus('loading')
      setChi2(null)
      setC1(null)
      setC2(null)
      setFoxs(null)
      setErrorMsg(null)
      stopPoll()

      let previewId: string
      try {
        const form = new FormData()
        form.append('pdb_file', pdb)
        form.append('dat_file', dat)
        form.append('max_q', String(q))
        const result = await addCarbonaraInitFoxs(form).unwrap()
        previewId = result.previewId
      } catch {
        setStatus('error')
        setErrorMsg('Failed to submit preview request')
        return
      }

      const started = Date.now()
      const CAP_MS = 60_000

      pollRef.current = setInterval(async () => {
        if (Date.now() - started > CAP_MS) {
          stopPoll()
          setStatus('error')
          setErrorMsg('Preview timed out (60 s)')
          return
        }
        try {
          const data = await triggerGetPreview(previewId).unwrap()
          if (data.status === 'done') {
            stopPoll()
            setChi2(data.chi2 ?? null)
            setC1(data.c1 ?? null)
            setC2(data.c2 ?? null)
            setFoxs(data.foxs ?? null)
            setStatus('done')
          } else if (data.status === 'error') {
            stopPoll()
            setStatus('error')
            setErrorMsg(data.message ?? 'Preview failed')
          }
          // status === 'pending': keep polling
        } catch {
          // transient fetch error: keep polling until cap
        }
      }, 2000)
    },
    [addCarbonaraInitFoxs, triggerGetPreview, stopPoll]
  )

  // Fire (debounced) on input change. A render-time trigger would re-fire on
  // every state update (incl. completion), so this is driven by an effect.
  useEffect(() => {
    if (!pdbFile || !datFile) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      startPreview(pdbFile, datFile, maxQ).catch(() => undefined)
    }, 600)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [pdbFile, datFile, maxQ, startPreview])

  // Stop polling when unmounted.
  useEffect(() => stopPoll, [stopPoll])

  if (status === 'idle') return null

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        p: 2,
        my: 2
      }}
    >
      <Typography
        variant="subtitle2"
        sx={{ mb: 1, fontWeight: 600 }}
      >
        Initial scattering check{label ? ` — ${label}` : ''}
      </Typography>

      {status === 'loading' && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={16} />
          <Typography
            variant="body2"
            color="text.secondary"
          >
            Running initial FoXS fit…
          </Typography>
        </Box>
      )}

      {status === 'error' && (
        <Alert
          severity="info"
          variant="outlined"
          sx={{ mt: 1 }}
        >
          Initial check unavailable: {errorMsg}
        </Alert>
      )}

      {status === 'done' && foxs && (
        <>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {'Initial χ² = '}
            <strong>{chi2 != null ? chi2.toFixed(3) : 'N/A'}</strong>
            {c1 != null ? ` · c1 = ${c1.toFixed(2)}` : ''}
            {c2 != null ? ` · c2 = ${c2.toFixed(4)}` : ''}
          </Typography>
          <InitialFitChart
            data={foxs.map((p) => ({
              q: p.q,
              exp_intensity: p.exp,
              model_intensity: p.model,
              error: p.error
            }))}
            residualsData={foxs.map((p) => ({
              q: p.q,
              res:
                p.error !== 0
                  ? Number(((p.exp - p.model) / p.error).toFixed(2))
                  : 0
            }))}
          />
        </>
      )}
    </Box>
  )
}

export default CarbonaraInitFitCheck
