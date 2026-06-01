import { Job as BullMQJob } from 'bullmq'
import { BilboMdCarbonaraJob } from '@bilbomd/mongodb-schema'
import path from 'node:path'
import fs from 'fs-extra'
import { config } from '../../config/config.js'
import { logger } from '../../helpers/loggers.js'
import { initializeJob, cleanupJob, handleError } from '../functions/job-utils.js'
import { createProgressTracker } from '../functions/progress-tracker.js'
import {
  buildCarbonaraJobJson,
  buildCarbonaraContainerArgs,
  parseCarbonaraSummary,
  runCarbonaraContainer
} from '../functions/carbonara-functions.js'

/**
 * Local Carbonara coarse-grained pipeline.
 *
 * Prepares an isolated job directory, writes the wrapper job.json, launches the
 * Carbonara container, then parses results/wrapper_summary.json to determine
 * success. All-atom (cg2all) reconstruction is intentionally out of scope for
 * this first pass.
 */
const processBilboMDCarbonaraJob = async (MQjob: BullMQJob) => {
  await MQjob.updateProgress(1)

  const foundJob = await BilboMdCarbonaraJob.findOne({ _id: MQjob.data.jobid })
    .populate('user')
    .exec()
  if (!foundJob) {
    throw new Error(`No job found for: ${MQjob.data.jobid}`)
  }

  const progress = createProgressTracker(MQjob, foundJob)
  await progress.update(5)

  await initializeJob(MQjob, foundJob)
  await progress.update(10)

  // Host job directory; bind-mounted into the container at /job.
  const workDir = path.join(config.uploadDir, foundJob.uuid)

  try {
    // validating-inputs
    await MQjob.log('start carbonara-validate')
    const pdbPath = path.join(workDir, foundJob.pdb_file)
    const saxsPath = path.join(workDir, foundJob.data_file)
    if (!(await fs.pathExists(pdbPath))) {
      throw new Error(`Carbonara structure file not found: ${pdbPath}`)
    }
    if (!(await fs.pathExists(saxsPath))) {
      throw new Error(`Carbonara SAXS file not found: ${saxsPath}`)
    }
    await MQjob.log('end carbonara-validate')
    await progress.update(15)

    // preparing-carbonara-inputs: write the wrapper job.json
    await MQjob.log('start carbonara-prepare')
    const jobJson = buildCarbonaraJobJson({
      jobName: foundJob.uuid,
      carbonaraRoot: config.carbonara.carbonaraRoot,
      pdbFileName: foundJob.pdb_file,
      saxsFileName: foundJob.data_file,
      parameters: {
        fit_n_times: foundJob.fit_n_times,
        min_q: foundJob.min_q,
        max_q: foundJob.max_q,
        max_q_start: foundJob.max_q_start,
        max_fit_steps: foundJob.max_fit_steps,
        mixture_n: foundJob.mixture_n,
        rotation: foundJob.rotation ?? false
      }
    })
    const jobJsonPath = path.join(workDir, 'job.json')
    await fs.writeJson(jobJsonPath, jobJson, { spaces: 2 })

    const logDir = path.join(workDir, 'logs')
    await fs.ensureDir(logDir)
    const containerLog = path.join(logDir, 'carbonara.container.log')
    await fs.ensureFile(containerLog)
    await MQjob.log('end carbonara-prepare')
    await progress.update(20)

    // running-carbonara
    await MQjob.log('start carbonara-run')
    const args = buildCarbonaraContainerArgs({
      image: config.carbonara.image,
      hostJobDir: workDir,
      runnerPath: config.carbonara.runnerPath,
      pythonBin: config.carbonara.pythonBin
    })
    logger.info(
      `Carbonara container: ${config.carbonara.containerBin} ${args.join(' ')}`
    )

    const logStream = fs.createWriteStream(containerLog, { flags: 'a' })
    let heartbeat: NodeJS.Timeout | null = setInterval(() => {
      MQjob.log(`Heartbeat: Carbonara still running for ${foundJob.uuid}`)
    }, 30_000)

    let result
    try {
      result = await runCarbonaraContainer({
        containerBin: config.carbonara.containerBin,
        args,
        cwd: workDir,
        timeoutMs: config.carbonara.timeoutMs,
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
    await MQjob.log('end carbonara-run')
    await progress.update(85)

    // collecting-results: parse the wrapper summary
    await MQjob.log('start carbonara-results')
    const summaryPath = path.join(workDir, 'results', 'wrapper_summary.json')
    if (!(await fs.pathExists(summaryPath))) {
      throw new Error(
        `Carbonara wrapper_summary.json not found (container exit code ${result.code}): ${summaryPath}`
      )
    }
    const summaryText = await fs.readFile(summaryPath, 'utf8')
    const parsed = parseCarbonaraSummary(summaryText)
    await MQjob.log(parsed.message)
    logger.info(`Carbonara result for ${foundJob.uuid}: ${parsed.message}`)

    if (!parsed.succeeded) {
      throw new Error(parsed.message)
    }
    await MQjob.log('end carbonara-results')
    await progress.update(99)

    foundJob.results_ready = true
    await foundJob.save()

    await cleanupJob(MQjob, foundJob)
    await progress.update(100)
  } catch (error) {
    await handleError(error, foundJob)
  }
}

export { processBilboMDCarbonaraJob }
