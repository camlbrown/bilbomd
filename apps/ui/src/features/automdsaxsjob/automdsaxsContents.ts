// Client-side classification of a PDB's contents for the setup-page contents
// toggle, mirroring the pipeline's automd_saxs.openmm.ligand.classify_residues.
// Lets the user see/choose what to keep (protein / ions / crystallisation agents
// / ligands / waters) before uploading — no round-trip needed.

const AA = new Set([
  'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
  'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL',
  'ASH', 'GLH', 'HID', 'HIE', 'HIP', 'LYN', 'CYX', 'CYM', 'HYP',
  'ACE', 'NME', 'NMA', 'NH2', 'FOR'
])
const NUCLEIC = new Set([
  'DA', 'DT', 'DG', 'DC', 'DU', 'DI', 'A', 'U', 'G', 'C', 'I', 'T',
  'RA', 'RU', 'RG', 'RC', '5MC', 'PSU'
])
// Common modified amino acids PDBFixer converts (kept with the protein).
const MODIFIED_AA = new Set([
  'MSE', 'SEP', 'TPO', 'PTR', 'CSO', 'CME', 'MLY', 'KCX', 'PCA', 'CSD',
  'OCS', 'M3L', 'CAS', 'CSS', 'FME', 'LLP', 'KCX', 'AIB'
])
export const WATER = new Set([
  'HOH', 'WAT', 'TIP', 'TIP3', 'TIP4', 'TIP5', 'SOL', 'H2O', 'DOD', 'SPC'
])
export const IONS = new Set([
  'NA', 'CL', 'K', 'MG', 'CA', 'ZN', 'FE', 'FE2', 'MN', 'CU', 'CU1', 'CO',
  'NI', 'LI', 'RB', 'CS', 'SR', 'BA', 'F', 'BR', 'IOD', 'CD', 'HG', 'PB',
  'AL', 'AU', 'AG', 'PT', 'PD', 'CR', 'MO', 'V', 'W', 'SB', 'SN'
])
export const CRYSTALLISATION_AGENTS = new Set([
  'GOL', 'EDO', 'PEG', 'PG4', 'PGE', '1PE', 'P6G', 'MPD', 'DMS', 'DMSO',
  'SO4', 'PO4', 'ACT', 'FMT', 'MES', 'EPE', 'TRS', 'IMD', 'BME', 'MRD',
  'BOG', 'NAG', 'MAN', 'BMA', 'FUC', 'GAL', 'CIT', 'TAR', 'MLI', 'ACY',
  'TBU', 'MOH', 'IPA', 'ETX', 'BU3', 'PGO', '12P', '15P', '2PE', 'XPE',
  'SIN', 'SCN', 'AZI', 'NO3', 'NH4', 'PEO', 'OLC', 'DTT', 'GSH'
])

export type ContentCategory = 'protein' | 'ion' | 'agent' | 'ligand' | 'water'

export interface ContentItem {
  resname: string
  category: ContentCategory
  count: number // number of residues (instances)
}

const category = (resname: string): ContentCategory => {
  if (AA.has(resname) || NUCLEIC.has(resname) || MODIFIED_AA.has(resname))
    return 'protein'
  if (WATER.has(resname)) return 'water'
  if (IONS.has(resname)) return 'ion'
  if (CRYSTALLISATION_AGENTS.has(resname)) return 'agent'
  return 'ligand'
}

/**
 * Parse PDB text and return the distinct residue types grouped by category,
 * with an instance count (distinct chain+resSeq+resname). Protein is collapsed
 * to a single "protein" pseudo-item (the user always keeps it).
 */
export const classifyPdbContents = (pdbText: string): ContentItem[] => {
  // key: resname -> Set of "chain:resSeq" so we count residues not atoms
  const byName = new Map<string, Set<string>>()
  let proteinResidues = 0
  const proteinSeen = new Set<string>()
  for (const line of pdbText.split('\n')) {
    const rec = line.slice(0, 6).trim()
    if (rec !== 'ATOM' && rec !== 'HETATM') continue
    const resname = line.slice(17, 20).trim()
    const chain = line.slice(21, 22)
    const resSeq = line.slice(22, 27).trim()
    const key = `${chain}:${resSeq}`
    if (category(resname) === 'protein') {
      if (!proteinSeen.has(key)) {
        proteinSeen.add(key)
        proteinResidues++
      }
      continue
    }
    if (!byName.has(resname)) byName.set(resname, new Set())
    byName.get(resname)!.add(key)
  }
  const items: ContentItem[] = []
  if (proteinResidues > 0)
    items.push({ resname: 'protein', category: 'protein', count: proteinResidues })
  for (const [resname, keys] of byName) {
    items.push({ resname, category: category(resname), count: keys.size })
  }
  return items
}
