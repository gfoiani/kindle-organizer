import { app } from 'electron'
import * as fs from 'fs-extra'
import { randomUUID } from 'crypto'
import { AppError } from './appErrors'
import { epubToKf8 } from './epubConvert'
import { ConversionAbortError, EpubDrmError, EpubInvalidError, throwIfAborted } from './epubConvert/errors'
import { writeKf8 } from './kf8'
import { toKindleJpeg } from './kindleThumbnails'

export { ConversionAbortError } from './epubConvert/errors'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

/**
 * Metadata forced onto the converted book, overriding whatever the source EPUB
 * declares. This is how the app's title/author — and the cover it extracted or
 * fetched — end up INSIDE the file the Kindle reads.
 */
export interface ConvertMetadata {
  title?: string
  author?: string
  /** Absolute path to an image embedded as the book's cover. */
  coverPath?: string
  /** Identifier stamped into the book (EXTH 113); the device keys its cover thumbnail on it. */
  identifier?: string
}

export interface ConvertOptions {
  /** Where the converted file should end up. */
  outputPath: string
  /** Cancels the conversion between documents. */
  signal?: AbortSignal
  /** Called with an integer percent (0–100) as documents are converted. */
  onProgress?: (percent: number) => void
  /** Title/author/cover/identifier to stamp into the output. Omitted fields fall back to the EPUB's. */
  metadata?: ConvertMetadata
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The app's cover is optional: one we cannot read just means the EPUB's own cover is used. */
async function readCover(coverPath: string | undefined): Promise<Buffer | undefined> {
  if (!coverPath) return undefined
  try {
    return await fs.readFile(coverPath)
  } catch (err) {
    debug(`[convert] Cover "${coverPath}" not readable, keeping the EPUB's own:`, errorText(err))
    return undefined
  }
}

/** Temp file then rename, so a crash or cancellation never leaves a truncated book behind. */
async function writeAtomically(target: string, data: Buffer): Promise<void> {
  const temp = `${target}.tmp`
  try {
    await fs.writeFile(temp, data)
    await fs.rename(temp, target)
  } catch (err) {
    await fs.remove(temp).catch((cleanupErr: unknown) =>
      console.error(`[convert] Failed to clean up ${temp}:`, errorText(cleanupErr))
    )
    throw err
  }
}

/** Maps a conversion failure onto a code the renderer can explain; cancellation passes through. */
function toReportableError(err: unknown, inputPath: string): Error {
  if (err instanceof ConversionAbortError) return err
  console.error(`[convert] Failed to convert "${inputPath}":`, errorText(err))
  if (err instanceof EpubDrmError) return new AppError('EPUB_DRM_PROTECTED')
  if (err instanceof EpubInvalidError) return new AppError('EPUB_INVALID')
  return new AppError('CONVERSION_FAILED')
}

/**
 * Converts an EPUB to a Kindle book at `options.outputPath`, entirely in-process
 * (no calibre, no external program). Only AZW3 (KF8) is produced (see
 * `KINDLE_FORMAT`). Failures reject with an `AppError`
 * (EPUB_INVALID / EPUB_DRM_PROTECTED / CONVERSION_FAILED); cancellation with an
 * AbortError-named error.
 */
export async function convert(inputPath: string, options: ConvertOptions): Promise<string> {
  const metadata = options.metadata ?? {}
  try {
    const book = await epubToKf8(inputPath, {
      asin: metadata.identifier ?? randomUUID(),
      title: metadata.title,
      author: metadata.author,
      cover: await readCover(metadata.coverPath),
      thumbnail: toKindleJpeg,
      signal: options.signal,
      // 100% is reported once the file is actually on disk, not when parsing ends.
      onProgress: (percent) => options.onProgress?.(Math.min(percent, 99))
    })
    throwIfAborted(options.signal)
    await writeAtomically(options.outputPath, writeKf8(book))
    options.onProgress?.(100)
    return options.outputPath
  } catch (err) {
    throw toReportableError(err, inputPath)
  }
}
