import * as fs from 'fs-extra'
import path from 'path'
import { readCalibreUuids, removeCalibreEntries } from './calibre'
import { SUPPORTED_EXTENSIONS } from './kindle'
import { getThumbnailDir, thumbnailFilename } from './kindleThumbnails'
import { readMobiIdentifiers, type MobiIdentifiers } from './mobiHeader'
import { toDeviceRelpath } from './paths'

export interface DeleteResult {
  /** Book paths that are gone. */
  deleted: string[]
  /** Book paths left in place: refused, missing or not removable. */
  failed: string[]
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isBookFile(name: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(path.extname(name).toLowerCase())
}

/** Whether `dir`, with every link resolved, is `documents/` or inside it. */
async function resolvesInsideDocuments(mountpoint: string, dir: string): Promise<boolean> {
  const documents = await fs.realpath(path.join(mountpoint, 'documents'))
  const real = await fs.realpath(dir)
  return real === documents || real.startsWith(documents + path.sep)
}

/**
 * The book's path under `documents/` when `bookPath` is a book file there,
 * else undefined. The path comes from the renderer, so it is never trusted:
 * anything outside `documents/`, any other file type, a symbolic link and a
 * folder that links off the device are all refused.
 */
async function deletableRelpath(mountpoint: string, bookPath: string): Promise<string | undefined> {
  const relpath = toDeviceRelpath(bookPath, mountpoint)
  if (relpath === undefined || !isBookFile(bookPath)) return undefined
  if (!(await resolvesInsideDocuments(mountpoint, path.dirname(bookPath)))) return undefined
  const stats = await fs.lstat(bookPath)
  return stats.isFile() ? relpath : undefined
}

/**
 * The firmware names reading data by stem, so `Book.azw3` and `Book.pdf` in
 * one folder share `Book.sdr` (compared ignoring case, as FAT does).
 */
async function stemStillInUse(bookPath: string): Promise<boolean> {
  const stem = path.parse(bookPath).name.toLowerCase()
  const siblings = await fs.readdir(path.dirname(bookPath))
  return siblings.some((name) => isBookFile(name) && path.parse(name).name.toLowerCase() === stem)
}

/**
 * Best-effort removal of what the firmware keeps beside a book — the book is
 * already gone, so a leftover is logged rather than reported as a failure.
 */
async function removeLeftover(leftover: string): Promise<void> {
  await fs.remove(leftover).catch((err: unknown) => {
    console.error(`[delete] Could not remove ${leftover}:`, errorText(err))
  })
}

/** A deleted book: its path under `documents/` and the identifiers its thumbnail is named after. */
interface DeletedBook {
  relpath: string
  identifiers: MobiIdentifiers | null
}

/**
 * Deletes one book and its `<name>.sdr` folder (reading position, highlights)
 * unless another book still uses it. Undefined when it was not deleted.
 */
async function deleteOne(mountpoint: string, bookPath: string): Promise<DeletedBook | undefined> {
  const relpath = await deletableRelpath(mountpoint, bookPath)
  if (relpath === undefined) {
    console.error(`[delete] Refusing to delete ${bookPath}: not a book file under documents/`)
    return undefined
  }
  // Read before the file goes: the identifiers name the thumbnail.
  const identifiers = await readMobiIdentifiers(bookPath)
  await fs.unlink(bookPath)
  if (!(await stemStillInUse(bookPath))) {
    await removeLeftover(path.join(path.dirname(bookPath), `${path.parse(bookPath).name}.sdr`))
  }
  return { relpath, identifiers }
}

/**
 * Removes the home-screen thumbnails of deleted books, except one another copy
 * of the same book still shows: copies share an identifier, and every book
 * calibre or this app sent is recorded in metadata.calibre under it. When that
 * file cannot be read the thumbnails stay — a stray image is harmless, a
 * missing cover is not.
 */
async function removeThumbnails(mountpoint: string, deleted: readonly DeletedBook[]): Promise<void> {
  const identified = deleted.flatMap((book) => (book.identifiers ? [book.identifiers] : []))
  if (identified.length === 0) return
  const stillRecorded = readCalibreUuids(mountpoint)
  if (!stillRecorded) {
    console.error('[delete] metadata.calibre is not readable; keeping the thumbnails of the deleted books')
    return
  }
  for (const identifiers of identified.filter((ids) => !stillRecorded.has(ids.asin.toLowerCase()))) {
    await removeLeftover(path.join(getThumbnailDir(mountpoint), thumbnailFilename(identifiers)))
  }
}

/**
 * Deletes books from the Kindle with everything the device keeps about them:
 * the `.sdr` folder, the thumbnail and the `metadata.calibre` record. Each
 * book is independent — one that cannot be deleted does not stop the rest.
 */
export async function deleteDeviceBooks(mountpoint: string, bookPaths: readonly string[]): Promise<DeleteResult> {
  const outcomes: Array<{ bookPath: string; deleted?: DeletedBook }> = []
  for (const bookPath of bookPaths) {
    const deleted = await deleteOne(mountpoint, bookPath).catch((err: unknown) => {
      console.error(`[delete] Could not delete ${bookPath}:`, errorText(err))
      return undefined
    })
    outcomes.push({ bookPath, deleted })
  }

  const deletedBooks = outcomes.flatMap((o) => (o.deleted ? [o.deleted] : []))
  if (deletedBooks.length > 0 && !removeCalibreEntries(mountpoint, deletedBooks.map((book) => book.relpath))) {
    console.error('[delete] metadata.calibre is not readable; the deleted books keep their records')
  }
  // After the records go: a thumbnail is kept only for a book still recorded.
  await removeThumbnails(mountpoint, deletedBooks)
  return {
    deleted: outcomes.filter((o) => o.deleted).map((o) => o.bookPath),
    failed: outcomes.filter((o) => !o.deleted).map((o) => o.bookPath)
  }
}
