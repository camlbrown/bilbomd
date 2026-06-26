import {
  createEntityAdapter,
  createSelector,
  EntityId,
  type EntityState
} from '@reduxjs/toolkit'
import { apiSlice } from '../app/api/apiSlice'
import type { BilboMDJobDTO, JobAssetsDTO } from '@bilbomd/bilbomd-types'
import { FileCheckResult } from '../types/jobCheckResults'
import { RootState } from '../app/store'

interface FoxsData {
  [key: string]: unknown
}

interface AutoRgResponse {
  rg?: number
  rg_min?: number
  rg_max?: number
  qmin?: number
  qmax?: number
  i0?: number
  [key: string]: unknown
}

interface JobCreationResponse {
  message: string
  jobid: string
  uuid: string
  md_engine: string
  [key: string]: unknown
}

interface Af2PaeResponse {
  uuid: string
  status: string
  [key: string]: unknown
}

interface CarbonaraInitFoxsResponse {
  previewId: string
}

interface CarbonaraPreviewResult {
  status: 'pending' | 'done' | 'error'
  chi2?: number
  c1?: number
  c2?: number
  foxs?: { q: number; exp: number; model: number; error: number }[]
  message?: string
}

interface CarbonaraAutoFlexResponse {
  previewId: string
}

// B2.4: result of the Carbonara auto-flexibility prepare-step.
// flex_ranges/chain are 1-based (chain 1 = first chain); residues are PDB
// (auth) numbers, matching the manual-range convention and the 3D viewer.
export interface CarbonaraAutoFlexResult {
  status: 'pending' | 'done' | 'error'
  flex_ranges?: { chain: number; ranges: number[][] }[]
  sections?: number[]
  all_linkers?: {
    segment: number
    chain: number
    start: number
    stop: number
    selected: boolean
  }[]
  message?: string
}

interface Af2PaeStatusResponse {
  status: string
  progress?: number
  [key: string]: unknown
}

// -----------------------------------------------------------------------
// Carbonara results analysis.json contract (matches infra/carbonara/carbonara_results.py output)
// -----------------------------------------------------------------------
export interface CarbonaraAnalysisPrediction {
  id: string
  run: number
  sub: number
  aa_pdb: string // relative path under results/, e.g. "all_atom/mol1_sub_0_end/mol1_sub_0_end_AA.pdb"
  chi2: number
  rg: number
  rmsd_to_original: number
  tm_to_original: number
}

export interface CarbonaraConvergencePoint {
  step: number
  chi2: number
  penalty: number
  elapsed_min: number
}

export interface CarbonaraConvergenceRun {
  log: string
  run: number
  points: CarbonaraConvergencePoint[]
}

export interface CarbonaraHistograms {
  rmsd: { pairwise: number[]; vs_original: number[] }
  tm: { pairwise: number[]; vs_original: number[] }
  rg: { predictions: number[]; original: number }
}

export interface CarbonaraBestFit {
  chi2: number
  c1: number
  c2: number
  foxs: { q: number; exp: number; model: number; error: number }[]
}

// Live fitting progress (parsed from fitLog*.dat while the job is running).
// Shares the convergence shape with CarbonaraAnalysis so the chart is reusable.
export interface CarbonaraLiveProgress {
  status: 'running' | 'pending'
  convergence: CarbonaraConvergenceRun[]
}

// Mixture (ensemble) pseudo-MultiFoXS result. One "state" per fit run; each
// state weights its species to best fit the SAXS data.
export interface CarbonaraMixtureSpecies {
  id: string
  sub: number
  weight: number
  aa_pdb: string
  chi2: number | null
}

export interface CarbonaraMixtureState {
  run: number
  chi2: number
  scale: number
  weights: number[]
  species: CarbonaraMixtureSpecies[]
  fit: {
    chi2: number
    foxs: { q: number; exp: number; model: number; error: number }[]
  }
}

export interface CarbonaraMixture {
  n_species: number
  n_states: number
  best: CarbonaraMixtureState
  states: CarbonaraMixtureState[]
  // 'multi_foxs' = rigorous IMP MultiFoXS ensemble fit; 'estimated' = the
  // in-process weight-fit fallback.
  method?: 'multi_foxs' | 'estimated'
}

