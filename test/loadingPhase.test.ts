import { describe, expect, test } from 'vitest'
import { selectLoadingPhase } from '../src/renderer/src/utils/loadingPhase'

describe('selectLoadingPhase', () => {
  test('reports detection while the first drive lookup is in flight', () => {
    expect(
      selectLoadingPhase({
        hasResolvedDevice: false,
        isDetectingDrive: true,
        isReadingBooks: false
      })
    ).toBe('detecting')
  })

  test('reports reading while the first device scan is in flight', () => {
    expect(
      selectLoadingPhase({
        hasResolvedDevice: false,
        isDetectingDrive: true,
        isReadingBooks: true
      })
    ).toBe('reading')
  })

  test('keeps blocking until the first cycle resolves, even with no load in flight', () => {
    expect(
      selectLoadingPhase({
        hasResolvedDevice: false,
        isDetectingDrive: false,
        isReadingBooks: false
      })
    ).toBe('detecting')
  })

  test('stops blocking once the first cycle has resolved', () => {
    expect(
      selectLoadingPhase({
        hasResolvedDevice: true,
        isDetectingDrive: false,
        isReadingBooks: false
      })
    ).toBeNull()
  })

  test('never blocks during a later refresh, so the current list stays visible', () => {
    expect(
      selectLoadingPhase({
        hasResolvedDevice: true,
        isDetectingDrive: true,
        isReadingBooks: true
      })
    ).toBeNull()
  })
})
