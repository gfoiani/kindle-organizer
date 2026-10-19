import * as fs from 'fs-extra'
import path from 'path'
import { app, nativeImage } from 'electron'
import { readMobiIdentifiers, type MobiIdentifiers } from './mobiHeader'
import { readImageSize } from './epubConvert/images'

/**
 * Writes the Kindle's home-screen cover for a sideloaded book.
 *
 * Copying a book into `documents/` is not enough: for sideloaded content the
 * firmware paints a blank placeholder unless a matching JPEG already exists in
 * `system/thumbnails/`, keyed on the identifier stored inside the book. This is
 * the same sidecar calibre's KINDLE2 driver writes on every send, and the reason
 * books pushed through calibre show a cover while a plain file copy does not.
 *
 * Everything here is best-effort: a book we cannot identify, an undecodable
 * cover, or a device yanked mid-write yields `null` (logged), never a throw —
 * the book itself is already safely on the device by the time we run.
 */

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

/** Calibre's KINDLE2 `THUMBNAIL_HEIGHT` — the height the device's grid renders. */
const THUMBNAIL_HEIGHT = 330
const JPEG_QUALITY = 90
/**
 * Covers are decoded in the main process. A header declaring more pixels than
 * this (a large print scan is ~25 MP) is refused rather than decoded: a small,
 * well-compressed PNG can declare a size whose decode needs gigabytes.
 */
export const MAX_COVER_PIXELS = 40_000_000

/** `<mountpoint>/system/thumbnails` — where the firmware looks for the cover. */
export function getThumbnailDir(mountpoint: string): string {
  return path.join(mountpoint, 'system', 'thumbnails')
}

/** The exact filename the firmware expects (calibre's THUMBNAIL_NAME_TEMPLATE). */
export function thumbnailFilename(identifiers: MobiIdentifiers): string {
  return `thumbnail_${identifiers.asin}_${identifiers.cdetype}_portrait.jpg`
}

/**
 * Normalizes a cached cover into a device-sized JPEG, or null for a cover too
 * large to decode safely.
 *
 * The cover cache stores whatever a provider (or an EPUB) handed us — often a
 * PNG, sometimes a 1600px scan — while the device wants a modest JPEG. Chromium's
 * decoder does both jobs. A cover whose size cannot be read from its header is
 * not decoded at all, and like one the decoder rejects, it is shipped as-is: a
 * possibly-oversized cover still beats no cover.
 */
export function toKindleJpeg(image: Buffer): Buffer | null {
  const size = readImageSize(image)
  if (!size) return image
  if (size.width * size.height > MAX_COVER_PIXELS) return null

  try {
    const decoded = nativeImage.createFromBuffer(image)
    if (decoded.isEmpty()) return image

    const { height } = decoded.getSize()
    const scaled =
      height > THUMBNAIL_HEIGHT
        ? decoded.resize({ height: THUMBNAIL_HEIGHT, quality: 'good' })
        : decoded

    const jpeg = scaled.toJPEG(JPEG_QUALITY)
    return jpeg.length > 0 ? jpeg : image
  } catch (err) {
    debug('[thumbnails] Could not re-encode cover, using it as-is:', errorText(err))
    return image
  }
}

/**
 * Writes `cover` as the device thumbnail for the book at `bookPath` (the LOCAL
 * copy — byte-identical to the uploaded one, and far cheaper to read than the
 * file on the device). Returns the filename written, or null when there is
 * nothing to write: the book carries no usable identifier, the cover is empty
 * or too large to decode. A failed write is thrown (after its temp file is
 * removed), so the caller can tell the user the cover did not make it.
 *
 * Unlike calibre — which bails when `system/thumbnails` is absent — the folder
 * is created if needed: the caller has already proven this is a Kindle by
 * uploading into its `documents/`, and a missing folder would otherwise cost
 * the user every cover.
 */
export async function writeKindleThumbnail(
  mountpoint: string,
  bookPath: string,
  cover: Buffer
): Promise<string | null> {
  // A 0-byte buffer is the cover cache's "no cover exists" marker.
  if (cover.length === 0) return null

  const identifiers = await readMobiIdentifiers(bookPath)
  if (!identifiers) {
    debug(`[thumbnails] No MOBI identifiers in ${bookPath} — skipping thumbnail`)
    return null
  }

  const jpeg = toKindleJpeg(cover)
  if (!jpeg) {
    console.warn(`[thumbnails] Cover for ${bookPath} declares too many pixels to decode — skipping thumbnail`)
    return null
  }

  const filename = thumbnailFilename(identifiers)
  const dir = getThumbnailDir(mountpoint)
  const finalPath = path.join(dir, filename)
  const tempPath = path.join(dir, `.${filename}.tmp`)

  try {
    await fs.ensureDir(dir)
    // Atomic device write (temp then rename), like calibre.ts: an unplug mid-write
    // must never leave a half-written JPEG the firmware would cache as the cover.
    await fs.writeFile(tempPath, jpeg)
    await fs.rename(tempPath, finalPath)
    debug(`[thumbnails] Wrote ${filename}`)
    return filename
  } catch (err) {
    try {
      await fs.remove(tempPath)
    } catch (cleanupErr) {
      console.error(`[thumbnails] Failed to clean up ${tempPath}:`, errorText(cleanupErr))
    }
    throw err
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
