// Safe numeric helpers for Carbonara analysis values that can be null at runtime.
// The worker sanitises non-finite (NaN/Inf) FoXS/analysis numbers to null, and
// some per-prediction metrics (rmsd_to_original/tm_to_original) are absent when
// their computation fails while the job still reports status 'done'. Rendering
// `null.toFixed()` throws a TypeError and white-screens the whole results tab, so
// every numeric render must go through fmtNum.

export const fmtNum = (
  v: number | null | undefined,
  digits: number,
  fallback = '—'
): string =>
  v == null || !Number.isFinite(v) ? fallback : (v as number).toFixed(digits)

// For sorting / min-selection: map null/undefined/non-finite to +Infinity so bad
// values sort LAST and are never picked as the "best" (lowest χ²) state.
export const numOrWorst = (v: number | null | undefined): number =>
  v == null || !Number.isFinite(v) ? Number.POSITIVE_INFINITY : (v as number)
