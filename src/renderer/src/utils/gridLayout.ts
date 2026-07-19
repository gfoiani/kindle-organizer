/**
 * Layout math for the virtualized books grid, kept out of the component so it is
 * unit-testable without a DOM. The virtualizer's row-height estimate is derived
 * from these constants so it matches what actually renders.
 */

export const GRID_GAP_PX = 16 // gap-4
export const GRID_PADDING_PX = 24 // p-6 (one side)
export const CARD_INFO_HEIGHT_PX = 72 // title + author + size block under the cover
export const COVER_ASPECT = 1.5 // 2:3 book cover → height = width * 1.5

/** Rough on-screen width we aim each cover card for; the column count derives from it. */
const TARGET_CARD_WIDTH_PX = 220
const MIN_COLUMNS = 2
const MAX_COLUMNS = 8
/** Used until the container has actually been measured (width 0). */
const FALLBACK_COLUMNS = 5

/**
 * Responsive column count from the MEASURED CONTAINER width (not the viewport).
 *
 * The grid lives beside the detail sidebar and inside p-6 padding, so the old
 * Tailwind viewport breakpoints (sm/lg/xl) don't map onto the container's actual
 * width. Instead we target a card width against the usable (padding-subtracted)
 * width and clamp the result, so the grid adapts to whatever space it's given.
 */
export function columnsForWidth(width: number): number {
  if (width <= 0) return FALLBACK_COLUMNS
  const usable = Math.max(0, width - GRID_PADDING_PX * 2)
  const cols = Math.round(usable / TARGET_CARD_WIDTH_PX)
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, cols))
}
