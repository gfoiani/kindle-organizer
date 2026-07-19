import { describe, expect, test } from 'vitest'
import { buildCoverSrc, COVER_SCHEME } from '../src/renderer/src/utils/coverSrc'

describe('buildCoverSrc', () => {
  const key = 'a'.repeat(64)

  test('builds a cover-cache URL with the version-epoch query', () => {
    expect(buildCoverSrc(key, 3)).toBe(`${COVER_SCHEME}://covers/${key}?v=3-0`)
  })

  test('defaults the version and epoch to 0', () => {
    expect(buildCoverSrc(key)).toBe(`${COVER_SCHEME}://covers/${key}?v=0-0`)
  })

  test('folds the cache-clear epoch into the query so a re-download busts the immutable cache', () => {
    // Same key + same version but a bumped epoch must yield a DISTINCT URL,
    // otherwise Chromium would serve the stale pre-clear image (M4).
    const beforeClear = buildCoverSrc(key, 1, 0)
    const afterClear = buildCoverSrc(key, 1, 1)
    expect(beforeClear).toBe(`${COVER_SCHEME}://covers/${key}?v=1-0`)
    expect(afterClear).toBe(`${COVER_SCHEME}://covers/${key}?v=1-1`)
    expect(afterClear).not.toBe(beforeClear)
  })
})
