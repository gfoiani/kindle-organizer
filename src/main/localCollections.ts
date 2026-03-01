import { app } from 'electron'
import Database from 'better-sqlite3'
import path from 'path'
import type { Collection } from './kindle'
import type { CalibreBook } from './calibre'

function getDbPath(): string {
  return path.join(app.getPath('userData'), 'collections.db')
}

function openDb(): Database.Database {
  const db = new Database(getDbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL DEFAULT 'local'
    );

    CREATE TABLE IF NOT EXISTS collection_books (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      book_relpath TEXT NOT NULL,
      PRIMARY KEY (collection_id, book_relpath)
    );
  `)
}

export function getCollections(): Collection[] {
  const db = openDb()
  try {
    initSchema(db)
    const rows = db
      .prepare(
        `
        SELECT
          c.id,
          c.name,
          c.source,
          COUNT(cb.book_relpath) AS bookCount
        FROM collections c
        LEFT JOIN collection_books cb ON c.id = cb.collection_id
        GROUP BY c.id, c.name, c.source
        ORDER BY c.name
      `
      )
      .all() as Array<{ id: string; name: string; source: string; bookCount: number }>

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      source: row.source as 'calibre' | 'local',
      bookCount: row.bookCount
    }))
  } finally {
    db.close()
  }
}

export function getCollectionBooks(collectionId: string): string[] {
  const db = openDb()
  try {
    initSchema(db)
    const rows = db
      .prepare('SELECT book_relpath FROM collection_books WHERE collection_id = ?')
      .all(collectionId) as Array<{ book_relpath: string }>

    return rows.map((row) => row.book_relpath)
  } finally {
    db.close()
  }
}

export function getBookCollections(bookRelpath: string): string[] {
  const db = openDb()
  try {
    initSchema(db)
    const rows = db
      .prepare('SELECT collection_id FROM collection_books WHERE book_relpath = ?')
      .all(bookRelpath) as Array<{ collection_id: string }>

    return rows.map((row) => row.collection_id)
  } finally {
    db.close()
  }
}

export function getAllBookTags(): Map<string, string[]> {
  const db = openDb()
  try {
    initSchema(db)
    const rows = db
      .prepare(
        `
        SELECT cb.book_relpath, c.name
        FROM collection_books cb
        JOIN collections c ON c.id = cb.collection_id
        ORDER BY cb.book_relpath
      `
      )
      .all() as Array<{ book_relpath: string; name: string }>

    const result = new Map<string, string[]>()
    for (const row of rows) {
      const tags = result.get(row.book_relpath) ?? []
      tags.push(row.name)
      result.set(row.book_relpath, tags)
    }
    return result
  } finally {
    db.close()
  }
}

export function createCollection(name: string): Collection {
  const db = openDb()
  try {
    initSchema(db)
    const id = crypto.randomUUID()
    db.prepare(`INSERT INTO collections (id, name, source) VALUES (?, ?, 'local')`).run(id, name)
    return { id, name, source: 'local', bookCount: 0 }
  } finally {
    db.close()
  }
}

export function renameCollection(id: string, newName: string): void {
  const db = openDb()
  try {
    initSchema(db)
    db.prepare(`UPDATE collections SET name = ? WHERE id = ?`).run(newName, id)
  } finally {
    db.close()
  }
}

export function deleteCollection(id: string): void {
  const db = openDb()
  try {
    initSchema(db)
    db.prepare(`DELETE FROM collections WHERE id = ?`).run(id)
  } finally {
    db.close()
  }
}

export function addBookToCollection(collectionId: string, bookRelpath: string): void {
  const db = openDb()
  try {
    initSchema(db)
    db
      .prepare(
        `INSERT OR IGNORE INTO collection_books (collection_id, book_relpath) VALUES (?, ?)`
      )
      .run(collectionId, bookRelpath)
  } finally {
    db.close()
  }
}

export function removeBookFromCollection(collectionId: string, bookRelpath: string): void {
  const db = openDb()
  try {
    initSchema(db)
    db
      .prepare(`DELETE FROM collection_books WHERE collection_id = ? AND book_relpath = ?`)
      .run(collectionId, bookRelpath)
  } finally {
    db.close()
  }
}

export function importFromCalibre(calibreBooks: CalibreBook[]): void {
  const db = openDb()
  try {
    initSchema(db)

    const deleteCalibreCollections = db.prepare(`DELETE FROM collections WHERE source = 'calibre'`)

    const insertCollection = db.prepare(
      `INSERT INTO collections (id, name, source)
       VALUES (?, ?, 'calibre')
       ON CONFLICT(name) DO NOTHING`
    )

    const getCollectionByName = db.prepare(`SELECT id FROM collections WHERE name = ?`)

    const insertBook = db.prepare(
      `INSERT OR IGNORE INTO collection_books (collection_id, book_relpath) VALUES (?, ?)`
    )

    const doImport = db.transaction(() => {
      deleteCalibreCollections.run()

      const tagToId = new Map<string, string>()

      for (const book of calibreBooks) {
        for (const tag of book.tags) {
          if (!tagToId.has(tag)) {
            const id = crypto.randomUUID()
            insertCollection.run(id, tag)
            const row = getCollectionByName.get(tag) as { id: string } | undefined
            tagToId.set(tag, row?.id ?? id)
          }

          const relpath = book.lpath.startsWith('documents/')
            ? book.lpath.slice('documents/'.length)
            : book.lpath

          const collectionId = tagToId.get(tag)!
          insertBook.run(collectionId, relpath)
        }
      }
    })

    doImport()
  } finally {
    db.close()
  }
}