export interface CarbonaraAnalysis {
  status: 'done' | 'pending' | 'error'
  chi2_threshold: number
  n_predictions: number
  predictions: CarbonaraAnalysisPrediction[]
  convergence: CarbonaraConvergenceRun[]
  histograms: CarbonaraHistograms
  best: {
    id: string
    chi2: number
    fit: CarbonaraBestFit
  }
  mixture?: CarbonaraMixture | null
  warnings: string[]
}

const jobsAdapter = createEntityAdapter<BilboMDJobDTO>()

const initialState = jobsAdapter.getInitialState()

export const jobsApiSlice = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    getJobs: builder.query<EntityState<BilboMDJobDTO, string>, unknown>({
      query: () => ({
        url: '/jobs',
        method: 'GET'
      }),

      transformResponse: (responseData: BilboMDJobDTO[]) => {
        if (!responseData || responseData.length === 0) {
          return jobsAdapter.getInitialState()
        }

        const loadedJobs = responseData

        return jobsAdapter.setAll(initialState, loadedJobs)
      },
      providesTags: (result) =>
        result
          ? [
              { type: 'Job', id: 'LIST' },
              ...result.ids.map((id: EntityId) => ({
                type: 'Job' as const,
                id
              }))
            ]
          : [{ type: 'Job', id: 'LIST' }]
    }),
    getJobById: builder.query<BilboMDJobDTO, string>({
      query: (id) => ({
        url: `/jobs/${id}`,
        method: 'GET'
      }),
      transformResponse: (responseData: BilboMDJobDTO) => {
        return responseData
      },
      providesTags: (_, __, id) => [{ type: 'Job', id }]
    }),
    getFoxsAnalysisById: builder.query<FoxsData, string>({
      query: (id) => ({
        url: `/jobs/${id}/results/foxs`,
        method: 'GET'
      }),
      providesTags: (_, __, id) => [{ type: 'FoxsAnalysis', id }]
    }),
    addNewJob: builder.mutation<JobCreationResponse, FormData>({
      query: (newJob) => ({
        url: '/jobs',
        method: 'POST',
        body: newJob
      }),
      invalidatesTags: [{ type: 'Job', id: 'LIST' }]
    }),
    updateJob: builder.mutation<
      BilboMDJobDTO,
      Partial<BilboMDJobDTO> & { id: string }
    >({
      query: (initialJob) => ({
        url: '/jobs',
        method: 'PATCH',
        body: {
          ...initialJob
        }
      }),
      invalidatesTags: (_, __, arg) => [{ type: 'Job', id: arg.id }]
    }),
    deleteJob: builder.mutation<void, { id: string }>({
      query: ({ id }) => ({
        url: `/jobs/${id}`,
        method: 'DELETE'
      }),
      // Optimistically remove the job from the cache before the server confirms deletion.
      // If the server request fails, the rollback mechanism (patchResult.undo())
      // restores the cache to its previous state.
      async onQueryStarted({ id }, { dispatch, queryFulfilled }) {
        const patchResult = dispatch(
          jobsApiSlice.util.updateQueryData('getJobs', undefined, (draft) => {
            if ('ids' in draft && 'entities' in draft) {
              jobsAdapter.removeOne(draft, id)
            }
          })
        )
        try {
          await queryFulfilled
        } catch (error) {
          console.error('Error occurred during job deletion:', error)
          patchResult.undo()
        }
      },
      invalidatesTags: (_, __, arg) => [{ type: 'Job', id: arg.id }]
    }),
    checkJobFiles: builder.query<FileCheckResult, string>({
      query: (id: string) => ({
        url: `/jobs/${id}/check-files`,
        method: 'GET'
      })
    }),
    calculateAutoRg: builder.mutation<AutoRgResponse, FormData>({
      query: (formData) => ({
        url: '/autorg',
        method: 'POST',
        body: formData
      })
    }),
    addNewAutoJob: builder.mutation<JobCreationResponse, FormData>({
      query: (newJob) => ({
        url: '/jobs/bilbomd-auto',
        method: 'POST',
        body: newJob
      }),
      invalidatesTags: [{ type: 'Job', id: 'LIST' }]
    }),
    addNewAlphaFoldJob: builder.mutation<JobCreationResponse, FormData>({
      query: (newJob) => ({
        url: '/jobs/bilbomd-alphafold',
        method: 'POST',
        body: newJob
      }),
      invalidatesTags: [{ type: 'Job', id: 'LIST' }]
    }),
    addNewOpenFoldJob: builder.mutation<JobCreationResponse, FormData>({
      query: (newJob) => ({
        url: '/jobs/bilbomd-openfold',
        method: 'POST',
        body: newJob
      }),
      invalidatesTags: [{ type: 'Job', id: 'LIST' }]
    }),
    addNewSANSJob: builder.mutation<JobCreationResponse, FormData>({
      query: (newJob) => ({
        url: '/jobs/bilbomd-sans',
        method: 'POST',
        body: newJob
      }),
      invalidatesTags: [{ type: 'Job', id: 'LIST' }]
    }),
    addNewScoperJob: builder.mutation<JobCreationResponse, FormData>({
      query: (newJob) => ({
        url: '/jobs/bilbomd-scoper',
        method: 'POST',
        body: newJob
      }),
      invalidatesTags: [{ type: 'Job', id: 'LIST' }]
    }),
    addNewCarbonaraJob: builder.mutation<JobCreationResponse, FormData>({
      query: (newJob) => ({
        url: '/jobs/bilbomd-carbonara',
        method: 'POST',
        body: newJob
      }),
      invalidatesTags: [{ type: 'Job', id: 'LIST' }]
    }),
    addNewMultiJob: builder.mutation<JobCreationResponse, FormData>({
      query: (newJob) => ({
        url: '/jobs/bilbomd-multi',
        method: 'POST',
        body: newJob
      }),
      invalidatesTags: [{ type: 'Job', id: 'LIST' }]
    }),
    af2PaeJiffy: builder.mutation<Af2PaeResponse, FormData>({
      query: (formData) => ({
        url: '/af2pae',
        method: 'POST',
        body: formData
      })
    }),
    getAf2PaeConstFile: builder.query<string, string>({
      query: (uuid) => ({
        url: `af2pae?uuid=${uuid}`,
        method: 'GET',
        responseHandler: 'text'
      }),
      transformResponse(baseQueryReturnValue: string) {
        return baseQueryReturnValue
      }
    }),
    getAf2PaeStatus: builder.query<Af2PaeStatusResponse, string>({
      query: (uuid) => ({
        url: `/af2pae/status?uuid=${uuid}`,
        method: 'GET'
      })
    }),
    getFileByIdAndName: builder.query<string, { id: string; filename: string }>(
      {
        query: ({ id, filename }) => ({
          url: `/jobs/${id}/${filename}`,
          method: 'GET',
          responseHandler: (response) => response.blob()
        }),
        async transformResponse(baseQueryReturnValue: Blob) {
          const text = await baseQueryReturnValue.text()
          return text
        }
      }
    ),
    getMDMovies: builder.query<JobAssetsDTO, string>({
      query: (id) => ({ url: `/jobs/${id}/movies`, method: 'GET' }),
      providesTags: (_, __, id) => [{ type: 'MovieAsset', id }]
    }),
    // B5: Carbonara initial scattering check (preview mini-pipeline)
    addCarbonaraInitFoxs: builder.mutation<CarbonaraInitFoxsResponse, FormData>({
      query: (formData) => ({
        url: '/jobs/carbonara-initfoxs',
        method: 'POST',
        body: formData
      })
    }),
    getCarbonaraInitFoxs: builder.query<CarbonaraPreviewResult, string>({
      query: (previewId) => ({
        url: `/jobs/carbonara-initfoxs/${previewId}`,
        method: 'GET'
      })
    }),
    // B2.4: Carbonara auto-flexibility prepare-step (preview mini-pipeline)
    addCarbonaraAutoFlex: builder.mutation<CarbonaraAutoFlexResponse, FormData>({
      query: (formData) => ({
        url: '/jobs/carbonara-autoflex',
        method: 'POST',
        body: formData
      })
    }),
    getCarbonaraAutoFlex: builder.query<CarbonaraAutoFlexResult, string>({
      query: (previewId) => ({
        url: `/jobs/carbonara-autoflex/${previewId}`,
        method: 'GET'
      })
    }),
    // Carbonara results: fetch analysis.json for a completed job
    getCarbonaraAnalysis: builder.query<CarbonaraAnalysis, string>({
      query: (jobId) => ({
        url: `/jobs/${jobId}/carbonara-analysis`,
        method: 'GET'
      }),
      providesTags: (_, __, id) => [{ type: 'Job', id }]
    }),
    // Carbonara results: fetch a single AA PDB text for the 3D viewer
    getCarbonaraAaPdb: builder.query<
      string,
      { jobId: string; pdbPath: string }
    >({
      query: ({ jobId, pdbPath }) => ({
        url: `/jobs/${jobId}/carbonara-aa-pdb?pdbPath=${encodeURIComponent(pdbPath)}`,
        method: 'GET',
        responseHandler: (response) => response.text()
      })
    }),
    // Carbonara results: fetch the original uploaded structure text, for the
    // 3D viewer's "overlay original" comparison
    getCarbonaraOriginalPdb: builder.query<string, string>({
      query: (jobId) => ({
        url: `/jobs/${jobId}/carbonara-original-pdb`,
        method: 'GET',
        responseHandler: (response) => response.text()
      })
    }),
    // Mixture: fetch the original uploaded structure a given species derived
    // from (sub 0 = primary pdb_file, sub i = mixture_pdb_files[i-1]).
    getCarbonaraOriginalPdbBySub: builder.query<
      string,
      { jobId: string; sub: number }
    >({
      query: ({ jobId, sub }) => ({
        url: `/jobs/${jobId}/carbonara-original-pdb?sub=${sub}`,
        method: 'GET',
        responseHandler: (response) => response.text()
      })
    }),
    // Carbonara: live fitting convergence (chi² per step, per run) while running
    getCarbonaraLiveProgress: builder.query<CarbonaraLiveProgress, string>({
      query: (jobId) => ({
        url: `/jobs/${jobId}/carbonara-live-progress`,
        method: 'GET'
      })
    })
  })
})

