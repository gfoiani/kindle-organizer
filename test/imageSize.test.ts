import { describe, expect, test } from 'vitest'
import { readImageSize } from '../src/main/epubConvert/images'
import { gifHeader, jpegHeader, pngHeader } from './setup/imageHeaders'

describe('readImageSize', () => {
  test('reads the size a PNG declares in its IHDR', () => {
    expect(readImageSize(pngHeader(600, 800))).toEqual({ width: 600, height: 800 })
  })

  test('reads the size a GIF declares in its logical screen descriptor', () => {
    expect(readImageSize(gifHeader(320, 200))).toEqual({ width: 320, height: 200 })
  })

  test('reads the size from a JPEG frame header, past the segments before it', () => {
    expect(readImageSize(jpegHeader(1200, 1600))).toEqual({ width: 1200, height: 1600 })
  })

  test('returns null for truncated or unknown data', () => {
    expect(readImageSize(pngHeader(1, 1).subarray(0, 12))).toBeNull()
    expect(readImageSize(jpegHeader(1, 1).subarray(0, 10))).toBeNull()
    expect(readImageSize(Buffer.from('not an image'))).toBeNull()
  })
})
