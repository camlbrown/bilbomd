import * as yup from 'yup'
import {
  requiredFile,
  fileSizeTest,
  fileExtTest,
  fileNameLengthTest,
  noSpacesTest,
  noShellMetacharsTest
} from './helpers/fileValidators.js'

// AutoMD-SAXS job validation: a PDB structure (required) and an optional
// experimental SAXS .dat file, plus explicit-solvent OpenMM MD controls.
// Numeric/enum fields are optional because the Mongoose schema supplies sensible
// defaults; bounds keep obviously-bad values out.
export const automdSaxsJobSchema = yup.object({
  title: yup.string().required('Job title is required').max(100, 'Title too long'),
  bilbomd_mode: yup
    .string()
    .oneOf(['automd-saxs'], 'Invalid mode')
    .required(),
  email: yup.string().email('Invalid email address').optional(),
  pdb_file: requiredFile('A PDB file is required')
    .concat(fileExtTest('pdb'))
    .concat(fileSizeTest(30_000_000))
    .concat(noSpacesTest())
    .concat(noShellMetacharsTest())
    .concat(fileNameLengthTest()),
  // Optional experimental SAXS data (.dat). Without it, FoXS fitting is skipped.
  dat_file: yup
    .mixed()
    .test('dat-file-optional', 'Invalid SAXS .dat file', function (value) {
      if (value === undefined || value === null) return true
      const file = value as { size?: number; originalname?: string }
      if (!file.originalname) return true
      const name = file.originalname.toLowerCase()
      if (file.size !== undefined && file.size > 2_000_000) {
        return this.createError({ message: 'SAXS file must be < 2 MB' })
      }
      if (/\s/.test(name)) {
        return this.createError({
          message: 'SAXS file name must not contain spaces'
        })
      }
      if (name.length > 100) {
        return this.createError({ message: 'SAXS file name too long' })
      }
      if (!/\.dat$/.test(name)) {
        return this.createError({
          message: 'SAXS file must have a .dat extension'
        })
      }
      return true
    })
    .optional(),
  system: yup
    .string()
    .oneOf(['Protein', 'Protein-ligand'], 'Invalid system type')
    .optional(),
  force_field: yup
    .string()
    .oneOf(['amber14', 'charmm36'], 'Invalid force field')
    .optional(),
  water_model: yup
    .string()
    .oneOf(['tip3p', 'tip3pfb', 'spce'], 'Invalid water model')
    .optional(),
  simulation_time_ns: yup
    .number()
    .typeError('simulation_time_ns must be a number')
    .integer('simulation_time_ns must be an integer')
    .min(1, 'simulation_time_ns must be at least 1')
    .max(10000, 'simulation_time_ns too large')
    .optional(),
  n_repeats: yup
    .number()
    .typeError('n_repeats must be a number')
    .integer('n_repeats must be an integer')
    .min(1, 'n_repeats must be at least 1')
    .max(20, 'n_repeats too large')
    .optional(),
  temperature_K: yup
    .number()
    .typeError('temperature_K must be a number')
    .min(1, 'temperature_K must be > 0')
    .optional(),
  ionic_concentration_M: yup
    .number()
    .typeError('ionic_concentration_M must be a number')
    .min(0, 'ionic_concentration_M must be >= 0')
    .optional(),
  ph: yup
    .number()
    .typeError('ph must be a number')
    .moreThan(0, 'ph must be > 0')
    .lessThan(14, 'ph must be < 14')
    .optional(),
  disulfide: yup.boolean().optional(),
  box_padding_nm: yup
    .number()
    .typeError('box_padding_nm must be a number')
    .moreThan(0, 'box_padding_nm must be > 0')
    .optional(),
  seed: yup
    .number()
    .typeError('seed must be a number')
    .integer('seed must be an integer')
    .optional()
})
