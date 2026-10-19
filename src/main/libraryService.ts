import * as fs from 'fs-extra'
import * as crypto from 'crypto'
import { createReadStream } from 'fs'
import path from 'path'
import { app } from 'electron'
import { SUPPORTED_EXTENSIONS } from './kindle'
import { parseEpub } from './epub'
import { importLocalCover } from './covers'
import {
  insertLibraryBook,
  findByContentHash,
  deleteLibraryBook,
  getLibraryBook,
  getLibraryFolder,
  upsertConversion,
  setUploaded,
  type LibraryBook
} from './library'
import { AppError } from './appErrors'
import { isRegularFileInside } from './folderScan'
import { convert, type ConvertOptions } from './convert'
import { availableFilename, uploadFile } from './deviceUpload'
import { titleFromFilename } from './titleFromFilename'
import { getCacheKey, getCachePath } from './coverPaths'
import { calibreMimeType, upsertCalibreEntry } from './calibre'
import { writeKindleThumbnail } from './kindleThumbnails'
import type { KindleFormat } from './settings'

export type AddStatus = 'added' | 'duplicate' | 'unsupported' | 'error'

/** Per-file outcome of an add-books operation. */
export interface AddResult {
  path: string
  status: AddStatus
  book?: LibraryBook
  error?: string
}

function getLibraryRoot(): string {
  return path.join(app.getPath('userData'), 'library')
}

/** Library ids are crypto.randomUUID()s. Ids come back from the renderer, so nothing else becomes a path. */
const LIBRARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function itemDir(id: string): string {
  if (!LIBRARY_ID.test(id)) throw new Error('Not a library id')
  return path.join(getLibraryRoot(), id)
}

/** Streams a sha256 of the file's bytes — the dedupe key. */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Imports dropped files into the staging library. Each file is handled
 * independently and gets its own AddResult, so one bad file never aborts the
 * batch. EPUBs are parsed for real metadata + an embedded cover; already-Kindle
 * formats and PDFs are stored as-is with a filename title.
 */
export async function addDroppedFiles(filePaths: string[]): Promise<AddResult[]> {
  const results: AddResult[] = []
  for (const filePath of filePaths) {
    results.push(await addOneFile(filePath))
  }
  return results
}

