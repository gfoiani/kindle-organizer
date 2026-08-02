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
  `)
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
    createdAt: row.created_at
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
          source_format, cover_key, target_relpath, uploaded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
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
      createdAt
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
    createdAt
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
