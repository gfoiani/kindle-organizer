import { describe, expect, test } from 'vitest'
import { PLACEHOLDER_TINTS, placeholderTint } from '../src/renderer/src/utils/coverPlaceholder'

describe('placeholderTint', () => {
  test('returns the same tint for repeated calls with the same book', () => {
    const first = placeholderTint('Dune', 'Frank Herbert')
    const second = placeholderTint('Dune', 'Frank Herbert')

    expect(second).toEqual(first)
  })

  test('returns the same tint for the NFD and NFC forms of an accented title', () => {
    // macOS hands back NFD from the Kindle volume; the staging library stores NFC.
    // Without normalization the same book would change colour depending on which
    // side it was read from.
    const composed = 'Perché le nazioni falliscono'
    const decomposed = composed.normalize('NFD')

    expect(decomposed).not.toBe(composed) // guard: the two forms really differ
    expect(placeholderTint(decomposed)).toEqual(placeholderTint(composed))
  })

  test('ignores surrounding whitespace and letter case', () => {
    expect(placeholderTint('  DUNE  ', '  Frank Herbert ')).toEqual(
      placeholderTint('dune', 'frank herbert')
    )
  })

  test('treats an absent author the same as an empty one', () => {
    expect(placeholderTint('Dune')).toEqual(placeholderTint('Dune', ''))
  })

  test('returns a stable palette tint for an empty title', () => {
    expect(placeholderTint('')).toEqual(placeholderTint(''))
    expect(PLACEHOLDER_TINTS).toContainEqual(placeholderTint(''))
  })

  test('always returns a palette member, including for inputs whose raw hash overflows to negative', () => {
    for (let i = 0; i < 500; i++) {
      expect(PLACEHOLDER_TINTS).toContainEqual(placeholderTint(`Book ${i}`, `Author ${i}`))
    }
  })

  test('spreads distinct books across more than one tint', () => {
    const distinct = new Set(
      Array.from({ length: 40 }, (_, i) => placeholderTint(`Book ${i}`, `Author ${i}`).from)
    )

    expect(distinct.size).toBeGreaterThan(1)
  })

  test('exposes exactly the eight curated pairs', () => {
    expect(PLACEHOLDER_TINTS).toHaveLength(8)
    expect(PLACEHOLDER_TINTS[0]).toEqual({ from: '#1e1b4b', to: '#3730a3' })
  })
})
