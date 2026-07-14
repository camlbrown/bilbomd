import { useState } from 'react'
import { useNavigate } from 'react-router'
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
  FormControlLabel,
  Table,
  TableBody,
  TableRow,
  TableCell,
  Chip
} from '@mui/material'
import Grid from '@mui/material/Grid'
import { Form, Formik, Field, FormikHelpers } from 'formik'
import FileSelect from 'features/jobs/FileSelect'
import { useStartAutoMDSaxsPrepMutation } from 'slices/jobsApiSlice'
import AutoMDSAXSStructureViewer from './AutoMDSAXSStructureViewer'
import {
  classifyPdbContents,
  ContentItem
} from './automdsaxsContents'
import SendIcon from '@mui/icons-material/Send'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { bilbomdAutoMDSaxsJobSchema } from 'schemas/BilboMDAutoMDSaxsJobSchema'
import { Debug } from 'components/Debug'
import LinearProgress from '@mui/material/LinearProgress'
import HeaderBox from 'components/HeaderBox'
import useTitle from 'hooks/useTitle'

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
  hmr: boolean
}

const NewAutoMDSaxsJobForm = () => {
  useTitle('BilboMD: New AutoMD-SAXS Job')
  const navigate = useNavigate()

  const [startPrep, { isLoading: isPreparing }] = useStartAutoMDSaxsPrepMutation()

  const [submitError, setSubmitError] = useState<string | null>(null)
  // Client-side inspection of the uploaded PDB for the contents preview.
  const [pdbText, setPdbText] = useState<string>('')
  const [contents, setContents] = useState<ContentItem[]>([])
  // Per-non-protein-residue "keep" choices + per-ligand SMILES hints.
  const [keep, setKeep] = useState<Record<string, boolean>>({})
  const [ligandSmiles, setLigandSmiles] = useState<Record<string, string>>({})

  // Read the selected PDB client-side to preview its contents + 3D structure.
  const handlePdbFileChange = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      setPdbText(text)
      const items = classifyPdbContents(text)
      setContents(items)
      // Defaults: keep protein + ions + ligands; strip water + agents.
      const k: Record<string, boolean> = {}
      for (const it of items) {
        k[it.resname] =
          it.category === 'protein' ||
          it.category === 'ion' ||
          it.category === 'ligand'
      }
      setKeep(k)
      setLigandSmiles({})
    }
    reader.readAsText(file)
  }

  const ligandItems = contents.filter((c) => c.category === 'ligand')
  const ionItems = contents.filter((c) => c.category === 'ion')
  const agentItems = contents.filter((c) => c.category === 'agent')
  const waterItems = contents.filter((c) => c.category === 'water')


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
    disulfide: false,
    hmr: false
  }

  const onSubmit = async (
    values: AutoMDSaxsJobFormValues,
    _helpers: FormikHelpers<AutoMDSaxsJobFormValues>
  ) => {
    setSubmitError(null)
    // Kept ligands (by resname) + their optional SMILES hints; kept ions/agents
    // map to the category-level config booleans.
    const keptLigands = ligandItems
      .filter((l) => keep[l.resname])
      .map((l) => l.resname)
    const smilesForKept: Record<string, string> = {}
    for (const r of keptLigands)
      if (ligandSmiles[r]?.trim()) smilesForKept[r] = ligandSmiles[r].trim()
    // Per-species ion selection: keep only the ticked ion resnames (keep_ions is
    // the master switch — true if any ion is kept).
    const keptIonResnames = ionItems
      .filter((i) => keep[i.resname])
      .map((i) => i.resname)
    const keepIons = keptIonResnames.length > 0
    const keepAgents = agentItems.some((a) => keep[a.resname])
    const keepWaters = waterItems.some((w) => keep[w.resname])

    // 1) start a prep preview (structure prep only, no MD)
    const prepForm = new FormData()
    prepForm.append('pdb_file', values.pdb_file)
    prepForm.append('system', values.system)
    prepForm.append('force_field', values.force_field)
    prepForm.append('water_model', values.water_model)
    prepForm.append('ph', String(values.ph))
    prepForm.append('ionic_concentration_M', String(values.ionic_concentration_M))
    prepForm.append('disulfide', values.disulfide.toString())
    prepForm.append('keep_ions', String(keepIons))
    prepForm.append('keep_crystallisation_agents', String(keepAgents))
    prepForm.append('keep_waters', String(keepWaters))
    if (keptIonResnames.length > 0)
      prepForm.append('ion_resnames', JSON.stringify(keptIonResnames))
    if (keptLigands.length > 0)
      prepForm.append('ligand_resnames', JSON.stringify(keptLigands))
    if (Object.keys(smilesForKept).length > 0)
      prepForm.append('ligand_smiles', JSON.stringify(smilesForKept))

    try {
      const { previewId } = await startPrep(prepForm).unwrap()
      // Carry the full run settings to the review page; it submits the real job.
      void navigate(`/dashboard/jobs/automd-saxs/review/${previewId}`, {
        state: {
          // The File is structured-cloneable, so it survives in-session router
          // state (used by the review page's "Run MD" to submit the real job).
          pdbFile: values.pdb_file,
          settings: { ...values, pdb_file: undefined },
          keepIons,
          keepAgents,
          keepWaters,
          ionResnames: keptIonResnames,
          ligandResnames: keptLigands,
          ligandSmiles: smilesForKept
        }
      })
    } catch (error) {
      console.error('prep rejected', error)
      setSubmitError(
        (error as { data?: { message?: string } }).data?.message ||
          'Failed to start structure preparation.'
      )
    }
  }

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
              AutoMD-SAXS is an explicit-solvent all-atom
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
          <Alert severity="info" sx={{ mb: 2 }}>
            <strong>Structure preparation is a best-effort automated step.</strong>{' '}
            Please <strong>review the prepared structure</strong> — protonation
            states, kept/stripped contents, ligands and ions — before running the
            simulation.
          </Alert>
          {
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
                        onFileChange={handlePdbFileChange}
                        error={errors.pdb_file && touched.pdb_file}
                        errorMessage={errors.pdb_file ? errors.pdb_file : ''}
                        fileType="structure *.pdb"
                        fileExt=".pdb"
                      />
                    </Grid>

                    {/* Structure contents preview + keep/strip toggles */}
                    {contents.length > 0 && (
                      <Box sx={{ my: 1 }}>
                        <Typography variant="subtitle1" sx={{ mb: 1 }}>
                          Structure contents — choose what to keep
                        </Typography>
                        <Grid container spacing={2}>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <AutoMDSAXSStructureViewer
                              pdbText={pdbText}
                              height={360}
                              keep={keep}
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <Table size="small">
                              <TableBody>
                                <TableRow>
                                  <TableCell>
                                    <strong>Protein</strong>
                                  </TableCell>
                                  <TableCell>
                                    {contents.find((c) => c.category === 'protein')
                                      ?.count ?? 0}{' '}
                                    residues (always kept)
                                  </TableCell>
                                </TableRow>
                                {/* One toggle per bound-ion species, so e.g. a
                                    catalytic Zn can be kept while Ca is stripped. */}
                                {ionItems.map((ion) => (
                                  <TableRow key={ion.resname}>
                                    <TableCell>
                                      <FormControlLabel
                                        control={
                                          <Checkbox
                                            size="small"
                                            checked={!!keep[ion.resname]}
                                            onChange={(e) =>
                                              setKeep((k) => ({
                                                ...k,
                                                [ion.resname]: e.target.checked
                                              }))
                                            }
                                          />
                                        }
                                        label={`Bound ion ${ion.resname} ×${ion.count}`}
                                      />
                                    </TableCell>
                                    <TableCell />
                                  </TableRow>
                                ))}
                                {agentItems.length > 0 && (
                                  <TableRow>
                                    <TableCell>
                                      <FormControlLabel
                                        control={
                                          <Checkbox
                                            size="small"
                                            checked={agentItems.some(
                                              (a) => keep[a.resname]
                                            )}
                                            onChange={(e) =>
                                              setKeep((k) => {
                                                const n = { ...k }
                                                agentItems.forEach(
                                                  (a) =>
                                                    (n[a.resname] = e.target.checked)
                                                )
                                                return n
                                              })
                                            }
                                          />
                                        }
                                        label="Crystallisation agents"
                                      />
                                    </TableCell>
                                    <TableCell>
                                      {agentItems.map((a) => (
                                        <Chip
                                          key={a.resname}
                                          size="small"
                                          variant="outlined"
                                          label={`${a.resname} ×${a.count}`}
                                          sx={{ mr: 0.5 }}
                                        />
                                      ))}
                                    </TableCell>
                                  </TableRow>
                                )}
                                {ligandItems.map((lig) => (
                                  <TableRow key={lig.resname}>
                                    <TableCell>
                                      <FormControlLabel
                                        control={
                                          <Checkbox
                                            size="small"
                                            checked={!!keep[lig.resname]}
                                            onChange={(e) =>
                                              setKeep((k) => ({
                                                ...k,
                                                [lig.resname]: e.target.checked
                                              }))
                                            }
                                          />
                                        }
                                        label={`Ligand ${lig.resname} ×${lig.count}`}
                                      />
                                    </TableCell>
                                    <TableCell>
                                      <TextField
                                        size="small"
                                        fullWidth
                                        placeholder="SMILES (recommended)"
                                        value={ligandSmiles[lig.resname] || ''}
                                        disabled={!keep[lig.resname]}
                                        onChange={(e) =>
                                          setLigandSmiles((s) => ({
                                            ...s,
                                            [lig.resname]: e.target.value
                                          }))
                                        }
                                      />
                                    </TableCell>
                                  </TableRow>
                                ))}
                                {waterItems.length > 0 && (
                                  <TableRow>
                                    <TableCell>
                                      <FormControlLabel
                                        control={
                                          <Checkbox
                                            size="small"
                                            checked={waterItems.some(
                                              (w) => keep[w.resname]
                                            )}
                                            onChange={(e) =>
                                              setKeep((k) => {
                                                const n = { ...k }
                                                waterItems.forEach(
                                                  (w) =>
                                                    (n[w.resname] = e.target.checked)
                                                )
                                                return n
                                              })
                                            }
                                          />
                                        }
                                        label="Crystallographic waters"
                                      />
                                    </TableCell>
                                    <TableCell>
                                      {waterItems.reduce((n, w) => n + w.count, 0)}{' '}
                                      waters —{' '}
                                      {waterItems.some((w) => keep[w.resname])
                                        ? 'kept (bulk solvent added around them)'
                                        : 'removed (re-added as explicit solvent)'}
                                    </TableCell>
                                  </TableRow>
                                )}
                              </TableBody>
                            </Table>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ display: 'block', mt: 1 }}
                            >
                              A ligand without hydrogens needs a SMILES hint to be
                              parameterised; otherwise it is stripped.
                            </Typography>
                          </Grid>
                        </Grid>
                      </Box>
                    )}

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

                    <Box sx={{ my: 1 }}>
                      <Field name="hmr">
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
                            label="Fast mode — Hydrogen Mass Repartitioning (4 fs timestep)"
                          />
                        )}
                      </Field>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', ml: 4, mt: -0.5 }}
                      >
                        Repartitions mass onto hydrogen atoms so the simulation can
                        take a larger timestep (4 fs instead of 2 fs), running the MD
                        roughly <strong>2× faster</strong> for the same simulated
                        time. Leave off for the conventional 2 fs timestep.
                      </Typography>
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
                            label="Box padding (nm)"
                            name="box_padding_nm"
                            type="number"
                            as={TextField}
                            disabled={isSubmitting}
                            onChange={handleChange}
                            value={values.box_padding_nm}
                            helperText="Blank = auto"
                            sx={{ minWidth: 200 }}
                          />
                          <Field
                            label="Random seed"
                            name="seed"
                            type="number"
                            as={TextField}
                            disabled={isSubmitting}
                            onChange={handleChange}
                            value={values.seed}
                            helperText="Blank = random"
                            sx={{ minWidth: 200 }}
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
                        loading={isSubmitting || isPreparing}
                        endIcon={<SendIcon />}
                        loadingPosition="end"
                        variant="contained"
                        sx={{ width: '190px' }}
                      >
                        <span>Prepare structure</span>
                      </Button>
                    </Grid>
                  </Grid>
                  {import.meta.env.MODE === 'development' ? <Debug /> : ''}
                </Form>
              )}
            </Formik>
          }
        </Paper>
      </Grid>
    </Grid>
  )
}

export default NewAutoMDSaxsJobForm
