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
  FormControlLabel,
  IconButton,
  Radio,
  RadioGroup,
  FormControl,
  FormLabel
} from '@mui/material'
import Grid from '@mui/material/Grid'
import { Form, Formik, Field, FormikHelpers } from 'formik'
import FileSelect from 'features/jobs/FileSelect'
import { useAddNewCarbonaraJobMutation } from 'slices/jobsApiSlice'
import SendIcon from '@mui/icons-material/Send'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import { bilbomdCarbonaraJobSchema } from 'schemas/CarbonaraValidationSchema'
import { Debug } from 'components/Debug'
import LinearProgress from '@mui/material/LinearProgress'
import HeaderBox from 'components/HeaderBox'
import useTitle from 'hooks/useTitle'
import JobSuccessAlert from 'features/jobs/JobSuccessAlert'

interface ConstraintPairRow {
  res1: string
  chain1: string
  res2: string
  chain2: string
  distance: string
}

// B7: one row in the manual flexibility range editor.
// chain is 1-based (chain 1 = first chain in the structure).
interface FlexRangeRow {
  chain: string
  start: string
  stop: string
}

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
  pae_file: string
  alphafold_flex: boolean
  pae_flex_threshold: number
  constraints_file: string
}

const emptyPairRow = (): ConstraintPairRow => ({
  res1: '',
  chain1: '',
  res2: '',
  chain2: '',
  distance: ''
})

const emptyFlexRow = (): FlexRangeRow => ({ chain: '1', start: '', stop: '' })

