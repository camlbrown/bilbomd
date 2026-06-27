import { useState } from 'react'
import {
  Box,
  Button,
  TextField,
  MenuItem,
  Typography,
  Alert,
  Paper,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Checkbox,
  FormControlLabel
} from '@mui/material'
import Grid from '@mui/material/Grid'
import { Form, Formik, Field, FormikHelpers } from 'formik'
import FileSelect from 'features/jobs/FileSelect'
import { useAddNewAutoMDSaxsJobMutation } from 'slices/jobsApiSlice'
import SendIcon from '@mui/icons-material/Send'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { bilbomdAutoMDSaxsJobSchema } from 'schemas/BilboMDAutoMDSaxsJobSchema'
import { Debug } from 'components/Debug'
import LinearProgress from '@mui/material/LinearProgress'
import HeaderBox from 'components/HeaderBox'
import useTitle from 'hooks/useTitle'
import JobSuccessAlert from 'features/jobs/JobSuccessAlert'

interface AutoMDSaxsJobFormValues {
  title: string
  pdb_file: string
  dat_file: string
  system: string
  force_field: string
  water_model: string
  simulation_time_ns: number | string
  n_repeats: number | string
  ionic_concentration_M: number | string
  ph: number | string
  temperature_K: number | string
  box_padding_nm: number | string
  seed: number | string
  disulfide: boolean
}

