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
  runCarbonaraContainer,
  buildReconstructionPlan,
  buildBackmapLoopCommand,
  buildBackmapContainerArgs,
  parseFoxsResultsSummary,
  selectBestAaModel
} from '../functions/carbonara-functions.js'

/**
 * Local Carbonara pipeline.
 *
 * Prepares an isolated job directory, writes the wrapper job.json, launches the
 * Carbonara container, then parses results/wrapper_summary.json to determine
 * success.
 *
 * When foundJob.all_atom === true a second podman invocation calls backmap_cli.py
 * (already baked into the image) per selected coords file to produce *_AA.pdb
 * outputs. Reconstruction failure is LENIENT: coarse results are preserved and
 * the job is still marked Completed with a warning; the job only fails hard if
 * the coarse fit itself failed.
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
    if (foundJob.alphafold_flex === true) {
      if (!foundJob.pae_file) {
        throw new Error(
          'alphafold_flex is enabled but no pae_file was stored for this job'
        )
      }
      const paePath = path.join(workDir, foundJob.pae_file)
      if (!(await fs.pathExists(paePath))) {
        throw new Error(`Carbonara PAE file not found: ${paePath}`)
      }
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
      },
      alphaFoldFlex: foundJob.alphafold_flex,
      paeFileName: foundJob.pae_file,
      paeFlexThreshold: foundJob.pae_flex_threshold
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
    await progress.update(85)

    // ----------------------------------------------------------------
    // A2 — optional cg2all all-atom reconstruction (gated on all_atom)
    // ----------------------------------------------------------------
    if (foundJob.all_atom === true) {
      await MQjob.log('start carbonara-reconstruct')
      await progress.update(86)

      const coordsFiles: string[] = Array.isArray(parsed.summary.final_model_files)
        ? (parsed.summary.final_model_files as string[])
        : []

      if (coordsFiles.length === 0) {
        logger.warn(
          `Carbonara all_atom requested but no final_model_files in summary for ${foundJob.uuid}; skipping reconstruction`
        )
        await MQjob.log(
          'carbonara-reconstruct: no final_model_files found; skipping (coarse results preserved)'
        )
      } else {
        // fitdata_dir is an in-container path; scenarioRoot = parent of fitdata
        const fitdataDir: string =
          typeof parsed.summary.fitdata_dir === 'string'
            ? parsed.summary.fitdata_dir
            : ''
        const scenarioRoot = fitdataDir
          ? fitdataDir.split('/').slice(0, -1).join('/')
          : coordsFiles[0].split('/').slice(0, -2).join('/')

        const outRootContainer = '/job/results/all_atom'
        const outRootHost = path.join(workDir, 'results', 'all_atom')
        await fs.ensureDir(outRootHost)

        const saxsInContainer = `${scenarioRoot}/Saxs.dat`
        const disulfideHostPath = path.join(
          workDir,
          'work',
          foundJob.uuid,
          'carbonara_runs',
          foundJob.uuid,
          'fixedDistanceConstraints1.dat'
        )
        const disulfideExists = await fs.pathExists(disulfideHostPath)
        const disulfideInContainer = disulfideExists
          ? `${scenarioRoot}/fixedDistanceConstraints1.dat`
          : undefined

        const tasks = buildReconstructionPlan({
          coordsFiles,
          scenarioRoot,
          outRoot: outRootContainer,
          maxModels: config.carbonara.maxBackmap
        })

        if (tasks.length < coordsFiles.length) {
          logger.info(
            `Carbonara reconstruction capped at ${config.carbonara.maxBackmap} ` +
              `models (${coordsFiles.length} available) for ${foundJob.uuid}`
          )
        }

        const doFoxs = foundJob.do_foxs !== false

        const loopBody = buildBackmapLoopCommand(tasks, {
          pythonBin: config.carbonara.pythonBin,
          carbonaraRoot: config.carbonara.carbonaraRoot,
          cg2allExec: config.carbonara.cg2allExec,
          doFoxs,
          foxsCmd: config.carbonara.foxsCmd,
          saxs: saxsInContainer,
          maxQ: foundJob.max_q,
          disulfideFile: disulfideInContainer
        })

        const backmapLog = path.join(workDir, 'logs', 'carbonara.backmap.log')
        await fs.ensureFile(backmapLog)
        const backmapStream = fs.createWriteStream(backmapLog, { flags: 'a' })

        const backmapArgs = buildBackmapContainerArgs({
          image: config.carbonara.image,
          hostJobDir: workDir,
          loopBody
        })

        logger.info(
          `Carbonara backmap: ${config.carbonara.containerBin} ${backmapArgs.slice(0, 4).join(' ')} ...`
        )

        try {
          await runCarbonaraContainer({
            containerBin: config.carbonara.containerBin,
            args: backmapArgs,
            cwd: workDir,
            timeoutMs: config.carbonara.backmapTimeoutMs,
            onStdoutLine: (line) => backmapStream.write(line + '\n'),
            onStderrLine: (line) => backmapStream.write(line + '\n')
          })
        } finally {
          await new Promise<void>((resolve) => backmapStream.end(resolve))
        }

        if (doFoxs) {
          await MQjob.log('start carbonara-scoring')
          await progress.update(93)
        }

        // Collect results from each task outdir (host-side paths)
        const allEntries: { name: string; aaPdb: string; chi2: number | null }[] =
          []
        for (const task of tasks) {
          // Map the in-container outdir back to a host path
          const taskOutdirHost = path.join(
            outRootHost,
            task.name
          )
          const foxsResultsHost = path.join(taskOutdirHost, 'foxs_results.txt')
          if (doFoxs && (await fs.pathExists(foxsResultsHost))) {
            const text = await fs.readFile(foxsResultsHost, 'utf8')
            const entries = parseFoxsResultsSummary(text)
            for (const e of entries) {
              allEntries.push({ name: task.name, aaPdb: e.aaPdb, chi2: e.chi2 })
            }
          } else {
            // Check whether the AA PDB was produced at all
            const aaPdbHost = path.join(taskOutdirHost, `${task.name}_AA.pdb`)
            if (await fs.pathExists(aaPdbHost)) {
              allEntries.push({ name: task.name, aaPdb: aaPdbHost, chi2: null })
            }
          }
        }

        const bestEntry = selectBestAaModel(
          allEntries.map((e) => ({ aaPdb: e.aaPdb, chi2: e.chi2 }))
        )

        if (allEntries.length === 0) {
          logger.error(
            `Carbonara reconstruction produced no AA PDB files for ${foundJob.uuid}; ` +
              'coarse results are preserved (partial success)'
          )
          await MQjob.log(
            'carbonara-reconstruct: WARNING — no *_AA.pdb produced; coarse results preserved'
          )
        } else {
          logger.info(
            `Carbonara reconstruction: ${allEntries.length} model(s) produced for ${foundJob.uuid}`
          )
        }

        // Write all_atom_summary.json
        const summaryData = {
          all_atom: true,
          backend: 'cg2all',
          n_models: tasks.length,
          models: allEntries.map((e) => ({
            name: e.name,
            aa_pdb: e.aaPdb,
            chi2: e.chi2
          })),
          best_all_atom: bestEntry
            ? { aa_pdb: bestEntry.aaPdb, chi2: bestEntry.chi2 }
            : null,
          do_foxs: doFoxs
        }
        await fs.writeJson(
          path.join(workDir, 'results', 'all_atom_summary.json'),
          summaryData,
          { spaces: 2 }
        )

        if (doFoxs) {
          await MQjob.log('end carbonara-scoring')
        }
      }

      await MQjob.log('end carbonara-reconstruct')
      await progress.update(98)
    } else {
      await progress.update(99)
    }

    foundJob.results_ready = true
    await foundJob.save()

    await cleanupJob(MQjob, foundJob)
    await progress.update(100)
  } catch (error) {
    await handleError(error, foundJob)
  }
}

export { processBilboMDCarbonaraJob }
