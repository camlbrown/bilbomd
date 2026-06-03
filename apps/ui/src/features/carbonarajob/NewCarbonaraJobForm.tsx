import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Box,
  Button,
  TextField,
  Typography,
  Alert,
  Paper,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Checkbox,
  FormControlLabel,
  IconButton,
  Radio,
  RadioGroup,
  FormControl,
  FormLabel,
  CircularProgress,
  Chip,
  Stack,
  ToggleButton,
  ToggleButtonGroup
} from '@mui/material'
import Grid from '@mui/material/Grid'
import { Form, Formik, Field, FormikHelpers } from 'formik'
import FileSelect from 'features/jobs/FileSelect'
import {
  useAddNewCarbonaraJobMutation,
  useAddCarbonaraInitFoxsMutation,
  useLazyGetCarbonaraInitFoxsQuery,
  useAddCarbonaraAutoFlexMutation,
  useLazyGetCarbonaraAutoFlexQuery
} from 'slices/jobsApiSlice'
import SendIcon from '@mui/icons-material/Send'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import { bilbomdCarbonaraJobSchema } from 'schemas/CarbonaraValidationSchema'
import { Debug } from 'components/Debug'
import LinearProgress from '@mui/material/LinearProgress'
import HeaderBox from 'components/HeaderBox'
import useTitle from 'hooks/useTitle'
import JobSuccessAlert from 'features/jobs/JobSuccessAlert'
import InitialFitChart from 'features/carbonarajob/InitialFitChart'
import CarbonaraStructureViewer, {
  FlexSegment,
  ViewerConstraint
} from 'features/carbonarajob/CarbonaraStructureViewer'
import { carbonaraChainColorHex } from 'features/carbonarajob/carbonaraChainPalette'
import CarbonaraPaePlot from 'features/carbonarajob/CarbonaraPaePlot'

interface ConstraintPairRow {
  res1: string
  chain1: string
  res2: string
  chain2: string
  distance: string
}

// B7: one row in the manual flexibility range editor.
// chain is 1-based (chain 1 = first chain in the structure).
interface FlexRangeRow {
  chain: string
  start: string
  stop: string
}

interface CarbonaraJobFormValues {
  title: string
  pdb_file: string
  dat_file: string
  fit_n_times: number
  min_q: number
  max_q: number
  max_fit_steps: number
  all_atom: boolean
  do_foxs: boolean
  pae_file: string
  alphafold_flex: boolean
  pae_flex_threshold: number
  constraints_file: string
}

const emptyPairRow = (): ConstraintPairRow => ({
  res1: '',
  chain1: '',
  res2: '',
  chain2: '',
  distance: ''
})

const emptyFlexRow = (): FlexRangeRow => ({ chain: '1', start: '', stop: '' })

// Translate user-defined subunit groups (sets of chain ids merged into one rigid
// subunit) into the sequential, renumbering 1-based chain-index pairs that the
// Carbonara wrapper's apply_merges expects. chainOrder is the chains in document
// order (Carbonara numbers chains the same way). Merging (lo,hi) puts the result
// at lo and removes hi, so later positions shift down by one — we simulate that.
const groupsToMergePairs = (
  chainOrder: string[],
  groups: string[][]
): number[][] => {
  const current: string[][] = chainOrder.map((id) => [id])
  const pairs: number[][] = []
  const posOf = (id: string): number =>
    current.findIndex((arr) => arr.includes(id))
  for (const group of groups) {
    const members = group.filter((id) => chainOrder.includes(id))
    for (let m = 1; m < members.length; m++) {
      const a = posOf(members[0]!)
      const b = posOf(members[m]!)
      if (a < 0 || b < 0 || a === b) continue
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      pairs.push([lo + 1, hi + 1])
      current[lo] = [...current[lo]!, ...current[hi]!]
      current.splice(hi, 1)
    }
  }
  return pairs
}

// Surface the real reason a prepare-step submission failed (RTK Query throws an
// object with status/data) so an expired session etc. is visible rather than a
// generic message.
const submitErrorMessage = (err: unknown, what: string): string => {
  const e = err as { status?: number | string; data?: { message?: string } }
  if (e?.status === 401 || e?.status === 403) {
    return 'Your session expired — please reload and sign in again.'
  }
  const detail = e?.data?.message
  if (detail) return `Failed to submit ${what} request: ${detail}`
  if (e?.status) return `Failed to submit ${what} request (${e.status})`
  return `Failed to submit ${what} request`
}

// Parse a user constraints file into viewer constraints. One pair per line:
// "res1 chain1 res2 chain2 [distance]" — chains are letters, residues are the
// numbers shown in the viewer. Blank / '#'-comment / short lines are skipped.
const parseConstraintsText = (text: string): ViewerConstraint[] => {
  const out: ViewerConstraint[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const p = line.split(/\s+/)
    if (p.length < 4) continue
    const res1 = parseInt(p[0]!, 10)
    const chain1 = p[1]!
    const res2 = parseInt(p[2]!, 10)
    const chain2 = p[3]!
    if (Number.isFinite(res1) && Number.isFinite(res2) && chain1 && chain2) {
      out.push({ chain1, res1, chain2, res2 })
    }
  }
  return out
}

// Reads the uploaded constraints file (when file mode is active) and reports the
// parsed pairs. Rendered inside the Formik tree so it sees the current value.
const ConstraintsFileParser = ({
  file,
  active,
  onParsed
}: {
  file: File | string
  active: boolean
  onParsed: (c: ViewerConstraint[]) => void
}) => {
  useEffect(() => {
    let cancelled = false
    if (!active || !(file instanceof File)) {
      onParsed([])
      return
    }
    file
      .text()
      .then((t) => {
        if (!cancelled) onParsed(parseConstraintsText(t))
      })
      .catch(() => {
        if (!cancelled) onParsed([])
      })
    return () => {
      cancelled = true
    }
  }, [file, active, onParsed])
  return null
}

// B5: fire the initial-fit preview ONLY when the inputs actually change, via an
// effect — not from render. A render-time trigger re-fired on every state update
// (incl. preview completion), causing an infinite preview loop. Rendered inside
// the Formik tree so it sees current values; effect deps gate re-runs.
const InitialFitTrigger = ({
  pdbFile,
  datFile,
  maxQ,
  onTrigger
}: {
  pdbFile: string
  datFile: string
  maxQ: number
  onTrigger: (pdb: string, dat: string, maxQ: number) => void
}) => {
  useEffect(() => {
    if (pdbFile && datFile) {
      onTrigger(pdbFile, datFile, maxQ)
    }
  }, [pdbFile, datFile, maxQ, onTrigger])
  return null
}

