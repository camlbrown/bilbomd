import { Job as BullMQJob } from 'bullmq'
import { BilboMdAutoMDSAXSJob, StepStatus } from '@bilbomd/mongodb-schema'
import path from 'node:path'
import fs from 'fs-extra'
import { config } from '../../config/config.js'
import { logger } from '../../helpers/loggers.js'
import {
  initializeJob,
  cleanupJob,
  handleError,
  sendJobFailureNotification
} from '../functions/job-utils.js'
import { updateStepStatus } from '../functions/mongo-utils.js'
import { createProgressTracker } from '../functions/progress-tracker.js'
import {
  buildAutoMDSaxsConfig,
  buildAutoMDSaxsArgs,
  runAutoMDSaxs,
  parseAutoMDSaxsManifest,
  createResultsArchive
} from '../functions/automd-saxs-functions.js'

/**
 * AutoMD-SAXS pipeline (explicit-solvent OpenMM MD + FoXS refinement).
 *
 * Treats AutoMD-SAXS as an external pip-installed CLI dependency: prepare the
 * job directory, write config.json, run `automd-saxs run --config ... --out ...`,
 * stream its logs, then read the manifest.json it produces to determine success.
 * No automd-saxs internals are imported into BilboMD.
 */
const processBilboMDAutoMDSAXSJob = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMdAutoMDSAXSJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }

  const progress = createProgressTracker(MQjob, foundJob)
  await progress.update(5)

  await initializeJob(MQjob, foundJob)
  await progress.update(10)

  const workDir = path.join(config.uploadDir, foundJob.uuid)
  // Write results into the conventional `results/` dir so the generic
  // "Download Results" endpoint can bundle and serve them.
  const outDir = path.join(workDir, 'results')

  try {
    // validate inputs
    await MQjob.log('start automd-saxs-validate')
    const pdbPath = path.join(workDir, foundJob.pdb_file)
    if (!(await fs.pathExists(pdbPath))) {
      throw new Error(`AutoMD-SAXS structure file not found: ${pdbPath}`)
    }
    let saxsPath: string | undefined
    if (foundJob.dat_file) {
      saxsPath = path.join(workDir, foundJob.dat_file)
      if (!(await fs.pathExists(saxsPath))) {
        throw new Error(`AutoMD-SAXS SAXS file not found: ${saxsPath}`)
      }
    }
    await MQjob.log('end automd-saxs-validate')
    await progress.update(15)

    // write the automd-saxs config.json
    await MQjob.log('start automd-saxs-prepare')
    const jobConfig = buildAutoMDSaxsConfig({
      jobName: foundJob.uuid,
      pdbPath,
      saxsPath,
      system: foundJob.system,
      forceField: foundJob.force_field,
      waterModel: foundJob.water_model,
      simulationTimeNs: foundJob.simulation_time_ns,
      nRepeats: foundJob.n_repeats,
      temperatureK: foundJob.temperature_K,
      ionicConcentrationM: foundJob.ionic_concentration_M,
      ph: foundJob.ph,
      disulfide: foundJob.disulfide,
      boxPaddingNm: foundJob.box_padding_nm,
      seed: foundJob.seed,
      hmr: foundJob.hmr,
      keepIons: foundJob.keep_ions,
      keepCrystallisationAgents: foundJob.keep_crystallisation_agents,
      keepWaters: foundJob.keep_waters,
      ionResnames: foundJob.ion_resnames,
      ligandResnames: foundJob.ligand_resnames,
      ligandSmiles: foundJob.ligand_smiles,
      protonationOverrides: foundJob.protonation_overrides
    })
    const configPath = path.join(workDir, 'automd_saxs_config.json')
    await fs.writeJson(configPath, jobConfig, { spaces: 2 })
    await fs.ensureDir(outDir)

    const logDir = path.join(workDir, 'logs')
    await fs.ensureDir(logDir)
    const cliLog = path.join(logDir, 'automd-saxs.log')
    await fs.ensureFile(cliLog)
    await MQjob.log('end automd-saxs-prepare')
    await progress.update(20)

    // run the external CLI
    await MQjob.log('start automd-saxs-run')
    const args = buildAutoMDSaxsArgs({ configPath, outDir })
    logger.info(`AutoMD-SAXS: ${config.automdSaxs.bin} ${args.join(' ')}`)

    const logStream = fs.createWriteStream(cliLog, { flags: 'a' })
    let heartbeat: NodeJS.Timeout | null = setInterval(() => {
      MQjob.log(`Heartbeat: AutoMD-SAXS still running for ${foundJob.uuid}`)
    }, 30_000)

    let result
    try {
      result = await runAutoMDSaxs({
        bin: config.automdSaxs.bin,
        args,
        cwd: workDir,
        timeoutMs: config.automdSaxs.timeoutMs,
        onStdoutLine: (line) => logStream.write(line + '\n'),
        onStderrLine: (line) => logStream.write(line + '\n')
      })
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      await new Promise<void>((resolve) => logStream.end(resolve))
    }
    await MQjob.log('end automd-saxs-run')
    await progress.update(90)

    // collect results from the manifest
    await MQjob.log('start automd-saxs-results')
    const manifestPath = path.join(outDir, 'manifest.json')
    if (!(await fs.pathExists(manifestPath))) {
      throw new Error(
        `AutoMD-SAXS manifest.json not found (CLI exit code ${result.code}): ${manifestPath}`
      )
    }
    const parsed = parseAutoMDSaxsManifest(await fs.readFile(manifestPath, 'utf8'))
    await MQjob.log(parsed.message)
    logger.info(`AutoMD-SAXS result for ${foundJob.uuid}: ${parsed.message}`)

    if (!parsed.succeeded || result.code !== 0) {
      throw new Error(
        `${parsed.message} (CLI exit code ${result.code})`
      )
    }
    // Bundle results for the generic Download Results endpoint.
    await createResultsArchive(workDir, foundJob.uuid)
    await updateStepStatus(foundJob, 'results', {
      status: StepStatus.Success,
      message: parsed.message
    })
    await MQjob.log('end automd-saxs-results')

    foundJob.results_ready = true
    await foundJob.save()

    await cleanupJob(MQjob, foundJob)
    await progress.update(100)
  } catch (error) {
    await handleError(error, foundJob)
    // Notify the user their AutoMD-SAXS job failed (other pipelines email on
    // success only; this is opt-in per pipeline so their behaviour is unchanged).
    await sendJobFailureNotification(foundJob)
  }
}

export { processBilboMDAutoMDSAXSJob }
