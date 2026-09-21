import { useEffect, useState } from 'react'
import { Box, Alert, AlertTitle, CircularProgress, Typography } from '@mui/material'
import { detectNumberingGaps, type NumberingGap } from './carbonaraPdbCheck'

export interface MissingResiduesInfo {
  hasGaps: boolean
  // Which source(s) detected missing residues (kept as an array for the button
  // label; currently always ['the structure numbering']).
  sources: string[]
}

interface CarbonaraFastaCheckPanelProps {
  pdbFile?: File | string
  // Retained for API compatibility with the form; not used for detection —
  // gaps come from the structure's own residue numbering (see below).
  fastaFile?: File | string
  // Lifts the missing-residue signal to the form so the PDBFixer "build" control
  // is shown only when internal gaps are actually detected.
  onMissingResidues?: (info: MissingResiduesInfo) => void
}

const describeGap = (g: NumberingGap): string =>
  g.count === 1
    ? `residue ${g.start}`
    : `residues ${g.start}–${g.stop} (${g.count} residues)`

// Reports INTERNAL missing residues in the uploaded structure, detected directly
// from a break in the residue numbering (e.g. 76 -> 78 means residue 77 is
// absent). This is exactly what PDBFixer builds and — unlike aligning the chain
// against a FASTA/SEQRES sequence — is unambiguous and immune to multi-chain /
// repeated-sequence mis-alignment. Advisory only; never blocks submission.
const CarbonaraFastaCheckPanel = ({
  pdbFile,
  onMissingResidues
}: CarbonaraFastaCheckPanelProps) => {
  const [gaps, setGaps] = useState<NumberingGap[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setGaps(null)
    if (!(pdbFile instanceof File)) {
      onMissingResidues?.({ hasGaps: false, sources: [] })
      return
    }
    // Carbonara re-derives numbering for mmCIF; the PDB-numbering heuristic only
    // applies to .pdb uploads.
    if (pdbFile.name.toLowerCase().endsWith('.cif')) {
      onMissingResidues?.({ hasGaps: false, sources: [] })
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const text = await pdbFile.text()
        if (cancelled) return
        const ng = detectNumberingGaps(text)
        setGaps(ng)
        onMissingResidues?.({
          hasGaps: ng.length > 0,
          sources: ng.length > 0 ? ['the structure numbering'] : []
        })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // onMissingResidues intentionally omitted — a stable setter from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdbFile])

  if (loading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 1 }}>
        <CircularProgress size={16} />
        <Typography
          variant="body2"
          color="text.secondary"
        >
          Checking for missing residues…
        </Typography>
      </Box>
    )
  }

  if (gaps === null) return null

  if (gaps.length === 0) {
    return (
      <Alert
        severity="success"
        sx={{ my: 1 }}
      >
        No internal missing residues detected in the structure (the residue
        numbering is continuous).
      </Alert>
    )
  }

  // Group gaps by chain for a per-chain summary.
  const byChain = new Map<string, NumberingGap[]>()
  for (const g of gaps) {
    const list = byChain.get(g.chainId) ?? []
    list.push(g)
    byChain.set(g.chainId, list)
  }

  return (
    <Box sx={{ my: 1 }}>
      {[...byChain.entries()].map(([chainId, list]) => {
        const total = list.reduce((n, g) => n + g.count, 0)
        return (
          <Alert
            key={chainId}
            severity="warning"
            sx={{ mb: 1 }}
          >
            <AlertTitle>
              Chain {chainId}: {total} internal residue{total === 1 ? '' : 's'}{' '}
              missing from the structure
            </AlertTitle>
            <Typography
              variant="body2"
              sx={{ mb: 1 }}
            >
              These residues are absent from the structure (a break in the
              residue numbering). PDBFixer can build them in before fitting.
            </Typography>
            <Box
              component="ul"
              sx={{ m: 0, pl: 2 }}
            >
              {list.map((g) => (
                <li key={`${chainId}-${g.start}`}>
                  <Typography variant="body2">{describeGap(g)}</Typography>
                </li>
              ))}
            </Box>
          </Alert>
        )
      })}
    </Box>
  )
}

export default CarbonaraFastaCheckPanel
