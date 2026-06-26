// Carbonara FASTA ↔ structure compatibility check (client-side).
//
// Users often upload a PDB that is missing residues probed by the SAXS
// experiment. If they also upload a FASTA with the full experimental sequence,
// this module aligns each structure chain's observed sequence against the FASTA
// and reports which residues are absent from the structure (so they can be
// built in before fitting). Phase 1: advisory only — never blocks submission.

import { extractObservedChains, type ObservedChain } from './carbonaraPdbCheck'

export interface FastaRecord {
  header: string
  // Chain hint parsed from a trailing "-A" style suffix on the header, if any.
  chainHint: string | null
  sequence: string
}

export interface MissingRange {
  // 1-based positions within the FASTA sequence.
  fastaStart: number
  fastaEnd: number
  count: number
  sequence: string
  location: 'N-terminal' | 'internal' | 'C-terminal'
  // Flanking observed PDB residue numbers (for internal/terminal context).
  afterPdbResSeq?: number
  beforePdbResSeq?: number
}

export interface Mutation {
  fastaPos: number
  fastaAa: string
  pdbAa: string
  pdbResSeq: number
}

export interface ChainFastaReport {
  pdbChainId: string
  fastaHeader: string
  fastaLength: number
  observedCount: number
  missingCount: number
  missing: MissingRange[]
  mutations: Mutation[]
  identityPct: number
  // false when the chosen FASTA record doesn't confidently match the chain
  // (low identity) — we then avoid reporting misleading "missing" residues.
  matched: boolean
}

export interface FastaCheckResult {
  ran: boolean
  ok: boolean
  chains: ChainFastaReport[]
  warnings: string[]
  error?: string
}

const ONE_LETTER_AA = new Set('ACDEFGHIKLMNPQRSTVWY'.split(''))

// Parse FASTA text into records. Sequences are uppercased and stripped of
// whitespace/non-letters; a trailing "-A" / "_A" / "|A" chain tag is captured.
export const parseFasta = (text: string): FastaRecord[] => {
  const records: FastaRecord[] = []
  let header: string | null = null
  let seq: string[] = []

  const flush = () => {
    if (header === null) return
    const sequence = seq
      .join('')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
    const chainMatch = /[-_|:]([A-Za-z0-9])\s*$/.exec(header)
    records.push({
      header,
      chainHint: chainMatch ? chainMatch[1]! : null,
      sequence
    })
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('>')) {
      flush()
      header = line.slice(1).trim()
      seq = []
    } else if (header !== null) {
      seq.push(line)
    } else {
      // Headerless sequence (bare sequence file): treat as a single record.
      header = ''
      seq = [line]
    }
  }
  flush()
  return records.filter((r) => r.sequence.length > 0)
}

const MATCH = 2
const MISMATCH = -1
const GAP = -1
// Above this many cells the O(F·P) matrix is too big; skip with a warning.
const MAX_CELLS = 6_000_000

interface AlignedColumn {
  f: string | null
  p: string | null
  pResSeq?: number
}

// Global Needleman–Wunsch alignment of the FASTA sequence (rows) against the
// observed PDB residues (cols). Returns the aligned columns; a column with
// f set and p null is a FASTA residue absent from the structure.
const align = (
  fasta: string,
  observed: ObservedChain['residues']
): AlignedColumn[] | null => {
  const F = fasta.length
  const P = observed.length
  if (F === 0 || P === 0) return null
  if ((F + 1) * (P + 1) > MAX_CELLS) return null

  const width = P + 1
  const dp = new Float64Array((F + 1) * width)
  // 0 = diagonal, 1 = up (FASTA-only / gap in PDB), 2 = left (PDB-only).
  const ptr = new Uint8Array((F + 1) * width)

  for (let i = 1; i <= F; i++) {
    dp[i * width] = i * GAP
    ptr[i * width] = 1
  }
  for (let j = 1; j <= P; j++) {
    dp[j] = j * GAP
    ptr[j] = 2
  }

  for (let i = 1; i <= F; i++) {
    const fAa = fasta[i - 1]
    for (let j = 1; j <= P; j++) {
      const same = fAa === observed[j - 1]!.oneLetter
      const diag = dp[(i - 1) * width + (j - 1)]! + (same ? MATCH : MISMATCH)
      const up = dp[(i - 1) * width + j]! + GAP
      const left = dp[i * width + (j - 1)]! + GAP
      let best = diag
      let dir: number = 0
      if (up > best) {
        best = up
        dir = 1
      }
      if (left > best) {
        best = left
        dir = 2
      }
      dp[i * width + j] = best
      ptr[i * width + j] = dir
    }
  }

  const cols: AlignedColumn[] = []
  let i = F
  let j = P
  while (i > 0 || j > 0) {
    const dir = i === 0 ? 2 : j === 0 ? 1 : ptr[i * width + j]!
    if (dir === 0) {
      cols.push({
        f: fasta[i - 1]!,
        p: observed[j - 1]!.oneLetter,
        pResSeq: observed[j - 1]!.resSeq
      })
      i--
      j--
    } else if (dir === 1) {
      cols.push({ f: fasta[i - 1]!, p: null })
      i--
    } else {
      cols.push({
        f: null,
        p: observed[j - 1]!.oneLetter,
        pResSeq: observed[j - 1]!.resSeq
      })
      j--
    }
  }
  cols.reverse()
  return cols
}

