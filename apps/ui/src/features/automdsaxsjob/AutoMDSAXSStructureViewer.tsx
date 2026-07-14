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
// mol-script/language/builder is already used elsewhere (carbonara viewer), so it
// is a safe import here — it does NOT fragment molstar's Vite bundle the way
// mol-plugin/behavior/static/* does.
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder'
import 'molstar/lib/mol-plugin-ui/skin/light.scss'
import { classifyPdbContents, ContentCategory } from './automdsaxsContents'

interface Props {
  // Provide exactly one source: raw PDB text (client-side uploaded file) or a
  // backend URL (e.g. the prepared.pdb, fetched with the auth token).
  pdbText?: string
  url?: string
  height?: number
  // Per-residue-name keep map ("LMJ"/"CA"/"ZN"/... -> true/false). A residue
  // whose keep is false is hidden, mirroring the setup keep/strip toggles per
  // species (so LMJ toggles independently of protein caps, and CA/ZN toggle
  // independently). Omit to show everything.
  keep?: Record<string, boolean>
}

// Representation per content category. Ions are spheres a quarter of the default
// VdW size; the rest are ball-and-stick. Protein is handled separately (cartoon).
const REPRESENTATION: Record<
  ContentCategory,
  { type: string; sizeFactor?: number }
> = {
  protein: { type: 'cartoon' },
  ion: { type: 'spacefill', sizeFactor: 0.375 },
  water: { type: 'ball-and-stick' },
  agent: { type: 'ball-and-stick' },
  ligand: { type: 'ball-and-stick' }
}

// Lightweight single-structure Molstar viewer used on the setup + review pages
// (contents preview of the uploaded PDB, and the prepared structure).
const AutoMDSAXSStructureViewer = ({
  pdbText,
  url,
  height = 420,
  keep
}: Props) => {
  const token = useSelector(selectCurrentToken)
  const parent = createRef<HTMLDivElement>()
  const pluginRef = useRef<PluginUIContext | null>(null)
  const hasInit = useRef(false)
  // Per-residue-name components (transform refs), so each species can be shown or
  // hidden independently without re-parsing the structure.
  const compRefs = useRef<Record<string, { comp: string; reps: string[] }>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mirror keep/strip toggles by flipping per-species visibility via the plugin's
  // own state API (what setSubtreeVisibility does internally) — NO molstar
  // behavior/static sub-path import, which would fragment molstar's Vite bundle.
  const applyVisibility = (): void => {
    const plugin = pluginRef.current
    if (!plugin) return
    for (const [resname, r] of Object.entries(compRefs.current)) {
      const hidden = keep ? keep[resname] === false : false
      try {
        plugin.state.data.updateCellState(r.comp, { isHidden: hidden })
        for (const rep of r.reps)
          plugin.state.data.updateCellState(rep, { isHidden: hidden })
      } catch {
        // ignore a single species; others still toggle
      }
    }
  }

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

      // Build components by OUR residue classification (not Molstar's coarse
      // 'ligand'/'ion' preset components, which lump protein caps in with real
      // ligands and all ions together). Protein (incl. caps like ACE/NMA) is one
      // always-visible cartoon; each non-protein species (LMJ, CA, ZN, ...) is
      // its own toggleable component. Falls back to the default preset if this
      // renders nothing, so the viewer can never go blank.
      compRefs.current = {}
      let rendered = false
      try {
        const model = await plugin.builders.structure.createModel(trajectory)
        const structure = await plugin.builders.structure.createStructure(
          model,
          { name: 'model', params: {} }
        )
        const items = classifyPdbContents(data).filter(
          (c) => c.category !== 'protein'
        )
        const toggleResnames = items.map((c) => c.resname)
        const b = plugin.builders.structure

        // Protein + caps + terminal = everything that is NOT a toggleable
        // non-protein species -> cartoon (always shown, never toggles).
        const proteinExpr = toggleResnames.length
          ? MS.struct.generator.atomGroups({
              'residue-test': MS.core.logic.not([
                MS.core.set.has([
                  MS.set(...toggleResnames),
                  MS.ammp('auth_comp_id')
                ])
              ])
            })
          : null
        const protein = proteinExpr
          ? await b.tryCreateComponentFromExpression(
              structure,
              proteinExpr,
              'automd-protein',
              { label: 'protein' }
            )
          : await b.tryCreateComponentStatic(structure, 'polymer')
        if (protein) {
          await b.representation.addRepresentation(protein, { type: 'cartoon' })
          rendered = true
        }

        // One toggleable component per non-protein residue name.
        for (const item of items) {
          const rep = REPRESENTATION[item.category]
          const expr = MS.struct.generator.atomGroups({
            'residue-test': MS.core.rel.eq([
              MS.ammp('auth_comp_id'),
              item.resname
            ])
          })
          const comp = await b.tryCreateComponentFromExpression(
            structure,
            expr,
            `automd-${item.resname}`,
            { label: item.resname }
          )
          if (!comp) continue
          const r3d = await b.representation.addRepresentation(comp, {
            type: rep.type as 'spacefill',
            typeParams: rep.sizeFactor ? { sizeFactor: rep.sizeFactor } : {},
            color: 'element-symbol'
          })
          compRefs.current[item.resname] = {
            comp: comp.ref,
            reps: r3d?.ref ? [r3d.ref] : []
          }
          rendered = true
        }
        applyVisibility()
        plugin.managers.camera.reset()
      } catch {
        rendered = false
      }

      if (!rendered) {
        compRefs.current = {}
        await plugin.builders.structure.hierarchy.applyPreset(
          trajectory,
          'default'
        )
        plugin.managers.camera.reset()
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

  // Mirror keep/strip toggles live (no re-parse) when the keep map changes.
  useEffect(() => {
    if (pluginRef.current) applyVisibility()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(keep)])

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
