import { useEffect, useRef, useState, createRef } from 'react'
import { Box, CircularProgress, Alert } from '@mui/material'
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
import 'molstar/lib/mol-plugin-ui/skin/light.scss'

interface Props {
  // Provide exactly one source: raw PDB text (client-side uploaded file) or a
  // backend URL (e.g. the prepared.pdb, fetched with the auth token).
  pdbText?: string
  url?: string
  height?: number
}

// Lightweight single-structure Molstar viewer used on the setup + review pages
// (contents preview of the uploaded PDB, and the prepared structure).
const AutoMDSAXSStructureViewer = ({ pdbText, url, height = 420 }: Props) => {
  const token = useSelector(selectCurrentToken)
  const parent = createRef<HTMLDivElement>()
  const pluginRef = useRef<PluginUIContext | null>(null)
  const hasInit = useRef(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const plugin = pluginRef.current
    if (!plugin) return
    setLoading(true)
    setError(null)
    try {
      let data = pdbText
      if (!data && url) {
        const headers = { Authorization: `Bearer ${token}` }
        const response = await axiosInstance.get(url, {
          responseType: 'text',
          headers
        })
        data = response.data as string
      }
      if (!data) {
        setError('No structure to display.')
        return
      }
      await plugin.clear()
      const raw = await plugin.builders.data.rawData({ data, label: 'structure' })
      const trajectory = await plugin.builders.structure.parseTrajectory(raw, 'pdb')
      await plugin.builders.structure.hierarchy.applyPreset(trajectory, 'default')

      // Enlarge ions: after the default preset renders, add a spacefill sphere
      // to the ion component so bound ions read as large spheres (the default
      // preset draws them as small ball-and-stick). Uses only the plugin API —
      // NO molstar sub-path imports (importing e.g. mol-plugin/behavior/static/*
      // fragments molstar's Vite optimization and breaks plugin init). Wrapped so
      // it can never prevent the base render.
      try {
        const struct =
          plugin.managers.structure.hierarchy.current.structures[0]
        for (const comp of struct?.components ?? []) {
          const params = comp.cell.transform.params as
            | { type?: { params?: unknown } }
            | undefined
          if (params?.type?.params === 'ion') {
            await plugin.builders.structure.representation.addRepresentation(
              comp.cell,
              {
                type: 'spacefill',
                typeParams: { sizeFactor: 0.375 },
                color: 'element-symbol'
              }
            )
          }
        }
      } catch {
        // ion styling is optional; the default preset render stands
      }
    } catch (err) {
      setError(
        `Could not display the structure: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    } finally {
      setLoading(false)
    }
  }

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
          [PluginConfig.Viewport.ShowAnimation, false]
        ]
      }
      const plugin = await createPluginUI({
        target: parent.current as HTMLDivElement,
        spec,
        render: renderReact18
      })
      pluginRef.current = plugin
      await load()
    }
    void init()
    return () => {
      pluginRef.current?.dispose()
      pluginRef.current = null
      hasInit.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload when the source changes (new file selected / prepared structure).
  useEffect(() => {
    if (pluginRef.current) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdbText, url])

  return (
    <Box>
      {loading && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <CircularProgress size={16} />
        </Box>
      )}
      {error && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      <div
        ref={parent}
        style={{ width: '100%', height: `${height}px`, position: 'relative' }}
      />
    </Box>
  )
}

export default AutoMDSAXSStructureViewer
