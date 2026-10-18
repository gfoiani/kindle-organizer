import { app } from 'electron'
import type Database from 'better-sqlite3'
import path from 'path'
import { createCachedDb } from './sqlite'

/**
 * SQLite store for the local staging library — books the user added to the app
 * (by drag-and-drop) that may or may not yet live on a connected Kindle.
 *
 * Uses the shared cached-connection helper (see sqlite.ts), like every other
 * store in the app: one handle for the process lifetime, closed on `will-quit`.
 */

/** Lifecycle of a per-format conversion of a library book. */
export type ConversionStatus = 'pending' | 'converting' | 'done' | 'error'

/** A book in the staging library (camelCase view of a library_books row). */
export interface LibraryBook {
  id: string
  contentHash: string
  originalPath: string
  filename: string
  title: string
  author?: string
  /** Source file format without the dot, e.g. 'epub', 'azw3', 'pdf'. */
  sourceFormat: string
  /** Cover cache key, when a cover was seeded (embedded or downloaded). */
  coverKey?: string
  /** Relative path under documents/ once uploaded to a device. */
  targetRelpath?: string
  /** Epoch ms of the last successful upload, or undefined if never uploaded. */
  uploadedAt?: number
  /** Epoch ms the book was added to the library. */
  createdAt: number
  /**
   * The library folder the book is read from, in place. Absent for a dropped
   * book, whose `originalPath` is the app's own copy.
   */
  folderId?: string
  /** Size and mtime (epoch ms) of a folder book's file when last read: a rescan skips unchanged files. */
  fileSize?: number
  fileMtime?: number
}

/** Fields the caller supplies when inserting; id/file layout are owned upstream. */
export interface LibraryBookInput {
  id: string
  contentHash: string
  originalPath: string
  filename: string
  title: string
  author?: string
  sourceFormat: string
  coverKey?: string
  targetRelpath?: string
  folderId?: string
  fileSize?: number
  fileMtime?: number
}

/** A folder on this computer whose books the library shows without copying them. */
export interface LibraryFolder {
  id: string
  /** Real (symlink-resolved) absolute path. */
  path: string
  /** Epoch ms the folder was added. */
  addedAt: number
}

/** Where a folder book's file now is; its identity (id, upload stamp) is kept. */
export interface FolderBookLocation {
  folderId: string
  originalPath: string
  filename: string
  fileSize: number
  fileMtime: number
}

/** New content found at a folder book's path: replaces hash and metadata. */
export interface FolderBookContent {
  contentHash: string
  title: string
  author?: string
  coverKey?: string
  sourceFormat: string
  fileSize: number
  fileMtime: number
}

export interface LibraryConversion {
  libraryId: string
  format: string
  outputPath?: string
  status: ConversionStatus
  error?: string
}

export interface ConversionInput {
  libraryId: string
  format: string
  status: ConversionStatus
  outputPath?: string
  error?: string
}

