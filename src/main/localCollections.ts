import { app } from 'electron'
import type Database from 'better-sqlite3'
import path from 'path'
import type { Collection } from './kindle'
import type { CalibreBook } from './calibre'
import { stripDocumentsPrefix } from './paths'
import { createCachedDb } from './sqlite'
import { AppError } from './appErrors'

function getDbPath(): string {
  return path.join(app.getPath('userData'), 'collections.db')
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

// One cached handle for the process lifetime instead of an open/init/close cycle
// per call — see sqlite.ts for why the path is re-checked on every get().
const store = createCachedDb(getDbPath, initSchema)

/** Closes the collections DB handle. Called from `will-quit`. */
export function closeCollectionsDb(): void {
  store.close()
}

// ─── Name validation ─────────────────────────────────────────────────────────
// Collection names are UNIQUE in the schema, so a duplicate used to surface as a
// raw SQLITE_CONSTRAINT whose message the UI could not translate (and, in the
// renderer, was swallowed to the console). These guards fail with a stable code
// the renderer maps to a localized message instead.

/** Trims a name, rejecting one that is blank once trimmed. */
function requireName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new AppError('COLLECTION_NAME_EMPTY')
  return name
}

/** Throws COLLECTION_NAME_TAKEN when `name` already belongs to another collection. */
function assertNameFree(db: Database.Database, name: string, exceptId?: string): void {
  const row = db
    .prepare<[string], { id: string }>('SELECT id FROM collections WHERE name = ?')
    .get(name)
  if (row && row.id !== exceptId) throw new AppError('COLLECTION_NAME_TAKEN')
}

interface CollectionRow {
  id: string
  name: string
  source: string
  bookCount: number
}

export function getCollections(): Collection[] {
  const rows = store
    .get()
    .prepare<[], CollectionRow>(
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
    .all()

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    source: row.source as 'calibre' | 'local',
    bookCount: row.bookCount
  }))
}

export function getCollectionBooks(collectionId: string): string[] {
  const rows = store
    .get()
    .prepare<[string], { book_relpath: string }>(
      'SELECT book_relpath FROM collection_books WHERE collection_id = ?'
    )
    .all(collectionId)

  return rows.map((row) => row.book_relpath)
}

export function getBookCollections(bookRelpath: string): string[] {
  const rows = store
    .get()
    .prepare<[string], { collection_id: string }>(
      'SELECT collection_id FROM collection_books WHERE book_relpath = ?'
    )
    .all(bookRelpath)

  return rows.map((row) => row.collection_id)
}

/**
 * Builds the authoritative book-relpath → tags map for writing to the device.
 *
 * Every relpath in `knownRelpaths` is seeded with an empty array so that a book
 * the user removed from all collections is written back with `tags: []` (the
 * H1 fix: sync is authoritative, not additive-only). Tags from current
 * collection membership are then layered on top. Books not in `knownRelpaths`
 * that still have tags are also included, so manual DB membership is preserved.
 */
export function getAllBookTags(knownRelpaths: readonly string[] = []): Map<string, string[]> {
  const rows = store
    .get()
    .prepare<[], { book_relpath: string; name: string }>(
      `
      SELECT cb.book_relpath, c.name
      FROM collection_books cb
      JOIN collections c ON c.id = cb.collection_id
      ORDER BY cb.book_relpath
    `
    )
    .all()

  const result = new Map<string, string[]>()
  // Seed every known device book with an explicit empty array.
  for (const relpath of knownRelpaths) {
    result.set(relpath, [])
  }
  // Layer current collection membership on top (immutable: never push in place).
  for (const row of rows) {
    const tags = result.get(row.book_relpath) ?? []
    result.set(row.book_relpath, [...tags, row.name])
  }
  return result
}

/** A "<collection name> contains these book relpaths" instruction for the batch writer. */
export interface CollectionMembership {
  name: string
  relpaths: string[]
}

/**
 * Generic batch writer: ensures each named collection exists (created as a
 * `local` collection when absent) and contains the given book relpaths.
 *
 * Idempotent — re-running with the same payload is a no-op: both the collection
 * row (`INSERT OR IGNORE` on the UNIQUE name) and each membership row
 * (`INSERT OR IGNORE`) tolerate duplicates, sidestepping the throw `createCollection`
 * would hit on a duplicate name. Runs in a single transaction so a mid-way
 * failure rolls back cleanly.
 *
 * Hierarchy is NOT understood here — names arrive pre-composed by the caller
 * (the renderer's collectionHierarchy util). This keeps the main process a
 * dumb, reusable primitive. Returns the refreshed collection list.
 */
export function ensureCollectionsContain(entries: CollectionMembership[]): Collection[] {
  const db = store.get()

  const getByName = db.prepare<[string], { id: string }>(`SELECT id FROM collections WHERE name = ?`)
  const insertCollection = db.prepare<[string, string]>(
    `INSERT OR IGNORE INTO collections (id, name, source) VALUES (?, ?, 'local')`
  )
  const insertBook = db.prepare<[string, string]>(
    `INSERT OR IGNORE INTO collection_books (collection_id, book_relpath) VALUES (?, ?)`
  )

  const apply = db.transaction(() => {
    for (const entry of entries) {
      const name = entry.name.trim()
      if (!name) continue
      let row = getByName.get(name)
      if (!row) {
        insertCollection.run(crypto.randomUUID(), name)
        row = getByName.get(name)
      }
      if (!row) continue
      for (const relpath of entry.relpaths) {
        if (relpath) insertBook.run(row.id, relpath)
      }
    }
  })

  apply()
  return getCollections()
}