interface MatchedPair {
  fastaPos: number
  resSeq: number
  fAa: string
  pAa: string
}

// Pull the aligned pairs (FASTA position ↔ observed residue) out of the columns.
const matchedPairs = (cols: AlignedColumn[]): MatchedPair[] => {
  const pairs: MatchedPair[] = []
  let fastaPos = 0
  for (const col of cols) {
    if (col.f !== null) fastaPos++
    if (col.f !== null && col.p !== null) {
      pairs.push({ fastaPos, resSeq: col.pResSeq!, fAa: col.f, pAa: col.p })
    }
  }
  return pairs
}

// Most common value in a list, with the fraction of entries that share it.
const mode = (xs: number[]): { value: number; frac: number } => {
  const counts = new Map<number, number>()
  let best = 0
  let bestCount = 0
  for (const x of xs) {
    const c = (counts.get(x) ?? 0) + 1
    counts.set(x, c)
    if (c > bestCount) {
      bestCount = c
      best = x
    }
  }
  return { value: best, frac: xs.length > 0 ? bestCount / xs.length : 0 }
}

// When the matched residues share a single PDB↔FASTA numbering offset (the
// common case — the PDB just uses construct/UniProt numbering), coverage is
// derived directly from that offset. This is exact and avoids the tie-break
// artefacts of reading gaps off a raw sequence alignment.
const buildFromOffset = (
  record: FastaRecord,
  observed: ObservedChain['residues'],
  offset: number
): { missing: MissingRange[]; mutations: Mutation[] } => {
  const F = record.sequence.length
  const covered = new Map<number, number>() // fastaPos -> resSeq
  const mutations: Mutation[] = []
  for (const r of observed) {
    const fp = r.resSeq + offset
    if (fp < 1 || fp > F) continue
    if (!covered.has(fp)) covered.set(fp, r.resSeq)
    if (record.sequence[fp - 1] !== r.oneLetter) {
      mutations.push({
        fastaPos: fp,
        fastaAa: record.sequence[fp - 1]!,
        pdbAa: r.oneLetter,
        pdbResSeq: r.resSeq
      })
    }
  }
  const positions = [...covered.keys()].sort((a, b) => a - b)
  const minCov = positions[0] ?? F + 1
  const maxCov = positions[positions.length - 1] ?? 0

  const missing: MissingRange[] = []
  let run: { start: number; chars: string[] } | null = null
  const close = (beforePos: number | undefined) => {
    if (!run) return
    const end = run.start + run.chars.length - 1
    const location: MissingRange['location'] =
      run.start < minCov ? 'N-terminal' : end > maxCov ? 'C-terminal' : 'internal'
    missing.push({
      fastaStart: run.start,
      fastaEnd: end,
      count: run.chars.length,
      sequence: run.chars.join(''),
      location,
      afterPdbResSeq: covered.get(run.start - 1),
      beforePdbResSeq: beforePos !== undefined ? covered.get(beforePos) : undefined
    })
    run = null
  }
  for (let p = 1; p <= F; p++) {
    if (covered.has(p)) {
      close(p)
    } else {
      if (!run) run = { start: p, chars: [] }
      run.chars.push(record.sequence[p - 1]!)
    }
  }
  close(undefined)
  return { missing, mutations }
}

// Fallback when numbering is inconsistent (renumbered / insertion codes): read
// the missing runs straight off the alignment columns.
const buildFromColumns = (
  cols: AlignedColumn[]
): { missing: MissingRange[]; mutations: Mutation[] } => {
  const missing: MissingRange[] = []
  const mutations: Mutation[] = []
  let fastaPos = 0
  let lastObservedResSeq: number | undefined
  let seenObserved = false
  let run: { start: number; chars: string[]; after?: number } | null = null

  const closeRun = (beforeResSeq?: number) => {
    if (!run) return
    const location: MissingRange['location'] = !seenObserved
      ? 'N-terminal'
      : beforeResSeq === undefined
        ? 'C-terminal'
        : 'internal'
    missing.push({
      fastaStart: run.start,
      fastaEnd: run.start + run.chars.length - 1,
      count: run.chars.length,
      sequence: run.chars.join(''),
      location,
      afterPdbResSeq: run.after,
      beforePdbResSeq: beforeResSeq
    })
    run = null
  }

  for (const col of cols) {
    if (col.f !== null) fastaPos++
    if (col.f !== null && col.p === null) {
      if (!run) run = { start: fastaPos, chars: [], after: lastObservedResSeq }
      run.chars.push(col.f)
    } else if (col.f !== null && col.p !== null) {
      closeRun(col.pResSeq)
      if (col.f !== col.p) {
        mutations.push({
          fastaPos,
          fastaAa: col.f,
          pdbAa: col.p,
          pdbResSeq: col.pResSeq!
        })
      }
      seenObserved = true
      lastObservedResSeq = col.pResSeq
    } else if (col.p !== null) {
      closeRun(col.pResSeq)
      seenObserved = true
      lastObservedResSeq = col.pResSeq
    }
  }
  closeRun(undefined)
  return { missing, mutations }
}

