import { describe, it, expect } from 'vitest'
import {
  parseFasta,
  checkFastaAgainstStructure
} from '../carbonaraFastaCheck'

const AA3: Record<string, string> = {
  A: 'ALA', C: 'CYS', D: 'ASP', E: 'GLU', F: 'PHE', G: 'GLY', H: 'HIS',
  I: 'ILE', K: 'LYS', L: 'LEU', M: 'MET', N: 'ASN', P: 'PRO', Q: 'GLN',
  R: 'ARG', S: 'SER', T: 'THR', V: 'VAL', W: 'TRP', Y: 'TYR'
}

// Build a minimal PDB with one Cα ATOM record per (oneLetter, resSeq) pair.
const caLine = (serial: number, one: string, resSeq: number): string => {
  const x = (serial * 3.8).toFixed(3).padStart(8)
  const y = (10.0).toFixed(3).padStart(8)
  const z = (10.0).toFixed(3).padStart(8)
  return (
    'ATOM  ' +
    String(serial).padStart(5) +
    ' ' +
    ' CA ' +
    ' ' +
    AA3[one]!.padStart(3) +
    ' ' +
    'A' +
    String(resSeq).padStart(4) +
    ' ' +
    '   ' +
    x +
    y +
    z
  )
}

// Make a PDB from (fastaPos -> present?) using a numbering offset.
const makePdb = (
  fasta: string,
  presentPositions: number[],
  offset: number
): string =>
  presentPositions
    .map((p, i) => caLine(i + 1, fasta[p - 1]!, p + offset))
    .join('\n') + '\nTER\nEND\n'

describe('parseFasta', () => {
  it('parses a single record and captures the chain hint', () => {
    const recs = parseFasta('>5_ACVR1_monomer.pdb-A\nACDEF\nGHIK\n')
    expect(recs).toHaveLength(1)
    expect(recs[0]!.sequence).toBe('ACDEFGHIK')
    expect(recs[0]!.chainHint).toBe('A')
  })

  it('treats a headerless sequence as one record', () => {
    const recs = parseFasta('ACDEFG\nHIKL\n')
    expect(recs).toHaveLength(1)
    expect(recs[0]!.sequence).toBe('ACDEFGHIKL')
  })
})

describe('checkFastaAgainstStructure', () => {
  const fasta = 'ACDEFGHIKLMNPQRST' // 17 residues
  const fastaText = `>test-A\n${fasta}\n`

  it('finds N-terminal, internal and C-terminal missing residues with offset numbering', () => {
    // Present FASTA positions 3–7 and 10–15; numbering offset +100.
    const pdb = makePdb(fasta, [3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15], 100)
    const res = checkFastaAgainstStructure('test.pdb', pdb, fastaText)

    expect(res.ran).toBe(true)
    expect(res.chains).toHaveLength(1)
    const chain = res.chains[0]!
    expect(chain.matched).toBe(true)
    expect(chain.identityPct).toBe(100)
    expect(chain.mutations).toHaveLength(0)
    expect(chain.missingCount).toBe(6)

    const byLoc = (loc: string) =>
      chain.missing.filter((m) => m.location === loc)

    const nTerm = byLoc('N-terminal')
    expect(nTerm).toHaveLength(1)
    expect(nTerm[0]!.fastaStart).toBe(1)
    expect(nTerm[0]!.fastaEnd).toBe(2)
    expect(nTerm[0]!.sequence).toBe('AC')

    const internal = byLoc('internal')
    expect(internal).toHaveLength(1)
    expect(internal[0]!.sequence).toBe('IK')
    // Flanks are the real, non-consecutive structure residue numbers.
    expect(internal[0]!.afterPdbResSeq).toBe(107)
    expect(internal[0]!.beforePdbResSeq).toBe(110)

    const cTerm = byLoc('C-terminal')
    expect(cTerm).toHaveLength(1)
    expect(cTerm[0]!.sequence).toBe('ST')

    expect(res.ok).toBe(false)
  })

  it('reports a fully-covered structure as ok', () => {
    const allPositions = Array.from({ length: fasta.length }, (_, i) => i + 1)
    const pdb = makePdb(fasta, allPositions, 0)
    const res = checkFastaAgainstStructure('test.pdb', pdb, fastaText)
    expect(res.ok).toBe(true)
    expect(res.chains[0]!.missingCount).toBe(0)
  })

  it('warns on a low-identity (mismatched) FASTA without listing missing residues', () => {
    const pdb = makePdb(fasta, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0)
    const unrelated = '>wrong\nWWWWWWWWWWWWWWWWW\n'
    const res = checkFastaAgainstStructure('test.pdb', pdb, unrelated)
    expect(res.chains[0]!.matched).toBe(false)
    expect(res.warnings.some((w) => w.includes('identity'))).toBe(true)
  })

  it('skips CIF structures with an informational note', () => {
    const res = checkFastaAgainstStructure('test.cif', '', fastaText)
    expect(res.ran).toBe(false)
    expect(res.warnings[0]).toMatch(/CIF/)
  })
})