const NewCarbonaraJobForm = () => {
  useTitle('BilboMD: New Carbonara Job')

  const [addNewCarbonaraJob, { isSuccess, data: jobResponse }] =
    useAddNewCarbonaraJobMutation()
  const [submitError, setSubmitError] = useState<string | null>(null)

  // B7: 3-way flexibility mode selector (replaces the PAE checkbox)
  const [flexMode, setFlexMode] = useState<'auto' | 'pae' | 'manual'>('auto')
  // Manual flexibility rows: chain (1-based), start residue, stop residue
  const [flexRangeRows, setFlexRangeRows] = useState<FlexRangeRow[]>([emptyFlexRow()])

  // Constraints state — managed outside Formik (file/pairs are UI-only state)
  const [constraintsMethod, setConstraintsMethod] = useState<'none' | 'file' | 'pairs'>('none')
  const [constraintPairs, setConstraintPairs] = useState<ConstraintPairRow[]>([emptyPairRow()])

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
    do_foxs: true,
    pae_file: '',
    alphafold_flex: false,
    pae_flex_threshold: 16,
    constraints_file: ''
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

    // B7: emit flex_mode and mode-specific data
    form.append('flex_mode', flexMode)
    if (flexMode === 'pae') {
      form.append('alphafold_flex', 'true')
      form.append('pae_flex_threshold', values.pae_flex_threshold.toString())
      if (values.pae_file) {
        form.append('pae_file', values.pae_file)
      }
    } else if (flexMode === 'manual') {
      form.append('alphafold_flex', 'false')
      // Group valid rows by chain into [{chain, ranges:[...]}] format
      const validRows = flexRangeRows.filter(
        (r) => r.chain && r.start && r.stop
      )
      if (validRows.length > 0) {
        const byChain: Record<number, number[][]> = {}
        for (const row of validRows) {
          const chain = parseInt(row.chain, 10)
          const start = parseInt(row.start, 10)
          const stop = parseInt(row.stop, 10)
          if (!byChain[chain]) byChain[chain] = []
          byChain[chain].push([start, stop])
        }
        const flexRanges = Object.entries(byChain).map(([chain, ranges]) => ({
          chain: parseInt(chain, 10),
          ranges
        }))
        form.append('flex_ranges', JSON.stringify(flexRanges))
      }
    } else {
      // auto
      form.append('alphafold_flex', 'false')
    }

    // Constraints: append only when the user has provided input
    if (constraintsMethod === 'file' && values.constraints_file) {
      form.append('constraints_file', values.constraints_file)
    } else if (constraintsMethod === 'pairs') {
      const validPairs = constraintPairs.filter(
        (p) => p.res1 && p.chain1 && p.res2 && p.chain2
      )
      if (validPairs.length > 0) {
        form.append('constraints_pairs', JSON.stringify(validPairs))
      }
    }
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

                    {/* B7: 3-way flexibility mode selector */}
                    <Box sx={{ mt: 2, mb: 1 }}>
                      <FormControl component="fieldset">
                        <FormLabel
                          component="legend"
                          sx={{ fontWeight: 600, fontSize: '0.875rem', mb: 0.5 }}
                        >
                          Flexibility mode
                        </FormLabel>
                        <RadioGroup
                          row
                          value={flexMode}
                          onChange={(e) =>
                            setFlexMode(e.target.value as 'auto' | 'pae' | 'manual')
                          }
                        >
                          <FormControlLabel
                            value="auto"
                            control={<Radio size="small" />}
                            label="Auto (default)"
                            disabled={isSubmitting}
                          />
                          <FormControlLabel
                            value="pae"
                            control={<Radio size="small" />}
                            label="AlphaFold PAE"
                            disabled={isSubmitting}
                          />
                          <FormControlLabel
                            value="manual"
                            control={<Radio size="small" />}
                            label="Manual ranges"
                            disabled={isSubmitting}
                          />
                        </RadioGroup>
                      </FormControl>

                      {/* PAE mode: show PAE file upload + threshold */}
                      {flexMode === 'pae' && (
                        <Box
                          sx={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 1,
                            ml: 3,
                            mt: 0.5
                          }}
                        >
                          <Grid>
                            <Field
                              name="pae_file"
                              id="pae-file-upload"
                              as={FileSelect}
                              title="Select File"
                              disabled={isSubmitting}
                              setFieldValue={setFieldValue}
                              setFieldTouched={setFieldTouched}
                              error={errors.pae_file && touched.pae_file}
                              errorMessage={
                                errors.pae_file ? errors.pae_file : ''
                              }
                              fileType="AlphaFold2 PAE *.json"
                              fileExt=".json"
                            />
                          </Grid>

                          <Field
                            label="PAE flexibility threshold (Å)"
                            name="pae_flex_threshold"
                            id="pae_flex_threshold"
                            type="number"
                            disabled={isSubmitting}
                            as={TextField}
                            onChange={handleChange}
                            onBlur={handleBlur}
                            error={
                              errors.pae_flex_threshold &&
                              touched.pae_flex_threshold
                            }
                            helperText={
                              errors.pae_flex_threshold &&
                              touched.pae_flex_threshold
                                ? errors.pae_flex_threshold
                                : ''
                            }
                            value={values.pae_flex_threshold}
                            sx={{ width: '260px' }}
                          />
                        </Box>
                      )}

                      {/* Manual mode: residue range editor */}
                      {flexMode === 'manual' && (
                        <Box sx={{ ml: 3, mt: 0.5 }}>
                          <Typography variant="caption" color="text.secondary">
                            Enter flexible residue ranges (chain 1 = first chain).
                            Start and stop are inclusive residue numbers.
                          </Typography>
                          {flexRangeRows.map((row, idx) => (
                            <Box
                              key={idx}
                              sx={{
                                display: 'flex',
                                gap: 1,
                                mt: 1,
                                alignItems: 'center'
                              }}
                            >
                              <TextField
                                label="Chain"
                                size="small"
                                type="number"
                                value={row.chain}
                                onChange={(e) => {
                                  const updated = flexRangeRows.map(
                                    (r, i): FlexRangeRow =>
                                      i === idx ? { ...r, chain: e.target.value } : r
                                  )
                                  setFlexRangeRows(updated)
                                }}
                                sx={{ width: '70px' }}
                                disabled={isSubmitting}
                              />
                              <TextField
                                label="Start"
                                size="small"
                                type="number"
                                value={row.start}
                                onChange={(e) => {
                                  const updated = flexRangeRows.map(
                                    (r, i): FlexRangeRow =>
                                      i === idx ? { ...r, start: e.target.value } : r
                                  )
                                  setFlexRangeRows(updated)
                                }}
                                sx={{ width: '80px' }}
                                disabled={isSubmitting}
                              />
                              <TextField
                                label="Stop"
                                size="small"
                                type="number"
                                value={row.stop}
                                onChange={(e) => {
                                  const updated = flexRangeRows.map(
                                    (r, i): FlexRangeRow =>
                                      i === idx ? { ...r, stop: e.target.value } : r
                                  )
                                  setFlexRangeRows(updated)
                                }}
                                sx={{ width: '80px' }}
                                disabled={isSubmitting}
                              />
                              <IconButton
                                size="small"
                                disabled={isSubmitting || flexRangeRows.length <= 1}
                                onClick={() =>
                                  setFlexRangeRows(
                                    flexRangeRows.filter((_, i) => i !== idx)
                                  )
                                }
                                aria-label="remove-flex-range"
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Box>
                          ))}
                          <Button
                            size="small"
                            startIcon={<AddIcon />}
                            onClick={() =>
                              setFlexRangeRows([...flexRangeRows, emptyFlexRow()])
                            }
                            disabled={isSubmitting}
                            sx={{ mt: 1 }}
                          >
                            Add range
                          </Button>
                        </Box>
                      )}
                    </Box>

                    {/* Optional distance constraints section */}
                    <Box sx={{ mt: 2, mb: 1 }}>
                      <Typography
                        variant="subtitle2"
                        sx={{ mb: 0.5, fontWeight: 600 }}
                      >
                        Distance Constraints (optional)
                      </Typography>
                      <RadioGroup
                        row
                        value={constraintsMethod}
                        onChange={(e) =>
                          setConstraintsMethod(
                            e.target.value as 'none' | 'file' | 'pairs'
                          )
                        }
                      >
                        <FormControlLabel
                          value="none"
                          control={<Radio size="small" />}
                          label="None"
                        />
                        <FormControlLabel
                          value="file"
                          control={<Radio size="small" />}
                          label="Upload file"
                        />
                        <FormControlLabel
                          value="pairs"
                          control={<Radio size="small" />}
                          label="Enter pairs"
                        />
                      </RadioGroup>

                      {constraintsMethod === 'file' && (
                        <Grid sx={{ mt: 0.5 }}>
                          <Field
                            name="constraints_file"
                            id="constraints-file-upload"
                            as={FileSelect}
                            title="Select File"
                            disabled={isSubmitting}
                            setFieldValue={setFieldValue}
                            setFieldTouched={setFieldTouched}
                            error={
                              errors.constraints_file &&
                              touched.constraints_file
                            }
                            errorMessage={
                              errors.constraints_file
                                ? errors.constraints_file
                                : ''
                            }
                            fileType="constraints *.dat or *.txt"
                            fileExt=".dat,.txt"
                          />
                        </Grid>
                      )}

                      {constraintsMethod === 'pairs' && (
                        <Box sx={{ mt: 1 }}>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            Format: residue number, chain letter for each end of
                            the pair; optional target distance in Å.
                          </Typography>
                          {constraintPairs.map((pair, idx) => (
                            <Box
                              key={idx}
                              sx={{
                                display: 'flex',
                                gap: 1,
                                mt: 1,
                                alignItems: 'center'
                              }}
                            >
                              <TextField
                                label="Res 1"
                                size="small"
                                value={pair.res1}
                                onChange={(e) => {
                                  const updated = constraintPairs.map(
                                    (p, i): ConstraintPairRow =>
                                      i === idx ? { ...p, res1: e.target.value } : p
                                  )
                                  setConstraintPairs(updated)
                                }}
                                sx={{ width: '70px' }}
                                disabled={isSubmitting}
                              />
                              <TextField
                                label="Chain 1"
                                size="small"
                                value={pair.chain1}
                                onChange={(e) => {
                                  const updated = constraintPairs.map(
                                    (p, i): ConstraintPairRow =>
                                      i === idx ? { ...p, chain1: e.target.value } : p
                                  )
                                  setConstraintPairs(updated)
                                }}
                                sx={{ width: '70px' }}
                                disabled={isSubmitting}
                              />
                              <TextField
                                label="Res 2"
                                size="small"
                                value={pair.res2}
                                onChange={(e) => {
                                  const updated = constraintPairs.map(
                                    (p, i): ConstraintPairRow =>
                                      i === idx ? { ...p, res2: e.target.value } : p
                                  )
                                  setConstraintPairs(updated)
                                }}
                                sx={{ width: '70px' }}
                                disabled={isSubmitting}
                              />
                              <TextField
                                label="Chain 2"
                                size="small"
                                value={pair.chain2}
                                onChange={(e) => {
                                  const updated = constraintPairs.map(
                                    (p, i): ConstraintPairRow =>
                                      i === idx ? { ...p, chain2: e.target.value } : p
                                  )
                                  setConstraintPairs(updated)
                                }}
                                sx={{ width: '70px' }}
                                disabled={isSubmitting}
                              />
                              <TextField
                                label="Dist (Å)"
                                size="small"
                                value={pair.distance}
                                onChange={(e) => {
                                  const updated = constraintPairs.map(
                                    (p, i): ConstraintPairRow =>
                                      i === idx ? { ...p, distance: e.target.value } : p
                                  )
                                  setConstraintPairs(updated)
                                }}
                                sx={{ width: '80px' }}
                                disabled={isSubmitting}
                              />
                              <IconButton
                                size="small"
                                disabled={isSubmitting || constraintPairs.length <= 1}
                                onClick={() =>
                                  setConstraintPairs(
                                    constraintPairs.filter((_, i) => i !== idx)
                                  )
                                }
                                aria-label="remove-pair"
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Box>
                          ))}
                          <Button
                            size="small"
                            startIcon={<AddIcon />}
                            onClick={() =>
                              setConstraintPairs([
                                ...constraintPairs,
                                emptyPairRow()
                              ])
                            }
                            disabled={isSubmitting}
                            sx={{ mt: 1 }}
                          >
                            Add pair
                          </Button>
                        </Box>
                      )}
                    </Box>

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
                          values.dat_file === '' ||
                          (flexMode === 'pae' && values.pae_file === '') ||
                          (flexMode === 'manual' &&
                            flexRangeRows.filter(
                              (r) => r.chain && r.start && r.stop
                            ).length === 0)
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
