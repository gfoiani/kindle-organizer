import * as fs from 'fs-extra'
import * as crypto from 'crypto'
import { createReadStream } from 'fs'
import path from 'path'
import { app } from 'electron'
import { SUPPORTED_EXTENSIONS } from './kindle'
import { parseEpub } from './epub'
import { importLocalCover } from './covers'
import { insertLibraryBook, findByContentHash, deleteLibraryBook, type LibraryBook } from './library'

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

/** Readable fallback title from a filename (strip extension, underscores → spaces). */
function titleFromFilename(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath))
  return base.replace(/_/g, ' ').trim() || base
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
