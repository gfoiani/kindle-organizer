/** Minimal image headers: enough for a size reader, not a decodable image. */

/** PNG signature + IHDR declaring `width`×`height` (CRC not checked by readers of the size). */
export function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr.writeUInt8(8, 16) // bit depth
  ihdr.writeUInt8(2, 17) // truecolour
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr])
}

export function gifHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(10)
  header.write('GIF89a', 0, 'latin1')
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  return header
}

/** SOI, a JFIF APP0 segment, then a baseline SOF0 declaring the size. */
export function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof0 = Buffer.alloc(19)
  sof0.writeUInt16BE(0xffc0, 0)
  sof0.writeUInt16BE(17, 2)
  sof0.writeUInt8(8, 4)
  sof0.writeUInt16BE(height, 5)
  sof0.writeUInt16BE(width, 7)
  sof0.writeUInt8(3, 9)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0])
}
