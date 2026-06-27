import { mixed, object, string, number, boolean } from 'yup'
import { noSpaces, isSaxsData } from './ValidationFunctions'

// Frontend validation for the AutoMD-SAXS job form. A PDB structure is required;
// the experimental SAXS .dat is optional (without it, FoXS fitting is skipped).
// MD parameters are optional with bounds; the backend/CLI apply defaults.
export const bilbomdAutoMDSaxsJobSchema = object().shape({
  title: string()
    .required('Please provide a title for your AutoMD-SAXS Job.')
    .min(4, 'Title must contain at least 4 characters.')
    .max(30, 'Title must contain less than 30 characters.')
    .matches(/^[\w\s-]+$/, 'no special characters allowed'),

  pdb_file: mixed()
    .required('A PDB file is required')
    .test('file-size-check', 'Max file size is 30MB', (file) => {
      if (file && (file as File).size <= 30000000) return true
      return false
    })
    .test('file-type-check', 'Please select a PDB file', (file) => {
      if (file && (file as File).name.split('.').pop()?.toUpperCase() === 'PDB') {
        return true
      }
      return false
    })
    .test(
      'check-for-spaces',
      'Only accept file with no spaces in the name.',
      async (file) => {
        if (file) return noSpaces(file as File)
        return false
      }
    )
    .test(
      'filename-length-check',
      'Filename must be no longer than 30 characters.',
      (file) => {
        if (file && (file as File).name.length <= 30) return true
        return false
      }
    ),

  // Optional experimental SAXS data.
  dat_file: mixed()
    .notRequired()
    .test('file-size-check', 'Max file size is 3MB', (file) => {
      if (!file) return true
      if ((file as File).size <= 3000000) return true
      return false
    })
    .test('file-type-check', 'Please select a SAXS *.dat data file.', (file) => {
      if (!file) return true
      if ((file as File).name.split('.').pop()?.toUpperCase() === 'DAT') {
        return true
      }
      return false
    })
    .test(
      'saxs-data-check',
      'File does not appear to be SAXS data',
      async (file, { createError }) => {
        if (!file) return true
        const result = await isSaxsData(file as File)
        return result.valid ? true : createError({ message: result.message })
      }
    ),

  system: string().oneOf(['Protein', 'Protein-ligand']).notRequired(),
  force_field: string().oneOf(['amber14', 'charmm36']).notRequired(),
  water_model: string().oneOf(['tip3p', 'tip3pfb', 'spce']).notRequired(),
  simulation_time_ns: number()
    .typeError('Simulation length must be a number')
    .integer('Must be a whole number of ns')
    .min(1, 'Must be at least 1 ns')
    .max(10000, 'Too large')
    .notRequired(),
  n_repeats: number()
    .typeError('Repeats must be a number')
    .integer('Must be a whole number')
    .min(1, 'At least 1 repeat')
    .max(20, 'Too many repeats')
    .notRequired(),
  temperature_K: number()
    .typeError('Temperature must be a number')
    .moreThan(0, 'Must be > 0')
    .notRequired(),
  ionic_concentration_M: number()
    .typeError('Ionic concentration must be a number')
    .min(0, 'Must be >= 0')
    .notRequired(),
  ph: number()
    .typeError('pH must be a number')
    .moreThan(0, 'pH must be > 0')
    .lessThan(14, 'pH must be < 14')
    .notRequired(),
  box_padding_nm: number()
    .typeError('Box padding must be a number')
    .moreThan(0, 'Must be > 0')
    .notRequired(),
  seed: number()
    .typeError('Seed must be a number')
    .integer('Must be an integer')
    .notRequired(),
  disulfide: boolean().notRequired()
})
