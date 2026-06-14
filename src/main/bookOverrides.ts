import Database from 'better-sqlite3'
import * as path from 'path'
import { app } from 'electron'
import type { KindleBook } from './kindle'
import { stripDocumentsBase } from './paths'

interface OverrideRow {
  book_path: string
  title: string
  author: string | null
}

let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(path.join(app.getPath('userData'), 'overrides.db'))
    _db.exec(`
      CREATE TABLE IF NOT EXISTS book_override (
        book_path TEXT PRIMARY KEY,
        title     TEXT NOT NULL,
        author    TEXT
      )
    `)
  }
  return _db
}

/** Closes the lazily-opened overrides DB handle. Called from `will-quit`. */
export function closeOverridesDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

export function setOverride(
  bookRelpath: string,
  title: string,
  author: string | undefined
): void {
  getDb()
    .prepare<[string, string, string | null]>(
      'INSERT OR REPLACE INTO book_override (book_path, title, author) VALUES (?, ?, ?)'
    )
    .run(bookRelpath, title, author ?? null)
}

export function applyOverrides(books: KindleBook[], documentsBase: string): KindleBook[] {
  const rows = getDb()
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