const NewAutoMDSaxsJobForm = () => {
  useTitle('BilboMD: New AutoMD-SAXS Job')

  const [addNewAutoMDSaxsJob, { isSuccess, data: jobResponse }] =
    useAddNewAutoMDSaxsJobMutation()

  const [submitError, setSubmitError] = useState<string | null>(null)

  const initialValues: AutoMDSaxsJobFormValues = {
    title: '',
    pdb_file: '',
    dat_file: '',
    system: 'Protein',
    force_field: 'amber14',
    water_model: 'tip3p',
    simulation_time_ns: 100,
    n_repeats: 3,
    ionic_concentration_M: 0.15,
    ph: 7,
    temperature_K: 300,
    box_padding_nm: '',
    seed: '',
    disulfide: false
  }

  const onSubmit = async (
    values: AutoMDSaxsJobFormValues,
    { setStatus }: FormikHelpers<AutoMDSaxsJobFormValues>
  ) => {
    setSubmitError(null)
    const form = new FormData()
    form.append('bilbomd_mode', 'automd-saxs')
    form.append('title', values.title)
    form.append('pdb_file', values.pdb_file)
    if (values.dat_file) form.append('dat_file', values.dat_file)
    form.append('system', values.system)
    form.append('force_field', values.force_field)
    form.append('water_model', values.water_model)
    form.append('simulation_time_ns', String(values.simulation_time_ns))
    form.append('n_repeats', String(values.n_repeats))
    form.append('ionic_concentration_M', String(values.ionic_concentration_M))
    form.append('ph', String(values.ph))
    form.append('temperature_K', String(values.temperature_K))
    if (values.box_padding_nm !== '')
      form.append('box_padding_nm', String(values.box_padding_nm))
    if (values.seed !== '') form.append('seed', String(values.seed))
    form.append('disulfide', values.disulfide.toString())

    try {
      const newJob = await addNewAutoMDSaxsJob(form).unwrap()
      setStatus(newJob)
    } catch (error) {
      console.error('rejected', error)
      setSubmitError(
        (error as { data?: { message?: string } }).data?.message ||
          'An error occurred during submission.'
      )
    }
  }

  const successResponse = jobResponse
    ? {
        message: jobResponse.message || 'Job submitted successfully',
        jobid: jobResponse.jobid,
        uuid: jobResponse.uuid
      }
    : undefined

  return (
    <Grid
      container
      spacing={2}
    >
      <Grid size={{ xs: 12 }}>
        <Accordion>
          <AccordionSummary
            expandIcon={<ExpandMoreIcon sx={{ color: '#fff' }} />}
            sx={{
              backgroundColor: '#888',
              borderTopLeftRadius: 4,
              borderTopRightRadius: 4,
              pl: 1
            }}
          >
            <Typography
              sx={{
                textTransform: 'uppercase',
                fontSize: '0.875rem',
                fontWeight: 400,
                color: '#fff',
                letterSpacing: '1px'
              }}
            >
              Instructions
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography sx={{ m: 1 }}>
              AutoMD-SAXS is a higher-accuracy, explicit-solvent all-atom
              molecular dynamics refinement pipeline (OpenMM) with optional
              SAXS fitting (FoXS/MultiFoXS). Upload a PDB structure and,
              optionally, an experimental SAXS <b>.dat</b> file. The structure is
              prepared, solvated, minimised, equilibrated, and run for the
              requested number of production repeats; frames are then scored
              against the SAXS data and clustered.
            </Typography>
          </AccordionDetails>
        </Accordion>
      </Grid>

      <Grid size={{ xs: 12 }}>
        <HeaderBox>
          <Typography>AutoMD-SAXS Job Form</Typography>
        </HeaderBox>

        <Paper sx={{ p: 2 }}>
          {isSuccess && successResponse ? (
            <JobSuccessAlert
              jobResponse={successResponse}
              jobType="AutoMD-SAXS"
            />
          ) : (
            <Formik
              initialValues={initialValues}
              validationSchema={bilbomdAutoMDSaxsJobSchema}
              onSubmit={onSubmit}
            >
              {({
                values,
                errors,
                touched,
                isValid,
                isSubmitting,
                handleChange,
                handleBlur,
                setFieldValue,
                setFieldTouched
              }) => (
                <Form>
                  <Grid
                    container
                    sx={{ flexDirection: 'column' }}
                  >
                    <Box sx={{ my: 1, minWidth: '520px' }}>
                      <Field
                        fullWidth
                        label="Title"
                        name="title"
                        id="title"
                        type="text"
                        disabled={isSubmitting}
                        as={TextField}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={errors.title && touched.title}
                        helperText={
                          errors.title && touched.title ? errors.title : ''
                        }
                        value={values.title || ''}
                      />
                    </Box>

                    {submitError && (
                      <Alert
                        severity="error"
                        sx={{ my: 1 }}
                      >
                        {submitError}
                      </Alert>
                    )}

                    <Grid>
                      <Field
                        name="pdb_file"
                        id="pdb-file-upload"
                        as={FileSelect}
                        title="Select File"
                        disabled={isSubmitting}
                        setFieldValue={setFieldValue}
                        setFieldTouched={setFieldTouched}
                        error={errors.pdb_file && touched.pdb_file}
                        errorMessage={errors.pdb_file ? errors.pdb_file : ''}
                        fileType="structure *.pdb"
                        fileExt=".pdb"
                      />
                    </Grid>

                    <Grid>
                      <Field
                        name="dat_file"
                        id="dat-file-upload"
                        as={FileSelect}
                        title="Select File"
                        disabled={isSubmitting}
                        setFieldValue={setFieldValue}
                        setFieldTouched={setFieldTouched}
                        error={errors.dat_file && touched.dat_file}
                        errorMessage={errors.dat_file ? errors.dat_file : ''}
                        fileType="experimental SAXS data *.dat (optional)"
                        fileExt=".dat"
                      />
                    </Grid>

                    <Box sx={{ display: 'flex', gap: 2, my: 2 }}>
                      <Field
                        select
                        label="System type"
                        name="system"
                        as={TextField}
                        disabled={isSubmitting}
                        value={values.system}
                        onChange={handleChange}
                        sx={{ minWidth: 250 }}
                      >
                        <MenuItem value="Protein">Protein</MenuItem>
                        <MenuItem value="Protein-ligand">
                          Protein-ligand (experimental)
                        </MenuItem>
                      </Field>

                      <Field
                        select
                        label="Force field"
                        name="force_field"
                        as={TextField}
                        disabled={isSubmitting}
                        value={values.force_field}
                        onChange={handleChange}
                        sx={{ minWidth: 250 }}
                      >
                        <MenuItem value="amber14">AMBER14</MenuItem>
                        <MenuItem value="charmm36">CHARMM36</MenuItem>
                      </Field>
                    </Box>

                    <Box sx={{ display: 'flex', gap: 2, my: 1 }}>
                      <Field
                        label="Simulation length (ns)"
                        name="simulation_time_ns"
                        type="number"
                        as={TextField}
                        disabled={isSubmitting}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={
                          errors.simulation_time_ns &&
                          touched.simulation_time_ns
                        }
                        helperText={
                          errors.simulation_time_ns &&
                          touched.simulation_time_ns
                            ? errors.simulation_time_ns
                            : ''
                        }
                        value={values.simulation_time_ns}
                      />
                      <Field
                        label="Number of repeats"
                        name="n_repeats"
                        type="number"
                        as={TextField}
                        disabled={isSubmitting}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={errors.n_repeats && touched.n_repeats}
                        helperText={
                          errors.n_repeats && touched.n_repeats
                            ? errors.n_repeats
                            : ''
                        }
                        value={values.n_repeats}
                      />
                    </Box>

                    <Box sx={{ display: 'flex', gap: 2, my: 1 }}>
                      <Field
                        label="Ionic concentration (M)"
                        name="ionic_concentration_M"
                        type="number"
                        as={TextField}
                        disabled={isSubmitting}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={
                          errors.ionic_concentration_M &&
                          touched.ionic_concentration_M
                        }
                        helperText={
                          errors.ionic_concentration_M &&
                          touched.ionic_concentration_M
                            ? errors.ionic_concentration_M
                            : ''
                        }
                        value={values.ionic_concentration_M}
                      />
                      <Field
                        label="pH"
                        name="ph"
                        type="number"
                        as={TextField}
                        disabled={isSubmitting}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={errors.ph && touched.ph}
                        helperText={errors.ph && touched.ph ? errors.ph : ''}
                        value={values.ph}
                      />
                    </Box>

                    <Box sx={{ display: 'flex', alignItems: 'center', my: 1 }}>
                      <Field name="disulfide">
                        {({
                          field
                        }: {
                          field: {
                            name: string
                            value: boolean
                            onChange: (
                              e: React.ChangeEvent<HTMLInputElement>
                            ) => void
                          }
                        }) => (
                          <FormControlLabel
                            control={
                              <Checkbox
                                checked={field.value}
                                onChange={field.onChange}
                                name={field.name}
                                disabled={isSubmitting}
                              />
                            }
                            label="System contains disulfide bonds"
                          />
                        )}
                      </Field>
                    </Box>

                    <Accordion sx={{ my: 1 }}>
                      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Typography>Advanced settings</Typography>
                      </AccordionSummary>
                      <AccordionDetails>
                        <Box sx={{ display: 'flex', gap: 2, my: 1 }}>
                          <Field
                            select
                            label="Water model"
                            name="water_model"
                            as={TextField}
                            disabled={isSubmitting}
                            value={values.water_model}
                            onChange={handleChange}
                            sx={{ minWidth: 200 }}
                          >
                            <MenuItem value="tip3p">TIP3P</MenuItem>
                            <MenuItem value="tip3pfb">TIP3P-FB</MenuItem>
                            <MenuItem value="spce">SPC/E</MenuItem>
                          </Field>
                          <Field
                            label="Temperature (K)"
                            name="temperature_K"
                            type="number"
                            as={TextField}
                            disabled={isSubmitting}
                            onChange={handleChange}
                            value={values.temperature_K}
                          />
                        </Box>
                        <Box sx={{ display: 'flex', gap: 2, my: 1 }}>
                          <Field
                            label="Box padding (nm, blank = auto)"
                            name="box_padding_nm"
                            type="number"
                            as={TextField}
                            disabled={isSubmitting}
                            onChange={handleChange}
                            value={values.box_padding_nm}
                          />
                          <Field
                            label="Random seed (blank = random)"
                            name="seed"
                            type="number"
                            as={TextField}
                            disabled={isSubmitting}
                            onChange={handleChange}
                            value={values.seed}
                          />
                        </Box>
                      </AccordionDetails>
                    </Accordion>

                    {isSubmitting && (
                      <Box sx={{ my: 1, width: '520px' }}>
                        <LinearProgress />
                      </Box>
                    )}

                    <Grid sx={{ mt: 2 }}>
                      <Button
                        type="submit"
                        disabled={
                          !isValid ||
                          values.title === '' ||
                          values.pdb_file === ''
                        }
                        loading={isSubmitting}
                        endIcon={<SendIcon />}
                        loadingPosition="end"
                        variant="contained"
                        sx={{ width: '110px' }}
                      >
                        <span>Submit</span>
                      </Button>
                    </Grid>
                  </Grid>
                  {import.meta.env.MODE === 'development' ? <Debug /> : ''}
                </Form>
              )}
            </Formik>
          )}
        </Paper>
      </Grid>
    </Grid>
  )
}

export default NewAutoMDSaxsJobForm
