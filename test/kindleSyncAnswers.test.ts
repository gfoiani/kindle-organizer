import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import { getFirstSyncAnswer, recordFirstSyncAnswer } from '../src/main/kindleSync/firstSyncAnswers'

beforeEach(() => {
  freshUserData()
})

afterAll(() => {
  cleanupUserDataDirs()
})

describe('first-sync answers, remembered per Kindle', () => {
  test('a Kindle never asked has no answer', () => {
    expect(getFirstSyncAnswer('kt5-ab12')).toBeNull()
  })

  test('the answer is remembered for that Kindle only', () => {
    // Act
    recordFirstSyncAnswer('kt5-ab12', 'import')

    // Assert
    expect(getFirstSyncAnswer('kt5-ab12')).toBe('import')
    expect(getFirstSyncAnswer('pw5-ff00')).toBeNull()
  })

  test('answering again replaces the earlier answer', () => {
    recordFirstSyncAnswer('kt5-ab12', 'import')
    recordFirstSyncAnswer('kt5-ab12', 'discard')

    expect(getFirstSyncAnswer('kt5-ab12')).toBe('discard')
  })
})
