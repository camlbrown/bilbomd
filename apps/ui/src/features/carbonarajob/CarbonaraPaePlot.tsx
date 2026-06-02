import { useEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'

// Lightweight client-side PAE (Predicted Aligned Error) heatmap with labelled
// axes and a colour-bar key. Reads the uploaded AlphaFold PAE JSON and draws the
// matrix directly — no backend jiffy is involved, so it works purely as a visual
// aid next to the structure viewer. Accepts the same JSON shapes Carbonara's
// load_pae_matrix accepts: a dict with 'pae' / 'predicted_aligned_error' /
// 'predicted_alignment_error', an AlphaFold DB style list-of-dict, or a bare 2D
// matrix.

interface CarbonaraPaePlotProps {
  paeFile?: File | string
  plot?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractMatrix = (data: any): number[][] | null => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fromEntry = (e: any): number[][] | null => {
    if (!e || typeof e !== 'object') return null
    return (
      e.predicted_aligned_error ??
      e.predicted_alignment_error ??
      e.pae ??
      null
    )
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return null
    if (Array.isArray(data[0])) return data as number[][]
    return fromEntry(data[0])
  }
  return fromEntry(data)
}

// Colour ramp: low error (confident / rigid) -> dark blue; high error
// (flexible) -> light yellow, matching the viewer's flexible highlight.
const ramp = (t: number): [number, number, number] => {
  const c = Math.max(0, Math.min(1, t))
  return [
    Math.round(30 + c * 225),
    Math.round(40 + c * 200),
    Math.round(120 - c * 110)
  ]
}

// Pick a "nice" residue tick step (1/2/5 × 10ⁿ) giving roughly `target` ticks.
const niceStep = (n: number, target = 6): number => {
  const raw = n / target
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1
  return Math.max(1, step * mag)
}

const CarbonaraPaePlot = ({ paeFile, plot = 260 }: CarbonaraPaePlotProps) => {
  const heatRef = useRef<HTMLCanvasElement>(null)
  const barRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<{ n: number; mean: number; max: number } | null>(
    null
  )

  useEffect(() => {
    let cancelled = false
    const draw = async () => {
      setError(null)
      setInfo(null)
      const heat = heatRef.current
      const bar = barRef.current
      if (!heat || !bar || !paeFile) return
      try {
        const text =
          paeFile instanceof File ? await paeFile.text() : (paeFile as string)
        const matrix = extractMatrix(JSON.parse(text))
        if (cancelled) return
        if (!matrix || matrix.length === 0 || !Array.isArray(matrix[0])) {
          setError('Could not read a PAE matrix from this file.')
          return
        }
        const n = matrix.length
        let max = 0
        let sum = 0
        for (const row of matrix) {
          for (const v of row) {
            if (v > max) max = v
            sum += v
          }
        }
        const denom = max || 1
        setInfo({ n, mean: sum / (n * n), max })

        const ML = 52
        const MT = 8
        const MR = 10
        const MB = 48
        const ctx = heat.getContext('2d')
        if (!ctx) return
        heat.width = ML + plot + MR
        heat.height = MT + plot + MB
        ctx.clearRect(0, 0, heat.width, heat.height)

        // Heatmap (nearest-neighbour downsample into a plot×plot ImageData).
        const img = ctx.createImageData(plot, plot)
        for (let py = 0; py < plot; py++) {
          const sy = Math.min(n - 1, Math.floor((py / plot) * n))
          for (let px = 0; px < plot; px++) {
            const sx = Math.min(n - 1, Math.floor((px / plot) * n))
            const [r, g, b] = ramp(matrix[sy]![sx]! / denom)
            const o = (py * plot + px) * 4
            img.data[o] = r
            img.data[o + 1] = g
            img.data[o + 2] = b
            img.data[o + 3] = 255
          }
        }
        ctx.putImageData(img, ML, MT)

        // Axes frame + ticks + labels.
        ctx.strokeStyle = '#666'
        ctx.lineWidth = 1
        ctx.strokeRect(ML + 0.5, MT + 0.5, plot, plot)
        ctx.fillStyle = '#333'
        ctx.font = '10px sans-serif'
        const step = niceStep(n)
        for (let t = 0; t <= n; t += step) {
          const frac = t / n
          const x = ML + frac * plot
          const y = MT + frac * plot
          // bottom (aligned residue) ticks
          ctx.beginPath()
          ctx.moveTo(x, MT + plot)
          ctx.lineTo(x, MT + plot + 4)
          ctx.stroke()
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillText(String(t), x, MT + plot + 6)
          // left (scored residue) ticks
          ctx.beginPath()
          ctx.moveTo(ML, y)
          ctx.lineTo(ML - 4, y)
          ctx.stroke()
          ctx.textAlign = 'right'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(t), ML - 6, y)
        }
        // axis titles
        ctx.fillStyle = '#000'
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText('Aligned residue', ML + plot / 2, MT + plot + 26)
        ctx.save()
        ctx.translate(12, MT + plot / 2)
        ctx.rotate(-Math.PI / 2)
        ctx.fillText('Scored residue', 0, 0)
        ctx.restore()

        // Colour bar.
        const barCtx = bar.getContext('2d')
        if (!barCtx) return
        const bw = plot
        const bh = 12
        bar.width = bw
        bar.height = bh
        const grad = barCtx.createImageData(bw, bh)
        for (let x = 0; x < bw; x++) {
          const [r, g, b] = ramp(x / (bw - 1))
          for (let y = 0; y < bh; y++) {
            const o = (y * bw + x) * 4
            grad.data[o] = r
            grad.data[o + 1] = g
            grad.data[o + 2] = b
            grad.data[o + 3] = 255
          }
        }
        barCtx.putImageData(grad, 0, 0)
      } catch (err) {
        console.error('PAE plot failed:', err)
        if (!cancelled) setError('Could not parse this PAE file.')
      }
    }
    void draw()
    return () => {
      cancelled = true
    }
  }, [paeFile, plot])

  if (error) {
    return (
      <Typography
        variant="caption"
        color="error"
      >
        {error}
      </Typography>
    )
  }

  return (
    <Box>
      <canvas
        ref={heatRef}
        style={{ imageRendering: 'pixelated' }}
      />
      <Box sx={{ width: plot, ml: '52px' }}>
        <canvas
          ref={barRef}
          style={{
            width: plot,
            height: 12,
            display: 'block',
            border: '1px solid #ccc'
          }}
        />
        <Box
          sx={{ display: 'flex', justifyContent: 'space-between', mt: '2px' }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
          >
            0
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
          >
            Expected position error (Å)
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
          >
            {info ? info.max.toFixed(0) : ''}
          </Typography>
        </Box>
      </Box>
      {info && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 0.5 }}
        >
          {info.n}×{info.n} residues · mean {info.mean.toFixed(1)} Å. Dark = low
          error (confident, rigid); light = high error (flexible).
        </Typography>
      )}
    </Box>
  )
}

export default CarbonaraPaePlot
