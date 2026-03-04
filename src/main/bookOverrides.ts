import Database from 'better-sqlite3'
import * as path from 'path'
import { app } from 'electron'
import type { KindleBook } from './kindle'

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

export function setOverride(
  bookRelpath: string,
  title: string,
  author: string | undefined
): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO book_override (book_path, title, author) VALUES (?, ?, ?)'
    )
    .run(bookRelpath, title, author ?? null)
}

export function applyOverrides(books: KindleBook[], documentsBase: string): KindleBook[] {
  const rows = getDb()
    .prepare('SELECT book_path, title, author FROM book_override')
    .all() as Array<{ book_path: string; title: string; author: string | null }>

  if (rows.length === 0) return books

  const overrides = new Map(rows.map((r) => [r.book_path, r]))

  return books.map((book) => {
    const relpath = book.path.startsWith(documentsBase)
      ? book.path.slice(documentsBase.length)
      : book.path
    const ov = overrides.get(relpath)
    if (!ov) return book
    return { ...book, title: ov.title, author: ov.author ?? undefined }
  })
}