async function addOneFile(filePath: string): Promise<AddResult> {
  const ext = path.extname(filePath).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return { path: filePath, status: 'unsupported' }
  }

  try {
    const contentHash = await hashFile(filePath)
    const existing = findByContentHash(contentHash)
    if (existing) return { path: filePath, status: 'duplicate', book: existing }

    const metadata = await readBookMetadata(filePath)

    // Copy the original into the library store under a fresh id.
    const id = crypto.randomUUID()
    const originalPath = path.join(itemDir(id), `original${ext}`)
    const book = await storeCopy(filePath, originalPath, () =>
      insertLibraryBook({
        id,
        contentHash,
        originalPath,
        filename: path.basename(filePath),
        ...metadata,
        sourceFormat: ext.slice(1)
      })
    ).catch((err: unknown) => {
      // Refused because a concurrent add or a folder sync stored the same content meanwhile.
      if (findByContentHash(contentHash)) return undefined
      throw err
    })
    if (!book) return { path: filePath, status: 'duplicate', book: findByContentHash(contentHash) ?? undefined }
    return { path: filePath, status: 'added', book }
  } catch (err) {
    console.error(
      `[library] Failed to add "${filePath}":`,
      err instanceof Error ? err.message : String(err)
    )
    return {
      path: filePath,
      status: 'error',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Copies `source` to `target` (a fresh item directory) and records it with
 * `insert`. When the record is refused the copy is removed again, so the store
 * never holds a file without a row.
 */
async function storeCopy(source: string, target: string, insert: () => LibraryBook): Promise<LibraryBook> {
  await fs.ensureDir(path.dirname(target))
  await fs.copy(source, target)
  try {
    return insert()
  } catch (err) {
    await fs.remove(path.dirname(target))
    throw err
  }
}

/** What the library shows for a book, read from the file itself. */
export interface BookFileMetadata {
  title: string
  author?: string
  coverKey?: string
}

/**
 * EPUBs are parsed for real metadata and their embedded cover seeds the cover
 * cache; already-Kindle formats and PDFs get a title from the file name.
 */
export async function readBookMetadata(filePath: string): Promise<BookFileMetadata> {
  if (path.extname(filePath).toLowerCase() !== '.epub') return { title: titleFromFilename(filePath) }

  const meta = await parseEpub(filePath)
  // null → not a valid image → fall back to the normal online lookup at display time.
  const coverKey = meta.coverImage ? await importLocalCover(meta.title, meta.author, meta.coverImage) : null
  return {
    title: meta.title,
    ...(meta.author ? { author: meta.author } : {}),
    ...(coverKey ? { coverKey } : {})
  }
}

/** Deletes a book's directory in the app's store (its dropped copy and its conversions). */
export async function removeLibraryItemCache(id: string): Promise<void> {
  await fs.remove(itemDir(id))
}

/**
 * Removes a dropped book: DB row (cascades conversions) + its on-disk directory.
 * A book read from a library folder is refused: its file belongs to the user,
 * and it leaves the library when it leaves its folder.
 */
export async function removeLibraryBook(id: string): Promise<void> {
  const book = getLibraryBook(id)
  if (!book) throw new Error('Library book not found')
  if (book.folderId) throw new AppError('LIBRARY_FOLDER_BOOK')
  deleteLibraryBook(id)
  await removeLibraryItemCache(id)
}

/**
 * The file to read a book from. A dropped book's copy lives in the app's store.
 * A folder book's file belongs to the user and may have changed since the last
 * sync: it must still be a regular file inside its folder, or a symlink swapped
 * in could make the app read and upload any file on the disk.
 */
async function readableSourcePath(book: LibraryBook): Promise<string> {
  if (!book.folderId) return book.originalPath

  const folder = getLibraryFolder(book.folderId)
  if (!folder || !(await isRegularFileInside(folder.path, book.originalPath))) {
    throw new AppError('LIBRARY_FILE_MISSING')
  }
  return book.originalPath
}

// ─── Send to Kindle (convert + upload) ────────────────────────────────────────

type ConvertFn = (inputPath: string, options: ConvertOptions) => Promise<string>
type UploadFn = (
  source: string,
  mountpoint: string,
  targetFilename: string,
  onProgress?: (percent: number) => void
) => Promise<string>

/** Progress payload pushed to the renderer during a send (keyed by libraryId). */
export interface SendProgress {
  libraryId: string
  percent: number
}

export type SendEmit = (channel: string, payload: SendProgress) => void

export interface SendDeps {
  convert?: ConvertFn
  uploadFile?: UploadFn
}

/**
 * On-disk path of the cover the UI shows for this book, or undefined when there
 * is none yet.
 *
 * Two keys are tried because a book can be covered from either side: `coverKey`
 * is stamped at import time from an embedded EPUB cover, while a cover the
 * renderer later fetched online lands under `getCacheKey(title, author)`. A
 * 0-byte file is the cache's "no cover exists" marker, not a cover.
 */
async function findCoverPath(book: LibraryBook): Promise<string | undefined> {
  const keys = [...new Set([book.coverKey, getCacheKey(book.title, book.author)])]

  for (const key of keys) {
    if (!key) continue
    const cachePath = getCachePath(key)
    if (!(await fs.pathExists(cachePath))) continue
    if ((await fs.stat(cachePath)).size > 0) return cachePath
  }
  return undefined
}

/** A file calibre writes beside a sent book; a send reports the ones it could not write. */
export type SendSidecar = 'thumbnail' | 'calibreRecord'

/** What a send did: where the book landed, and which sidecars are missing. */
export interface SendResult {
  targetRelpath: string
  /** Empty when the book is complete on the device. */
  unwrittenSidecars: SendSidecar[]
}

/**
 * Reproduces the bookkeeping calibre does after copying a book onto a Kindle:
 *
 *  1. the home-screen cover under `system/thumbnails/` — without it the firmware
 *     paints a blank placeholder for sideloaded books, which is exactly what
 *     "the book has no cover" looks like on the device;
 *  2. a record in `metadata.calibre`, so the book can carry collections.
 *
 * The file is already safely on the device by now, so a failure here does not
 * fail the send: it is logged and returned, for the UI to say what is missing.
 */
async function applyCalibreSidecars(
  book: LibraryBook,
  uploadSource: string,
  mountpoint: string,
  targetRelpath: string,
  coverPath: string | undefined
): Promise<SendSidecar[]> {
  // The two sidecars fail independently: a cover we cannot read must not cost
  // the book its metadata.calibre record.
  const thumbnailWritten = await attempt('cover thumbnail', book, async () => {
    // Read the LOCAL copy of the book: byte-identical to what was uploaded,
    // and far cheaper than reading it back over USB.
    if (coverPath) await writeKindleThumbnail(mountpoint, uploadSource, await fs.readFile(coverPath))
    return true
  })
  const recordWritten = await attempt('metadata.calibre entry', book, async () =>
    upsertCalibreEntry(mountpoint, {
      relpath: targetRelpath,
      title: book.title,
      author: book.author,
      size: (await fs.stat(uploadSource)).size,
      mime: calibreMimeType(targetRelpath),
      uuid: book.id
    })
  )
  return [...(thumbnailWritten ? [] : ['thumbnail' as const]), ...(recordWritten ? [] : ['calibreRecord' as const])]
}

/** Runs one sidecar write; false when it threw (logged) or reported that it wrote nothing. */
async function attempt(what: string, book: LibraryBook, write: () => Promise<boolean>): Promise<boolean> {
  try {
    return await write()
  } catch (err) {
    logSidecarFailure(what, book, err)
    return false
  }
}

function logSidecarFailure(what: string, book: LibraryBook, err: unknown): void {
  console.error(
    `[library] Failed to write the ${what} for "${book.title}":`,
    err instanceof Error ? err.message : String(err)
  )
}

/** Makes a title safe to use as a device filename. */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned || 'book'
}

/**
 * Converts (EPUB → the requested format) and uploads a library book to the
 * device, then writes the same sidecars calibre would (cover thumbnail +
 * metadata.calibre record) so the book shows a cover on the home screen. A
 * different book already on the device under the same name is kept: this one
 * gets a ` (2)` suffix.
 * Already-Kindle formats and PDFs are uploaded as-is. Progress is forwarded
 * through `emit` (convert:progress then upload:progress). On success the book
 * is stamped uploaded. `convert`/`uploadFile` are injectable for tests.
 */
export async function sendToKindle(
  id: string,
  mountpoint: string,
  format: KindleFormat,
  emit: SendEmit,
  deps: SendDeps = {}
): Promise<SendResult> {
  const convertFn = deps.convert ?? convert
  const uploadFn = deps.uploadFile ?? uploadFile

  const book = getLibraryBook(id)
  if (!book) throw new Error(`Library book ${id} not found`)

  const sourcePath = await readableSourcePath(book)
  const coverPath = await findCoverPath(book)
  let uploadSource: string
  let targetFilename: string

  if (book.sourceFormat === 'epub') {
    // A folder book has no directory in the app's store until its first conversion.
    await fs.ensureDir(itemDir(id))
    const outputPath = path.join(itemDir(id), `converted.${format}`)
    upsertConversion({ libraryId: id, format, status: 'converting' })
    try {
      await convertFn(sourcePath, {
        outputPath,
        // Stamp the app's own metadata into the book, like calibre does: the
        // device reads title/author/cover from the file itself.
        metadata: { title: book.title, author: book.author, coverPath, identifier: book.id },
        onProgress: (percent) => emit('convert:progress', { libraryId: id, percent })
      })
    } catch (err) {
      upsertConversion({
        libraryId: id,
        format,
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
    upsertConversion({ libraryId: id, format, status: 'done', outputPath })
    uploadSource = outputPath
    targetFilename = `${sanitizeFilename(book.title)}.${format}`
  } else {
    // Already Kindle-compatible (or PDF): upload the original untouched.
    uploadSource = sourcePath
    targetFilename = book.filename
  }

  const freeFilename = await availableFilename(mountpoint, targetFilename, book.targetRelpath)
  const targetRelpath = await uploadFn(uploadSource, mountpoint, freeFilename, (percent) =>
    emit('upload:progress', { libraryId: id, percent })
  )

  const unwrittenSidecars = await applyCalibreSidecars(book, uploadSource, mountpoint, targetRelpath, coverPath)

  setUploaded(id, targetRelpath)
  return { targetRelpath, unwrittenSidecars }
}
