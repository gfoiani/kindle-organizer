import { describe, expect, test } from 'vitest'
import { encodeBackwardVwi, encodeForwardVwi, toBase32 } from '../src/main/kf8/encoding'

describe('encodeForwardVwi', () => {
  test('marks the last byte of a forward variable-width integer', () => {
    expect([...encodeForwardVwi(0)]).toEqual([0x80])
    expect([...encodeForwardVwi(127)]).toEqual([0xff])
    expect([...encodeForwardVwi(214)]).toEqual([0x01, 0xd6])
    expect([...encodeForwardVwi(1098)]).toEqual([0x08, 0xca])
  })
})

describe('encodeBackwardVwi', () => {
  test('marks the first byte so the value can be read from the end', () => {
    expect([...encodeBackwardVwi(4)]).toEqual([0x84])
    expect([...encodeBackwardVwi(200)]).toEqual([0x81, 0x48])
  })
})

describe('toBase32', () => {
  test('pads uppercase base-32 to the requested width', () => {
    expect(toBase32(0, 4)).toBe('0000')
    expect(toBase32(89, 10)).toBe('000000002P')
    expect(toBase32(31, 4)).toBe('000V')
  })

  test('rejects negative or fractional values', () => {
    expect(() => toBase32(-1, 4)).toThrow()
    expect(() => toBase32(1.5, 4)).toThrow()
  })
})
