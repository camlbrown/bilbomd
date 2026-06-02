import * as yup from 'yup'
import {
  requiredFile,
  fileSizeTest,
  fileExtTest,
  fileNameLengthTest,
  noSpacesTest,
  noShellMetacharsTest,
  saxsCheck,
  jsonFileCheck,
  pdbOrCifExtTest,
  pdbOrCifResidueCheck
} from './helpers/fileValidators.js'

// Phase-1 + Phase-B Carbonara job validation: structure + SAXS files plus
// coarse-grained fitting controls and optional PAE-guided flexibility.
// Numeric fields are optional here because the Mongoose schema supplies sensible
// defaults; bounds keep obviously-bad values out.
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
  // No chain-ID check (unlike other job types): Carbonara splits chains by TER
  // records, so a missing chain-ID column is valid input.
  pdb_file: requiredFile('A PDB or CIF file is required')
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
  do_foxs: yup.boolean().optional(),
  alphafold_flex: yup.boolean().optional(),
  pae_flex_threshold: yup
    .number()
    .typeError('pae_flex_threshold must be a number')
    .min(0, 'pae_flex_threshold must be >= 0')
    .optional(),
  pae_file: yup.mixed().when('alphafold_flex', {
    is: true,
    then: (s) =>
      s
        .concat(requiredFile('A PAE *.json file is required when using AlphaFold flexibility'))
        .concat(jsonFileCheck())
        .concat(fileExtTest('json'))
        .concat(fileSizeTest(120_000_000))
        .concat(noSpacesTest())
        .concat(noShellMetacharsTest())
        .concat(fileNameLengthTest()),
    otherwise: (s) => s.optional()
  }),
  // Optional distance-constraints file (.dat or .txt). All constraints are
  // optional for every pathway; when absent the job runs without constraints.
  constraints_file: yup
    .mixed()
    .test(
      'constraints-file-optional',
      'Invalid constraints file',
      function (value) {
        if (value === undefined || value === null) return true
        const file = value as { size?: number; originalname?: string }
        if (!file.originalname) return true
        if (file.size !== undefined && file.size > 1_000_000) {
          return this.createError({ message: 'Constraints file must be < 1 MB' })
        }
        const name = file.originalname.toLowerCase()
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
    .optional(),
  // B7: flex_mode selects the 3-way flexibility mode (default 'auto').
  flex_mode: yup
    .string()
    .oneOf(['auto', 'pae', 'manual'], 'flex_mode must be auto, pae, or manual')
    .optional(),
  // flex_ranges is required when flex_mode === 'manual' and must contain at
  // least one entry with a valid chain (integer >= 1) and non-empty ranges
  // where each range is [start, stop] with start <= stop (integers).
  flex_ranges: yup.mixed().when('flex_mode', {
    is: 'manual',
    then: (s) =>
      s.test(
        'flex-ranges-required-shape',
        'flex_ranges must be a non-empty array of {chain, ranges} when flex_mode is manual',
        function (value) {
          if (!value || !Array.isArray(value) || value.length === 0) {
            return this.createError({
              message:
                'flex_ranges is required and must be non-empty when flex_mode is manual'
            })
          }
          for (const entry of value as unknown[]) {
            const e = entry as { chain?: unknown; ranges?: unknown }
            if (
              typeof e.chain !== 'number' ||
              !Number.isInteger(e.chain) ||
              e.chain < 1
            ) {
              return this.createError({
                message: 'Each flex_ranges entry must have chain as integer >= 1'
              })
            }
            if (!Array.isArray(e.ranges) || e.ranges.length === 0) {
              return this.createError({
                message: 'Each flex_ranges entry must have a non-empty ranges array'
              })
            }
            for (const r of e.ranges as unknown[]) {
              const range = r as number[]
              if (
                !Array.isArray(range) ||
                range.length !== 2 ||
                !Number.isInteger(range[0]) ||
                !Number.isInteger(range[1]) ||
                range[0] > range[1]
              ) {
                return this.createError({
                  message:
                    'Each range must be [start, stop] with integer start <= stop'
                })
              }
            }
          }
          return true
        }
      ),
    otherwise: (s) => s.optional()
  }),
  // B8: multimer mode toggle (default false).
  multimer: yup.boolean().optional(),
  // chain_merges is validated WHEN multimer === true: must be an array of
  // [i, j] pairs where i, j are positive integers and i !== j.
  // Empty array is allowed (multimer on but no merges yet).
  chain_merges: yup.mixed().when('multimer', {
    is: true,
    then: (s) =>
      s.test(
        'chain-merges-shape',
        'chain_merges must be an array of [i,j] positive integer pairs with i !== j',
        function (value) {
          // undefined / null / empty array => valid (no merges yet)
          if (value === undefined || value === null) return true
          if (!Array.isArray(value)) {
            return this.createError({
              message: 'chain_merges must be an array when multimer is true'
            })
          }
          for (const pair of value as unknown[]) {
            const p = pair as number[]
            if (
              !Array.isArray(p) ||
              p.length !== 2 ||
              !Number.isInteger(p[0]) ||
              !Number.isInteger(p[1]) ||
              p[0] < 1 ||
              p[1] < 1 ||
              p[0] === p[1]
            ) {
              return this.createError({
                message:
                  'Each chain_merges entry must be [i,j] with positive integers and i !== j'
              })
            }
          }
          return true
        }
      ),
    otherwise: (s) => s.optional()
  })
})
