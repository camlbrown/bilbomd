import { useEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { createPluginUI } from 'molstar/lib/mol-plugin-ui'
import { renderReact18 } from 'molstar/lib/mol-plugin-ui/react18'
import { DefaultPluginUISpec } from 'molstar/lib/mol-plugin-ui/spec'
import { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context'
import { PluginConfig } from 'molstar/lib/mol-plugin/config'
import { BuiltInTrajectoryFormat } from 'molstar/lib/mol-plugin-state/formats/trajectory'
import {
  setStructureOverpaint,
  clearStructureOverpaint
} from 'molstar/lib/mol-plugin-state/helpers/structure-overpaint'
import {
  setStructureTransparency,
  clearStructureTransparency
} from 'molstar/lib/mol-plugin-state/helpers/structure-transparency'
import { Script } from 'molstar/lib/mol-script/script'
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder'
import { compile } from 'molstar/lib/mol-script/runtime/query/compiler'
import {
  QueryContext,
  Structure,
  StructureElement,
  StructureProperties,
  StructureSelection
} from 'molstar/lib/mol-model/structure'
import { alignAndSuperpose } from 'molstar/lib/mol-model/structure/structure/util/superposition'
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms'
import { Color } from 'molstar/lib/mol-util/color'
import { chainColor } from 'features/carbonarajob/carbonaraChainPalette'
import 'molstar/lib/mol-plugin-ui/skin/light.scss'

// A flexible residue segment to highlight in the viewer.
// chain is 1-based (chain 1 = first chain in the structure), matching the
// Carbonara/manual-range convention used elsewhere in the form. start/stop are
// inclusive PDB (auth) residue numbers.
export interface FlexSegment {
  chain: number
  start: number
  stop: number
}

// A distance-constraint pair to draw as a dashed line in the viewer.
// chain1/chain2 are auth_asym_id letters; res1/res2 are PDB (auth) residue
// numbers. The line connects the two Cα atoms.
export interface ViewerConstraint {
  chain1: string
  res1: number
  chain2: string
  res2: number
}

interface CarbonaraStructureViewerProps {
  // The uploaded structure file (a Formik File value) or raw structure text.
  structureFile?: File | string
  // Optional raw PDB text of the ORIGINAL input structure. When provided it is
  // loaded as a second structure, superposed onto structureFile, and rendered
  // as a semi-transparent grey "ghost" so the user can see how much the
  // structure changed during refinement.
  overlayStructure?: string
  // Segments to colour yellow as "flexible".
  flexSegments?: FlexSegment[]
  // Chain identifiers (auth_asym_id) to hide in the viewer.
  hiddenChains?: string[]
  // Distance-constraint pairs to draw as dashed lines between Cα atoms.
  constraints?: ViewerConstraint[]
  // Optional per-chain colour override (auth_asym_id -> hex). When set, a chain
  // is painted this colour instead of the default palette — used to give merged
  // subunits a shared colour.
  chainColors?: Record<string, string>
  // Reports the structure's chain identifiers (auth_asym_id) in document order
  // once a structure has loaded, so the form can build chain controls.
  onChainsDetected?: (chains: string[]) => void
  // Reports how many constraint pairs were actually located + drawn (so the form
  // can flag pairs whose residue/chain weren't found in the structure).
  onConstraintsDrawn?: (drawn: number) => void
  height?: number
}

// Carbonara flexible-region colour (yellow), kept distinct from the blue/orange
// domain colours used by the results-page MDConstraints viewer.
const FLEX_COLOR = Color(0xfadb14)

// Original-structure overlay: a muted grey ghost rendered behind the
// colour-coded prediction. transparency is 0 (opaque) .. 1 (invisible).
const OVERLAY_COLOR = Color(0x9e9e9e)
const OVERLAY_TRANSPARENCY = 0.6

// Build a Mol* selection expression for one inclusive residue range on one chain.
const segmentExpression = (chainId: string, start: number, stop: number) =>
  MS.struct.generator.atomGroups({
    'chain-test': MS.core.rel.eq([MS.ammp('auth_asym_id'), chainId]),
    'residue-test': MS.core.logic.and([
      MS.core.rel.gre([MS.ammp('auth_seq_id'), start]),
      MS.core.rel.lte([MS.ammp('auth_seq_id'), stop])
    ])
  })

// Build a Mol* selection expression for whole chains.
const chainsExpression = (chainIds: string[]) =>
  MS.struct.generator.atomGroups({
    'chain-test': MS.core.set.has([
      MS.set(...chainIds),
      MS.ammp('auth_asym_id')
    ])
  })

const CHAIN_LETTERS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// Some PDBs (e.g. cg2all output) leave the chain-ID column (col 22) blank and
// mark chains only with TER records — exactly how Carbonara splits chains
// (topology.chains). Mol* would then see one chain. When chain IDs are missing
// we assign A, B, C… per TER block so the viewer's chains match Carbonara's
// numbering (chain 1 = first TER block = 'A'), preserving residue numbers.
const assignChainsByTer = (
  pdbText: string
): { text: string; assigned: boolean; nChains: number } => {
  const lines = pdbText.split(/\r?\n/)
  const hasChainId = lines.some(
    (l) => /^(ATOM|HETATM)/.test(l) && l.length > 21 && l[21]!.trim() !== ''
  )
  if (hasChainId) return { text: pdbText, assigned: false, nChains: 0 }

  let ci = 0
  const used = new Set<number>()
  const out = lines.map((l) => {
    if (/^(ATOM|HETATM)/.test(l)) {
      const idx = Math.min(ci, CHAIN_LETTERS.length - 1)
      used.add(idx)
      const padded = l.length < 22 ? l.padEnd(22, ' ') : l
      return padded.slice(0, 21) + CHAIN_LETTERS[idx]! + padded.slice(22)
    }
    if (/^TER/.test(l)) {
      ci += 1
      return l
    }
    return l
  })
  return { text: out.join('\n'), assigned: true, nChains: used.size }
}

// Enumerate the structure's chains (auth_asym_id) in document order.
const detectChains = (structure: Structure): string[] => {
  const seen = new Set<string>()
  const ordered: string[] = []
  const loc = StructureElement.Location.create(structure)
  for (const unit of structure.units) {
    if (unit.elements.length === 0) continue
    loc.unit = unit
    loc.element = unit.elements[0]!
    const id = StructureProperties.chain.auth_asym_id(loc)
    if (!seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }
  return ordered
}

// Cα selection used to superpose the overlay onto the prediction.
const caExpression = MS.struct.generator.atomGroups({
  'atom-test': MS.core.rel.eq([MS.ammp('label_atom_id'), 'CA'])
})

// Whole-structure loci getter, for painting/relucenting the overlay uniformly.
const allAtomsLoci = async (structure: Structure) => {
  const sel = Script.getStructureSelection(MS.struct.generator.all(), structure)
  return StructureSelection.toLociWithSourceUnits(sel)
}

// Load the original input structure as a second structure, superpose it onto
// the already-loaded prediction (structures[0]) by a Cα sequence alignment, and
// render it as a uniform-grey, semi-transparent "ghost". Failures are
// swallowed (logged) so a bad overlay never breaks the prediction view.
const loadOverlay = async (plugin: PluginUIContext, text: string) => {
  if (!text.trim()) return
  // The original input can be a PDB or an mmCIF (e.g. an AlphaFold .cif). Detect
  // the format from the content — an mmCIF has a `data_` header / `_atom_site.`
  // loop — since a CIF parsed as 'pdb' silently yields no overlay.
  const isCif = /^\s*data_/m.test(text) || text.includes('_atom_site.')
  const format: BuiltInTrajectoryFormat = isCif ? 'mmcif' : 'pdb'
  // TER-based chain assignment is PDB-only; leave CIF text untouched.
  const payload = isCif ? text : assignChainsByTer(text).text
  const data = await plugin.builders.data.rawData({
    data: payload,
    label: 'original (input)'
  })
  const trajectory = await plugin.builders.structure.parseTrajectory(
    data,
    format
  )
  await plugin.builders.structure.hierarchy.applyPreset(trajectory, 'default')

  const structures = plugin.managers.structure.hierarchy.current.structures
  if (structures.length < 2) return
  const mainRef = structures[0]
  const overlayRef = structures[structures.length - 1]
  const mainData = mainRef?.cell.obj?.data
  const overlayData = overlayRef?.cell.obj?.data
  if (!mainRef || !overlayRef || !mainData || !overlayData) return

  // Superpose: compute the rigid transform that best fits the overlay's Cα
  // atoms onto the prediction's, then bake it into the overlay structure.
  try {
    const query = compile<StructureSelection>(caExpression)
    const mainLoci = StructureSelection.toLociWithCurrentUnits(
      query(new QueryContext(mainData))
    )
    const overlayLoci = StructureSelection.toLociWithCurrentUnits(
      query(new QueryContext(overlayData))
    )
    const [result] = alignAndSuperpose([mainLoci, overlayLoci])
    if (result?.bTransform) {
      const b = plugin.state.data
        .build()
        .to(overlayRef.cell)
        .insert(StateTransforms.Model.TransformStructureConformation, {
          transform: {
            name: 'matrix',
            params: { data: result.bTransform, transpose: false }
          }
        })
      await plugin.runTask(plugin.state.data.updateTree(b))
    }
  } catch (err) {
    console.warn('Carbonara overlay superposition failed:', err)
  }

  // Paint the overlay uniform grey and make it semi-transparent so the
  // colour-coded prediction reads as the "main" structure on top of it.
  const components = overlayRef.components
  if (components.length > 0) {
    await setStructureOverpaint(plugin, components, OVERLAY_COLOR, allAtomsLoci, [
      'cartoon'
    ])
    await setStructureTransparency(
      plugin,
      components,
      OVERLAY_TRANSPARENCY,
      allAtomsLoci,
      ['cartoon']
    )
  }

  // Re-fit the camera so both structures are framed once the overlay has moved.
  plugin.managers.camera.reset()
}

const CarbonaraStructureViewer = ({
  structureFile,
  overlayStructure,
  flexSegments = [],
  hiddenChains = [],
  constraints = [],
  chainColors,
  onChainsDetected,
  onConstraintsDrawn,
  height = 460
}: CarbonaraStructureViewerProps) => {
  const parentRef = useRef<HTMLDivElement>(null)
  const pluginRef = useRef<PluginUIContext | null>(null)
  const chainOrderRef = useRef<string[]>([])
  // State refs of the distance-measurement objects we created, so we can remove
  // them before re-drawing when the constraints change.
  const measurementRefsRef = useRef<string[]>([])
  const [pluginReady, setPluginReady] = useState(false)
  const [structureLoaded, setStructureLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when chain IDs were missing and we auto-assigned them from TER breaks.
  const [autoAssigned, setAutoAssigned] = useState(0)

  // Create one dedicated Mol* plugin instance for this viewer. It is kept on a
  // ref (NOT window.molstar) so it never clashes with the results-page viewer.
  useEffect(() => {
    let disposed = false
    const init = async () => {
      if (!parentRef.current) return
      const spec = DefaultPluginUISpec()
      spec.layout = {
        initial: {
          isExpanded: false,
          showControls: false,
          controlsDisplay: 'reactive'
        }
      }
      spec.config = [
        [PluginConfig.Viewport.ShowExpand, true],
        [PluginConfig.Viewport.ShowControls, true],
        [PluginConfig.Viewport.ShowSettings, false],
        [PluginConfig.Viewport.ShowSelectionMode, false],
        [PluginConfig.Viewport.ShowAnimation, false]
      ]
      const plugin = await createPluginUI({
        target: parentRef.current,
        spec,
        render: renderReact18
      })
      if (disposed) {
        plugin.dispose()
        return
      }
      pluginRef.current = plugin
      setPluginReady(true)
    }
    void init()
    return () => {
      disposed = true
      pluginRef.current?.dispose()
      pluginRef.current = null
      setPluginReady(false)
      setStructureLoaded(false)
    }
  }, [])

  // (Re)load the structure whenever the uploaded file changes.
  useEffect(() => {
    const plugin = pluginRef.current
    if (!plugin || !pluginReady) return
    let cancelled = false

    const load = async () => {
      setError(null)
      setStructureLoaded(false)
      setAutoAssigned(0)
      await plugin.clear()
      chainOrderRef.current = []
      measurementRefsRef.current = []
      if (!structureFile) return

      try {
        const isFile = structureFile instanceof File
        const fileName = isFile ? structureFile.name : 'structure'
        let text = isFile
          ? await structureFile.text()
          : (structureFile as string)
        if (!text || !text.trim()) return
        const format: BuiltInTrajectoryFormat = fileName
          .toLowerCase()
          .endsWith('.cif')
          ? 'mmcif'
          : 'pdb'

        // PDBs with no chain-ID column: assign chains from TER breaks so the
        // viewer matches Carbonara's TER-based chain numbering.
        if (format === 'pdb') {
          const r = assignChainsByTer(text)
          text = r.text
          if (r.assigned && r.nChains > 1) setAutoAssigned(r.nChains)
        }

        const data = await plugin.builders.data.rawData({
          data: text,
          label: fileName
        })
        const trajectory = await plugin.builders.structure.parseTrajectory(
          data,
          format
        )
        // The built-in 'default' preset reliably builds the representations AND
        // focuses the camera on the structure. Chain hide/show and the flexible
        // highlight are then layered on via transparency/overpaint, which act on
        // the preset's components without rebuilding them.
        await plugin.builders.structure.hierarchy.applyPreset(
          trajectory,
          'default'
        )
        if (cancelled) return

        const structure =
          plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj
            ?.data
        chainOrderRef.current = structure ? detectChains(structure) : []
        onChainsDetected?.(chainOrderRef.current)

        // Load the original-input overlay BEFORE flagging the structure as
        // loaded, so the chain-colour / flex / constraint effects (which key off
        // structureLoaded and only touch structures[0]) run after the second
        // structure is fully in place — avoiding concurrent state edits.
        if (overlayStructure) {
          await loadOverlay(plugin, overlayStructure)
          if (cancelled) return
        }

        setStructureLoaded(true)
      } catch (err) {
        console.error('Carbonara viewer failed to load structure:', err)
        if (!cancelled) setError('Could not render this structure.')
      }
    }

    void load()
    return () => {
      cancelled = true
    }
    // onChainsDetected intentionally omitted: callers pass a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureFile, overlayStructure, pluginReady])

  // Colour each chain with its palette colour, then paint the flexible segments
  // yellow on top. Re-runs whenever the flexible selection changes. Done in one
  // effect because clearing overpaint wipes everything, so chain colours and the
  // yellow highlight must be re-applied together.
  useEffect(() => {
    const plugin = pluginRef.current
    if (!plugin || !structureLoaded) return
    let cancelled = false

    const overpaintLoci =
      (expr: ReturnType<typeof MS.struct.combinator.merge>) =>
      async (structure: Structure) => {
        const sel = Script.getStructureSelection(expr, structure)
        return StructureSelection.toLociWithSourceUnits(sel)
      }

    const paint = async () => {
      const structureRef =
        plugin.managers.structure.hierarchy.current.structures[0]
      if (!structureRef) return
      const components = structureRef.components
      if (components.length === 0) return

      await clearStructureOverpaint(plugin, components, ['cartoon'])
      if (cancelled) return

      // Base colour per chain (matches the form's chain chips). A chainColors
      // override (e.g. merged-subunit colours) takes precedence over the palette.
      const order = chainOrderRef.current
      for (let i = 0; i < order.length; i++) {
        const id = order[i]!
        const hex = chainColors?.[id]
        const col = hex
          ? Color(Number.parseInt(hex.replace('#', ''), 16))
          : chainColor(i)
        await setStructureOverpaint(
          plugin,
          components,
          col,
          overpaintLoci(chainsExpression([id])),
          ['cartoon']
        )
        if (cancelled) return
      }

      // Flexible segments yellow, applied last so they win over the chain
      // colour on the residues they cover. ALL valid segments are merged into
      // one loci (combinator.merge — modifier.union only keeps the first).
      const exprs = flexSegments
        .filter(
          (s) =>
            s.chain >= 1 &&
            s.chain <= order.length &&
            Number.isFinite(s.start) &&
            Number.isFinite(s.stop) &&
            s.stop >= s.start
        )
        .map((s) => segmentExpression(order[s.chain - 1]!, s.start, s.stop))
      if (exprs.length === 0) return

      await setStructureOverpaint(
        plugin,
        components,
        FLEX_COLOR,
        overpaintLoci(MS.struct.combinator.merge(exprs)),
        ['cartoon']
      )
    }

    void paint()
    return () => {
      cancelled = true
    }
  }, [flexSegments, structureLoaded, chainColors])

  // Show/hide chains by making hidden chains fully transparent (works on the
  // preset's cartoon component — no per-chain rebuild needed).
  useEffect(() => {
    const plugin = pluginRef.current
    if (!plugin || !structureLoaded) return
    let cancelled = false

    const apply = async () => {
      const structureRef =
        plugin.managers.structure.hierarchy.current.structures[0]
      if (!structureRef) return
      const components = structureRef.components
      if (components.length === 0) return

      await clearStructureTransparency(plugin, components, ['cartoon'])
      if (cancelled) return

      const order = chainOrderRef.current
      const hidden = hiddenChains.filter((c) => order.includes(c))
      if (hidden.length === 0) return

      const expr = chainsExpression(hidden)
      await setStructureTransparency(
        plugin,
        components,
        1,
        async (structure: Structure) => {
          const sel = Script.getStructureSelection(expr, structure)
          return StructureSelection.toLociWithSourceUnits(sel)
        },
        ['cartoon']
      )
    }

    void apply()
    return () => {
      cancelled = true
    }
  }, [hiddenChains, structureLoaded])

  // Draw a dashed distance line (+ measured-distance label) between the Cα atoms
  // of each constraint pair. Re-runs when the constraints change.
  useEffect(() => {
    const plugin = pluginRef.current
    if (!plugin || !structureLoaded) return
    let cancelled = false

    const caLoci = (structure: Structure, chain: string, res: number) => {
      const expr = MS.struct.generator.atomGroups({
        'chain-test': MS.core.rel.eq([MS.ammp('auth_asym_id'), chain]),
        'residue-test': MS.core.rel.eq([MS.ammp('auth_seq_id'), res]),
        'atom-test': MS.core.rel.eq([MS.ammp('label_atom_id'), 'CA'])
      })
      const sel = Script.getStructureSelection(expr, structure)
      return StructureSelection.toLociWithSourceUnits(sel)
    }

    const apply = async () => {
      // Remove previously drawn measurement lines.
      if (measurementRefsRef.current.length > 0) {
        const b = plugin.state.data.build()
        for (const ref of measurementRefsRef.current) {
          try {
            b.delete(ref)
          } catch {
            // already gone
          }
        }
        await b.commit()
        measurementRefsRef.current = []
      }
      if (cancelled || constraints.length === 0) {
        onConstraintsDrawn?.(0)
        return
      }

      const structure =
        plugin.managers.structure.hierarchy.current.structures[0]?.cell.obj
          ?.data
      if (!structure) return

      let drawn = 0
      for (const c of constraints) {
        const a = caLoci(structure, c.chain1, c.res1)
        const d = caLoci(structure, c.chain2, c.res2)
        if (a.elements.length === 0 || d.elements.length === 0) continue
        const result =
          await plugin.managers.structure.measurement.addDistance(a, d, {
            // 4× the default line thickness (0.075) and 10× the default label
            // size (0.33) so constraints read clearly in the viewer.
            visualParams: { linesSize: 0.3, textSize: 3.3 }
          })
        if (cancelled) return
        if (result?.selection?.ref) {
          measurementRefsRef.current.push(result.selection.ref)
        }
        drawn += 1
      }
      onConstraintsDrawn?.(drawn)
    }

    void apply()
    return () => {
      cancelled = true
    }
    // onConstraintsDrawn intentionally omitted: callers pass a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constraints, structureLoaded])

  return (
    <Box>
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          height: `${height}px`,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden'
        }}
      >
        <div
          ref={parentRef}
          style={{ position: 'absolute', inset: 0 }}
        />
        {!structureFile && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'text.secondary',
              pointerEvents: 'none'
            }}
          >
            <Typography variant="body2">
              Upload a structure in Block 1 to explore it here.
            </Typography>
          </Box>
        )}
      </Box>
      {error && (
        <Typography
          variant="caption"
          color="error"
          sx={{ mt: 0.5, display: 'block' }}
        >
          {error}
        </Typography>
      )}
      {autoAssigned > 0 && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mt: 0.5, display: 'block' }}
        >
          No chain IDs were found in this file — {autoAssigned} chains were
          auto-assigned (A, B, …) from chain breaks (TER records), matching how
          Carbonara identifies chains.
        </Typography>
      )}
    </Box>
  )
}

export default CarbonaraStructureViewer
