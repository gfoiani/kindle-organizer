import { describe, expect, test } from 'vitest'
import { createLatestGate } from '../src/renderer/src/utils/latestGate'

describe('createLatestGate', () => {
  test('of two overlapping loads, only the one started last may apply its result', () => {
    // Arrange
    const gate = createLatestGate()

    // Act: the first load is still running when a second one starts.
    const first = gate.begin()
    const second = gate.begin()

    // Assert: whichever resolves last, the stale one is ignored.
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  test('a load that finished before the next one began was the latest at the time', () => {
    const gate = createLatestGate()
    const only = gate.begin()

    expect(only()).toBe(true)
  })
})
