import { object, string, number, boolean, mixed } from 'yup'
import {
  requiredFile,
  pdbOrCifExtTest,
  pdbOrCifChainIdCheck,
  pdbOrCifResidueCheck,
  fileSizeTest,
  fileNameLengthTest,
  noSpacesTest,
  saxsCheck,
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
  pdb_file: requiredFile('A PDB or CIF file is required')
    .concat(pdbOrCifChainIdCheck())
    .concat(pdbOrCifResidueCheck())
    .concat(pdbOrCifExtTest())
    .concat(fileSizeTest(10_000_000))
    .concat(noSpacesTest())
    .concat(fileNameLengthTest()),
  dat_file: requiredFile('Experimental SAXS data is required')
    .concat(saxsCheck())
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
  alphafold_flex: boolean().optional(),
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
  })
})
