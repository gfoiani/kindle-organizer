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
