import { describe, expect, test } from 'vitest'
import { KINDLE_FORMAT } from '../src/main/settings'

describe('Kindle format', () => {
  test('AZW3 is the one format the native converter produces', () => {
    expect(KINDLE_FORMAT).toBe('azw3')
  })
})
