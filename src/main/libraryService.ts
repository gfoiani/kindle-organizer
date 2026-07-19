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
  upsertConversion,
  setUploaded,
  type LibraryBook
} from './library'
import { convert, type ConvertOptions } from './convert'
import { uploadFile } from './deviceUpload'
import { titleFromFilename } from './titleFromFilename'
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

function itemDir(id: string): string {
  return path.join(getLibraryRoot(), id)
}

/** Streams a sha256 of the file's bytes — the dedupe key. */
function hashFile(filePath: string): Promise<string> {
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

    let title = titleFromFilename(filePath)
    let author: string | undefined
    let coverImage: Buffer | undefined
    if (ext === '.epub') {
      const meta = await parseEpub(filePath)
      title = meta.title
      author = meta.author
      coverImage = meta.coverImage
    }

    // Copy the original into the library store under a fresh id.
    const id = crypto.randomUUID()
    const dir = itemDir(id)
    await fs.ensureDir(dir)
    const originalPath = path.join(dir, `original${ext}`)
    await fs.copy(filePath, originalPath)

    // Seed the cover cache from the embedded image, if any (null → not a valid
    // image → fall back to the normal online lookup at display time).
    let coverKey: string | undefined
    if (coverImage) {
      coverKey = (await importLocalCover(title, author, coverImage)) ?? undefined
    }

    const book = insertLibraryBook({
      id,
      contentHash,
      originalPath,
      filename: path.basename(filePath),
      title,
      author,
      sourceFormat: ext.slice(1),
      coverKey
    })
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

/** Removes a library book: DB row (cascades conversions) + its on-disk directory. */
export async function removeLibraryBook(id: string): Promise<void> {
  deleteLibraryBook(id)
  await fs.remove(itemDir(id))
}

// ─── Send to Kindle (convert + upload) ────────────────────────────────────────

type ConvertFn = (inputPath: string, format: KindleFormat, options: ConvertOptions) => Promise<string>
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
 * device. Already-Kindle formats and PDFs are uploaded as-is. Progress is
 * forwarded through `emit` (convert:progress then upload:progress). On success
 * the book is stamped uploaded. `convert`/`uploadFile` are injectable for tests.
 */
export async function sendToKindle(
  id: string,
  mountpoint: string,
  format: KindleFormat,
  emit: SendEmit,
  deps: SendDeps = {}
): Promise<{ targetRelpath: string }> {
  const convertFn = deps.convert ?? convert
  const uploadFn = deps.uploadFile ?? uploadFile

  const book = getLibraryBook(id)
  if (!book) throw new Error(`Library book ${id} not found`)

  let uploadSource: string
  let targetFilename: string

  if (book.sourceFormat === 'epub') {
    const outputPath = path.join(itemDir(id), `converted.${format}`)
    upsertConversion({ libraryId: id, format, status: 'converting' })
    try {
      await convertFn(book.originalPath, format, {
        outputPath,
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
    uploadSource = book.originalPath
    targetFilename = book.filename
  }

  const targetRelpath = await uploadFn(uploadSource, mountpoint, targetFilename, (percent) =>
    emit('upload:progress', { libraryId: id, percent })
  )

  setUploaded(id, targetRelpath)
  return { targetRelpath }
}
