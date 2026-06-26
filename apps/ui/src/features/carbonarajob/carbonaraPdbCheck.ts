// Carbonara PDB compatibility checker (client-side).
//
// Carbonara's setup (CarbonaraDataTools.pull_structure_from_pdb +
// setup_carbonara.py) makes several assumptions about the input structure that,
// when violated, lead to silent data loss or a hard setup failure. This module
// parses an uploaded .pdb and flags those issues BEFORE submission. Key code
// paths it guards against (in the upstream Carbonara source):
//   * seq is appended per-residue but a CA coordinate only when a CA exists, and
//     only the first CA per residue -> missing/duplicate CA desyncs the
//     sequence vs coordinate arrays.
//   * `if len(ca_coords) > 10` -> chains with <=10 residues are silently dropped.
//   * find_missing_residues does `range(1, resIDs[0])` -> a chain not starting at
//     residue 1 fabricates phantom "missing" residues.
//   * missing_ca_check splits a chain wherever consecutive CA atoms are >7 A apart.
//   * residue names outside the 20 standard amino acids are read as 'X'.
//
// .cif files are auto-repaired by PDBFixer inside Carbonara (missing
// atoms/residues/hydrogens added), so the deep checks here are PDB-only; for CIF
// we surface an informational note instead.

export interface PdbCheckFinding {
  code: string
  message: string
}

export interface PdbCheckResult {
  // false when deep parsing was not run (e.g. a .cif file).
  ran: boolean
  errors: PdbCheckFinding[]
  warnings: PdbCheckFinding[]
  info: PdbCheckFinding[]
}

const STANDARD_AA = new Set([
  'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
  'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL'
])

// 3-letter -> 1-letter amino-acid codes; anything else maps to 'X'.
const THREE_TO_ONE: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E',
  GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F',
  PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V'
}

const CHAIN_LETTERS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// Carbonara silently drops chains with this many residues or fewer.
const MIN_CHAIN_RESIDUES = 10
// Consecutive CA atoms further apart than this (A) make setup split the chain.
const CA_BREAK_DIST = 7

interface ParsedAtom {
  name: string
  altLoc: string
  x: number
  y: number
  z: number
}

interface ParsedResidue {
  resSeq: number
  iCode: string
  resName: string
  atoms: ParsedAtom[]
}

interface ParsedChain {
  id: string
  residues: ParsedResidue[]
}

// Join a list of items into a short, capped, human-readable string.
const summariseList = (items: string[], cap = 6): string => {
  if (items.length <= cap) return items.join(', ')
  return `${items.slice(0, cap).join(', ')} +${items.length - cap} more`
}

