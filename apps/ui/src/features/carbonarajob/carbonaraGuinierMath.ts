// Client-side SAXS + Guinier helpers for the interactive Guinier panel.
//
// Parsing matches the worker's robust loader (carbonara_guinier.py): skip any
// non-numeric header/comment lines, keep only positive (q, I), sort by q. This
// keeps client point indices aligned with the worker's AutoRg-style selection so
// the "auto-select" window maps 1:1 onto the client array.

export interface SaxsPoint {
  q: number
  I: number
  sigma: number | null
  q2: number
  lnI: number
}

export interface GuinierResult {
  valid: boolean
  slope: number
  intercept: number
  rg: number
  i0: number
  r2: number
  qrgMin: number
  qrgMax: number
  // Δ/σ (or raw ln residual when no sigma) across the fit window, for plotting.
  residuals: { q2: number; z: number }[]
  weighted: boolean
}

export const parseSaxsDat = (text: string): SaxsPoint[] => {
  const pts: SaxsPoint[] = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const parts = s.split(/\s+/)
    const q = Number(parts[0])
    const I = parts.length > 1 ? Number(parts[1]) : NaN
    if (!Number.isFinite(q) || !Number.isFinite(I)) continue // header row
    if (!(q > 0) || !(I > 0)) continue // matches the worker's positive filter
    const sigRaw = parts.length > 2 ? Number(parts[2]) : NaN
    const sigma = Number.isFinite(sigRaw) && sigRaw > 0 ? sigRaw : null
    pts.push({ q, I, sigma, q2: q * q, lnI: Math.log(I) })
  }
  pts.sort((a, b) => a.q - b.q)
  return pts
}

// Weighted (1/σ_ln²) least-squares fit of ln I vs q² over [startIdx, endIdx]
// inclusive. Falls back to ordinary least squares when the window has no usable
// error column. Returns valid=false when the window is too short or the slope is
// non-negative (no meaningful Rg).
export const guinierFit = (
  pts: SaxsPoint[],
  startIdx: number,
  endIdx: number
): GuinierResult => {
  const empty: GuinierResult = {
    valid: false,
    slope: 0,
    intercept: 0,
    rg: 0,
    i0: 0,
    r2: 0,
    qrgMin: 0,
    qrgMax: 0,
    residuals: [],
    weighted: false
  }
  const lo = Math.max(0, Math.min(startIdx, endIdx))
  const hi = Math.min(pts.length - 1, Math.max(startIdx, endIdx))
  const win = pts.slice(lo, hi + 1)
  if (win.length < 3) return empty

  // σ in ln space is σ_I / I; use weights only when every point has one.
  const allSigma = win.every((p) => p.sigma != null)
  const w = win.map((p) =>
    allSigma && p.sigma != null ? 1 / Math.pow(p.sigma / p.I, 2) : 1
  )

  let sw = 0
  let swx = 0
  let swy = 0
  let swxx = 0
  let swxy = 0
  for (let i = 0; i < win.length; i++) {
    const x = win[i]!.q2
    const y = win[i]!.lnI
    sw += w[i]!
    swx += w[i]! * x
    swy += w[i]! * y
    swxx += w[i]! * x * x
    swxy += w[i]! * x * y
  }
  const denom = sw * swxx - swx * swx
  if (denom === 0) return empty
  const slope = (sw * swxy - swx * swy) / denom
  const intercept = (swy * swxx - swx * swxy) / denom
  if (!(slope < 0)) return empty // need a negative slope for a real Rg

  // Weighted R².
  const ybar = swy / sw
  let ssRes = 0
  let ssTot = 0
  const residuals: { q2: number; z: number }[] = []
  for (let i = 0; i < win.length; i++) {
    const p = win[i]!
    const yhat = intercept + slope * p.q2
    const resid = p.lnI - yhat
    ssRes += w[i]! * resid * resid
    ssTot += w[i]! * Math.pow(p.lnI - ybar, 2)
    const sigmaLn = allSigma && p.sigma != null ? p.sigma / p.I : null
    residuals.push({
      q2: p.q2,
      z: sigmaLn && sigmaLn > 0 ? resid / sigmaLn : resid
    })
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1
  const rg = Math.sqrt(-3 * slope)
  return {
    valid: true,
    slope,
    intercept,
    rg,
    i0: Math.exp(intercept),
    r2,
    qrgMin: win[0]!.q * rg,
    qrgMax: win[win.length - 1]!.q * rg,
    residuals,
    weighted: allSigma
  }
}

// Produce a trimmed .dat by dropping all data rows with q < qMin, preserving the
// original header/comment lines and row formatting verbatim (so Carbonara reads
// the same format it always does — just without the low-q prefix).
export const trimSaxsText = (text: string, qMin: number): string => {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) {
      out.push(line)
      continue
    }
    const parts = s.split(/\s+/)
    const q = Number(parts[0])
    const I = parts.length > 1 ? Number(parts[1]) : NaN
    const isData = Number.isFinite(q) && Number.isFinite(I)
    if (!isData) {
      out.push(line) // header/comment — keep verbatim
      continue
    }
    if (q >= qMin - 1e-12) out.push(line) // keep points at/above the cutoff
  }
  return out.join('\n') + '\n'
}
