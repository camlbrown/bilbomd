import { Color } from 'molstar/lib/mol-util/color'

// Distinct per-chain palette (Tableau-10-ish), shared so the 3D viewer paints
// each chain with chainColor(i) and the form colours its chain chips with
// carbonaraChainColorHex(i) — keeping the two in agreement.
const CHAIN_PALETTE = [
  0x4e79a7, 0xf28e2b, 0x59a14f, 0xe15759, 0x76b7b2, 0xedc948, 0xb07aa1, 0xff9da7,
  0x9c755f, 0xbab0ac
]

// Map any index (incl. negative / non-finite) into a valid palette slot so an
// unexpected value can never yield undefined (and a .toString() white-screen).
const paletteIdx = (i: number): number => {
  const n = Number.isFinite(i) ? Math.trunc(i) : 0
  const L = CHAIN_PALETTE.length
  return ((n % L) + L) % L
}

export const chainColor = (i: number): Color =>
  Color(CHAIN_PALETTE[paletteIdx(i)]!)

export const carbonaraChainColorHex = (i: number): string =>
  '#' + CHAIN_PALETTE[paletteIdx(i)]!.toString(16).padStart(6, '0')
