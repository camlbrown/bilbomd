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
  selectBestAaModel,
  buildResultsContainerArgs,
  buildMultiFoxsContainerArgs,
  parseMultiFoxsEnsembles,
  parseMultiFoxsFit
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
    if (foundJob.constraints_file) {
      const constraintsPath = path.join(workDir, foundJob.constraints_file)
      if (!(await fs.pathExists(constraintsPath))) {
        throw new Error(
          `Carbonara constraints file not found: ${constraintsPath}`
        )
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
        max_mixture_combos: foundJob.max_mixture_combos,
        rotation: foundJob.rotation ?? false
      },
      alphaFoldFlex: foundJob.alphafold_flex,
      paeFileName: foundJob.pae_file,
      paeFlexThreshold: foundJob.pae_flex_threshold,
      constraintsFileName: foundJob.constraints_file,
      flexMode: foundJob.flex_mode,
      flexRanges: foundJob.flex_ranges as
        | { chain: number; ranges: number[][] }[]
        | undefined,
      multimer: foundJob.multimer,
      chainMerges: foundJob.chain_merges as number[][] | undefined,
      mixturePdbFileNames: foundJob.mixture_pdb_files as string[] | undefined
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
      pythonBin: config.carbonara.pythonBin,
      runnerMountHost: config.carbonara.runnerMount || undefined,
      dataToolsMountHost: config.carbonara.dataToolsMount || undefined,
      dataToolsPath: config.carbonara.dataToolsPath
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
        execMode: config.carbonara.exec,
        image: config.carbonara.image,
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
        // R0: do NOT pass the distance-constraints file as backmap's disulfide
        // file. Doing so makes backmap emit SSBOND records, which the cg2all
        // build cannot process (it crashes on disulfide cysteines — an SSBOND
        // column misread, then a CYS-topology 'HG1' error), aborting all-atom
        // reconstruction. cg2all does not enforce disulfide geometry anyway, and
        // distance constraints are not necessarily disulfides — so we
        // reconstruct without SSBOND. Real disulfide support would need a cg2all
        // build that handles CYS2/CYX.
        const disulfideInContainer = undefined

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
            execMode: config.carbonara.exec,
            image: config.carbonara.image,
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

        // Mixture all-atom weighting via BilboMD's IMP multi_foxs (rigorous;
        // the results step uses it in place of the rough ported weight-fit when
        // present). Non-fatal — any failure leaves the fallback in place.
        const nSpecies = foundJob.mixture_n ?? 1
        if (nSpecies > 1 && allEntries.length > 0) {
          try {
            // Find a complete per-run species set (sub 0..N-1) among the
            // backmapped models.
            const byRun = new Map<number, Map<number, string>>()
            for (const e of allEntries) {
              const m = e.name.match(/mol(\d+)_sub_(\d+)/)
              if (!m) continue
              const run = Number(m[1])
              const sub = Number(m[2])
              if (!byRun.has(run)) byRun.set(run, new Map())
              byRun.get(run)?.set(sub, e.name)
            }
            const wanted = [...Array(nSpecies).keys()]
            let chosen: string[] | null = null
            for (const run of [...byRun.keys()].sort((a, b) => a - b)) {
              const subs = byRun.get(run) as Map<number, string>
              if (wanted.every((s) => subs.has(s))) {
                chosen = wanted.map((s) => subs.get(s) as string)
                break
              }
            }
            if (chosen) {
              const speciesContainer = chosen.map(
                (name) => `/job/results/all_atom/${name}/${name}_AA.pdb`
              )
              const mfArgs = buildMultiFoxsContainerArgs({
                image: config.carbonara.multiFoxsImage,
                multiFoxsBin: config.carbonara.multiFoxsBin,
                hostJobDir: workDir,
                outDirContainer: '/job/results/multifoxs_mixture',
                saxsContainer: `/job/${foundJob.data_file}`,
                speciesPdbsContainer: speciesContainer,
                numStates: nSpecies
              })
              const mfLog = path.join(workDir, 'logs', 'carbonara.multifoxs.log')
              await fs.ensureFile(mfLog)
              const mfStream = fs.createWriteStream(mfLog, { flags: 'a' })
              try {
                await runCarbonaraContainer({
                  containerBin: config.carbonara.containerBin,
                  args: mfArgs,
                  cwd: workDir,
                  execMode: config.carbonara.exec,
                  image: config.carbonara.multiFoxsImage,
                  timeoutMs: config.carbonara.backmapTimeoutMs,
                  onStdoutLine: (l) => mfStream.write(l + '\n'),
                  onStderrLine: (l) => mfStream.write(l + '\n')
                })
              } finally {
                await new Promise<void>((r) => mfStream.end(r))
              }

              const mfDir = path.join(workDir, 'results', 'multifoxs_mixture')

              type MfState = {
                run: number
                chi2: number
                scale: number
                weights: number[]
                species: {
                  id: string
                  sub: number
                  aa_pdb: string
                  weight: number
                }[]
                fit: {
                  chi2: number
                  foxs: {
                    q: number
                    exp: number
                    model: number
                    error: number
                  }[]
                }
              }

              // Best ensemble at a given size (number of states) from
              // multi_foxs's ensembles_size_<k>.txt + its .fit curve. Collecting
              // every size shows how χ² improves as species are added.
              const buildState = async (
                size: number
              ): Promise<MfState | null> => {
                const ensFile = path.join(mfDir, `ensembles_size_${size}.txt`)
                if (!(await fs.pathExists(ensFile))) return null
                const ens = parseMultiFoxsEnsembles(
                  await fs.readFile(ensFile, 'utf8')
                )
                if (!ens) return null
                const species = ens.members
                  .map((mem) => {
                    // multi_foxs echoes back the PDB path we passed, so take the
                    // basename to recover the model id (mol{i}_sub_{j}_end).
                    const base = (mem.pdb.split('/').pop() ?? mem.pdb).replace(
                      /_AA\.pdb$/,
                      ''
                    )
                    const sm = base.match(/_sub_(\d+)/)
                    return {
                      id: base,
                      sub: sm ? Number(sm[1]) : 0,
                      aa_pdb: `all_atom/${base}/${base}_AA.pdb`,
                      weight: mem.weight
                    }
                  })
                  .sort((a, b) => a.sub - b.sub)
                let fitRows: MfState['fit']['foxs'] = []
                const fitFile = path.join(
                  mfDir,
                  `multi_state_model_${size}_1_1.fit`
                )
                if (await fs.pathExists(fitFile)) {
                  fitRows = parseMultiFoxsFit(await fs.readFile(fitFile, 'utf8'))
                }
                return {
                  run: size,
                  chi2: ens.chi2,
                  scale: 1,
                  weights: species.map((s) => s.weight),
                  species,
                  fit: { chi2: ens.chi2, foxs: fitRows }
                }
              }

              const states: MfState[] = []
              for (let size = 1; size <= nSpecies; size++) {
                const st = await buildState(size)
                if (st) states.push(st)
              }

              if (states.length > 0) {
                // Headline = the full N-species ensemble; the smaller-size
                // ensembles populate the "ensembles by size" table.
                const best =
                  states.find((s) => s.species.length === nSpecies) ??
                  states.reduce((a, b) => (b.chi2 < a.chi2 ? b : a))
                await fs.writeJson(
                  path.join(workDir, 'results', 'mixture_multifoxs.json'),
                  {
                    method: 'multi_foxs',
                    chi2: best.chi2,
                    n_species: nSpecies,
                    species: best.species,
                    fit: best.fit,
                    n_states: states.length,
                    states
                  },
                  { spaces: 2 }
                )
                await MQjob.log(
                  `carbonara mixture multi_foxs chi2=${best.chi2.toFixed(4)} (${states.length} ensemble sizes)`
                )
                logger.info(
                  `Carbonara mixture multi_foxs chi2=${best.chi2} for ${foundJob.uuid}`
                )
              }
            } else {
              logger.warn(
                `Carbonara mixture: no complete species set for multi_foxs (${foundJob.uuid})`
              )
            }
          } catch (e) {
            logger.warn(
              `Carbonara mixture multi_foxs failed (non-fatal): ${
                e instanceof Error ? e.message : String(e)
              }`
            )
          }
        }

        if (doFoxs) {
          await MQjob.log('end carbonara-scoring')
        }
      }

      await MQjob.log('end carbonara-reconstruct')
      await progress.update(98)
    } else {
      await progress.update(99)
    }

    // R1: results analysis -> results/analysis.json (for the web UI). Lenient:
    // a failure here must not fail the job (coarse + AA results are preserved).
    await MQjob.log('start carbonara-analysis')
    try {
      const analysisArgs = buildResultsContainerArgs({
        image: config.carbonara.image,
        hostDir: workDir,
        pdbFileName: foundJob.pdb_file,
        datFileName: foundJob.data_file,
        pythonBin: config.carbonara.pythonBin,
        resultsPath: config.carbonara.resultsPath,
        carbonaraRoot: config.carbonara.carbonaraRoot,
        maxQ: foundJob.max_q,
        foxsCmd: config.carbonara.foxsCmd,
        resultsMount: config.carbonara.resultsMount || undefined
      })
      const analysisRes = await runCarbonaraContainer({
        containerBin: config.carbonara.containerBin,
        args: analysisArgs,
        cwd: workDir,
        execMode: config.carbonara.exec,
        image: config.carbonara.image,
        timeoutMs: config.carbonara.backmapTimeoutMs,
        onStdoutLine: (line) => logger.debug(`carbonara-analysis: ${line}`),
        onStderrLine: (line) =>
          logger.warn(`carbonara-analysis ${foundJob.uuid}: ${line}`)
      })
      const analysisJson = path.join(workDir, 'results', 'analysis.json')
      if (await fs.pathExists(analysisJson)) {
        await MQjob.log('carbonara-analysis: analysis.json written')
        logger.info(`Carbonara analysis.json written for ${foundJob.uuid}`)
      } else {
        await MQjob.log(
          `carbonara-analysis: analysis.json not produced (exit ${analysisRes.code})`
        )
      }
    } catch (analysisErr) {
      logger.warn(
        `carbonara-analysis failed for ${foundJob.uuid}: ${
          analysisErr instanceof Error ? analysisErr.message : String(analysisErr)
        }`
      )
      await MQjob.log('carbonara-analysis: failed (non-fatal; results preserved)')
    }
    await MQjob.log('end carbonara-analysis')

    foundJob.results_ready = true
    await foundJob.save()

    await cleanupJob(MQjob, foundJob)
    await progress.update(100)
  } catch (error) {
    await handleError(error, foundJob)
  }
}

export { processBilboMDCarbonaraJob }
