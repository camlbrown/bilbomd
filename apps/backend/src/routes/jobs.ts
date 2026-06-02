import express from 'express'
import {
  getAllJobs,
  getJobById,
  createNewJob,
  deleteJob,
  downloadJobResults,
  getLogForStep
} from '../controllers/jobs/index.js'
import { createSANSJob } from '../controllers/jobs/sansJobController.js'
import { createCarbonaraJob } from '../controllers/jobs/carbonaraJobController.js'
import {
  createCarbonaraInitFoxs,
  getCarbonaraInitFoxs
} from '../controllers/jobs/carbonaraInitFoxsController.js'
import {
  createCarbonaraAutoFlex,
  getCarbonaraAutoFlex
} from '../controllers/jobs/carbonaraAutoFlexController.js'
import { createNewMultiJob } from '../controllers/jobs/multiMdController.js'
import { downloadPDB, getFoxsData } from '../controllers/foxsController.js'
import { getFile } from '../controllers/fileDownloadController.js'
import getMovies from '../controllers/movies/getMovies.js'
import streamVideo from '../controllers/movies/streamVideo.js'
import { checkFiles } from '../controllers/resubmitController.js'
import { verifyJWT } from '../middleware/verifyJWT.js'
import { setVideoSession, verifyVideoSession } from '../middleware/videoAuth.js'
import { logger } from '../middleware/loggers.js'
const router = express.Router()

// Most routes use JWT authentication + set video session
router.use((req, res, next) => {
  // Skip JWT for video streaming route, use session auth instead
  if (req.path.match(/\/[^/]+\/movies\/[^/]+\/[^/]+$/)) {
    return next()
  }
  // All other routes use JWT + set video session
  verifyJWT(req, res, (err) => {
    if (err) {
      logger.error(`JWT verification failed: ${err}`)
      return next(err)
    }
    logger.debug(`JWT verified, req.user: ${req.user}`)
    setVideoSession(req, res, next)
  })
})

router.route('/').get(getAllJobs).post(createNewJob)

// B5: Carbonara initial scattering check (preview queue — no Mongo model).
// MUST be registered before the generic '/:id' and '/:id/:filename' routes,
// otherwise GET /carbonara-initfoxs/:id is shadowed by '/:id/:filename'.
router.route('/carbonara-initfoxs').post(createCarbonaraInitFoxs)
router.route('/carbonara-initfoxs/:id').get(getCarbonaraInitFoxs)

// B2.4: Carbonara auto-flexibility prepare-step (preview queue — no Mongo model).
// MUST be registered before the generic '/:id' and '/:id/:filename' routes.
router.route('/carbonara-autoflex').post(createCarbonaraAutoFlex)
router.route('/carbonara-autoflex/:id').get(getCarbonaraAutoFlex)

router.route('/:id').get(getJobById)
router.route('/:id').delete(deleteJob)
router.route('/:id/results').get(downloadJobResults)
router.route('/:id/results/foxs').get(getFoxsData)
router.route('/:id/results/:pdb').get(downloadPDB)
router.route('/:id/logs').get(getLogForStep)
router.route('/:id/check-files').get(checkFiles)
router.route('/:id/movies').get(getMovies)
router
  .route('/:id/movies/:label/:filename')
  .get(verifyVideoSession, streamVideo)
router.route('/:id/:filename').get(getFile)
router.route('/bilbomd-auto').post(createNewJob)
router.route('/bilbomd-scoper').post(createNewJob)
router.route('/bilbomd-alphafold').post(createNewJob)
router.route('/bilbomd-openfold').post(createNewJob)
router.route('/bilbomd-sans').post(createSANSJob)
router.route('/bilbomd-carbonara').post(createCarbonaraJob)
router.route('/bilbomd-multi').post(createNewMultiJob)

export default router
