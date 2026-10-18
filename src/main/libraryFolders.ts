import * as crypto from 'crypto'
import { promises as fsp } from 'fs'
import path from 'path'
import { AppError } from './appErrors'
import {
  deleteLibraryBook,
  deleteLibraryFolder,
  findByContentHash,
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
import {
  isReadableDirectory,
  isRegularFileInside,
  isSameOrInside,
  scanLibraryFolder,
  type FolderScan,
  type ScannedFile
} from './folderScan'

/**
 * Library folders: folders on this computer whose books the library shows
 * without copying them. A sync brings the library in line with every folder:
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

// ─── One operation at a time ──────────────────────────────────────────────────

/**
 * Syncs, additions and removals of folders run one after the other. A removal
 * landing in the middle of a sync would otherwise race its inserts, and two
 * syncs could both add the same new file.
 */
let tail: Promise<unknown> = Promise.resolve()

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task)
  tail = run.catch(() => undefined)
  return run
}

// ─── Folders ──────────────────────────────────────────────────────────────────

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
export function addLibraryFolder(folderPath: string): Promise<LibraryFolder> {
  return exclusive(async () => {
    const real = await realDirectory(folderPath)
    if (!real) throw new AppError('LIBRARY_FOLDER_INVALID')

    const overlaps = listLibraryFolders().some(
      (folder) => isSameOrInside(folder.path, real) || isSameOrInside(real, folder.path)
    )
    if (overlaps) throw new AppError('LIBRARY_FOLDER_OVERLAP')

    return insertLibraryFolder(crypto.randomUUID(), real)
  })
}

/** Drops a folder and its books from the library. Only the app's conversion caches are deleted. */
export function removeLibraryFolder(folderId: string): Promise<void> {
  return exclusive(async () => {
    const books = listFolderBooks(folderId)
    deleteLibraryFolder(folderId)
    await Promise.all(books.map((book) => removeLibraryItemCache(book.id)))
  })
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

let queuedSync: Promise<FolderSyncResult[]> | null = null

/**
 * Brings the library in line with every folder. Requests made while a sync is
 * waiting to start share it; one made while a sync runs queues the next, so a
 * change made during a pass is never missed.
 */
export function syncAllLibraryFolders(): Promise<FolderSyncResult[]> {
  if (queuedSync) return queuedSync
  const run = exclusive(() => {
    queuedSync = null
    return runSync()
  })
  queuedSync = run
  return run
}

/**
 * Syncs the library and reports on one folder. Every folder is read: a book
 * that left this folder may have moved into another one, and only reading that
 * one tells a move (the book keeps its id) from a deletion.
 */
export async function syncLibraryFolder(folderId: string): Promise<FolderSyncResult> {
  const results = await syncAllLibraryFolders()
  return results.find((result) => result.folderId === folderId) ?? emptyResult(folderId, 'unavailable')
}

/** What a sync knows about every folder once they have all been scanned. */
interface SyncContext {
  scannedPaths: ReadonlySet<string>
  /** Folders whose scan was complete: a path missing from them is really gone. */
  completeFolders: ReadonlySet<string>
}

interface FolderPass {
  folder: LibraryFolder
  scan: FolderScan | null
  outcomes: FileOutcome[]
  errors: number
}

async function runSync(): Promise<FolderSyncResult[]> {
  const folders = listLibraryFolders()
  const scans: Array<FolderScan | null> = []
  for (const folder of folders) scans.push(await scanLibraryFolder(folder.path))

  const context: SyncContext = {
    scannedPaths: new Set(scans.flatMap((scan) => scan?.files.map((file) => file.path) ?? [])),
    completeFolders: new Set(folders.filter((_, i) => scans[i]?.complete).map((folder) => folder.id))
  }
  forgetHashesExcept(context.scannedPaths)

  // Read every folder before removing anything: a book missing from one folder
  // may be adopted by another in this phase.
  const passes: FolderPass[] = []
  for (const [i, folder] of folders.entries()) {
    passes.push({ folder, scan: scans[i], ...(await readFolder(folder, scans[i], context)) })
  }

  const results: FolderSyncResult[] = []
  for (const pass of passes) results.push(await finishPass(pass))
  return results
}

async function readFolder(
  folder: LibraryFolder,
  scan: FolderScan | null,
  context: SyncContext
): Promise<Pick<FolderPass, 'outcomes' | 'errors'>> {
  if (!scan) return { outcomes: [], errors: 0 }

  const knownByPath = new Map(listFolderBooks(folder.id).map((book) => [book.originalPath, book]))
  const outcomes: FileOutcome[] = []
  let errors = 0
  for (const file of scan.files) {
    try {
      outcomes.push(await syncFile(folder, file, knownByPath.get(file.path), context))
    } catch (err) {
      console.error(`[library-folders] Failed to read "${file.path}":`, errorText(err))
      errors += 1
    }
  }
  return { outcomes, errors }
}

async function finishPass({ folder, scan, outcomes, errors }: FolderPass): Promise<FolderSyncResult> {
  if (!scan) return emptyResult(folder.id, 'unavailable')
  // Only a complete scan proves a book is gone.
  const removed = scan.complete ? await removeVanished(folder.id, new Set(scan.files.map((file) => file.path))) : 0
  return {
    folderId: folder.id,
    status: 'ok',
    added: outcomes.filter((o) => o === 'added').length,
    updated: outcomes.filter((o) => o === 'updated').length,
    removed,
    errors
  }
}

// ─── One file ─────────────────────────────────────────────────────────────────

/**
 * Hashes of files read during this run of the app, keyed by path. A file that
 * duplicates another book is never stored, so without this it would be read in
 * full on every sync.
 */
const hashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>()

function forgetHashesExcept(paths: ReadonlySet<string>): void {
  for (const cachedPath of [...hashCache.keys()]) {
    if (!paths.has(cachedPath)) hashCache.delete(cachedPath)
  }
}

async function hashOf(folder: LibraryFolder, file: ScannedFile): Promise<string> {
  const cached = hashCache.get(file.path)
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.hash

  // The scan saw a regular file; it may have been swapped for a link since.
  if (!(await isRegularFileInside(folder.path, file.path))) {
    throw new Error('no longer a regular file inside the library folder')
  }
  const hash = await hashFile(file.path)
  hashCache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, hash })
  return hash
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
  folder: LibraryFolder,
  file: ScannedFile,
  known: LibraryBook | undefined,
  context: SyncContext
): Promise<FileOutcome> {
  // Size and mtime unchanged: the file is not read again (a rescan of a large
  // folder costs one stat per book).
  if (known && known.fileSize === file.size && known.fileMtime === file.mtimeMs) return 'unchanged'

  const contentHash = await hashOf(folder, file)
  if (known) return refreshKnownBook(folder.id, file, known, contentHash)

  const twin = findByContentHash(contentHash)
  if (twin) return (await adoptTwin(folder.id, file, twin, context)) ? 'updated' : 'unchanged'

  const metadata = await readBookMetadata(file.path)
  insertLibraryBook({
    id: crypto.randomUUID(),
    contentHash,
    originalPath: file.path,
    filename: path.basename(file.path),
    ...metadata,
    sourceFormat: formatOf(file),
    folderId: folder.id,
    fileSize: file.size,
    fileMtime: file.mtimeMs
  })
  return 'added'
}