export function createCollection(name: string): Collection {
  const db = store.get()
  const trimmed = requireName(name)
  assertNameFree(db, trimmed)

  const id = crypto.randomUUID()
  db.prepare(`INSERT INTO collections (id, name, source) VALUES (?, ?, 'local')`).run(id, trimmed)
  return { id, name: trimmed, source: 'local', bookCount: 0 }
}

/** A single "rename this collection to that name" instruction for the batch. */
export interface RenameTarget {
  id: string
  newName: string
}

/**
 * Renames several collections in ONE transaction.
 *
 * This is the cascade-rename primitive (a genre plus every "<genre> / <author>"
 * child). Each target's name is checked for a collision immediately before its
 * own UPDATE rather than all up front, so a batch that legitimately reuses a
 * name freed earlier in the same batch ("A"→"C" then "B"→"A") still succeeds.
 * A collision throws, and the transaction rolls back every earlier rename — the
 * per-item loop this replaces could leave a half-renamed tree behind.
 *
 * Returns the refreshed collection list.
 */
export function renameCollections(targets: RenameTarget[]): Collection[] {
  const db = store.get()
  const update = db.prepare<[string, string]>(`UPDATE collections SET name = ? WHERE id = ?`)

  const apply = db.transaction(() => {
    for (const target of targets) {
      const newName = requireName(target.newName)
      assertNameFree(db, newName, target.id)
      update.run(newName, target.id)
    }
  })

  apply()
  return getCollections()
}

/**
 * Deletes several collections in ONE transaction (membership rows CASCADE).
 * Unknown ids are ignored. Returns the refreshed collection list.
 */
export function deleteCollections(ids: string[]): Collection[] {
  const db = store.get()
  const remove = db.prepare<[string]>(`DELETE FROM collections WHERE id = ?`)

  const apply = db.transaction(() => {
    for (const id of ids) remove.run(id)
  })

  apply()
  return getCollections()
}

export function addBookToCollection(collectionId: string, bookRelpath: string): void {
  store
    .get()
    .prepare<[string, string]>(
      `INSERT OR IGNORE INTO collection_books (collection_id, book_relpath) VALUES (?, ?)`
    )
    .run(collectionId, bookRelpath)
}

export function removeBookFromCollection(collectionId: string, bookRelpath: string): void {
  store
    .get()
    .prepare<[string, string]>(
      `DELETE FROM collection_books WHERE collection_id = ? AND book_relpath = ?`
    )
    .run(collectionId, bookRelpath)
}

/**
 * Imports Calibre tag-collections into the local store.
 *
 * H2 fix: this used to DELETE every `source='calibre'` collection and recreate
 * it under a fresh UUID, which wiped manual additions and broke any UI state
 * keyed on the old id on every sync. It now:
 *   - upserts each Calibre tag by name, keeping its STABLE id (`ON CONFLICT(name)`),
 *   - additively reconciles `collection_books` (INSERT OR IGNORE) so books the
 *     user manually added to a Calibre-sourced collection survive the sync,
 *   - drops only the Calibre collections whose tag no longer exists in the
 *     export at all.
 */
export function importFromCalibre(calibreBooks: CalibreBook[]): void {
  const db = store.get()

  const upsertCollection = db.prepare<[string, string]>(
    `INSERT INTO collections (id, name, source)
     VALUES (?, ?, 'calibre')
     ON CONFLICT(name) DO UPDATE SET source = 'calibre'`
  )

  const getCollectionByName = db.prepare<[string], { id: string }>(
    `SELECT id FROM collections WHERE name = ?`
  )

  const insertBook = db.prepare<[string, string]>(
    `INSERT OR IGNORE INTO collection_books (collection_id, book_relpath) VALUES (?, ?)`
  )

  const listCalibreCollections = db.prepare<[], { id: string; name: string }>(
    `SELECT id, name FROM collections WHERE source = 'calibre'`
  )

  const deleteById = db.prepare<[string]>(`DELETE FROM collections WHERE id = ?`)

  const doImport = db.transaction(() => {
    const tagToId = new Map<string, string>()
    const seenTags = new Set<string>()

    for (const book of calibreBooks) {
      for (const tag of book.tags) {
        seenTags.add(tag)
        if (!tagToId.has(tag)) {
          // Keep the existing id when the collection already exists (stable id).
          upsertCollection.run(crypto.randomUUID(), tag)
          const row = getCollectionByName.get(tag)
          if (row) tagToId.set(tag, row.id)
        }

        const relpath = stripDocumentsPrefix(book.lpath)
        const collectionId = tagToId.get(tag)
        if (collectionId) insertBook.run(collectionId, relpath)
      }
    }

    // Remove Calibre collections whose tag vanished from the export entirely
    // (their collection_books rows CASCADE-delete).
    for (const collection of listCalibreCollections.all()) {
      if (!seenTags.has(collection.name)) deleteById.run(collection.id)
    }
  })

  doImport()
}
