import * as crypto from 'crypto'
import { promises as fsp } from 'fs'
import path from 'path'
import { AppError } from './appErrors'
import {
  deleteLibraryBook,
  deleteLibraryFolder,
  findByContentHash,
  getLibraryFolder,
  insertLibraryBook,
  insertLibraryFolder,
  listFolderBooks,
  listLibraryFolders,
  updateFolderBookContent,
  updateFolderBookLocation,
  type FolderBookLocation,
  type LibraryBook,
  type LibraryFolder
} from './library'
import { hashFile, readBookMetadata, removeLibraryItemCache } from './libraryService'
import { isReadableDirectory, isSameOrInside, scanLibraryFolder, type ScannedFile } from './folderScan'

/**
 * Library folders: folders on this computer whose books the library shows
 * without copying them. A sync brings the library in line with one folder:
 * new files are added, renamed or moved ones keep their library id (and with
 * it the link to the copy on the Kindle), vanished ones leave the library.
 *
 * The files are never written, moved or deleted — only read.
 */

export type FolderSyncStatus = 'ok' | 'unavailable'

export interface FolderSyncResult {
  folderId: string
  /** 'unavailable': the folder could not be read (unplugged disk, revoked permission); nothing changed. */
  status: FolderSyncStatus
  added: number
  updated: number
  removed: number
  /** Files that could not be read; they are retried on the next sync. */
  errors: number
}

export interface LibraryFolderSummary extends LibraryFolder {
  bookCount: number
  available: boolean
}

type FileOutcome = 'added' | 'updated' | 'unchanged'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emptyResult(folderId: string, status: FolderSyncStatus): FolderSyncResult {
  return { folderId, status, added: 0, updated: 0, removed: 0, errors: 0 }
}

async function realDirectory(folderPath: string): Promise<string | null> {
  if (!path.isAbsolute(folderPath)) return null
  try {
    // The native realpath resolves symlinks and the real letter case, so two
    // spellings of one folder compare equal in the overlap check.
    const real = await fsp.realpath(folderPath)
    return (await isReadableDirectory(real)) ? real : null
  } catch {
    // A missing path is the answer, not a failure.
    return null
  }
}

/**
 * Adds a folder to the library (call `syncLibraryFolder` to read it). Refuses a
 * folder that is, contains or sits inside one already added: its books would
 * show twice, and removing one folder would take the other's books with it.
 */
export async function addLibraryFolder(folderPath: string): Promise<LibraryFolder> {
  const real = await realDirectory(folderPath)
  if (!real) throw new AppError('LIBRARY_FOLDER_INVALID')

  const overlaps = listLibraryFolders().some(
    (folder) => isSameOrInside(folder.path, real) || isSameOrInside(real, folder.path)
  )
  if (overlaps) throw new AppError('LIBRARY_FOLDER_OVERLAP')

  return insertLibraryFolder(crypto.randomUUID(), real)
}

/** Drops a folder and its books from the library. Only the app's conversion caches are deleted. */
export async function removeLibraryFolder(folderId: string): Promise<void> {
  const books = listFolderBooks(folderId)
  deleteLibraryFolder(folderId)
  await Promise.all(books.map((book) => removeLibraryItemCache(book.id)))
}

