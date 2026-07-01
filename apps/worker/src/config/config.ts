import dotenv from 'dotenv'
dotenv.config()

const getEnvVar = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`)
  }
  return value
}

const toBoolean = (value?: string): boolean =>
  value === 'true' || value === '1' || value?.toLowerCase() === 'yes'

const getEnvVarWithDefault = (name: string, defaultValue: string): string => {
  return process.env[name] || defaultValue
}

const parsePositiveIntEnv = (name: string, defaultValue: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Environment variable ${name}="${raw}" is not a positive number`
    )
  }
  return Math.floor(parsed)
}

// Like parsePositiveIntEnv but treats 0 as a valid value meaning "no limit".
// Used for step timeouts that may legitimately be disabled (e.g. long-running
// Carbonara jobs that should not be wall-clock capped). The consuming helper
// (runCarbonaraContainer) skips its kill timer when the value is 0.
const parseTimeoutEnv = (name: string, defaultValue: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Environment variable ${name}="${raw}" is not a non-negative number`
    )
  }
  return Math.floor(parsed)
}

const validateRequiredEnvVars = (): void => {
  const required = [
    'BILBOMD_URL',
    'SFAPI_URL',
    'SCRIPT_DIR',
    'UPLOAD_DIR',
    'WORK_DIR',
    'DATA_VOL',
    'CHARMM_TOPOLOGY',
    'CHARMM_TEMPLATES',
    'CHARMM',
    'FOXS',
    'MULTIFOXS',
    'PREPARE_CHARMM_SLURM_SCRIPT',
    'PREPARE_OMM_SLURM_SCRIPT',
    'CP2CFS_SCRIPT'
  ]
  const missing = required.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    )
  }
}

// Validate required environment variables at module initialization
validateRequiredEnvVars()

export const config = {
  sendEmailNotifications: toBoolean(process.env.SEND_EMAIL_NOTIFICATIONS),
  bilbomdUrl: getEnvVar('BILBOMD_URL'),
  runOnNERSC: toBoolean(process.env.USE_NERSC),
  nerscBaseAPI: getEnvVar('SFAPI_URL'),
  nerscScriptDir: getEnvVar('SCRIPT_DIR'),
  nerscUploadDir: getEnvVar('UPLOAD_DIR'),
  nerscWorkDir: getEnvVar('WORK_DIR'),
  uploadDir: getEnvVar('DATA_VOL'),
  charmmTopoDir: getEnvVar('CHARMM_TOPOLOGY'),
  charmmTemplateDir: getEnvVar('CHARMM_TEMPLATES'),
  charmmBin: getEnvVar('CHARMM'),
  foxBin: getEnvVar('FOXS'),
  multifoxsBin: getEnvVar('MULTIFOXS'),
  openmmPythonBin: getEnvVarWithDefault(
    'OPENMM_PYTHON_BIN',
    '/opt/envs/openmm/bin/python'
  ),
  openmmMdConcurrency: parsePositiveIntEnv('OPENMM_MD_CONCURRENCY', 1),
  basePythonBin: getEnvVarWithDefault(
    'BASE_PYTHON_BIN',
    '/opt/envs/base/bin/python'
  ),
  colabfoldServiceUrl: getEnvVarWithDefault(
    'COLABFOLD_SERVICE_URL',
    'http://colabfold-service:8000'
  ),
  colabfoldTimeoutMs: parsePositiveIntEnv(
    'COLABFOLD_TIMEOUT_MS',
    60 * 60 * 1000
  ),
  of3ServiceUrl: getEnvVarWithDefault(
    'OF3_SERVICE_URL',
    'http://of3-service:8000'
  ),
  of3TimeoutMs: parsePositiveIntEnv('OF3_TIMEOUT_MS', 60 * 60 * 1000),
  logLevel: getEnvVarWithDefault('LOG_LEVEL', 'info'),
  scripts: {
    prepareCHARMMSlurmScript: getEnvVar('PREPARE_CHARMM_SLURM_SCRIPT'),
    prepareOMMSlurmScript: getEnvVar('PREPARE_OMM_SLURM_SCRIPT'),
    copyFromScratchToCFSScript: getEnvVar('CP2CFS_SCRIPT')
  },
  bilbomd: {
    SANSEnabled: toBoolean(process.env.ENABLE_BILBOMD_SANS),
    AlphaFoldEnabled: toBoolean(process.env.ENABLE_BILBOMD_ALPHAFOLD),
    OpenFoldEnabled: toBoolean(process.env.ENABLE_BILBOMD_OPENFOLD),
    MultiEnabled: toBoolean(process.env.ENABLE_BILBOMD_MULTI),
    ScoperEnabled: toBoolean(process.env.ENABLE_BILBOMD_SCOPER),
    CarbonaraEnabled: toBoolean(process.env.ENABLE_BILBOMD_CARBONARA)
  },
  // Local Carbonara container-backed worker settings. All have safe defaults so
  // they never trip the required-env validation above; override per deployment.
  carbonara: {
    containerBin: getEnvVarWithDefault('CARBONARA_CONTAINER_BIN', 'podman'),
    // Execution mode: 'podman' (default) launches the Carbonara runtime as a
    // nested container (local dev). 'inprocess' runs the same command directly in
    // the worker pod (for k8s, where nested containers are an anti-pattern and the
    // Carbonara tools are baked into the worker image; the job dir must be mounted
    // at the CARBONARA_JOB_MOUNT path). Default preserves current local behaviour.
    exec: getEnvVarWithDefault('CARBONARA_EXEC', 'podman'),
    image: getEnvVarWithDefault(
      'CARBONARA_IMAGE',
      'carbonara-allatom-runtime:dev'
    ),
    // In-container path to the Carbonara checkout (carbonara_root in job.json).
    carbonaraRoot: getEnvVarWithDefault('CARBONARA_ROOT', '/opt/carbonara'),
    // In-container path to the BilboMD wrapper entry point.
    runnerPath: getEnvVarWithDefault(
      'CARBONARA_RUNNER',
      '/opt/carbonara/carbonara_bilbomd_runner_refined.py'
    ),
    // In-container python used to launch the wrapper.
    pythonBin: getEnvVarWithDefault('CARBONARA_PYTHON_BIN', 'python'),
    // 0 = no wall-clock cap (default). Carbonara jobs can run arbitrarily long
    // (many runs / high step counts); set a positive ms value to re-enable a cap.
    timeoutMs: parseTimeoutEnv('CARBONARA_TIMEOUT_MS', 0),
    // cg2all all-atom reconstruction settings (A2).
    cg2allExec: getEnvVarWithDefault(
      'CARBONARA_CG2ALL_EXEC',
      'convert_cg2all_carbonara'
    ),
    foxsCmd: getEnvVarWithDefault('CARBONARA_FOXS_CMD', 'pyfoxs'),
    maxBackmap: parsePositiveIntEnv('CARBONARA_MAX_BACKMAP', 5),
    // 0 = no wall-clock cap (default). Covers the cg2all reconstruction and the
    // FoXS analysis steps; set a positive ms value to re-enable a cap.
    backmapTimeoutMs: parseTimeoutEnv('CARBONARA_BACKMAP_TIMEOUT_MS', 0),
    // Optional host path to bind-mount over the in-container wrapper for local
    // dev iteration without an image rebuild. Empty string = no mount (prod).
    runnerMount: getEnvVarWithDefault('CARBONARA_RUNNER_MOUNT', ''),
    // In-container path to the Carbonara data-tools module (baked into image).
    dataToolsPath: getEnvVarWithDefault(
      'CARBONARA_DATATOOLS_PATH',
      '/opt/carbonara/CarbonaraDataTools.py'
    ),
    // Optional host path to bind-mount an updated CarbonaraDataTools.py over the
    // baked copy for local dev (mount-to-validate before an image rebuild), like
    // runnerMount. Empty string = no mount (use the baked version).
    dataToolsMount: getEnvVarWithDefault('CARBONARA_DATATOOLS_MOUNT', ''),
    // Mixture all-atom weighting via BilboMD's IMP multi_foxs. It is not in the
    // Carbonara image, so the mixture step runs in the BilboMD worker image
    // (which ships /usr/bin/multi_foxs). Falls back to the ported weight-fit in
    // carbonara_results.py if the image/binary is unavailable.
    multiFoxsImage: getEnvVarWithDefault(
      'CARBONARA_MULTIFOXS_IMAGE',
      'ghcr.io/bl1231/bilbomd-worker:2.10.0'
    ),
    multiFoxsBin: getEnvVarWithDefault(
      'CARBONARA_MULTIFOXS_BIN',
      '/usr/bin/multi_foxs'
    ),
    // B5: initial scattering check helper settings.
    // In-container path to carbonara_initfoxs.py (baked into the image).
    initFoxsPath: getEnvVarWithDefault(
      'CARBONARA_INITFOXS_PATH',
      '/opt/carbonara/carbonara_initfoxs.py'
    ),
    // Optional host path to bind-mount the helper for local dev (like runnerMount).
    initFoxsMount: getEnvVarWithDefault('CARBONARA_INITFOXS_MOUNT', ''),
    // Concurrency for the dedicated carbonara-preview BullMQ worker.
    previewConcurrency: parsePositiveIntEnv('CARBONARA_PREVIEW_CONCURRENCY', 2),
    // B2.4: auto-flexibility prepare helper settings.
    // In-container path to carbonara_autoflex.py (baked into the image).
    autoFlexPath: getEnvVarWithDefault(
      'CARBONARA_AUTOFLEX_PATH',
      '/opt/carbonara/carbonara_autoflex.py'
    ),
    // Optional host path to bind-mount the helper for local dev (like initFoxsMount).
    autoFlexMount: getEnvVarWithDefault('CARBONARA_AUTOFLEX_MOUNT', ''),
    // Concurrency for the dedicated carbonara-autoflex BullMQ worker.
    autoFlexConcurrency: parsePositiveIntEnv('CARBONARA_AUTOFLEX_CONCURRENCY', 2),
    // R1: results-analysis helper (carbonara_results.py -> analysis.json),
    // run as a post-reconstruction step on each Carbonara job.
    resultsPath: getEnvVarWithDefault(
      'CARBONARA_RESULTS_PATH',
      '/opt/carbonara/carbonara_results.py'
    ),
    // Optional host path to bind-mount the helper for local dev (like autoFlexMount).
    resultsMount: getEnvVarWithDefault('CARBONARA_RESULTS_MOUNT', '')
  },
  // AutoMD-SAXS: external `automd-saxs` CLI (pip-installed alongside the worker;
  // OpenMM/FoXS come from the worker image). The worker writes a config.json,
  // runs `automd-saxs run --config config.json --out <jobdir>`, then reads the
  // manifest.json it produces.
  automdSaxs: {
    bin: getEnvVarWithDefault('AUTOMD_SAXS_BIN', 'automd-saxs'),
    timeoutMs: parseTimeoutEnv('AUTOMD_SAXS_TIMEOUT_MS', 0)
  }
}
