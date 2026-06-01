import * as yup from 'yup'
import {
  requiredFile,
  fileSizeTest,
  fileExtTest,
  fileNameLengthTest,
  noSpacesTest,
  noShellMetacharsTest,
  saxsCheck,
  pdbOrCifExtTest,
  pdbOrCifChainIdCheck,
  pdbOrCifResidueCheck
} from './helpers/fileValidators.js'

// Phase-1 Carbonara job validation: structure + SAXS files plus coarse-grained
// fitting controls. Numeric fields are optional here because the Mongoose schema
// supplies sensible defaults; bounds keep obviously-bad values out.
export const carbonaraJobSchema = yup.object({
  title: yup
    .string()
    .required('Job title is required')
    .max(100, 'Title too long'),
  bilbomd_mode: yup.string().oneOf(['carbonara'], 'Invalid mode').required(),
  email: yup.string().email('Invalid email address').optional(),
  dat_file: requiredFile('Experimental SAXS data is required')
    .concat(fileSizeTest(2_000_000))
    .concat(fileExtTest('dat'))
    .concat(saxsCheck())
    .concat(noSpacesTest())
    .concat(noShellMetacharsTest())
    .concat(fileNameLengthTest()),
  pdb_file: requiredFile('A PDB or CIF file is required')
    .concat(pdbOrCifChainIdCheck())
    .concat(pdbOrCifResidueCheck())
    .concat(pdbOrCifExtTest())
    .concat(fileSizeTest(10_000_000))
    .concat(noSpacesTest())
    .concat(noShellMetacharsTest())
    .concat(fileNameLengthTest()),
  fit_n_times: yup
    .number()
    .typeError('fit_n_times must be a number')
    .integer('fit_n_times must be an integer')
    .min(1, 'fit_n_times must be at least 1')
    .max(100, 'fit_n_times too large')
    .optional(),
  min_q: yup.number().typeError('min_q must be a number').min(0).optional(),
  max_q: yup.number().typeError('max_q must be a number').min(0).optional(),
  max_q_start: yup
    .number()
    .typeError('max_q_start must be a number')
    .min(0)
    .optional(),
  max_fit_steps: yup
    .number()
    .typeError('max_fit_steps must be a number')
    .integer('max_fit_steps must be an integer')
    .min(1, 'max_fit_steps must be at least 1')
    .optional(),
  mixture_n: yup
    .number()
    .typeError('mixture_n must be a number')
    .integer('mixture_n must be an integer')
    .min(1, 'mixture_n must be at least 1')
    .optional(),
  rotation: yup.boolean().optional(),
  all_atom: yup.boolean().optional(),
  do_foxs: yup.boolean().optional()
})
