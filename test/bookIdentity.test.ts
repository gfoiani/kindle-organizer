import { describe, expect, test } from 'vitest'
import { bookIdentityKey } from '../src/renderer/src/utils/bookIdentity'

describe('bookIdentityKey', () => {
  test('returns the same key for the NFD and NFC forms of an accented title', () => {
    // macOS hands back NFD from the Kindle volume; the staging library stores NFC.
    // Without normalization the same book would have different keys depending on
    // which side it was read from.
    const composed = 'Perché le nazioni falliscono'
    const decomposed = composed.normalize('NFD')

    expect(decomposed).not.toBe(composed) // guard: the two forms really differ
    expect(bookIdentityKey(decomposed)).toEqual(bookIdentityKey(composed))
  })

  test('ignores surrounding whitespace and letter case', () => {
    expect(bookIdentityKey('  DUNE  ', '  Frank Herbert ')).toEqual(
      bookIdentityKey('dune', 'frank herbert')
    )
  })

  test('treats an absent author the same as an empty one', () => {
    expect(bookIdentityKey('Dune')).toEqual(bookIdentityKey('Dune', ''))
  })
})
