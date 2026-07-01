import { useEffect, useRef, useState, createRef } from 'react'
import {
  Box,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  Button,
  CircularProgress,
  Alert
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import { useSelector } from 'react-redux'
import { axiosInstance } from 'app/api/axios'
import { selectCurrentToken } from '../../slices/authSlice'
import { createPluginUI } from 'molstar/lib/mol-plugin-ui'
import {
  DefaultPluginUISpec,
  PluginUISpec
} from 'molstar/lib/mol-plugin-ui/spec'
import { PluginLayoutControlsDisplay } from 'molstar/lib/mol-plugin/layout'
import { PluginConfig } from 'molstar/lib/mol-plugin/config'
import { renderReact18 } from 'molstar/lib/mol-plugin-ui/react18'
import { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context'
import { AnimateModelIndex } from 'molstar/lib/mol-plugin-state/animation/built-in/model-index'
import 'molstar/lib/mol-plugin-ui/skin/light.scss'

interface AutoMDSAXSTrajectoryViewerProps {
  jobId: string
  repeats: number[]
  isPublic?: boolean
  publicId?: string
}

// Per-repeat, solvent-free trajectory movie. The backend
// (/jobs/:id/automd-saxs-trajectory) concatenates the extracted frame PDBs into
// a subsampled multi-model PDB; Molstar loads it as a trajectory and the model-
// index animation cycles the frames. The repeat toggle reloads a new repeat.
const AutoMDSAXSTrajectoryViewer = ({
  jobId,
  repeats,
  isPublic,
  publicId
}: AutoMDSAXSTrajectoryViewerProps) => {
  const token = useSelector(selectCurrentToken)
  const parent = createRef<HTMLDivElement>()
  const pluginRef = useRef<PluginUIContext | null>(null)
  const hasInit = useRef(false)
  const [repeat, setRepeat] = useState<number>(repeats[0] ?? 1)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRepeat = async (rep: number) => {
    const plugin = pluginRef.current
    if (!plugin) return
    setLoading(true)
    setError(null)
    setPlaying(false)
    try {
      const url = isPublic
        ? `/public/jobs/${publicId}/automd-saxs-trajectory?repeat=${rep}`
        : `/jobs/${jobId}/automd-saxs-trajectory?repeat=${rep}`
      const headers = isPublic ? {} : { Authorization: `Bearer ${token}` }
      const response = await axiosInstance.get(url, {
        responseType: 'text',
        headers
      })

      await plugin.clear()
      const data = await plugin.builders.data.rawData({
        data: response.data,
        label: `rep${rep}`
      })
      const trajectory = await plugin.builders.structure.parseTrajectory(
        data,
        'pdb'
      )
      await plugin.builders.structure.hierarchy.applyPreset(
        trajectory,
        'default'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Could not load trajectory for repeat ${rep}: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  const togglePlay = async () => {
    const plugin = pluginRef.current
    if (!plugin) return
    if (playing) {
      await plugin.managers.animation.stop()
      setPlaying(false)
    } else {
      await plugin.managers.animation.play(AnimateModelIndex, {
        mode: { name: 'loop', params: { direction: 'forward' } },
        duration: { name: 'computed', params: { targetFps: 15 } }
      })
      setPlaying(true)
    }
  }

  // Init the plugin once, then load the first repeat.
  useEffect(() => {
    if (hasInit.current) return
    hasInit.current = true

    async function init() {
      const defaultSpec = DefaultPluginUISpec()
      const spec: PluginUISpec = {
        ...defaultSpec,
        layout: {
          initial: {
            isExpanded: false,
            showControls: false,
            controlsDisplay: 'reactive' as PluginLayoutControlsDisplay
          }
        },
        components: {
          ...defaultSpec.components,
          controls: {
            ...defaultSpec.components?.controls,
            top: 'none',
            bottom: 'none',
            left: 'none',
            right: 'none'
          },
          remoteState: 'none'
        },
        config: [
          [PluginConfig.Viewport.ShowExpand, true],
          [PluginConfig.Viewport.ShowControls, true],
          [PluginConfig.Viewport.ShowSettings, false],
          [PluginConfig.Viewport.ShowSelectionMode, false],
          [PluginConfig.Viewport.ShowAnimation, true]
        ]
      }

      const plugin = await createPluginUI({
        target: parent.current as HTMLDivElement,
        spec,
        render: renderReact18
      })
      pluginRef.current = plugin
      await loadRepeat(repeat)
    }

    void init()

    return () => {
      pluginRef.current?.dispose()
      pluginRef.current = null
      hasInit.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRepeat = (_: unknown, value: number | null) => {
    if (value == null || value === repeat) return
    setRepeat(value)
    void loadRepeat(value)
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          gap: 2,
          alignItems: 'center',
          flexWrap: 'wrap',
          mb: 1
        }}
      >
        <Typography variant="subtitle2">Trajectory movie</Typography>
        {repeats.length > 1 && (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={repeat}
            onChange={handleRepeat}
          >
            {repeats.map((r) => (
              <ToggleButton
                key={r}
                value={r}
              >
                Rep {r}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        )}
        <Button
          size="small"
          variant="contained"
          startIcon={playing ? <PauseIcon /> : <PlayArrowIcon />}
          onClick={togglePlay}
          disabled={loading}
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        {loading && <CircularProgress size={20} />}
      </Box>

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mb: 1 }}
      >
        Solvent-free, subsampled to keep the viewer responsive. Press Play to
        animate the trajectory, or use the viewport animation controls.
      </Typography>

      {error && (
        <Alert
          severity="warning"
          sx={{ mb: 1 }}
        >
          {error}
        </Alert>
      )}

      <div
        ref={parent}
        style={{ width: '100%', height: '540px', position: 'relative' }}
      />
    </Box>
  )
}

export default AutoMDSAXSTrajectoryViewer
