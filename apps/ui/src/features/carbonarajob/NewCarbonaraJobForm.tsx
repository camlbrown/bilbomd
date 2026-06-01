import { useState } from 'react'
import {
  Box,
  Button,
  TextField,
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
import { useAddNewCarbonaraJobMutation } from 'slices/jobsApiSlice'
import SendIcon from '@mui/icons-material/Send'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { bilbomdCarbonaraJobSchema } from 'schemas/CarbonaraValidationSchema'
import { Debug } from 'components/Debug'
import LinearProgress from '@mui/material/LinearProgress'
import HeaderBox from 'components/HeaderBox'
import useTitle from 'hooks/useTitle'
import JobSuccessAlert from 'features/jobs/JobSuccessAlert'

interface CarbonaraJobFormValues {
  title: string
  pdb_file: string
  dat_file: string
  fit_n_times: number
  min_q: number
  max_q: number
  max_fit_steps: number
  rotation: boolean
  all_atom: boolean
  do_foxs: boolean
}

const NewCarbonaraJobForm = () => {
  useTitle('BilboMD: New Carbonara Job')

  const [addNewCarbonaraJob, { isSuccess, data: jobResponse }] =
    useAddNewCarbonaraJobMutation()
  const [submitError, setSubmitError] = useState<string | null>(null)

  const successResponse = jobResponse
    ? {
        message: jobResponse.message || 'Job submitted successfully',
        jobid: jobResponse.jobid,
        uuid: jobResponse.uuid
      }
    : undefined

  const initialValues: CarbonaraJobFormValues = {
    title: '',
    pdb_file: '',
    dat_file: '',
    fit_n_times: 4,
    min_q: 0.01,
    max_q: 0.2,
    max_fit_steps: 1000,
    rotation: false,
    all_atom: false,
    do_foxs: true
  }

  const onSubmit = async (
    values: CarbonaraJobFormValues,
    { setStatus }: FormikHelpers<CarbonaraJobFormValues>
  ) => {
    setSubmitError(null)
    const form = new FormData()
    form.append('title', values.title)
    form.append('pdb_file', values.pdb_file)
    form.append('dat_file', values.dat_file)
    form.append('fit_n_times', values.fit_n_times.toString())
    form.append('min_q', values.min_q.toString())
    form.append('max_q', values.max_q.toString())
    form.append('max_fit_steps', values.max_fit_steps.toString())
    form.append('rotation', values.rotation.toString())
    form.append('all_atom', values.all_atom.toString())
    form.append('do_foxs', values.do_foxs.toString())
    form.append('bilbomd_mode', 'carbonara')

    try {
      const newJob = await addNewCarbonaraJob(form).unwrap()
      setStatus(newJob)
    } catch (error) {
      console.error('rejected', error)
      setSubmitError(
        (error as { data?: { message?: string } }).data?.message ||
          'An error occurred during submission.'
      )
    }
  }

  const content = (
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
              Carbonara is a SAXS-guided protein structure refinement workflow.
              Starting from an atomic or predicted model, it converts the
              structure into a coarse-grained representation and samples
              conformational changes against your experimental SAXS data. Provide
              a structure (PDB or mmCIF) and a SAXS curve, then choose the
              q-range and how many independent fits to run.
            </Typography>
          </AccordionDetails>
        </Accordion>
      </Grid>

      <Grid size={{ xs: 12 }}>
        <HeaderBox>
          <Typography>Carbonara Job Form</Typography>
        </HeaderBox>

        <Paper sx={{ p: 2 }}>
          {isSuccess && successResponse ? (
            <JobSuccessAlert
              jobResponse={successResponse}
              jobType="Carbonara"
            />
          ) : (
            <Formik
              initialValues={initialValues}
              validationSchema={bilbomdCarbonaraJobSchema}
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
                        fileType="structure *.pdb or *.cif"
                        fileExt=".pdb,.cif"
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
                        fileType="experimental SAXS data *.dat"
                        fileExt=".dat"
                      />
                    </Grid>

                    <Box sx={{ display: 'flex', gap: 2, my: 2 }}>
                      <Field
                        label="q min"
                        name="min_q"
                        id="min_q"
                        type="number"
                        disabled={isSubmitting}
                        as={TextField}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={errors.min_q && touched.min_q}
                        helperText={
                          errors.min_q && touched.min_q ? errors.min_q : ''
                        }
                        value={values.min_q}
                        sx={{ width: '160px' }}
                      />
                      <Field
                        label="q max"
                        name="max_q"
                        id="max_q"
                        type="number"
                        disabled={isSubmitting}
                        as={TextField}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={errors.max_q && touched.max_q}
                        helperText={
                          errors.max_q && touched.max_q ? errors.max_q : ''
                        }
                        value={values.max_q}
                        sx={{ width: '160px' }}
                      />
                    </Box>

                    <Box sx={{ display: 'flex', gap: 2, my: 1 }}>
                      <Field
                        label="Number of fits"
                        name="fit_n_times"
                        id="fit_n_times"
                        type="number"
                        disabled={isSubmitting}
                        as={TextField}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={errors.fit_n_times && touched.fit_n_times}
                        helperText={
                          errors.fit_n_times && touched.fit_n_times
                            ? errors.fit_n_times
                            : ''
                        }
                        value={values.fit_n_times}
                        sx={{ width: '200px' }}
                      />
                      <Field
                        label="Max fitting steps"
                        name="max_fit_steps"
                        id="max_fit_steps"
                        type="number"
                        disabled={isSubmitting}
                        as={TextField}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        error={errors.max_fit_steps && touched.max_fit_steps}
                        helperText={
                          errors.max_fit_steps && touched.max_fit_steps
                            ? errors.max_fit_steps
                            : ''
                        }
                        value={values.max_fit_steps}
                        sx={{ width: '200px' }}
                      />
                    </Box>

                    <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
                      <Field name="rotation">
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
                                slotProps={{
                                  input: { 'aria-label': 'rotation-checkbox' }
                                }}
                              />
                            }
                            label="Allow affine rotation during fitting"
                          />
                        )}
                      </Field>
                    </Box>

                    <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
                      <Field name="all_atom">
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
                                slotProps={{
                                  input: {
                                    'aria-label': 'all-atom-checkbox'
                                  }
                                }}
                              />
                            }
                            label="Return all-atom models (cg2all)"
                          />
                        )}
                      </Field>
                    </Box>

                    {values.all_atom && (
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          ml: 3,
                          mt: 0.5
                        }}
                      >
                        <Field name="do_foxs">
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
                                  slotProps={{
                                    input: {
                                      'aria-label': 'do-foxs-checkbox'
                                    }
                                  }}
                                />
                              }
                              label="Score with FoXS"
                            />
                          )}
                        </Field>
                      </Box>
                    )}

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
                          values.pdb_file === '' ||
                          values.dat_file === ''
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

  return content
}

export default NewCarbonaraJobForm
