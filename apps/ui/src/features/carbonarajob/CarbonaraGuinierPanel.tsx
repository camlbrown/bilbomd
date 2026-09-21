import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  IconButton,
  Alert,
  AlertTitle,
  CircularProgress,
  Typography,
  Stack,
  Chip,
  Divider
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import ContentCutIcon from '@mui/icons-material/ContentCut'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import {
  useAddCarbonaraGuinierMutation,
  useLazyGetCarbonaraGuinierQuery
} from 'slices/jobsApiSlice'
import GuinierChart from './GuinierChart'
import {
  parseSaxsDat,
  guinierFit,
  trimSaxsText,
  type SaxsPoint
} from './carbonaraGuinierMath'

interface CarbonaraGuinierPanelProps {
  // Form stores the .dat in a string-typed field but assigns a File at runtime.
  datFile: File | string
  // Replace the job's SAXS data (trimmed or reverted). The form also clears the
  // job-side guinier_trim flag, since the trim is now baked into the data.
  onDatChange: (file: File) => void
  disabled?: boolean
}

const POLL_MS = 2000
const MAX_POLLS = 60
const MIN_WINDOW = 3

// Interactive Guinier panel. Hidden until the user clicks "Run Guinier fit", which
// auto-selects the Guinier region (worker AutoRg-style scan) and plots ONLY that
// region: ln I vs q² with the linear fit, plus residuals below. The user then
// nudges the window ends point-by-point and watches the residuals. Applying the
// trim replaces the job's SAXS data with the trimmed curve — which makes the
// initial FoXS scattering check above re-run on it, exactly like the notebooks.
const CarbonaraGuinierPanel = ({
  datFile,
  onDatChange,
  disabled
}: CarbonaraGuinierPanelProps) => {
  const [addGuinier] = useAddCarbonaraGuinierMutation()
  const [triggerGet] = useLazyGetCarbonaraGuinierQuery()

  const [pts, setPts] = useState<SaxsPoint[] | null>(null)
  const [fitWin, setFitWin] = useState<[number, number] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState<{ trimmed: number } | null>(null)

  // The panel always works from the ORIGINAL upload; the trimmed/reverted files it
  // emits are tracked here so its own dat_file writes don't re-snapshot the data.
  const originalFileRef = useRef<File | null>(null)
  const originalTextRef = useRef<string>('')
  const ownFileRef = useRef<File | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  // Snapshot + parse whenever a NEW SAXS file is uploaded (ignore our own writes).
  // Collapses the panel back to the button so a new curve starts fresh.
  useEffect(() => {
    let cancelled = false
    if (!(datFile instanceof File)) {
      setPts(null)
      setFitWin(null)
      return
    }
    if (datFile === ownFileRef.current) return // our own trim/revert output
    setError(null)
    setApplied(null)
    setFitWin(null)
    void (async () => {
      const text = await datFile.text()
      if (cancelled) return
      const parsed = parseSaxsDat(text)
      originalFileRef.current = datFile
      originalTextRef.current = text
      setPts(parsed)
    })()
    return () => {
      cancelled = true
    }
  }, [datFile])

  useEffect(() => stopPoll, [])

  const fit = useMemo(
    () => (pts && fitWin ? guinierFit(pts, fitWin[0], fitWin[1]) : null),
    [pts, fitWin]
  )

  // Run the worker's AutoRg-style selection and reveal the fit at that region.
  const handleRun = async () => {
    const file = originalFileRef.current
    if (!file || !pts) return
    setError(null)
    setBusy(true)
    try {
      const form = new FormData()
      form.append('dat_file', file)
      const { previewId } = await addGuinier(form).unwrap()
      let polls = 0
      pollRef.current = setInterval(async () => {
        polls += 1
        try {
          const data = await triggerGet(previewId).unwrap()
          if (data.status === 'pending') {
            if (polls >= MAX_POLLS) {
              stopPoll()
              setBusy(false)
              setError('Guinier analysis timed out.')
            }
            return
          }
          stopPoll()
          setBusy(false)
          if (
            data.status === 'done' &&
            data.first_point_1_indexed != null &&
            data.last_point_1_indexed != null
          ) {
            const start = Math.max(0, data.first_point_1_indexed - 1)
            const end = Math.min(pts.length - 1, data.last_point_1_indexed - 1)
            setFitWin([start, Math.max(end, start + MIN_WINDOW - 1)])
          } else {
            setError(data.message ?? 'No acceptable Guinier region found.')
          }
        } catch {
          if (polls >= MAX_POLLS) {
            stopPoll()
            setBusy(false)
            setError('Guinier analysis timed out.')
          }
        }
      }, POLL_MS)
    } catch (err) {
      setBusy(false)
      setError(
        `Could not run Guinier analysis: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  // Point-by-point window nudges (keep ≥ MIN_WINDOW points, stay in bounds).
  const nudgeStart = (delta: number) => {
    if (!pts || !fitWin) return
    const start = Math.min(
      Math.max(0, fitWin[0] + delta),
      fitWin[1] - (MIN_WINDOW - 1)
    )
    setFitWin([start, fitWin[1]])
  }
  const nudgeEnd = (delta: number) => {
    if (!pts || !fitWin) return
    const end = Math.max(
      Math.min(pts.length - 1, fitWin[1] + delta),
      fitWin[0] + (MIN_WINDOW - 1)
    )
    setFitWin([fitWin[0], end])
  }

  const handleApply = () => {
    if (!pts || !fitWin) return
    const startIdx = fitWin[0]
    const qMin = pts[startIdx]?.q ?? 0
    const trimmedText = trimSaxsText(originalTextRef.current, qMin)
    const name = originalFileRef.current?.name ?? 'saxs.dat'
    const trimmed = new File([trimmedText], name, { type: 'chemical/x-saxs' })
    ownFileRef.current = trimmed
    onDatChange(trimmed)
    setApplied({ trimmed: startIdx })
  }

  const handleRevert = () => {
    const orig = originalFileRef.current
    if (!orig) return
    ownFileRef.current = orig
    onDatChange(orig)
    setApplied(null)
  }

  if (!(datFile instanceof File)) return null

  const windowPoints =
    pts && fitWin ? pts.slice(fitWin[0], fitWin[1] + 1) : []

  const StepControl = ({
    label,
    qValue,
    idx,
    onMinus,
    onPlus
  }: {
    label: string
    qValue: number
    idx: number
    onMinus: () => void
    onPlus: () => void
  }) => (
    <Stack
      direction="row"
      sx={{ gap: 0.5, alignItems: 'center' }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ minWidth: 96 }}
      >
        {label}
      </Typography>
      <IconButton
        size="small"
        disabled={disabled}
        onClick={onMinus}
      >
        <RemoveIcon fontSize="inherit" />
      </IconButton>
      <Typography
        variant="body2"
        sx={{ minWidth: 132, textAlign: 'center' }}
      >
        pt {idx + 1} · q = {qValue.toPrecision(3)}
      </Typography>
      <IconButton
        size="small"
        disabled={disabled}
        onClick={onPlus}
      >
        <AddIcon fontSize="inherit" />
      </IconButton>
    </Stack>
  )

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
        sx={{ mb: 0.5, fontWeight: 600 }}
      >
        Guinier analysis & low-q trim (optional)
      </Typography>

      {!fitWin && (
        <>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 1 }}
          >
            Run a Guinier fit on the SAXS curve to inspect Rg and (optionally)
            trim the low-q region before fitting.
          </Typography>
          <Button
            variant="contained"
            size="small"
            startIcon={
              busy ? (
                <CircularProgress
                  size={16}
                  color="inherit"
                />
              ) : (
                <AutoFixHighIcon />
              )
            }
            disabled={!pts || busy || disabled}
            onClick={() => void handleRun()}
          >
            {busy ? 'Running Guinier fit…' : 'Run Guinier fit'}
          </Button>
        </>
      )}

      {error && (
        <Alert
          severity="error"
          sx={{ mt: 1 }}
        >
          {error}
        </Alert>
      )}

      {pts && fitWin && (
        <>
          <GuinierChart
            points={windowPoints.map((p) => ({ q2: p.q2, lnI: p.lnI }))}
            slope={fit?.slope ?? 0}
            intercept={fit?.intercept ?? 0}
            residuals={fit?.residuals ?? []}
            residualsWeighted={fit?.weighted ?? false}
          />

          <Stack sx={{ gap: 0.5, mt: 1 }}>
            <StepControl
              label="First point"
              idx={fitWin[0]}
              qValue={pts[fitWin[0]]?.q ?? 0}
              onMinus={() => nudgeStart(-1)}
              onPlus={() => nudgeStart(1)}
            />
            <StepControl
              label="Last point"
              idx={fitWin[1]}
              qValue={pts[fitWin[1]]?.q ?? 0}
              onMinus={() => nudgeEnd(-1)}
              onPlus={() => nudgeEnd(1)}
            />
          </Stack>

          <Stack
            direction="row"
            sx={{ gap: 1, flexWrap: 'wrap', mt: 1 }}
          >
            <Chip
              size="small"
              color={fit?.valid ? 'primary' : 'default'}
              variant="outlined"
              label={`Rg = ${(fit?.rg ?? 0).toFixed(1)} Å`}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`I(0) = ${(fit?.i0 ?? 0).toPrecision(3)}`}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`R² = ${(fit?.r2 ?? 0).toFixed(4)}`}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`qRg = ${(fit?.qrgMin ?? 0).toFixed(2)}–${(
                fit?.qrgMax ?? 0
              ).toFixed(2)}`}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`${fitWin[1] - fitWin[0] + 1} points`}
            />
          </Stack>

          {!fit?.valid && (
            <Alert
              severity="warning"
              sx={{ mt: 1 }}
            >
              This window has no valid Guinier fit (needs ≥{MIN_WINDOW} points and
              a negative slope). Widen or shift it.
            </Alert>
          )}

          <Divider sx={{ my: 1.5 }} />

          <Stack
            direction="row"
            sx={{ gap: 1, flexWrap: 'wrap' }}
          >
            <Button
              variant="contained"
              color="warning"
              size="small"
              startIcon={<ContentCutIcon />}
              disabled={disabled || fitWin[0] === 0}
              onClick={handleApply}
            >
              Apply trim &amp; update scattering check
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RestartAltIcon />}
              disabled={disabled || !applied}
              onClick={handleRevert}
            >
              Revert to full data
            </Button>
            <Button
              variant="text"
              size="small"
              startIcon={
                busy ? (
                  <CircularProgress
                    size={16}
                    color="inherit"
                  />
                ) : (
                  <AutoFixHighIcon />
                )
              }
              disabled={disabled || busy}
              onClick={() => void handleRun()}
            >
              Re-run auto
            </Button>
          </Stack>

          {applied && (
            <Alert
              severity="success"
              sx={{ mt: 1 }}
            >
              <AlertTitle>
                Trimmed {applied.trimmed} low-q point
                {applied.trimmed === 1 ? '' : 's'}
              </AlertTitle>
              The trimmed SAXS curve is now the job&apos;s data — the initial
              scattering check above has re-run on it. Use “Revert to full data”
              to undo.
            </Alert>
          )}
        </>
      )}
    </Box>
  )
}

export default CarbonaraGuinierPanel
