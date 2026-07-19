import { describe, expect, test } from 'vitest'
import { buildCoverSrc, COVER_SCHEME } from '../src/renderer/src/utils/coverSrc'

describe('buildCoverSrc', () => {
  const key = 'a'.repeat(64)

  test('builds a cover-cache URL with the version query', () => {
    expect(buildCoverSrc(key, 3)).toBe(`${COVER_SCHEME}://covers/${key}?v=3`)
  })

  test('defaults the version to 0', () => {
    expect(buildCoverSrc(key)).toBe(`${COVER_SCHEME}://covers/${key}?v=0`)
  })
})
