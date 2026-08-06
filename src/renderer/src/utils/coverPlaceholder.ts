import { bookIdentityKey } from './bookIdentity'

/** A gradient pair for the placeholder shown when a book has no cover. */
export interface PlaceholderTint {
  readonly from: string
  readonly to: string
}

/**
 * Tailwind 950 → 800 pairs, so the placeholder reads as native to the gray/indigo
 * UI and stays dark enough that the white badges layered on top keep contrast.
 *
 * A fixed palette rather than `hsl(hash % 360, …)`: at fixed saturation and
 * lightness some hues come out muddy and fight the indigo accent colour.
 *
 * Literal strings, not Tailwind classes — these are consumed as SVG `stop-color`,
 * and Tailwind v4 scans source text at build time, so a runtime-interpolated
 * `bg-[${tint.from}]` would silently generate no CSS at all.
 */
export const PLACEHOLDER_TINTS: readonly PlaceholderTint[] = [
  { from: '#1e1b4b', to: '#3730a3' }, // indigo
  { from: '#042f2e', to: '#115e59' }, // teal
  { from: '#500724', to: '#9d174d' }, // pink
  { from: '#451a03', to: '#92400e' }, // amber
  { from: '#2e1065', to: '#5b21b6' }, // violet
  { from: '#082f49', to: '#075985' }, // sky
  { from: '#022c22', to: '#065f46' }, // emerald
  { from: '#020617', to: '#334155' } // slate
]

/**
 * FNV-1a, 32-bit, over UTF-16 code units (via `charCodeAt`, not UTF-8 bytes).
 * Kept unsigned with `>>> 0`: a signed overflow would make the caller's
 * `% length` negative and index outside the palette.
 */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Picks a stable tint for a book with no cover.
 *
 * Deterministic by construction — no randomness and no clock — so a book keeps
 * its colour across restarts, re-scans and cover-cache clears.
 */
export function placeholderTint(title: string, author?: string): PlaceholderTint {
  const key = bookIdentityKey(title, author)
  return PLACEHOLDER_TINTS[hash(key) % PLACEHOLDER_TINTS.length]
}
