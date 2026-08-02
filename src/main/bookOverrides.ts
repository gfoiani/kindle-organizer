import type Database from 'better-sqlite3'
import * as path from 'path'
import { app } from 'electron'
import type { KindleBook } from './kindle'
import { stripDocumentsBase } from './paths'
import { createCachedDb } from './sqlite'

interface OverrideRow {
  book_path: string
  title: string
  author: string | null
}

function getDbPath(): string {
  return path.join(app.getPath('userData'), 'overrides.db')
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_override (
      book_path TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      author    TEXT
    )
  `)
}

const store = createCachedDb(getDbPath, initSchema)

/** Closes the lazily-opened overrides DB handle. Called from `will-quit`. */
export function closeOverridesDb(): void {
  store.close()
}

export function setOverride(
  bookRelpath: string,
  title: string,
  author: string | undefined
): void {
  store
    .get()
    .prepare<[string, string, string | null]>(
      'INSERT OR REPLACE INTO book_override (book_path, title, author) VALUES (?, ?, ?)'
    )
    .run(bookRelpath, title, author ?? null)
}

export function applyOverrides(books: KindleBook[], documentsBase: string): KindleBook[] {
  const rows = store
    .get()
    .prepare<[], OverrideRow>('SELECT book_path, title, author FROM book_override')
    .all()

  if (rows.length === 0) return books

  const overrides = new Map(rows.map((r) => [r.book_path, r]))

  return books.map((book) => {
    const relpath = stripDocumentsBase(book.path, documentsBase)
    const ov = overrides.get(relpath)
    if (!ov) return book
    return { ...book, title: ov.title, author: ov.author ?? undefined }
  })
}