/** Every library folder with its book count and whether it can be read right now. */
export async function describeLibraryFolders(): Promise<LibraryFolderSummary[]> {
  return Promise.all(
    listLibraryFolders().map(async (folder) => ({
      ...folder,
      bookCount: listFolderBooks(folder.id).length,
      available: await isReadableDirectory(folder.path)
    }))
  )
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

interface SyncSlot {
  current: Promise<FolderSyncResult>
  next: Promise<FolderSyncResult> | null
}

const syncSlots = new Map<string, SyncSlot>()

/**
 * Brings the library in line with one folder. Syncs of a folder never overlap:
 * requests arriving mid-sync share ONE follow-up sync that starts when the
 * running one ends, so a burst of watcher events costs at most two passes and a
 * change made during a pass is never missed.
 */
export function syncLibraryFolder(folderId: string): Promise<FolderSyncResult> {
  const slot = syncSlots.get(folderId)
  if (!slot) return startSync(folderId)
  if (slot.next) return slot.next

  const next = slot.current.then(
    () => startSync(folderId),
    () => startSync(folderId)
  )
  syncSlots.set(folderId, { ...slot, next })
  return next
}

function startSync(folderId: string): Promise<FolderSyncResult> {
  const current: Promise<FolderSyncResult> = runSync(folderId).finally(() => {
    const slot = syncSlots.get(folderId)
    if (slot?.current === current && !slot.next) syncSlots.delete(folderId)
  })
  syncSlots.set(folderId, { current, next: null })
  return current
}

/** Syncs every library folder, one after the other. */
export async function syncAllLibraryFolders(): Promise<FolderSyncResult[]> {
  const results: FolderSyncResult[] = []
  for (const folder of listLibraryFolders()) {
    results.push(await syncLibraryFolder(folder.id))
  }
  return results
}

async function runSync(folderId: string): Promise<FolderSyncResult> {
  const folder = getLibraryFolder(folderId)
  const scan = folder ? await scanLibraryFolder(folder.path) : null
  if (!scan) return emptyResult(folderId, 'unavailable')

  const knownByPath = new Map(listFolderBooks(folderId).map((book) => [book.originalPath, book]))
  const scannedPaths = new Set(scan.files.map((file) => file.path))
  const outcomes: FileOutcome[] = []
  let errors = 0

  for (const file of scan.files) {
    try {
      outcomes.push(await syncFile(folderId, file, knownByPath.get(file.path), scannedPaths))
    } catch (err) {
      console.error(`[library-folders] Failed to read "${file.path}":`, errorText(err))
      errors += 1
    }
  }

  // Only a complete scan proves a book is gone.
  const removed = scan.complete ? await removeVanished(folderId, scannedPaths) : 0
  return {
    folderId,
    status: 'ok',
    added: outcomes.filter((o) => o === 'added').length,
    updated: outcomes.filter((o) => o === 'updated').length,
    removed,
    errors
  }
}

function locationOf(folderId: string, file: ScannedFile): FolderBookLocation {
  return {
    folderId,
    originalPath: file.path,
    filename: path.basename(file.path),
    fileSize: file.size,
    fileMtime: file.mtimeMs
  }
}

function formatOf(file: ScannedFile): string {
  return path.extname(file.path).slice(1).toLowerCase()
}

async function syncFile(
  folderId: string,
  file: ScannedFile,
  known: LibraryBook | undefined,
  scannedPaths: ReadonlySet<string>
): Promise<FileOutcome> {
  // Size and mtime unchanged: the file is not read again (a rescan of a large
  // folder costs one stat per book).
  if (known && known.fileSize === file.size && known.fileMtime === file.mtimeMs) return 'unchanged'

  const contentHash = await hashFile(file.path)
  if (known) {
    if (known.contentHash === contentHash) {
      updateFolderBookLocation(known.id, locationOf(folderId, file))
      return 'unchanged'
    }
    const metadata = await readBookMetadata(file.path)
    updateFolderBookContent(known.id, {
      contentHash,
      ...metadata,
      sourceFormat: formatOf(file),
      fileSize: file.size,
      fileMtime: file.mtimeMs
    })
    return 'updated'
  }

  const twin = findByContentHash(contentHash)
  if (twin) return adoptTwin(folderId, file, twin, scannedPaths)

  const metadata = await readBookMetadata(file.path)
  insertLibraryBook({
    id: crypto.randomUUID(),
    contentHash,
    originalPath: file.path,
    filename: path.basename(file.path),
    ...metadata,
    sourceFormat: formatOf(file),
    folderId,
    fileSize: file.size,
    fileMtime: file.mtimeMs
  })
  return 'added'
}

/**
 * The same bytes are already in the library. A folder book whose own file is
 * gone was renamed or moved — possibly from another library folder — and keeps
 * its id. Anything else (a second copy, a book dropped into the app) is left as is.
 */
async function adoptTwin(
  folderId: string,
  file: ScannedFile,
  twin: LibraryBook,
  scannedPaths: ReadonlySet<string>
): Promise<FileOutcome> {
  if (!twin.folderId || scannedPaths.has(twin.originalPath) || (await exists(twin.originalPath))) return 'unchanged'
  updateFolderBookLocation(twin.id, locationOf(folderId, file))
  return 'updated'
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    // ENOENT is the answer, not a failure.
    return false
  }
}

async function removeVanished(folderId: string, scannedPaths: ReadonlySet<string>): Promise<number> {
  const vanished = listFolderBooks(folderId).filter((book) => !scannedPaths.has(book.originalPath))
  for (const book of vanished) {
    deleteLibraryBook(book.id)
    await removeLibraryItemCache(book.id)
  }
  return vanished.length
}