/** The file of a known book changed on disk (touched, or rewritten). */
async function refreshKnownBook(
  folderId: string,
  file: ScannedFile,
  known: LibraryBook,
  contentHash: string
): Promise<FileOutcome> {
  if (known.contentHash === contentHash) {
    updateFolderBookLocation(known.id, locationOf(folderId, file))
    return 'unchanged'
  }

  const owner = findByContentHash(contentHash)
  if (owner) {
    // The file now holds the bytes of another library book. Two rows cannot
    // share a hash, so this one keeps its old record; storing the new size and
    // mtime stops it being re-read (and re-reported) on every sync.
    console.warn(`[library-folders] "${file.path}" now duplicates "${owner.title}"; keeping the earlier record`)
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

/**
 * The same bytes are already in the library. A folder book whose own file is
 * gone was renamed or moved — possibly from another library folder — and keeps
 * its id. Anything else (a second copy, a book dropped into the app) is left as
 * is. Returns whether the book was adopted.
 */
async function adoptTwin(folderId: string, file: ScannedFile, twin: LibraryBook, context: SyncContext): Promise<boolean> {
  if (!twin.folderId || (await twinStillThere(twin, context))) return false
  updateFolderBookLocation(twin.id, locationOf(folderId, file))
  return true
}

/**
 * Whether the twin's own file still exists. A complete scan of its folder is
 * the authority: it compares exact names, so a rename that only changes letter
 * case (which `access` would still find on macOS and Windows) counts as a move.
 */
async function twinStillThere(twin: LibraryBook, context: SyncContext): Promise<boolean> {
  if (context.scannedPaths.has(twin.originalPath)) return true
  if (twin.folderId && context.completeFolders.has(twin.folderId)) return false
  return exists(twin.originalPath)
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
