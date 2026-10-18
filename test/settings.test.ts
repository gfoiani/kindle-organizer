import { describe, expect, test } from 'vitest'
import { isKindleFormat, KINDLE_FORMAT } from '../src/main/settings'

describe('Kindle format', () => {
  test('AZW3 is the one format the native converter produces', () => {
    expect(KINDLE_FORMAT).toBe('azw3')
    expect(isKindleFormat('azw3')).toBe(true)
  })

  test('rejects MOBI, which the native converter does not write', () => {
    expect(isKindleFormat('mobi')).toBe(false)
  })

  test('rejects anything that is not a format string', () => {
    expect(isKindleFormat(undefined)).toBe(false)
    expect(isKindleFormat(3)).toBe(false)
    expect(isKindleFormat('epub')).toBe(false)
  })
})
