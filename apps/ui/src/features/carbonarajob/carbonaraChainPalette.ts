import { Color } from 'molstar/lib/mol-util/color'

// Distinct per-chain palette (Tableau-10-ish), shared so the 3D viewer paints
// each chain with chainColor(i) and the form colours its chain chips with
// carbonaraChainColorHex(i) — keeping the two in agreement.
const CHAIN_PALETTE = [
  0x4e79a7, 0xf28e2b, 0x59a14f, 0xe15759, 0x76b7b2, 0xedc948, 0xb07aa1, 0xff9da7,
  0x9c755f, 0xbab0ac
]

export const chainColor = (i: number): Color =>
  Color(CHAIN_PALETTE[i % CHAIN_PALETTE.length]!)

export const carbonaraChainColorHex = (i: number): string =>
  '#' + CHAIN_PALETTE[i % CHAIN_PALETTE.length]!.toString(16).padStart(6, '0')