export const {
  useGetJobsQuery,
  useGetJobByIdQuery,
  useGetFoxsAnalysisByIdQuery,
  useAddNewJobMutation,
  useUpdateJobMutation,
  useDeleteJobMutation,
  useCheckJobFilesQuery,
  useCalculateAutoRgMutation,
  useAddNewAutoJobMutation,
  useAddNewAlphaFoldJobMutation,
  useAddNewOpenFoldJobMutation,
  useAddNewSANSJobMutation,
  useAddNewScoperJobMutation,
  useAddNewCarbonaraJobMutation,
  useAddNewMultiJobMutation,
  useAf2PaeJiffyMutation,
  useGetAf2PaeConstFileQuery,
  useGetAf2PaeStatusQuery,
  useGetFileByIdAndNameQuery,
  useLazyGetFileByIdAndNameQuery,
  useGetMDMoviesQuery,
  useAddCarbonaraInitFoxsMutation,
  useLazyGetCarbonaraInitFoxsQuery,
  useAddCarbonaraAutoFlexMutation,
  useLazyGetCarbonaraAutoFlexQuery,
  useGetCarbonaraAnalysisQuery,
  useLazyGetCarbonaraAaPdbQuery,
  useLazyGetCarbonaraOriginalPdbQuery,
  useLazyGetCarbonaraOriginalPdbBySubQuery,
  useGetCarbonaraLiveProgressQuery
} = jobsApiSlice

// Select the query result object from the cache
export const selectJobsResult =
  jobsApiSlice.endpoints.getJobs.select('jobsList')

// Memoized selector to get the normalized jobs data (if available)
const selectJobsData = createSelector(
  selectJobsResult,
  (jobsResult) => jobsResult.data ?? initialState
)

// Export selectors for use in components
export const {
  selectAll: selectAllJobs,
  selectById: selectJobById,
  selectIds: selectJobIds
} = jobsAdapter.getSelectors<RootState>((state) => selectJobsData(state))