// Parse the ATOM/HETATM records of the FIRST model into chains -> residues ->
// atoms. Chains follow the PDB chain-ID column, falling back to TER-delimited
// segments (A, B, …) when the column is blank — matching how Carbonara/MDTraj
// and the structure viewer assign chains.
const parseFirstModel = (
  text: string
): { chains: ParsedChain[]; hetCount: number; modelCount: number } => {
  const lines = text.split(/\r?\n/)
  const chains: ParsedChain[] = []
  let hetCount = 0
  let modelCount = 0

  let current: ParsedChain | null = null
  let currentRawId: string | null = null
  let currentResidue: ParsedResidue | null = null
  let breakPending = false
  let segIndex = 0
  let inFirstModel = true

  const startChain = (rawId: string): ParsedChain => {
    const display = rawId.trim() || CHAIN_LETTERS[segIndex] || '?'
    const chain: ParsedChain = { id: display, residues: [] }
    currentRawId = rawId
    currentResidue = null
    chains.push(chain)
    segIndex += 1
    return chain
  }

  for (const line of lines) {
    const record = line.slice(0, 6)
    if (record.startsWith('MODEL')) {
      modelCount += 1
      if (modelCount > 1) inFirstModel = false
      continue
    }
    if (record.startsWith('ENDMDL')) {
      if (modelCount <= 1) inFirstModel = false
      continue
    }
    if (!inFirstModel) continue
    if (record.startsWith('TER')) {
      breakPending = true
      continue
    }

    const isAtom = record.startsWith('ATOM')
    const isHet = record.startsWith('HETATM')
    if (!isAtom && !isHet) continue

    if (isHet) {
      hetCount += 1
      // HETATM (waters/ligands/ions) are reported in aggregate, not parsed into
      // protein chains.
      continue
    }
    if (line.length < 54) continue // too short to hold coordinates

    const atomName = line.slice(12, 16).trim()
    const altLoc = line.slice(16, 17).trim()
    const resName = line.slice(17, 20).trim()
    const rawChainId = line.slice(21, 22)
    const resSeq = parseInt(line.slice(22, 26), 10)
    const iCode = line.slice(26, 27).trim()
    const x = parseFloat(line.slice(30, 38))
    const y = parseFloat(line.slice(38, 46))
    const z = parseFloat(line.slice(46, 54))
    if (!Number.isFinite(resSeq)) continue

    const chainChanged =
      rawChainId.trim() !== '' && rawChainId !== currentRawId
    if (!current || breakPending || chainChanged) {
      current = startChain(rawChainId)
      breakPending = false
    }

    const chain = current
    if (
      !currentResidue ||
      currentResidue.resSeq !== resSeq ||
      currentResidue.iCode !== iCode ||
      currentResidue.resName !== resName
    ) {
      currentResidue = { resSeq, iCode, resName, atoms: [] }
      chain.residues.push(currentResidue)
    }
    currentResidue.atoms.push({ name: atomName, altLoc, x, y, z })
  }

  return { chains, hetCount, modelCount }
}