const NewCarbonaraJobForm = () => {
  useTitle('BilboMD: New Carbonara Job')

  const [addNewCarbonaraJob, { isSuccess, data: jobResponse }] =
    useAddNewCarbonaraJobMutation()
  const [submitError, setSubmitError] = useState<string | null>(null)

  // B5: initial scattering check state
  const [addCarbonaraInitFoxs] = useAddCarbonaraInitFoxsMutation()
  const [triggerGetPreview] = useLazyGetCarbonaraInitFoxsQuery()
  const [previewStatus, setPreviewStatus] = useState<
    'idle' | 'loading' | 'done' | 'error'
  >('idle')
  const [previewChi2, setPreviewChi2] = useState<number | null>(null)
  const [previewC1, setPreviewC1] = useState<number | null>(null)
  const [previewC2, setPreviewC2] = useState<number | null>(null)
  const [previewFoxs, setPreviewFoxs] = useState<
    { q: number; exp: number; model: number; error: number }[] | null
  >(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  // Refs to track the active preview poll so we can cancel when inputs change
  const previewPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const previewIdRef = useRef<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopPreviewPoll = useCallback(() => {
    if (previewPollRef.current) {
      clearInterval(previewPollRef.current)
      previewPollRef.current = null
    }
  }, [])

  const startPreview = useCallback(
    async (pdbFile: string, datFile: string, maxQ: number) => {
      setPreviewStatus('loading')
      setPreviewChi2(null)
      setPreviewC1(null)
      setPreviewC2(null)
      setPreviewFoxs(null)
      setPreviewError(null)
      stopPreviewPoll()

      let previewId: string
      try {
        const form = new FormData()
        form.append('pdb_file', pdbFile)
        form.append('dat_file', datFile)
        form.append('max_q', String(maxQ))
        const result = await addCarbonaraInitFoxs(form).unwrap()
        previewId = result.previewId
        previewIdRef.current = previewId
      } catch {
        setPreviewStatus('error')
        setPreviewError('Failed to submit preview request')
        return
      }

      const started = Date.now()
      const CAP_MS = 60_000

      previewPollRef.current = setInterval(async () => {
        if (Date.now() - started > CAP_MS) {
          stopPreviewPoll()
          setPreviewStatus('error')
          setPreviewError('Preview timed out (60 s)')
          return
        }
        try {
          const data = await triggerGetPreview(previewId).unwrap()
          if (data.status === 'done') {
            stopPreviewPoll()
            setPreviewChi2(data.chi2 ?? null)
            setPreviewC1(data.c1 ?? null)
            setPreviewC2(data.c2 ?? null)
            setPreviewFoxs(data.foxs ?? null)
            setPreviewStatus('done')
          } else if (data.status === 'error') {
            stopPreviewPoll()
            setPreviewStatus('error')
            setPreviewError(data.message ?? 'Preview failed')
          }
          // status === 'pending': keep polling
        } catch {
          // transient fetch error: keep polling until cap
        }
      }, 2000)
    },
    [addCarbonaraInitFoxs, triggerGetPreview, stopPreviewPoll]
  )

  // B2.4: Carbonara auto-flexibility prepare-step state.
  const [addCarbonaraAutoFlex] = useAddCarbonaraAutoFlexMutation()
  const [triggerGetAutoFlex] = useLazyGetCarbonaraAutoFlexQuery()
  const [autoFlexStatus, setAutoFlexStatus] = useState<
    'idle' | 'loading' | 'done' | 'error'
  >('idle')
  const [autoFlexRanges, setAutoFlexRanges] = useState<FlexRangeRow[]>([])
  const [autoFlexError, setAutoFlexError] = useState<string | null>(null)
  const autoFlexPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoFlexIdRef = useRef<string | null>(null)

  const stopAutoFlexPoll = useCallback(() => {
    if (autoFlexPollRef.current) {
      clearInterval(autoFlexPollRef.current)
      autoFlexPollRef.current = null
    }
  }, [])

  const startAutoFlex = useCallback(
    async (pdbFile: string, datFile: string, minQ: number, maxQ: number) => {
      setAutoFlexStatus('loading')
      setAutoFlexRanges([])
      setAutoFlexError(null)
      stopAutoFlexPoll()

      let previewId: string
      try {
        const form = new FormData()
        form.append('pdb_file', pdbFile)
        form.append('dat_file', datFile)
        form.append('min_q', String(minQ))
        form.append('max_q', String(maxQ))
        const result = await addCarbonaraAutoFlex(form).unwrap()
        previewId = result.previewId
        autoFlexIdRef.current = previewId
      } catch (err) {
        setAutoFlexStatus('error')
        setAutoFlexError(submitErrorMessage(err, 'auto-flexibility'))
        return
      }

      const started = Date.now()
      // Setup runs the C++ generator many times — allow up to ~12 min.
      const CAP_MS = 12 * 60_000

      autoFlexPollRef.current = setInterval(async () => {
        if (Date.now() - started > CAP_MS) {
          stopAutoFlexPoll()
          setAutoFlexStatus('error')
          setAutoFlexError('Auto-flexibility timed out')
          return
        }
        try {
          const data = await triggerGetAutoFlex(previewId).unwrap()
          if (data.status === 'done') {
            stopAutoFlexPoll()
            const rows: FlexRangeRow[] = (data.flex_ranges ?? []).flatMap(
              (entry) =>
                entry.ranges.map((r) => ({
                  chain: String(entry.chain),
                  start: String(r[0]),
                  stop: String(r[1])
                }))
            )
            setAutoFlexRanges(rows)
            setAutoFlexStatus('done')
          } else if (data.status === 'error') {
            stopAutoFlexPoll()
            setAutoFlexStatus('error')
            setAutoFlexError(data.message ?? 'Auto-flexibility failed')
          }
          // status === 'pending': keep polling
        } catch {
          // transient fetch error: keep polling until cap
        }
      }, 3000)
    },
    [addCarbonaraAutoFlex, triggerGetAutoFlex, stopAutoFlexPoll]
  )

  // B2.5: PAE side-aid state. PAE is an optional aid (not a main mode). It runs
  // Carbonara's own PAE-guided selection (setup --alphaFoldFlex getFlexibility)
  // via the same prepare-step, then surfaces the ranges so the user can send
  // them into the Manual editor or just read them as guidance.
  const [paeFlexStatus, setPaeFlexStatus] = useState<
    'idle' | 'loading' | 'done' | 'error'
  >('idle')
  const [paeFlexRanges, setPaeFlexRanges] = useState<FlexRangeRow[]>([])
  const [paeFlexError, setPaeFlexError] = useState<string | null>(null)
  const paeFlexPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPaeFlexPoll = useCallback(() => {
    if (paeFlexPollRef.current) {
      clearInterval(paeFlexPollRef.current)
      paeFlexPollRef.current = null
    }
  }, [])

  const startPaeFlex = useCallback(
    async (
      pdbFile: string,
      datFile: string,
      paeFile: string,
      threshold: number,
      minQ: number,
      maxQ: number
    ) => {
      setPaeFlexStatus('loading')
      setPaeFlexRanges([])
      setPaeFlexError(null)
      stopPaeFlexPoll()

      let previewId: string
      try {
        const form = new FormData()
        form.append('pdb_file', pdbFile)
        form.append('dat_file', datFile)
        form.append('pae_file', paeFile)
        form.append('pae_flex_threshold', String(threshold))
        form.append('min_q', String(minQ))
        form.append('max_q', String(maxQ))
        const result = await addCarbonaraAutoFlex(form).unwrap()
        previewId = result.previewId
      } catch (err) {
        setPaeFlexStatus('error')
        setPaeFlexError(submitErrorMessage(err, 'PAE flexibility'))
        return
      }

      const started = Date.now()
      const CAP_MS = 12 * 60_000

      paeFlexPollRef.current = setInterval(async () => {
        if (Date.now() - started > CAP_MS) {
          stopPaeFlexPoll()
          setPaeFlexStatus('error')
          setPaeFlexError('PAE flexibility timed out')
          return
        }
        try {
          const data = await triggerGetAutoFlex(previewId).unwrap()
          if (data.status === 'done') {
            stopPaeFlexPoll()
            const rows: FlexRangeRow[] = (data.flex_ranges ?? []).flatMap(
              (entry) =>
                entry.ranges.map((r) => ({
                  chain: String(entry.chain),
                  start: String(r[0]),
                  stop: String(r[1])
                }))
            )
            setPaeFlexRanges(rows)
            setPaeFlexStatus('done')
          } else if (data.status === 'error') {
            stopPaeFlexPoll()
            setPaeFlexStatus('error')
            setPaeFlexError(data.message ?? 'PAE flexibility failed')
          }
        } catch {
          // transient fetch error: keep polling until cap
        }
      }, 3000)
    },
    [addCarbonaraAutoFlex, triggerGetAutoFlex, stopPaeFlexPoll]
  )

  // Push the PAE-derived ranges into the Manual editor and switch to Manual so
  // they drive both the viewer highlight and the submitted flex_ranges.
  const sendPaeToManual = useCallback(() => {
    if (paeFlexRanges.length === 0) return
    setFlexRangeRows(paeFlexRanges)
    setFlexMode('manual')
  }, [paeFlexRanges])

  // Same, for the Auto result — explicit button (mirrors the PAE one) so the
  // hand-off to Manual is predictable rather than an implicit radio side effect.
  const sendAutoToManual = useCallback(() => {
    if (autoFlexRanges.length === 0) return
    setFlexRangeRows(autoFlexRanges)
    setFlexMode('manual')
  }, [autoFlexRanges])

  // B4: oligomeric state + affine-rotation + chain-merge subunits.
  // Merging is only relevant for affine rotations, so it's gated under
  // Multimer -> affine rotation. mergeGroups: each inner array is a set of
  // chain ids merged into one rigid subunit (rotates together).
  const [oligomericState, setOligomericState] = useState<
    'monomer' | 'multimer' | 'mixture'
  >('monomer')
  const [affineRotation, setAffineRotation] = useState<boolean>(false)
  const [mergeGroups, setMergeGroups] = useState<string[][]>([])
  const [mergeSelection, setMergeSelection] = useState<string[]>([])

  const toggleMergeSelect = useCallback((id: string) => {
    setMergeSelection((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    )
  }, [])

  const mergeSelected = useCallback(() => {
    setMergeGroups((prev) => {
      if (mergeSelection.length < 2) return prev
      // Remove the selected chains from any existing group, drop groups that
      // fall below 2 members, then add the new group.
      const cleaned = prev
        .map((g) => g.filter((id) => !mergeSelection.includes(id)))
        .filter((g) => g.length > 1)
      return [...cleaned, [...mergeSelection]]
    })
    setMergeSelection([])
  }, [mergeSelection])

  const clearMergeGroup = useCallback((idx: number) => {
    setMergeGroups((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  // B7: 3-way flexibility mode selector (replaces the PAE checkbox)
  const [flexMode, setFlexMode] = useState<'auto' | 'manual'>('auto')
  // Manual flexibility rows: chain (1-based), start residue, stop residue
  const [flexRangeRows, setFlexRangeRows] = useState<FlexRangeRow[]>([
    emptyFlexRow()
  ])
  // B2: chains detected by the 3D viewer (auth_asym_id, document order) and the
  // subset currently hidden via the chain toggles.
  const [viewerChains, setViewerChains] = useState<string[]>([])
  const [hiddenChains, setHiddenChains] = useState<string[]>([])

  // Stable callback for the viewer: record detected chains and reset any
  // chain-visibility toggles + stale auto-flexibility results when a new
  // structure loads.
  const handleChainsDetected = useCallback((chains: string[]) => {
    setViewerChains(chains)
    setHiddenChains([])
    setAutoFlexStatus('idle')
    setAutoFlexRanges([])
    setAutoFlexError(null)
    setPaeFlexStatus('idle')
    setPaeFlexRanges([])
    setPaeFlexError(null)
    setMergeGroups([])
    setMergeSelection([])
  }, [])

  // B4: per-chain colour map. When affine-rotation merging is active each merged
  // subunit shares the colour of its lowest-index chain; otherwise each chain
  // keeps its own palette colour. Used by both the viewer and the chain chips so
  // they always agree.
  const chainColorMap = useMemo<Record<string, string>>(() => {
    const applyMerges = oligomericState === 'multimer' && affineRotation
    const map: Record<string, string> = {}
    viewerChains.forEach((id, i) => {
      const group = applyMerges
        ? mergeGroups.find((g) => g.includes(id))
        : undefined
      if (group && group.length > 1) {
        const anchor = Math.min(
          ...group.map((g) => viewerChains.indexOf(g)).filter((x) => x >= 0)
        )
        map[id] = carbonaraChainColorHex(anchor)
      } else {
        map[id] = carbonaraChainColorHex(i)
      }
    })
    return map
  }, [viewerChains, mergeGroups, oligomericState, affineRotation])

  const toggleChainVisibility = useCallback((chainId: string) => {
    setHiddenChains((prev) =>
      prev.includes(chainId)
        ? prev.filter((c) => c !== chainId)
        : [...prev, chainId]
    )
  }, [])

  // B2: flexible segments to highlight (yellow) in the 3D viewer. Manual mode
  // uses the editable range rows; Auto mode uses the ranges returned by the
  // Carbonara prepare-step; PAE mode highlights nothing here (it is a side aid).
  const flexSegments = useMemo<FlexSegment[]>(() => {
    const rows =
      flexMode === 'manual'
        ? flexRangeRows
        : flexMode === 'auto'
          ? autoFlexRanges
          : []
    return rows
      .map((r) => ({
        chain: parseInt(r.chain, 10),
        start: parseInt(r.start, 10),
        stop: parseInt(r.stop, 10)
      }))
      .filter(
        (s) =>
          Number.isFinite(s.chain) &&
          Number.isFinite(s.start) &&
          Number.isFinite(s.stop) &&
          s.stop >= s.start
      )
  }, [flexMode, flexRangeRows, autoFlexRanges])

  // Constraints state — managed outside Formik (file/pairs are UI-only state)
  const [constraintsMethod, setConstraintsMethod] = useState<
    'none' | 'file' | 'pairs'
  >('none')
  const [constraintPairs, setConstraintPairs] = useState<ConstraintPairRow[]>([
    emptyPairRow()
  ])
  // How many constraint pairs the viewer actually located + drew.
  const [constraintsDrawn, setConstraintsDrawn] = useState(0)
  // Pairs parsed from an uploaded constraints file (file mode).
  const [fileConstraints, setFileConstraints] = useState<ViewerConstraint[]>([])

  // B3: valid constraint pairs to draw as dashed lines in the 3D viewer.
  // chain1/chain2 are auth_asym_id letters; res are the residue numbers shown in
  // the viewer. Sourced from the pairs editor or the uploaded file.
  const viewerConstraints = useMemo<ViewerConstraint[]>(() => {
    if (constraintsMethod === 'file') return fileConstraints
    if (constraintsMethod !== 'pairs') return []
    return constraintPairs
      .map((p) => ({
        chain1: p.chain1.trim(),
        res1: parseInt(p.res1, 10),
        chain2: p.chain2.trim(),
        res2: parseInt(p.res2, 10)
      }))
      .filter(
        (c) =>
          c.chain1 !== '' &&
          c.chain2 !== '' &&
          Number.isFinite(c.res1) &&
          Number.isFinite(c.res2)
      )
  }, [constraintsMethod, constraintPairs, fileConstraints])

  // Debounced trigger: called when pdb_file, dat_file, or max_q change
  const triggerPreviewDebounced = useCallback(
    (pdbFile: string, datFile: string, maxQ: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        startPreview(pdbFile, datFile, maxQ).catch(() => undefined)
      }, 800)
    },
    [startPreview]
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPreviewPoll()
      stopAutoFlexPoll()
      stopPaeFlexPoll()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [stopPreviewPoll, stopAutoFlexPoll, stopPaeFlexPoll])

  const successResponse = jobResponse
    ? {
        message: jobResponse.message || 'Job submitted successfully',
        jobid: jobResponse.jobid,
        uuid: jobResponse.uuid
      }
    : undefined

  const initialValues: CarbonaraJobFormValues = {
    title: '',
    pdb_file: '',
    dat_file: '',
    fit_n_times: 4,
    min_q: 0.01,
    max_q: 0.2,
    max_fit_steps: 1000,
    all_atom: false,
    do_foxs: true,
    pae_file: '',
    alphafold_flex: false,
    pae_flex_threshold: 16,
    constraints_file: ''
  }

  const onSubmit = async (
    values: CarbonaraJobFormValues,
    { setStatus }: FormikHelpers<CarbonaraJobFormValues>
  ) => {
    setSubmitError(null)
    const form = new FormData()
    form.append('title', values.title)
    form.append('pdb_file', values.pdb_file)
    form.append('dat_file', values.dat_file)
    form.append('fit_n_times', values.fit_n_times.toString())
    form.append('min_q', values.min_q.toString())
    form.append('max_q', values.max_q.toString())
    form.append('max_fit_steps', values.max_fit_steps.toString())
    // B4: the `rotation` flag is derived from local UI state (oligomeric state +
    // affine toggle), not a Formik field — affine rotation only applies to a
    // multimer.
    const isMultimer = oligomericState === 'multimer'
    const affineOn = isMultimer && affineRotation
    form.append('rotation', affineOn.toString())
    form.append('all_atom', values.all_atom.toString())
    form.append('do_foxs', values.do_foxs.toString())

    // B7/B2.5: emit flex_mode and mode-specific data. PAE is no longer a
    // submission mode of its own — the PAE side aid (Block 2) feeds its computed
    // ranges into Manual, so PAE-guided fits submit as explicit manual ranges.
    form.append('flex_mode', flexMode)
    if (flexMode === 'manual') {
      form.append('alphafold_flex', 'false')
      // Group valid rows by chain into [{chain, ranges:[...]}] format
      const validRows = flexRangeRows.filter(
        (r) => r.chain && r.start && r.stop
      )
      if (validRows.length > 0) {
        const byChain: Record<number, number[][]> = {}
        for (const row of validRows) {
          const chain = parseInt(row.chain, 10)
          const start = parseInt(row.start, 10)
          const stop = parseInt(row.stop, 10)
          if (!byChain[chain]) byChain[chain] = []
          byChain[chain].push([start, stop])
        }
        const flexRanges = Object.entries(byChain).map(([chain, ranges]) => ({
          chain: parseInt(chain, 10),
          ranges
        }))
        form.append('flex_ranges', JSON.stringify(flexRanges))
      }
    } else {
      // auto
      form.append('alphafold_flex', 'false')
    }

    // Constraints: append only when the user has provided input
    if (constraintsMethod === 'file' && values.constraints_file) {
      form.append('constraints_file', values.constraints_file)
    } else if (constraintsMethod === 'pairs') {
      const validPairs = constraintPairs.filter(
        (p) => p.res1 && p.chain1 && p.res2 && p.chain2
      )
      if (validPairs.length > 0) {
        form.append('constraints_pairs', JSON.stringify(validPairs))
      }
    }
    // B4: multimer + chain merges (chain_merges only apply to affine rotation —
    // they define which chains rotate together as one rigid subunit).
    form.append('multimer', isMultimer.toString())
    if (affineOn && mergeGroups.length > 0) {
      const merges = groupsToMergePairs(viewerChains, mergeGroups)
      if (merges.length > 0) {
        form.append('chain_merges', JSON.stringify(merges))
      }
    }

    form.append('bilbomd_mode', 'carbonara')

    try {
      const newJob = await addNewCarbonaraJob(form).unwrap()
      setStatus(newJob)
    } catch (error) {
      console.error('rejected', error)
      setSubmitError(
        (error as { data?: { message?: string } }).data?.message ||
          'An error occurred during submission.'
      )
    }
  }

  const content = (
    <Grid
      container
      spacing={2}
    >
      {/* Instructions accordion — always at the top */}
      <Grid size={{ xs: 12 }}>
        <Accordion>
          <AccordionSummary
            expandIcon={<ExpandMoreIcon sx={{ color: '#fff' }} />}
            sx={{
              backgroundColor: '#888',
              borderTopLeftRadius: 4,
              borderTopRightRadius: 4,
              pl: 1
            }}
          >
            <Typography
              sx={{
                textTransform: 'uppercase',
                fontSize: '0.875rem',
                fontWeight: 400,
                color: '#fff',
                letterSpacing: '1px'
              }}
            >
              Instructions
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography sx={{ m: 1 }}>
              Carbonara is a SAXS-guided protein structure refinement workflow.
              Starting from an atomic or predicted model, it converts the
              structure into a coarse-grained representation and samples
              conformational changes against your experimental SAXS data.
            </Typography>
            <Typography sx={{ m: 1 }}>
              You will fill in three blocks:
            </Typography>
            <Box
              component="ul"
              sx={{ m: 1, mt: 0, pl: 3 }}
            >
              <li>
                <strong>1 · Initial Scattering Check</strong> — upload your
                structure (PDB or mmCIF) and experimental SAXS curve, and choose
                the <strong>oligomeric state</strong> (Monomer or Multimer;
                Mixture coming soon). A quick FoXS fit shows how well the starting
                model already matches the data (I(q) vs q plus residuals), so you
                know what you&apos;re starting from.
              </li>
              <li>
                <strong>2 · Conformational Sampling</strong> — the heart of the
                setup, built around an interactive <strong>3D viewer</strong>.
                Hover a residue to see its name/number/chain, and toggle chains
                on/off. Three sub-blocks let you tell Carbonara how the model may
                move, and <strong>each choice is shown live in that 3D viewer</strong>:
                <Box
                  component="ul"
                  sx={{ pl: 3 }}
                >
                  <li>
                    <strong>Flexibility</strong> — which regions can flex.
                    Carbonara&apos;s <em>Auto</em> selection, your own{' '}
                    <em>Manual</em> ranges, or an optional <em>PAE</em> aid;
                    flexible residues are highlighted yellow.
                  </li>
                  <li>
                    <strong>Distance constraints</strong> — optional residue
                    pairs to keep near each other; drawn as dashed lines.
                  </li>
                  <li>
                    <strong>Affine rotations</strong> — for a Multimer (chosen in
                    Block 1) you can enable rigid-body rotations and merge chains
                    into subunits that move together (shown as shared colours).
                  </li>
                </Box>
              </li>
              <li>
                <strong>3 · Fitting</strong> — the q-range to fit over, how many
                independent fits to run, the sampling-step budget, and whether to
                rebuild all-atom models (cg2all) from the coarse-grained results.
              </li>
            </Box>
          </AccordionDetails>
        </Accordion>
      </Grid>

      <Grid size={{ xs: 12 }}>
        {isSuccess && successResponse ? (
          <JobSuccessAlert
            jobResponse={successResponse}
            jobType="Carbonara"
          />
        ) : (
          <Formik
            initialValues={initialValues}
            validationSchema={bilbomdCarbonaraJobSchema}
            onSubmit={onSubmit}
          >
            {({
              values,
              errors,
              touched,
              isValid,
              isSubmitting,
              handleChange,
              handleBlur,
              setFieldValue,
              setFieldTouched
            }) => (
              <Form>
                {submitError && (
                  <Alert
                    severity="error"
                    sx={{ mb: 2 }}
                  >
                    {submitError}
                  </Alert>
                )}

                {/* ── Block 1: Initial scattering check ────────────────── */}
                <HeaderBox>
                  <Typography>1 · Initial Scattering Check</Typography>
                </HeaderBox>
                <Paper sx={{ p: 2, mb: 2 }}>
                  <Grid
                    container
                    sx={{ flexDirection: 'column' }}
                  >
                    <Box sx={{ my: 1, minWidth: '520px' }}>
                      <Field
                        fullWidth
                        label="Title"
                        name="title"
                        id="title"
                        type="text"
                        disabled={isSubmitting}
                        as={TextField}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={errors.title && touched.title}
                        helperText={
                          errors.title && touched.title ? errors.title : ''
                        }
                        value={values.title || ''}
                      />
                    </Box>

                    <Grid>
                      <Field
                        name="pdb_file"
                        id="pdb-file-upload"
                        as={FileSelect}
                        title="Select File"
                        disabled={isSubmitting}
                        setFieldValue={setFieldValue}
                        setFieldTouched={setFieldTouched}
                        error={errors.pdb_file && touched.pdb_file}
                        errorMessage={errors.pdb_file ? errors.pdb_file : ''}
                        fileType="structure *.pdb or *.cif"
                        fileExt=".pdb,.cif"
                      />
                    </Grid>

                    <Grid>
                      <Field
                        name="dat_file"
                        id="dat-file-upload"
                        as={FileSelect}
                        title="Select File"
                        disabled={isSubmitting}
                        setFieldValue={setFieldValue}
                        setFieldTouched={setFieldTouched}
                        error={errors.dat_file && touched.dat_file}
                        errorMessage={errors.dat_file ? errors.dat_file : ''}
                        fileType="experimental SAXS data *.dat"
                        fileExt=".dat"
                      />
                    </Grid>

                    {/* Oligomeric state — chosen up front. Gates the affine
                        rotation sub-block in Block 2. Mixture is a placeholder
                        for upcoming multi-state functionality. */}
                    <Box sx={{ mt: 2, mb: 1 }}>
                      <Typography
                        variant="subtitle2"
                        sx={{ fontWeight: 600, mb: 0.5 }}
                      >
                        Oligomeric state
                      </Typography>
                      <ToggleButtonGroup
                        exclusive
                        size="small"
                        value={oligomericState}
                        onChange={(_e, v) => {
                          if (!v) return
                          setOligomericState(v)
                          if (v !== 'multimer') setAffineRotation(false)
                        }}
                      >
                        <ToggleButton
                          value="monomer"
                          disabled={isSubmitting}
                        >
                          Monomer
                        </ToggleButton>
                        <ToggleButton
                          value="multimer"
                          disabled={isSubmitting}
                        >
                          Multimer
                        </ToggleButton>
                        <ToggleButton
                          value="mixture"
                          disabled
                        >
                          Mixture (coming soon)
                        </ToggleButton>
                      </ToggleButtonGroup>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mt: 0.5 }}
                      >
                        {oligomericState === 'monomer'
                          ? 'A single subunit — no inter-subunit rotation.'
                          : oligomericState === 'multimer'
                            ? 'Multiple subunits — enable affine (rigid-body) rotations and chain merging in Block 2.'
                            : 'A mixture of oligomeric states — coming soon.'}
                      </Typography>
                    </Box>

                    {/* B5: effect-based preview trigger (fires on input change) */}
                    <InitialFitTrigger
                      pdbFile={values.pdb_file}
                      datFile={values.dat_file}
                      maxQ={values.max_q}
                      onTrigger={triggerPreviewDebounced}
                    />

                    {previewStatus !== 'idle' && (
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
                          Initial scattering check
                        </Typography>

                        {previewStatus === 'loading' && (
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1
                            }}
                          >
                            <CircularProgress size={16} />
                            <Typography
                              variant="body2"
                              color="text.secondary"
                            >
                              Running initial FoXS fit…
                            </Typography>
                          </Box>
                        )}

                        {previewStatus === 'error' && (
                          <Alert
                            severity="info"
                            variant="outlined"
                            sx={{ mt: 1 }}
                          >
                            Initial check unavailable: {previewError}
                          </Alert>
                        )}

                        {previewStatus === 'done' && previewFoxs && (
                          <>
                            <Typography variant="body2" sx={{ mb: 1 }}>
                              {'Initial χ² = '}
                              <strong>
                                {previewChi2 != null
                                  ? previewChi2.toFixed(3)
                                  : 'N/A'}
                              </strong>
                              {previewC1 != null
                                ? ` · c1 = ${previewC1.toFixed(2)}`
                                : ''}
                              {previewC2 != null
                                ? ` · c2 = ${previewC2.toFixed(4)}`
                                : ''}
                            </Typography>
                            <InitialFitChart
                              data={previewFoxs.map((p) => ({
                                q: p.q,
                                exp_intensity: p.exp,
                                model_intensity: p.model,
                                error: p.error
                              }))}
                              residualsData={previewFoxs.map((p) => ({
                                q: p.q,
                                res:
                                  p.error !== 0
                                    ? Number(
                                        ((p.exp - p.model) / p.error).toFixed(2)
                                      )
                                    : 0
                              }))}
                            />
                          </>
                        )}
                      </Box>
                    )}
                  </Grid>
                </Paper>

                {/* ── Block 2: Conformational Sampling ─────────────────── */}
                {/* One block: shared 3D viewer at the top, then Flexibility,
                    Distance constraints and Oligomeric state as sub-blocks whose
                    selections all render in the viewer above. */}
                <HeaderBox>
                  <Typography>2 · Conformational Sampling</Typography>
                </HeaderBox>
                <Paper sx={{ p: 2, mb: 2 }}>
                  {/* B2: interactive 3D viewer — hover a residue for its name,
                      number and chain; flexible segments are highlighted yellow,
                      distance constraints drawn as dashed lines. */}
                  <CarbonaraStructureViewer
                    structureFile={values.pdb_file}
                    flexSegments={flexSegments}
                    hiddenChains={hiddenChains}
                    constraints={viewerConstraints}
                    chainColors={chainColorMap}
                    onChainsDetected={handleChainsDetected}
                    onConstraintsDrawn={setConstraintsDrawn}
                  />
                  {/* Parses an uploaded constraints file into viewer lines. */}
                  <ConstraintsFileParser
                    file={values.constraints_file}
                    active={constraintsMethod === 'file'}
                    onParsed={setFileConstraints}
                  />
                  {viewerChains.length > 0 && (
                    <Stack
                      direction="row"
                      sx={{
                        mt: 1,
                        flexWrap: 'wrap',
                        gap: 0.5,
                        alignItems: 'center'
                      }}
                    >
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ mr: 0.5 }}
                      >
                        Show / hide chains in the 3D viewer (chain 1 ={' '}
                        {viewerChains[0]}):
                      </Typography>
                      {viewerChains.map((c, i) => {
                        const visible = !hiddenChains.includes(c)
                        const col = chainColorMap[c] ?? carbonaraChainColorHex(i)
                        return (
                          <Chip
                            key={c}
                            size="small"
                            label={c}
                            onClick={() => toggleChainVisibility(c)}
                            sx={
                              visible
                                ? {
                                    backgroundColor: col,
                                    color: '#fff',
                                    '&:hover': {
                                      backgroundColor: col,
                                      opacity: 0.85
                                    }
                                  }
                                : {
                                    backgroundColor: 'transparent',
                                    color: 'text.disabled',
                                    border: '1px solid',
                                    borderColor: col,
                                    textDecoration: 'line-through'
                                  }
                            }
                          />
                        )
                      })}
                    </Stack>
                  )}
                  {/* ── sub-block: Flexibility ── */}
                  <Typography
                    variant="subtitle1"
                    sx={{
                      fontWeight: 700,
                      mt: 3,
                      mb: 1,
                      pt: 2,
                      borderTop: '2px solid',
                      borderColor: 'divider'
                    }}
                  >
                    Flexibility
                  </Typography>
                  <Box sx={{ mt: 1, mb: 1 }}>
                    <FormControl component="fieldset">
                      <FormLabel
                        component="legend"
                        sx={{
                          fontWeight: 600,
                          fontSize: '0.875rem',
                          mb: 0.5
                        }}
                      >
                        Flexibility mode
                      </FormLabel>
                      <RadioGroup
                        row
                        value={flexMode}
                        onChange={(e) =>
                          setFlexMode(e.target.value as 'auto' | 'manual')
                        }
                      >
                        <FormControlLabel
                          value="auto"
                          control={<Radio size="small" />}
                          label="Auto (default)"
                          disabled={isSubmitting}
                        />
                        <FormControlLabel
                          value="manual"
                          control={<Radio size="small" />}
                          label="Manual ranges"
                          disabled={isSubmitting}
                        />
                      </RadioGroup>
                    </FormControl>

                    {/* Auto mode: run Carbonara's auto linker selection and
                        highlight it in the viewer. Editing is done by switching
                        to Manual (which pre-seeds from this result). */}
                    {flexMode === 'auto' && (
                      <Box sx={{ ml: 3, mt: 0.5 }}>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block', mb: 1 }}
                        >
                          Carbonara auto-selects flexible linker regions that can
                          move without breaking β-sheet contacts. Detect them to
                          highlight them (yellow) in the viewer above.
                        </Typography>
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={
                            isSubmitting ||
                            autoFlexStatus === 'loading' ||
                            values.pdb_file === '' ||
                            values.dat_file === ''
                          }
                          onClick={() =>
                            startAutoFlex(
                              values.pdb_file,
                              values.dat_file,
                              values.min_q,
                              values.max_q
                            )
                          }
                          startIcon={
                            autoFlexStatus === 'loading' ? (
                              <CircularProgress size={14} />
                            ) : undefined
                          }
                        >
                          {autoFlexStatus === 'loading'
                            ? 'Detecting…'
                            : 'Detect flexible regions'}
                        </Button>
                        {(values.pdb_file === '' || values.dat_file === '') && (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block', mt: 0.5 }}
                          >
                            Upload a structure and SAXS file in Block 1 first.
                          </Typography>
                        )}
                        {autoFlexStatus === 'loading' && (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block', mt: 0.5 }}
                          >
                            Running Carbonara setup — this can take a couple of
                            minutes.
                          </Typography>
                        )}
                        {autoFlexStatus === 'error' && (
                          <Alert
                            severity="error"
                            sx={{ mt: 1, py: 0 }}
                          >
                            {autoFlexError ?? 'Auto-flexibility failed'}
                          </Alert>
                        )}
                        {autoFlexStatus === 'done' && (
                          <Box sx={{ mt: 1 }}>
                            {autoFlexRanges.length === 0 ? (
                              <Typography variant="body2">
                                No auto-flexible regions were found for this
                                structure.
                              </Typography>
                            ) : (
                              <>
                                <Typography
                                  variant="body2"
                                  sx={{ fontWeight: 600, mb: 0.5 }}
                                >
                                  Auto-selected flexible residues (
                                  {autoFlexRanges.length}) — highlighted yellow
                                  in the 3D viewer above:
                                </Typography>
                                <Stack
                                  direction="row"
                                  sx={{ flexWrap: 'wrap', gap: 0.5 }}
                                >
                                  {autoFlexRanges.map((r, i) => (
                                    <Chip
                                      key={i}
                                      size="small"
                                      variant="outlined"
                                      color="warning"
                                      label={`Chain ${r.chain}: ${r.start}–${r.stop}`}
                                    />
                                  ))}
                                </Stack>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{ display: 'block', mt: 0.5, mb: 1 }}
                                >
                                  Submitting in Auto mode uses Carbonara&apos;s
                                  own selection. To alter it, send these into the
                                  Manual editor and edit there.
                                </Typography>
                                <Button
                                  size="small"
                                  variant="contained"
                                  onClick={sendAutoToManual}
                                  disabled={isSubmitting}
                                >
                                  Send to Manual editor
                                </Button>
                              </>
                            )}
                          </Box>
                        )}
                      </Box>
                    )}

                    {/* Manual mode: residue range editor */}
                    {flexMode === 'manual' && (
                      <Box sx={{ ml: 3, mt: 0.5 }}>
                        <Typography variant="caption" color="text.secondary">
                          Enter flexible residue ranges (chain 1 = first chain).
                          Start and stop are inclusive residue numbers. Each
                          valid range is highlighted yellow in the 3D viewer
                          above as you type.
                        </Typography>
                        {flexRangeRows.map((row, idx) => (
                          <Box
                            key={idx}
                            sx={{
                              display: 'flex',
                              gap: 1,
                              mt: 1,
                              alignItems: 'center'
                            }}
                          >
                            <TextField
                              label="Chain"
                              size="small"
                              type="number"
                              value={row.chain}
                              onChange={(e) => {
                                const updated = flexRangeRows.map(
                                  (r, i): FlexRangeRow =>
                                    i === idx
                                      ? { ...r, chain: e.target.value }
                                      : r
                                )
                                setFlexRangeRows(updated)
                              }}
                              sx={{ width: '70px' }}
                              disabled={isSubmitting}
                            />
                            <TextField
                              label="Start"
                              size="small"
                              type="number"
                              value={row.start}
                              onChange={(e) => {
                                const updated = flexRangeRows.map(
                                  (r, i): FlexRangeRow =>
                                    i === idx
                                      ? { ...r, start: e.target.value }
                                      : r
                                )
                                setFlexRangeRows(updated)
                              }}
                              sx={{ width: '80px' }}
                              disabled={isSubmitting}
                            />
                            <TextField
                              label="Stop"
                              size="small"
                              type="number"
                              value={row.stop}
                              onChange={(e) => {
                                const updated = flexRangeRows.map(
                                  (r, i): FlexRangeRow =>
                                    i === idx
                                      ? { ...r, stop: e.target.value }
                                      : r
                                )
                                setFlexRangeRows(updated)
                              }}
                              sx={{ width: '80px' }}
                              disabled={isSubmitting}
                            />
                            <IconButton
                              size="small"
                              disabled={
                                isSubmitting || flexRangeRows.length <= 1
                              }
                              onClick={() =>
                                setFlexRangeRows(
                                  flexRangeRows.filter((_, i) => i !== idx)
                                )
                              }
                              aria-label="remove-flex-range"
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        ))}
                        <Button
                          size="small"
                          startIcon={<AddIcon />}
                          onClick={() =>
                            setFlexRangeRows([
                              ...flexRangeRows,
                              emptyFlexRow()
                            ])
                          }
                          disabled={isSubmitting}
                          sx={{ mt: 1 }}
                        >
                          Add range
                        </Button>
                      </Box>
                    )}

                    {/* B2.5: PAE side aid — optional, available in any mode.
                        Uploads a PAE file, shows the matrix, and computes
                        Carbonara's PAE-guided flexible regions (its own
                        getFlexibility path) which can be sent to the Manual
                        editor or just read as guidance. */}
                    <Box
                      sx={{
                        mt: 2,
                        pt: 2,
                        borderTop: '1px dashed',
                        borderColor: 'divider'
                      }}
                    >
                      <Typography
                        variant="subtitle2"
                        sx={{ fontWeight: 600 }}
                      >
                        PAE aid (optional)
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mb: 1 }}
                      >
                        Upload an AlphaFold PAE file to view it and compute
                        Carbonara&apos;s PAE-guided flexible regions. Send the
                        result to the Manual editor, or just use it as a guide.
                      </Typography>
                      <Grid>
                        <Field
                          name="pae_file"
                          id="pae-file-upload"
                          as={FileSelect}
                          title="Select File"
                          disabled={isSubmitting}
                          setFieldValue={setFieldValue}
                          setFieldTouched={setFieldTouched}
                          error={errors.pae_file && touched.pae_file}
                          errorMessage={errors.pae_file ? errors.pae_file : ''}
                          fileType="AlphaFold2 PAE *.json"
                          fileExt=".json"
                        />
                      </Grid>
                      {values.pae_file && (
                        <Box
                          sx={{
                            mt: 1,
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 2,
                            alignItems: 'flex-start'
                          }}
                        >
                          <CarbonaraPaePlot paeFile={values.pae_file} />
                          <Box
                            sx={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 1
                            }}
                          >
                            <Field
                              label="PAE flexibility threshold (Å)"
                              name="pae_flex_threshold"
                              id="pae_flex_threshold"
                              type="number"
                              disabled={isSubmitting}
                              as={TextField}
                              onChange={handleChange}
                              onBlur={handleBlur}
                              error={
                                errors.pae_flex_threshold &&
                                touched.pae_flex_threshold
                              }
                              helperText={
                                errors.pae_flex_threshold &&
                                touched.pae_flex_threshold
                                  ? errors.pae_flex_threshold
                                  : ''
                              }
                              value={values.pae_flex_threshold}
                              sx={{ width: '240px' }}
                            />
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ maxWidth: 320 }}
                            >
                              Linkers whose predicted aligned error exceeds this
                              cutoff (Å) are treated as flexible. Lower → more
                              regions flexible; higher → stricter (fewer).
                              Carbonara&apos;s default is 16 Å; ~12–18 Å is
                              typical.
                            </Typography>
                            <Button
                              size="small"
                              variant="outlined"
                              disabled={
                                isSubmitting ||
                                paeFlexStatus === 'loading' ||
                                values.pdb_file === '' ||
                                values.dat_file === '' ||
                                values.pae_file === ''
                              }
                              onClick={() =>
                                startPaeFlex(
                                  values.pdb_file,
                                  values.dat_file,
                                  values.pae_file,
                                  values.pae_flex_threshold,
                                  values.min_q,
                                  values.max_q
                                )
                              }
                              startIcon={
                                paeFlexStatus === 'loading' ? (
                                  <CircularProgress size={14} />
                                ) : undefined
                              }
                            >
                              {paeFlexStatus === 'loading'
                                ? 'Computing…'
                                : 'Compute flexible regions from PAE'}
                            </Button>
                            {(values.pdb_file === '' ||
                              values.dat_file === '') && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                Upload a structure and SAXS file in Block 1
                                first.
                              </Typography>
                            )}
                            {paeFlexStatus === 'loading' && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                Running Carbonara setup — this can take a couple
                                of minutes.
                              </Typography>
                            )}
                            {paeFlexStatus === 'error' && (
                              <Alert
                                severity="error"
                                sx={{ py: 0 }}
                              >
                                {paeFlexError ?? 'PAE flexibility failed'}
                              </Alert>
                            )}
                            {paeFlexStatus === 'done' && (
                              <Box>
                                {paeFlexRanges.length === 0 ? (
                                  <Typography variant="body2">
                                    No PAE-based flexible regions were found at
                                    this threshold.
                                  </Typography>
                                ) : (
                                  <>
                                    <Typography
                                      variant="body2"
                                      sx={{ fontWeight: 600, mb: 0.5 }}
                                    >
                                      PAE-selected flexible residues (
                                      {paeFlexRanges.length}):
                                    </Typography>
                                    <Stack
                                      direction="row"
                                      sx={{ flexWrap: 'wrap', gap: 0.5, mb: 1 }}
                                    >
                                      {paeFlexRanges.map((r, i) => (
                                        <Chip
                                          key={i}
                                          size="small"
                                          variant="outlined"
                                          color="warning"
                                          label={`Chain ${r.chain}: ${r.start}–${r.stop}`}
                                        />
                                      ))}
                                    </Stack>
                                    <Button
                                      size="small"
                                      variant="contained"
                                      onClick={sendPaeToManual}
                                      disabled={isSubmitting}
                                    >
                                      Send to Manual editor
                                    </Button>
                                    <Typography
                                      variant="caption"
                                      color="text.secondary"
                                      sx={{ display: 'block', mt: 0.5 }}
                                    >
                                      Sending these to the Manual editor switches
                                      to Manual mode and highlights them yellow in
                                      the 3D viewer above, where you can refine
                                      them.
                                    </Typography>
                                  </>
                                )}
                              </Box>
                            )}
                          </Box>
                        </Box>
                      )}
                    </Box>
                  </Box>
                  {/* ── sub-block: Distance constraints ── */}
                  <Typography
                    variant="subtitle1"
                    sx={{
                      fontWeight: 700,
                      mt: 3,
                      mb: 1,
                      pt: 2,
                      borderTop: '2px solid',
                      borderColor: 'divider'
                    }}
                  >
                    Distance constraints
                  </Typography>
                  <Box sx={{ mt: 1, mb: 1 }}>
                    <RadioGroup
                      row
                      value={constraintsMethod}
                      onChange={(e) =>
                        setConstraintsMethod(
                          e.target.value as 'none' | 'file' | 'pairs'
                        )
                      }
                    >
                      <FormControlLabel
                        value="none"
                        control={<Radio size="small" />}
                        label="None"
                      />
                      <FormControlLabel
                        value="file"
                        control={<Radio size="small" />}
                        label="Upload file"
                      />
                      <FormControlLabel
                        value="pairs"
                        control={<Radio size="small" />}
                        label="Enter pairs"
                      />
                    </RadioGroup>

                    {constraintsMethod === 'file' && (
                      <Box sx={{ mt: 0.5 }}>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block', mb: 0.5 }}
                        >
                          One pair per line:{' '}
                          <code>res1 chain1 res2 chain2 distance</code> — using
                          the chain letters and residue numbers shown in the
                          viewer.
                        </Typography>
                        <Grid>
                          <Field
                            name="constraints_file"
                            id="constraints-file-upload"
                            as={FileSelect}
                            title="Select File"
                            disabled={isSubmitting}
                            setFieldValue={setFieldValue}
                            setFieldTouched={setFieldTouched}
                            error={
                              errors.constraints_file &&
                              touched.constraints_file
                            }
                            errorMessage={
                              errors.constraints_file
                                ? errors.constraints_file
                                : ''
                            }
                            fileType="constraints *.dat or *.txt"
                            fileExt=".dat,.txt"
                          />
                        </Grid>
                        {viewerConstraints.length > 0 && (
                          <Typography
                            variant="caption"
                            color={
                              constraintsDrawn < viewerConstraints.length
                                ? 'warning.main'
                                : 'text.secondary'
                            }
                            sx={{ display: 'block', mt: 0.5 }}
                          >
                            {constraintsDrawn === viewerConstraints.length
                              ? `Parsed ${viewerConstraints.length} pair(s); showing ${constraintsDrawn} in the viewer above.`
                              : `Parsed ${viewerConstraints.length} pair(s) but only ${constraintsDrawn} mapped — the rest reference a residue/chain not found (check the format, chain letters and residue numbers).`}
                          </Typography>
                        )}
                      </Box>
                    )}

                    {constraintsMethod === 'pairs' && (
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="caption" color="text.secondary">
                          Format: residue number, chain letter for each end of
                          the pair; optional target distance in Å. Each complete
                          pair is drawn as a dashed line (with its current Cα–Cα
                          distance) in the 3D viewer above.
                        </Typography>
                        {constraintPairs.map((pair, idx) => (
                          <Box
                            key={idx}
                            sx={{
                              display: 'flex',
                              gap: 1,
                              mt: 1,
                              alignItems: 'center'
                            }}
                          >
                            <TextField
                              label="Res 1"
                              size="small"
                              value={pair.res1}
                              onChange={(e) => {
                                const updated = constraintPairs.map(
                                  (p, i): ConstraintPairRow =>
                                    i === idx
                                      ? { ...p, res1: e.target.value }
                                      : p
                                )
                                setConstraintPairs(updated)
                              }}
                              sx={{ width: '70px' }}
                              disabled={isSubmitting}
                            />
                            <TextField
                              label="Chain 1"
                              size="small"
                              value={pair.chain1}
                              onChange={(e) => {
                                const updated = constraintPairs.map(
                                  (p, i): ConstraintPairRow =>
                                    i === idx
                                      ? { ...p, chain1: e.target.value }
                                      : p
                                )
                                setConstraintPairs(updated)
                              }}
                              sx={{ width: '70px' }}
                              disabled={isSubmitting}
                            />
                            <TextField
                              label="Res 2"
                              size="small"
                              value={pair.res2}
                              onChange={(e) => {
                                const updated = constraintPairs.map(
                                  (p, i): ConstraintPairRow =>
                                    i === idx
                                      ? { ...p, res2: e.target.value }
                                      : p
                                )
                                setConstraintPairs(updated)
                              }}
                              sx={{ width: '70px' }}
                              disabled={isSubmitting}
                            />
                            <TextField
                              label="Chain 2"
                              size="small"
                              value={pair.chain2}
                              onChange={(e) => {
                                const updated = constraintPairs.map(
                                  (p, i): ConstraintPairRow =>
                                    i === idx
                                      ? { ...p, chain2: e.target.value }
                                      : p
                                )
                                setConstraintPairs(updated)
                              }}
                              sx={{ width: '70px' }}
                              disabled={isSubmitting}
                            />
                            <TextField
                              label="Dist (Å)"
                              size="small"
                              value={pair.distance}
                              onChange={(e) => {
                                const updated = constraintPairs.map(
                                  (p, i): ConstraintPairRow =>
                                    i === idx
                                      ? { ...p, distance: e.target.value }
                                      : p
                                )
                                setConstraintPairs(updated)
                              }}
                              sx={{ width: '80px' }}
                              disabled={isSubmitting}
                            />
                            <IconButton
                              size="small"
                              disabled={
                                isSubmitting || constraintPairs.length <= 1
                              }
                              onClick={() =>
                                setConstraintPairs(
                                  constraintPairs.filter((_, i) => i !== idx)
                                )
                              }
                              aria-label="remove-pair"
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        ))}
                        <Button
                          size="small"
                          startIcon={<AddIcon />}
                          onClick={() =>
                            setConstraintPairs([
                              ...constraintPairs,
                              emptyPairRow()
                            ])
                          }
                          disabled={isSubmitting}
                          sx={{ mt: 1 }}
                        >
                          Add pair
                        </Button>
                        {viewerConstraints.length > 0 && (
                          <Typography
                            variant="caption"
                            color={
                              constraintsDrawn < viewerConstraints.length
                                ? 'warning.main'
                                : 'text.secondary'
                            }
                            sx={{ display: 'block', mt: 1 }}
                          >
                            {constraintsDrawn === viewerConstraints.length
                              ? `Showing ${constraintsDrawn} constraint line(s) in the viewer above.`
                              : `Showing ${constraintsDrawn} of ${viewerConstraints.length} pair(s). The rest reference a residue/chain not found — check the chain letter and that the residue number exists in that chain.`}
                          </Typography>
                        )}
                      </Box>
                    )}
                  </Box>

                  {/* ── sub-block: Affine rotations (multimer only) ── */}
                  {/* The oligomeric mode is chosen in Block 1; affine rotation
                      and chain merging are only relevant for a multimer, so this
                      sub-block is gated on that choice. */}
                  <Typography
                    variant="subtitle1"
                    sx={{
                      fontWeight: 700,
                      mt: 3,
                      mb: 1,
                      pt: 2,
                      borderTop: '2px solid',
                      borderColor: 'divider'
                    }}
                  >
                    Affine rotations
                  </Typography>
                  {oligomericState !== 'multimer' ? (
                    <Alert
                      severity="info"
                      variant="outlined"
                      sx={{ py: 0.5 }}
                    >
                      Affine rotations apply to multimers. Choose{' '}
                      <strong>Multimer</strong> mode in Block 1 (Initial
                      Scattering Check) to enable rigid-body rotation of subunits
                      and chain merging.
                    </Alert>
                  ) : (
                    <Box sx={{ ml: 1, mt: 1 }}>
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={affineRotation}
                            onChange={(e) =>
                              setAffineRotation(e.target.checked)
                            }
                            disabled={isSubmitting}
                            size="small"
                            slotProps={{
                              input: { 'aria-label': 'affine-rotation-checkbox' }
                            }}
                          />
                        }
                        label="Sample affine rotations of subunits"
                      />
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mb: 1 }}
                      >
                        During sampling, subunits are rotated rigidly about one
                        another. By default each chain is its own subunit. Merge
                        chains below so they rotate together as one subunit (e.g.
                        an antibody F(ab) arm = one heavy + one light chain).
                      </Typography>

                      {affineRotation && (
                        <Box sx={{ mt: 1 }}>
                          <Typography
                            variant="subtitle2"
                            sx={{ fontWeight: 600 }}
                          >
                            Subunits (merge chains)
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block', mb: 1 }}
                          >
                            Select two or more chains and merge them into one
                            subunit. Merged chains share a colour in the viewer
                            and rotate together; each unmerged chain is its own
                            subunit.
                          </Typography>

                          {viewerChains.length === 0 ? (
                            <Typography
                              variant="body2"
                              color="text.secondary"
                            >
                              Upload a structure to choose subunits.
                            </Typography>
                          ) : (
                            <>
                              <Stack
                                direction="row"
                                sx={{
                                  flexWrap: 'wrap',
                                  gap: 0.5,
                                  alignItems: 'center'
                                }}
                              >
                                {viewerChains.map((c, i) => {
                                  const selected = mergeSelection.includes(c)
                                  const col =
                                    chainColorMap[c] ??
                                    carbonaraChainColorHex(i)
                                  return (
                                    <Chip
                                      key={c}
                                      size="small"
                                      label={c}
                                      onClick={() => toggleMergeSelect(c)}
                                      variant={selected ? 'filled' : 'outlined'}
                                      sx={
                                        selected
                                          ? {
                                              backgroundColor: col,
                                              color: '#fff',
                                              outline: '2px solid #222'
                                            }
                                          : { borderColor: col, color: col }
                                      }
                                    />
                                  )
                                })}
                                <Button
                                  size="small"
                                  variant="contained"
                                  disabled={
                                    isSubmitting || mergeSelection.length < 2
                                  }
                                  onClick={mergeSelected}
                                  sx={{ ml: 1 }}
                                >
                                  Merge selected
                                </Button>
                              </Stack>

                              {mergeGroups.length > 0 && (
                                <Box sx={{ mt: 1 }}>
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    sx={{ display: 'block' }}
                                  >
                                    Merged subunits (each shown as a single
                                    colour in the 3D viewer above):
                                  </Typography>
                                  {mergeGroups.map((g, idx) => {
                                    const anchor = Math.min(
                                      ...g
                                        .map((id) => viewerChains.indexOf(id))
                                        .filter((x) => x >= 0)
                                    )
                                    const col = carbonaraChainColorHex(anchor)
                                    return (
                                      <Box
                                        key={idx}
                                        sx={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 1,
                                          mt: 0.5
                                        }}
                                      >
                                        <Box
                                          sx={{
                                            width: 14,
                                            height: 14,
                                            borderRadius: '3px',
                                            backgroundColor: col
                                          }}
                                        />
                                        <Typography variant="body2">
                                          {g.join(' + ')}
                                        </Typography>
                                        <IconButton
                                          size="small"
                                          onClick={() => clearMergeGroup(idx)}
                                          disabled={isSubmitting}
                                          aria-label="clear-merge"
                                        >
                                          <DeleteIcon fontSize="small" />
                                        </IconButton>
                                      </Box>
                                    )
                                  })}
                                </Box>
                              )}

                              {/* Advanced residue-range merge — deferred:
                                  Carbonara merges whole chains only. */}
                              <Box sx={{ mt: 2 }}>
                                <FormControlLabel
                                  control={
                                    <Checkbox
                                      checked={false}
                                      disabled
                                      size="small"
                                    />
                                  }
                                  label="Merge by residue range (advanced)"
                                />
                                <Alert
                                  severity="info"
                                  variant="outlined"
                                  sx={{ py: 0, mt: 0.5 }}
                                >
                                  Merging arbitrary residue ranges into a subunit
                                  isn&apos;t supported yet — Carbonara currently
                                  merges whole chains only. Coming later.
                                </Alert>
                              </Box>
                            </>
                          )}
                        </Box>
                      )}
                    </Box>
                  )}
                </Paper>

                {/* ── Block 3: Fitting ─────────────────────────────────── */}
                <HeaderBox>
                  <Typography>3 · Fitting</Typography>
                </HeaderBox>
                <Paper sx={{ p: 2, mb: 2 }}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mb: 1 }}
                  >
                    Controls the conformational sampling run itself. These do not
                    change the 3D viewer above.
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 2, my: 2 }}>
                    <Field
                      label="q min"
                      name="min_q"
                      id="min_q"
                      type="number"
                      disabled={isSubmitting}
                      as={TextField}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      error={errors.min_q && touched.min_q}
                      helperText={
                        errors.min_q && touched.min_q ? errors.min_q : ''
                      }
                      value={values.min_q}
                      slotProps={{
                        htmlInput: { step: 0.01, min: 0, max: values.max_q }
                      }}
                      sx={{ width: '160px' }}
                    />
                    <Field
                      label="q max"
                      name="max_q"
                      id="max_q"
                      type="number"
                      disabled={isSubmitting}
                      as={TextField}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      error={errors.max_q && touched.max_q}
                      helperText={
                        errors.max_q && touched.max_q ? errors.max_q : ''
                      }
                      value={values.max_q}
                      slotProps={{
                        htmlInput: { step: 0.01, min: values.min_q }
                      }}
                      sx={{ width: '160px' }}
                    />
                  </Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mb: 1 }}
                  >
                    q-range (Å⁻¹) of the SAXS curve to fit over. Restricting q
                    max drops noisy high-q data; this is the same q convention as
                    the initial scattering check.
                  </Typography>

                  <Box sx={{ display: 'flex', gap: 2, my: 1 }}>
                    <Field
                      label="Number of fits"
                      name="fit_n_times"
                      id="fit_n_times"
                      type="number"
                      disabled={isSubmitting}
                      as={TextField}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      error={errors.fit_n_times && touched.fit_n_times}
                      helperText={
                        errors.fit_n_times && touched.fit_n_times
                          ? errors.fit_n_times
                          : ''
                      }
                      value={values.fit_n_times}
                      slotProps={{ htmlInput: { step: 1, min: 1, max: 100 } }}
                      sx={{ width: '200px' }}
                    />
                    <Field
                      label="Max fitting steps"
                      name="max_fit_steps"
                      id="max_fit_steps"
                      type="number"
                      disabled={isSubmitting}
                      as={TextField}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      error={errors.max_fit_steps && touched.max_fit_steps}
                      helperText={
                        errors.max_fit_steps && touched.max_fit_steps
                          ? errors.max_fit_steps
                          : ''
                      }
                      value={values.max_fit_steps}
                      slotProps={{ htmlInput: { step: 100, min: 100 } }}
                      sx={{ width: '200px' }}
                    />
                  </Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mb: 1 }}
                  >
                    <strong>Number of fits</strong>: independent sampling runs —
                    more runs explore more conformations but take longer.{' '}
                    <strong>Max fitting steps</strong>: the sampling-step budget
                    per fit.
                  </Typography>

                  <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
                    <Field name="all_atom">
                      {({
                        field
                      }: {
                        field: {
                          name: string
                          value: boolean
                          onChange: (
                            e: React.ChangeEvent<HTMLInputElement>
                          ) => void
                        }
                      }) => (
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={field.value}
                              onChange={field.onChange}
                              name={field.name}
                              disabled={isSubmitting}
                              slotProps={{
                                input: { 'aria-label': 'all-atom-checkbox' }
                              }}
                            />
                          }
                          label="Return all-atom models (cg2all)"
                        />
                      )}
                    </Field>
                  </Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', ml: 4 }}
                  >
                    Rebuild full atomic detail from the coarse-grained fit results
                    using cg2all. Optionally score each rebuilt model against your
                    SAXS data with FoXS.
                  </Typography>

                  {values.all_atom && (
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        ml: 3,
                        mt: 0.5
                      }}
                    >
                      <Field name="do_foxs">
                        {({
                          field
                        }: {
                          field: {
                            name: string
                            value: boolean
                            onChange: (
                              e: React.ChangeEvent<HTMLInputElement>
                            ) => void
                          }
                        }) => (
                          <FormControlLabel
                            control={
                              <Checkbox
                                checked={field.value}
                                onChange={field.onChange}
                                name={field.name}
                                disabled={isSubmitting}
                                slotProps={{
                                  input: { 'aria-label': 'do-foxs-checkbox' }
                                }}
                              />
                            }
                            label="Score with FoXS"
                          />
                        )}
                      </Field>
                    </Box>
                  )}
                </Paper>

                {/* ── Submit ───────────────────────────────────────────── */}
                {isSubmitting && (
                  <Box sx={{ my: 1, width: '520px' }}>
                    <LinearProgress />
                  </Box>
                )}

                <Grid sx={{ mt: 2 }}>
                  <Button
                    type="submit"
                    disabled={
                      !isValid ||
                      values.title === '' ||
                      values.pdb_file === '' ||
                      values.dat_file === '' ||
                      (flexMode === 'manual' &&
                        flexRangeRows.filter(
                          (r) => r.chain && r.start && r.stop
                        ).length === 0)
                    }
                    loading={isSubmitting}
                    endIcon={<SendIcon />}
                    loadingPosition="end"
                    variant="contained"
                    sx={{ width: '110px' }}
                  >
                    <span>Submit</span>
                  </Button>
                </Grid>

                {import.meta.env.MODE === 'development' ? <Debug /> : ''}
              </Form>
            )}
          </Formik>
        )}
      </Grid>
    </Grid>
  )

  return content
}

export default NewCarbonaraJobForm
