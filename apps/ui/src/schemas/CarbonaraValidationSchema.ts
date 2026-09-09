import { object, string, number, boolean, mixed } from 'yup'
import {
  requiredFile,
  pdbOrCifExtTest,
  fileSizeTest,
  fileNameLengthTest,
  noSpacesTest,
  saxsCheckCarbonara,
  fileExtTest,
  jsonFileCheck
} from './fieldTests/fieldTests'

// Phase-1 + Phase-B Carbonara form validation: structure + SAXS plus
// coarse-grained fitting controls and optional PAE-guided flexibility.
// Mirrors the backend carbonaraJobSchema.
export const bilbomdCarbonaraJobSchema = object().shape({
  title: string()
    .required('Please provide a title for your BilboMD Carbonara Job.')
    .min(4, 'Title must contain at least 4 characters.')
    .max(30, 'Title must contain less than 30 characters.')
    .matches(/^[\w\s-]+$/, 'No special characters allowed'),
  // Note: no chain-ID check here (unlike other job types). Carbonara splits
  // chains by TER records, so a missing chain-ID column is fine — the viewer
  // auto-assigns chains from TER breaks for display.
  // Note: no generic residue allow-list check here either. That check flags any
  // HETATM (e.g. Ca²⁺ ions or waters in a calmodulin PDB) as "unsupported",
  // which would silently keep the form invalid and leave Submit greyed out. The
  // Carbonara worker sanitizes HETATM during setup, and the dedicated
  // CarbonaraPdbCheckPanel surfaces real compatibility issues, so we don't block
  // submission on it here.
  pdb_file: requiredFile('A PDB or CIF file is required')
    .concat(pdbOrCifExtTest())
    .concat(fileSizeTest(10_000_000))
    .concat(noSpacesTest())
    .concat(fileNameLengthTest()),
  // Optional full experimental sequence. Advisory only (drives the
  // missing-residue check) — never blocks submission.
  fasta_file: mixed()
    .test('fasta-optional', 'FASTA file must be < 1 MB', (file) => {
      if (!(file instanceof File)) return true
      return file.size <= 1_000_000
    })
    .test(
      'fasta-ext',
      'FASTA file must have a .fasta, .fa or .txt extension',
      (file) => {
        if (!(file instanceof File)) return true
        return /\.(fasta|fa|txt)$/i.test(file.name)
      }
    )
    .optional(),
  dat_file: requiredFile('Experimental SAXS data is required')
    .concat(saxsCheckCarbonara())
    .concat(fileExtTest('dat'))
    .concat(fileSizeTest(2_000_000))
    .concat(noSpacesTest())
    .concat(fileNameLengthTest()),
  fit_n_times: number()
    .typeError('Number of fits must be a number')
    .integer('Number of fits must be an integer')
    .min(1, 'At least 1 fit is required')
    .max(100, 'No more than 100 fits')
    .required('Number of fits is required'),
  min_q: number()
    .typeError('q min must be a number')
    .min(0, 'q min must be >= 0')
    .required('q min is required'),
  max_q: number()
    .typeError('q max must be a number')
    .min(0, 'q max must be >= 0')
    .required('q max is required')
    .test(
      'max-greater-than-min',
      'q max must be greater than q min',
      function (value) {
        const { min_q } = this.parent
        if (value == null || min_q == null) return true
        return value > min_q
      }
    ),
  max_fit_steps: number()
    .typeError('Max fitting steps must be a number')
    .integer('Max fitting steps must be an integer')
    .min(1, 'At least 1 step is required')
    .required('Max fitting steps is required'),
  // Mixture/ensemble controls (only meaningful when oligomeric state = mixture).
  mixture_n: number()
    .typeError('Number of species must be a number')
    .integer('Number of species must be an integer')
    .min(2, 'A mixture needs at least 2 species')
    .max(4, 'No more than 4 species')
    .optional(),
  max_mixture_combos: number()
    .typeError('Weight combinations must be a number')
    .integer('Weight combinations must be an integer')
    .min(1, 'At least 1 combination')
    .max(50, 'No more than 50 combinations')
    .optional(),
  alphafold_flex: boolean().optional(),
  // Feature G (opt-in): PDBFixer missing-residue repair.
  fix_missing_residues: boolean().optional(),
  pae_flex_threshold: number()
    .typeError('PAE flexibility threshold must be a number')
    .min(0, 'PAE flexibility threshold must be >= 0')
    .optional(),
  pae_file: mixed().when('alphafold_flex', {
    is: true,
    then: (s) =>
      s
        .concat(requiredFile('A PAE *.json file is required when using AlphaFold flexibility'))
        .concat(jsonFileCheck())
        .concat(fileExtTest('json'))
        .concat(fileSizeTest(120_000_000))
        .concat(noSpacesTest())
        .concat(fileNameLengthTest()),
    otherwise: (s) => s.optional()
  }),
  // B7: flex_mode drives the 3-way selector; flex_ranges validated client-side
  // via the submit-disable condition (manual needs >= 1 valid row).
  flex_mode: string().oneOf(['auto', 'pae', 'manual']).optional(),
  // B8: multimer toggle and chain_merges (validated client-side via merge editor)
  multimer: boolean().optional(),
  // Optional distance-constraints file — all validation is optional
  constraints_file: mixed()
    .test(
      'constraints-file-optional',
      'Invalid constraints file',
      function (value) {
        if (!value) return true
        const file = value as { size?: number; name?: string }
        if (!file.name) return true
        if (file.size !== undefined && file.size > 1_000_000) {
          return this.createError({ message: 'Constraints file must be < 1 MB' })
        }
        const name = file.name.toLowerCase()
        if (/\s/.test(name)) {
          return this.createError({
            message: 'Constraints file name must not contain spaces'
          })
        }
        if (name.length > 100) {
          return this.createError({ message: 'Constraints file name too long' })
        }
        if (!/\.(dat|txt)$/.test(name)) {
          return this.createError({
            message: 'Constraints file must have a .dat or .txt extension'
          })
        }
        return true
      }
    )
    .optional()
})