function getDbPath(): string {
  return path.join(app.getPath('userData'), 'library.db')
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_books (
      id TEXT PRIMARY KEY,
      content_hash TEXT UNIQUE NOT NULL,
      original_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      source_format TEXT NOT NULL,
      cover_key TEXT,
      target_relpath TEXT,
      uploaded_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_conversions (
      library_id TEXT NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
      format TEXT NOT NULL,
      output_path TEXT,
      status TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (library_id, format)
    );
    CREATE TABLE IF NOT EXISTS library_folders (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      added_at INTEGER NOT NULL
    );
  `)
  // Added after 0.4.0: a library.db from then has library_books without them.
  addColumnIfMissing(db, 'library_books', 'folder_id', 'TEXT REFERENCES library_folders(id) ON DELETE CASCADE')
  addColumnIfMissing(db, 'library_books', 'file_size', 'INTEGER')
  addColumnIfMissing(db, 'library_books', 'file_mtime', 'INTEGER')
  db.exec('CREATE INDEX IF NOT EXISTS library_books_folder ON library_books(folder_id)')
}

/** Additive migration: SQLite has no ADD COLUMN IF NOT EXISTS. */
function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all()
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

const store = createCachedDb(getDbPath, initSchema)

/** Closes the library DB handle. Called from `will-quit`. */
export function closeLibraryDb(): void {
  store.close()
}

interface LibraryBookRow {
  id: string
  content_hash: string
  original_path: string
  filename: string
  title: string
  author: string | null
  source_format: string
  cover_key: string | null
  target_relpath: string | null
  uploaded_at: number | null
  created_at: number
  folder_id: string | null
  file_size: number | null
  file_mtime: number | null
}

function toLibraryBook(row: LibraryBookRow): LibraryBook {
  return {
    id: row.id,
    contentHash: row.content_hash,
    originalPath: row.original_path,
    filename: row.filename,
    title: row.title,
    ...(row.author ? { author: row.author } : {}),
    sourceFormat: row.source_format,
    ...(row.cover_key ? { coverKey: row.cover_key } : {}),
    ...(row.target_relpath ? { targetRelpath: row.target_relpath } : {}),
    ...(row.uploaded_at != null ? { uploadedAt: row.uploaded_at } : {}),
    createdAt: row.created_at,
    ...(row.folder_id ? { folderId: row.folder_id } : {}),
    ...(row.file_size != null ? { fileSize: row.file_size } : {}),
    ...(row.file_mtime != null ? { fileMtime: row.file_mtime } : {})
  }
}

interface ConversionRow {
  library_id: string
  format: string
  output_path: string | null
  status: string
  error: string | null
}

function toConversion(row: ConversionRow): LibraryConversion {
  return {
    libraryId: row.library_id,
    format: row.format,
    status: row.status as ConversionStatus,
    ...(row.output_path ? { outputPath: row.output_path } : {}),
    ...(row.error ? { error: row.error } : {})
  }
}

export function insertLibraryBook(input: LibraryBookInput): LibraryBook {
  const createdAt = Date.now()
  store
    .get()
    .prepare(
      `INSERT INTO library_books
         (id, content_hash, original_path, filename, title, author,
          source_format, cover_key, target_relpath, uploaded_at, created_at,
          folder_id, file_size, file_mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.contentHash,
      input.originalPath,
      input.filename,
      input.title,
      input.author ?? null,
      input.sourceFormat,
      input.coverKey ?? null,
      input.targetRelpath ?? null,
      createdAt,
      input.folderId ?? null,
      input.fileSize ?? null,
      input.fileMtime ?? null
    )
  return {
    id: input.id,
    contentHash: input.contentHash,
    originalPath: input.originalPath,
    filename: input.filename,
    title: input.title,
    ...(input.author ? { author: input.author } : {}),
    sourceFormat: input.sourceFormat,
    ...(input.coverKey ? { coverKey: input.coverKey } : {}),
    ...(input.targetRelpath ? { targetRelpath: input.targetRelpath } : {}),
    createdAt,
    ...(input.folderId ? { folderId: input.folderId } : {}),
    ...(input.fileSize != null ? { fileSize: input.fileSize } : {}),
    ...(input.fileMtime != null ? { fileMtime: input.fileMtime } : {})
  }
}

export function findByContentHash(contentHash: string): LibraryBook | null {
  const row = store
    .get()
    .prepare<[string], LibraryBookRow>('SELECT * FROM library_books WHERE content_hash = ?')
    .get(contentHash)
  return row ? toLibraryBook(row) : null
}

export function getLibraryBook(id: string): LibraryBook | null {
  const row = store
    .get()
    .prepare<[string], LibraryBookRow>('SELECT * FROM library_books WHERE id = ?')
    .get(id)
  return row ? toLibraryBook(row) : null
}

export function listLibraryBooks(): LibraryBook[] {
  const rows = store
    .get()
    .prepare<[], LibraryBookRow>('SELECT * FROM library_books ORDER BY created_at DESC, rowid DESC')
    .all()
  return rows.map(toLibraryBook)
}

export function deleteLibraryBook(id: string): void {
  store.get().prepare('DELETE FROM library_books WHERE id = ?').run(id)
}

export function upsertConversion(input: ConversionInput): LibraryConversion {
  store
    .get()
    .prepare(
      `INSERT INTO library_conversions (library_id, format, output_path, status, error)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(library_id, format) DO UPDATE SET
         output_path = excluded.output_path,
         status = excluded.status,
         error = excluded.error`
    )
    .run(input.libraryId, input.format, input.outputPath ?? null, input.status, input.error ?? null)
  return {
    libraryId: input.libraryId,
    format: input.format,
    status: input.status,
    ...(input.outputPath ? { outputPath: input.outputPath } : {}),
    ...(input.error ? { error: input.error } : {})
  }
}

export function getConversion(libraryId: string, format: string): LibraryConversion | null {
  const row = store
    .get()
    .prepare<[string, string], ConversionRow>(
      'SELECT * FROM library_conversions WHERE library_id = ? AND format = ?'
    )
    .get(libraryId, format)
  return row ? toConversion(row) : null
}

/** Marks a book as uploaded: stamps uploaded_at (now) and the device relpath. */
export function setUploaded(id: string, targetRelpath: string): void {
  store
    .get()
    .prepare('UPDATE library_books SET uploaded_at = ?, target_relpath = ? WHERE id = ?')
    .run(Date.now(), targetRelpath, id)
}

// ─── Library folders ──────────────────────────────────────────────────────────

interface LibraryFolderRow {
  id: string
  path: string
  added_at: number
}

function toLibraryFolder(row: LibraryFolderRow): LibraryFolder {
  return { id: row.id, path: row.path, addedAt: row.added_at }
}

/** Records a library folder. Throws on a path that is already a library folder. */
export function insertLibraryFolder(id: string, folderPath: string): LibraryFolder {
  const addedAt = Date.now()
  store
    .get()
    .prepare('INSERT INTO library_folders (id, path, added_at) VALUES (?, ?, ?)')
    .run(id, folderPath, addedAt)
  return { id, path: folderPath, addedAt }
}

/** Every library folder, in the order it was added. */
export function listLibraryFolders(): LibraryFolder[] {
  return store
    .get()
    .prepare<[], LibraryFolderRow>('SELECT * FROM library_folders ORDER BY added_at, rowid')
    .all()
    .map(toLibraryFolder)
}

export function getLibraryFolder(id: string): LibraryFolder | null {
  const row = store
    .get()
    .prepare<[string], LibraryFolderRow>('SELECT * FROM library_folders WHERE id = ?')
    .get(id)
  return row ? toLibraryFolder(row) : null
}

/** Forgets a folder; its books go with it (ON DELETE CASCADE). The files are never touched. */
export function deleteLibraryFolder(id: string): void {
  store.get().prepare('DELETE FROM library_folders WHERE id = ?').run(id)
}

export function listFolderBooks(folderId: string): LibraryBook[] {
  return store
    .get()
    .prepare<[string], LibraryBookRow>('SELECT * FROM library_books WHERE folder_id = ? ORDER BY rowid')
    .all(folderId)
    .map(toLibraryBook)
}

/** A folder book was renamed or moved (possibly to another library folder). */
export function updateFolderBookLocation(id: string, location: FolderBookLocation): void {
  store
    .get()
    .prepare(
      `UPDATE library_books
         SET folder_id = ?, original_path = ?, filename = ?, file_size = ?, file_mtime = ?
       WHERE id = ?`
    )
    .run(location.folderId, location.originalPath, location.filename, location.fileSize, location.fileMtime, id)
}

/** A folder book's file now holds different bytes: everything read from it is replaced. */
export function updateFolderBookContent(id: string, content: FolderBookContent): void {
  store
    .get()
    .prepare(
      `UPDATE library_books
         SET content_hash = ?, title = ?, author = ?, cover_key = ?, source_format = ?,
             file_size = ?, file_mtime = ?
       WHERE id = ?`
    )
    .run(
      content.contentHash,
      content.title,
      content.author ?? null,
      content.coverKey ?? null,
      content.sourceFormat,
      content.fileSize,
      content.fileMtime,
      id
    )
}
