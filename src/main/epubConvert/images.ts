/** Image formats every KF8 reader can display. */
export type KindleImageMime = 'image/jpeg' | 'image/png' | 'image/gif'

/**
 * Identifies an image by its magic bytes — never by its file name or the
 * manifest's media type, both of which EPUBs routinely get wrong. Anything
 * else (WebP, SVG, BMP, …) is not something a Kindle renders from KF8.
 */
export function sniffImageMime(data: Buffer): KindleImageMime | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  const head = data.subarray(0, 6).toString('latin1')
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  return undefined
}

export interface ImageSize {
  width: number
  height: number
}

/**
 * The pixel size an image declares in its header, read without decoding it:
 * a small, well-compressed file can declare a size whose decode needs
 * gigabytes. Null when the header cannot be read.
 */
export function readImageSize(data: Buffer): ImageSize | null {
  switch (sniffImageMime(data)) {
    case 'image/png':
      return data.length >= 24 && data.toString('latin1', 12, 16) === 'IHDR'
        ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
        : null
    case 'image/gif':
      return data.length >= 10 ? { width: data.readUInt16LE(6), height: data.readUInt16LE(8) } : null
    case 'image/jpeg':
      return jpegSize(data)
    default:
      return null
  }
}

/** SOF0–SOF15 carry the frame size; DHT (C4), JPG (C8) and DAC (CC) share the range but do not. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

/** Markers that stand alone, without a length: TEM, RST0–7, SOI. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)
}

/** Walks the segments before the frame header (APPn, DQT, …) to the SOF that holds the size. */
function jpegSize(data: Buffer): ImageSize | null {
  let offset = 2
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return null
    const marker = data[offset + 1]
    if (marker === 0xff || isStandaloneMarker(marker)) {
      offset += marker === 0xff ? 1 : 2
      continue
    }
    if (isStartOfFrame(marker)) {
      return offset + 9 <= data.length
        ? { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) }
        : null
    }
    const length = data.readUInt16BE(offset + 2)
    if (length < 2) return null
    offset += 2 + length
  }
  return null
}
