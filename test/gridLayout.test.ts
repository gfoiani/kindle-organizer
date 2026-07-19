import { describe, expect, test } from 'vitest'
import { columnsForWidth } from '../src/renderer/src/utils/gridLayout'

describe('columnsForWidth', () => {
  test('returns the fallback column count before the container is measured (width <= 0)', () => {
    expect(columnsForWidth(0)).toBe(5)
    expect(columnsForWidth(-100)).toBe(5)
  })

  test('clamps to a minimum of 2 columns on very narrow containers', () => {
    expect(columnsForWidth(200)).toBe(2)
    expect(columnsForWidth(50)).toBe(2)
  })

  test('clamps to a maximum of 8 columns on very wide containers', () => {
    expect(columnsForWidth(5000)).toBe(8)
  })

  test('derives the column count from the MEASURED container width, not the viewport', () => {
    // A ~1072px container (full window minus the detail sidebar + p-6 padding)
    // should still show a dense grid — the old viewport breakpoints under-counted
    // it because they were meant for the full viewport width (L6).
    expect(columnsForWidth(1072)).toBeGreaterThanOrEqual(4)
    expect(columnsForWidth(1280)).toBeGreaterThanOrEqual(5)
  })

  test('is monotonically non-decreasing as the container grows', () => {
    let prev = 0
    for (let w = 300; w <= 3000; w += 50) {
      const cols = columnsForWidth(w)
      expect(cols).toBeGreaterThanOrEqual(prev)
      prev = cols
    }
  })
})
