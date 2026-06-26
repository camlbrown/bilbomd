import { useEffect, useState } from 'react'
import {
  Box,
  Alert,
  AlertTitle,
  CircularProgress,
  Typography,
  Chip,
  Stack
} from '@mui/material'
import {
  checkFastaAgainstStructure,
  type FastaCheckResult,
  type ChainFastaReport,
  type MissingRange
} from './carbonaraFastaCheck'

interface CarbonaraFastaCheckPanelProps {
  pdbFile?: File | string
  fastaFile?: File | string
}

const readText = async (f: File | string): Promise<string | null> =>
  f instanceof File ? await f.text() : null

const describeRange = (m: MissingRange): string => {
  // Only describe a flanking numbering gap when the two flanks are genuinely
  // non-consecutive (a real break in the structure).
  const realGap =
    m.afterPdbResSeq !== undefined &&
    m.beforePdbResSeq !== undefined &&
    m.beforePdbResSeq > m.afterPdbResSeq + 1
  const where =
    m.location === 'N-terminal'
      ? 'N-terminus'
      : m.location === 'C-terminal'
        ? 'C-terminus'
        : realGap
          ? `between structure residues ${m.afterPdbResSeq} and ${m.beforePdbResSeq}`
          : 'internal gap'
  const range =
    m.count === 1
      ? `residue ${m.fastaStart}`
      : `residues ${m.fastaStart}–${m.fastaEnd}`
  const seq = m.sequence.length <= 30 ? m.sequence : `${m.sequence.slice(0, 30)}…`
  return `${where}: ${range} (${m.count}) — ${seq}`
}

const ChainReport = ({ report }: { report: ChainFastaReport }) => {
  if (report.matched && report.missingCount === 0) {
    return (
      <Alert
        severity="success"
        sx={{ mb: 1 }}
      >
        Chain {report.pdbChainId}: all {report.fastaLength} sequence residues are
        present in the structure.
      </Alert>
    )
  }
  if (!report.matched) {
    // A low-identity match is surfaced as a warning at the panel level; don't
    // list misleading "missing" residues here.
    return null
  }
  return (
    <Alert
      severity="warning"
      sx={{ mb: 1 }}
    >
      <AlertTitle>
        Chain {report.pdbChainId}: {report.missingCount} of {report.fastaLength}{' '}
        residues missing from the structure
      </AlertTitle>
      <Typography
        variant="body2"
        sx={{ mb: 1 }}
      >
        These residues are in the experimental sequence but not built in the
        uploaded structure. Consider building them in before fitting.
      </Typography>
      <Box
        component="ul"
        sx={{ m: 0, pl: 2 }}
      >
        {report.missing.map((m) => (
          <li key={`${report.pdbChainId}-${m.fastaStart}`}>
            <Typography variant="body2">{describeRange(m)}</Typography>
          </li>
        ))}
      </Box>
      {report.mutations.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="body2">
            Sequence mismatches ({report.mutations.length}):
          </Typography>
          <Stack
            direction="row"
            sx={{ gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}
          >
            {report.mutations.slice(0, 12).map((mut) => (
              <Chip
                key={`${report.pdbChainId}-mut-${mut.fastaPos}`}
                size="small"
                variant="outlined"
                label={`${mut.fastaAa}${mut.fastaPos}→${mut.pdbAa} (res ${mut.pdbResSeq})`}
              />
            ))}
            {report.mutations.length > 12 && (
              <Chip
                size="small"
                label={`+${report.mutations.length - 12} more`}
              />
            )}
          </Stack>
        </Box>
      )}
    </Alert>
  )
}

// Compares an uploaded FASTA (full experimental sequence) against the uploaded
// structure and reports residues missing from the structure. Advisory only —
// it never blocks submission.
const CarbonaraFastaCheckPanel = ({
  pdbFile,
  fastaFile
}: CarbonaraFastaCheckPanelProps) => {
  const [result, setResult] = useState<FastaCheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [needPdb, setNeedPdb] = useState(false)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    setNeedPdb(false)
    if (!(fastaFile instanceof File)) return
    if (!(pdbFile instanceof File)) {
      // FASTA uploaded but no structure yet to compare against.
      setNeedPdb(true)
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const [pdbText, fastaText] = await Promise.all([
          readText(pdbFile),
          readText(fastaFile)
        ])
        if (cancelled) return
        if (pdbText && fastaText) {
          setResult(
            checkFastaAgainstStructure(pdbFile.name, pdbText, fastaText)
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pdbFile, fastaFile])

  if (needPdb) {
    return (
      <Alert
        severity="info"
        sx={{ my: 1 }}
      >
        Upload a structure above to check it against this sequence.
      </Alert>
    )
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 1 }}>
        <CircularProgress size={16} />
        <Typography
          variant="body2"
          color="text.secondary"
        >
          Comparing sequence to structure…
        </Typography>
      </Box>
    )
  }

  if (!result) return null

  return (
    <Box sx={{ my: 1 }}>
      {result.error && <Alert severity="error">{result.error}</Alert>}
      {result.warnings.map((w, i) => (
        <Alert
          key={`fasta-warn-${i}`}
          severity="info"
          sx={{ mb: 1 }}
        >
          {w}
        </Alert>
      ))}
      {result.ran &&
        result.chains.map((report) => (
          <ChainReport
            key={report.pdbChainId}
            report={report}
          />
        ))}
    </Box>
  )
}

export default CarbonaraFastaCheckPanel