const runPdbChecks = (text: string): PdbCheckResult => {
  const errors: PdbCheckFinding[] = []
  const warnings: PdbCheckFinding[] = []
  const info: PdbCheckFinding[] = []
  const { chains, hetCount, modelCount } = parseFirstModel(text)

  if (modelCount > 1) {
    warnings.push({
      code: 'multi-model',
      message: `File contains ${modelCount} models — Carbonara uses only the first.`
    })
  }

  const proteinChains = chains.filter((c) => c.residues.length > 0)
  if (proteinChains.length === 0) {
    errors.push({
      code: 'no-atoms',
      message: 'No ATOM records found — Carbonara needs protein coordinates.'
    })
    return { ran: true, errors, warnings, info }
  }

  // E4 — the FIRST residue in the file must be 1. Carbonara only requires the
  // overall numbering to begin at 1; later chains may start at a higher number
  // as long as numbering stays consecutive (e.g. chain A 1–241, chain B 242–…),
  // so this is checked once for the file, not per chain.
  const firstResidue = proteinChains[0]?.residues[0]
  if (firstResidue && firstResidue.resSeq !== 1) {
    errors.push({
      code: 'not-start-1',
      message: `The first residue in the file is ${firstResidue.resName}${firstResidue.resSeq} — Carbonara needs the structure to start at residue 1. (Later chains may start higher, as long as numbering stays consecutive.)`
    })
  }

  let totalCa = 0
  const nonStandard = new Set<string>()
  let anyAltLoc = false
  let anyInsertion = false

  for (const chain of proteinChains) {
    const residues = chain.residues
    const caResidues = residues.filter((r) =>
      r.atoms.some((a) => a.name === 'CA')
    )
    totalCa += caResidues.length

    // E2 — chains with <=10 residues are silently dropped.
    if (caResidues.length <= MIN_CHAIN_RESIDUES) {
      errors.push({
        code: 'chain-too-short',
        message: `Chain ${chain.id} has ${caResidues.length} residue(s) with a Cα — Carbonara silently drops chains of ${MIN_CHAIN_RESIDUES} or fewer.`
      })
    }

    // E1 — residue without a CA desyncs sequence vs coordinates.
    const noCa = residues.filter(
      (r) => !r.atoms.some((a) => a.name === 'CA')
    )
    if (noCa.length > 0) {
      const ids = noCa.map((r) => `${r.resName}${r.resSeq}${r.iCode}`)
      errors.push({
        code: 'residue-no-ca',
        message: `Chain ${chain.id}: ${noCa.length} residue(s) have no Cα atom (${summariseList(ids)}) — this desynchronises the sequence and coordinates.`
      })
    }

    // E3 — duplicate atoms within a residue (the "residue too long" case).
    const dupResidues: string[] = []
    for (const r of residues) {
      const byName = new Map<string, string[]>()
      for (const a of r.atoms) {
        const list = byName.get(a.name) ?? []
        list.push(a.altLoc)
        byName.set(a.name, list)
      }
      let dup = false
      for (const [, altLocs] of byName) {
        // Two atoms with the same name AND the same altLoc (or both blank) is a
        // true duplication; distinct altLocs (A/B) are alternate conformations.
        const seen = new Set<string>()
        for (const al of altLocs) {
          if (seen.has(al)) {
            dup = true
            break
          }
          seen.add(al)
        }
        if (dup) break
      }
      if (dup) dupResidues.push(`${r.resName}${r.resSeq}${r.iCode}`)
    }
    if (dupResidues.length > 0) {
      errors.push({
        code: 'duplicate-atoms',
        message: `Chain ${chain.id}: ${dupResidues.length} residue(s) have duplicate atoms (${summariseList(dupResidues)}) — clean up duplicated/overlong residues before submitting.`
      })
    }

    // W1 — gaps in residue numbering.
    const gaps: string[] = []
    for (let i = 1; i < residues.length; i++) {
      const prev = residues[i - 1]!.resSeq
      const cur = residues[i]!.resSeq
      if (cur - prev > 1) gaps.push(`${prev + 1}–${cur - 1}`)
    }
    if (gaps.length > 0) {
      warnings.push({
        code: 'residue-gaps',
        message: `Chain ${chain.id}: gap(s) in residue numbering (missing ${summariseList(gaps)}).`
      })
    }

    // W2 — large Cα–Cα jump: setup splits the chain here.
    const caCoords = caResidues
      .map((r) => r.atoms.find((a) => a.name === 'CA'))
      .filter((a): a is ParsedAtom => !!a)
    let breaks = 0
    for (let i = 1; i < caCoords.length; i++) {
      const a = caCoords[i - 1]!
      const b = caCoords[i]!
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
      if (d > CA_BREAK_DIST) breaks += 1
    }
    if (breaks > 0) {
      warnings.push({
        code: 'ca-break',
        message: `Chain ${chain.id}: ${breaks} large Cα–Cα gap(s) (>${CA_BREAK_DIST} Å) — Carbonara will split the chain there.`
      })
    }

    // Aggregate-level flags collected across chains.
    for (const r of residues) {
      if (!STANDARD_AA.has(r.resName)) nonStandard.add(r.resName)
      if (r.iCode) anyInsertion = true
      if (r.atoms.some((a) => a.altLoc)) anyAltLoc = true
    }
  }

  if (totalCa === 0) {
    errors.push({
      code: 'no-ca',
      message: 'No Cα atoms found — Carbonara cannot build a coarse-grained model.'
    })
  }

  if (nonStandard.size > 0) {
    warnings.push({
      code: 'non-standard-residues',
      message: `Non-standard residue name(s) present (${summariseList([...nonStandard])}) — Carbonara reads these as unknown ('X').`
    })
  }
  if (anyAltLoc) {
    warnings.push({
      code: 'altloc',
      message:
        'Alternate conformations (altLoc) present — Carbonara keeps only one per atom.'
    })
  }
  if (anyInsertion) {
    warnings.push({
      code: 'insertion-codes',
      message:
        'Insertion codes present — these residues collapse onto the same number and may misalign.'
    })
  }
  if (hetCount > 0) {
    warnings.push({
      code: 'hetatm',
      message: `${hetCount} HETATM record(s) (waters/ligands/ions) present — not modelled by Carbonara.`
    })
  }

  return { ran: true, errors, warnings, info }
}

// ---------------------------------------------------------------------------
// Fixers
// ---------------------------------------------------------------------------