const buildReport = (
  pdbChainId: string,
  record: FastaRecord,
  observed: ObservedChain['residues'],
  cols: AlignedColumn[]
): ChainFastaReport => {
  const pairs = matchedPairs(cols)
  const aligned = pairs.length
  const identical = pairs.filter((p) => p.fAa === p.pAa).length
  const identityPct = aligned > 0 ? (identical / aligned) * 100 : 0
  const matched = identityPct >= 70

  // Prefer the offset path when the numbering is a consistent single shift.
  const offsets = pairs
    .filter((p) => p.fAa === p.pAa)
    .map((p) => p.fastaPos - p.resSeq)
  const off = mode(offsets)
  const useOffset = matched && offsets.length >= 8 && off.frac >= 0.9

  const { missing, mutations } = useOffset
    ? buildFromOffset(record, observed, off.value)
    : buildFromColumns(cols)

  const missingCount = missing.reduce((s, m) => s + m.count, 0)

  return {
    pdbChainId,
    fastaHeader: record.header || '(unnamed)',
    fastaLength: record.sequence.length,
    observedCount: observed.length,
    missingCount,
    missing,
    mutations,
    identityPct,
    matched
  }
}

// Pick the FASTA record that best matches a chain: prefer a chain-hint match,
// else the record giving the highest alignment identity.
const chooseRecord = (
  chain: ObservedChain,
  records: FastaRecord[]
): { record: FastaRecord; cols: AlignedColumn[] } | null => {
  const hinted = records.find(
    (r) => r.chainHint && r.chainHint.toUpperCase() === chain.id.toUpperCase()
  )
  const candidates = hinted ? [hinted] : records
  let best: { record: FastaRecord; cols: AlignedColumn[]; score: number } | null =
    null
  for (const record of candidates) {
    const cols = align(record.sequence, chain.residues)
    if (!cols) continue
    let identical = 0
    let aligned = 0
    for (const c of cols) {
      if (c.f !== null && c.p !== null) {
        aligned++
        if (c.f === c.p) identical++
      }
    }
    const score = aligned > 0 ? identical / aligned : 0
    if (!best || score > best.score) best = { record, cols, score }
  }
  return best ? { record: best.record, cols: best.cols } : null
}

// Top-level: compare an uploaded FASTA against an uploaded PDB. CIF is skipped
// (Carbonara/PDBFixer repairs CIF), and a too-large structure is skipped too.
export const checkFastaAgainstStructure = (
  pdbFileName: string,
  pdbText: string,
  fastaText: string
): FastaCheckResult => {
  const warnings: string[] = []

  if (pdbFileName.toLowerCase().endsWith('.cif')) {
    return {
      ran: false,
      ok: true,
      chains: [],
      warnings: [
        'CIF structures are auto-repaired by Carbonara, so the FASTA check is not run here. Upload a .pdb to compare against the sequence.'
      ]
    }
  }

  const records = parseFasta(fastaText)
  if (records.length === 0) {
    return {
      ran: false,
      ok: false,
      chains: [],
      warnings: [],
      error: 'No sequences found in the FASTA file.'
    }
  }
  const badRecord = records.find(
    (r) => !r.sequence.split('').every((c) => ONE_LETTER_AA.has(c))
  )
  if (badRecord) {
    warnings.push(
      'The FASTA contains non-standard one-letter codes; results may be approximate.'
    )
  }

  const chains = extractObservedChains(pdbText).filter(
    (c) => c.residues.length > 0
  )
  if (chains.length === 0) {
    return {
      ran: false,
      ok: false,
      chains: [],
      warnings,
      error: 'No protein residues with Cα atoms were found in the structure.'
    }
  }

  if (records.length > 1 && records.length !== chains.length) {
    warnings.push(
      `The FASTA has ${records.length} sequences but the structure has ${chains.length} chain(s); each chain was matched to its best-fitting sequence.`
    )
  }

  const reports: ChainFastaReport[] = []
  for (const chain of chains) {
    const chosen = chooseRecord(chain, records)
    if (!chosen) {
      warnings.push(
        `Chain ${chain.id}: could not align to the FASTA (sequence too large or empty).`
      )
      continue
    }
    const report = buildReport(chain.id, chosen.record, chain.residues, chosen.cols)
    if (!report.matched) {
      warnings.push(
        `Chain ${chain.id}: low sequence identity (${report.identityPct.toFixed(
          0
        )}%) to the FASTA — check you uploaded the matching sequence.`
      )
    }
    reports.push(report)
  }

  const ok = reports.every((r) => !r.matched || r.missingCount === 0)
  return { ran: true, ok, chains: reports, warnings }
}