// Renumber a PDB so its FIRST residue becomes 1, shifting every residue by the
// same offset. This preserves consecutive cross-chain numbering and any internal
// gaps (e.g. a structure starting at 43 -> 1, and a second chain at 300 -> 258).
// Only the residue-sequence column (cols 23–26) of ATOM/ANISOU/TER records is
// rewritten; HETATM (waters/ligands, ignored by Carbonara) are left untouched.
// Returns the rewritten text + the applied offset, or null if no shift is needed.
export const renumberStructureFromOne = (
  text: string
): { text: string; offset: number } | null => {
  const lines = text.split(/\r?\n/)

  let firstResSeq: number | null = null
  for (const line of lines) {
    if (line.startsWith('ATOM') && line.length >= 26) {
      const v = parseInt(line.slice(22, 26), 10)
      if (Number.isFinite(v)) {
        firstResSeq = v
        break
      }
    }
  }
  if (firstResSeq === null || firstResSeq === 1) return null
  const offset = firstResSeq - 1

  const shift = (line: string): string => {
    if (line.length < 26) return line
    const v = parseInt(line.slice(22, 26), 10)
    if (!Number.isFinite(v)) return line
    // Right-justify in the 4-wide resSeq field; keep insertion code (col 27+).
    const renumbered = String(v - offset).padStart(4, ' ')
    return line.slice(0, 22) + renumbered.slice(-4) + line.slice(26)
  }

  const out = lines.map((line) =>
    line.startsWith('ATOM') ||
    line.startsWith('ANISOU') ||
    line.startsWith('TER')
      ? shift(line)
      : line
  )
  return { text: out.join('\n'), offset }
}

// Remove HETATM records (waters, ligands, ions, modified-residue heteroatoms).
// Carbonara ignores these, but they inflate the chain/residue interpretation, so
// stripping them gives a cleaner input. Also drops ANISOU/SIGUIJ/SIGATM lines so
// no orphan anisotropy records are left behind. Returns null if there were none.
export const stripHetatms = (
  text: string
): { text: string; removed: number } | null => {
  const lines = text.split(/\r?\n/)
  let removed = 0
  let prevWasHet = false
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('HETATM')) {
      removed += 1
      prevWasHet = true
      continue
    }
    // Drop the anisotropy record that belongs to a just-removed HETATM atom.
    if (
      prevWasHet &&
      (line.startsWith('ANISOU') ||
        line.startsWith('SIGUIJ') ||
        line.startsWith('SIGATM'))
    ) {
      continue
    }
    prevWasHet = false
    out.push(line)
  }
  if (removed === 0) return null
  return { text: out.join('\n'), removed }
}

// One residue that is actually built in the structure (has a Cα), with its
// PDB numbering and 1-letter code.
export interface ObservedResidue {
  resSeq: number
  iCode: string
  oneLetter: string
  resName: string
}

export interface ObservedChain {
  id: string
  residues: ObservedResidue[]
}

// Extract the per-chain residues present in the FIRST model of a PDB, keeping
// only residues with a Cα (the ones Carbonara turns into coarse-grained beads).
// Used to compare the structure's coverage against a full experimental FASTA.
export const extractObservedChains = (text: string): ObservedChain[] => {
  const { chains } = parseFirstModel(text)
  return chains.map((c) => ({
    id: c.id,
    residues: c.residues
      .filter((r) => r.atoms.some((a) => a.name === 'CA'))
      .map((r) => ({
        resSeq: r.resSeq,
        iCode: r.iCode,
        oneLetter: THREE_TO_ONE[r.resName] ?? 'X',
        resName: r.resName
      }))
  }))
}

// Decide format from the filename and run the appropriate checks.
export const checkCarbonaraStructure = (
  fileName: string,
  text: string
): PdbCheckResult => {
  const isCif = fileName.toLowerCase().endsWith('.cif')
  if (isCif) {
    return {
      ran: false,
      errors: [],
      warnings: [],
      info: [
        {
          code: 'cif-autorepair',
          message:
            'CIF files are auto-repaired by Carbonara (PDBFixer adds missing atoms, residues and hydrogens), so detailed compatibility checks are not run here. Upload a .pdb for a full check.'
        }
      ]
    }
  }
  return runPdbChecks(text)
}
