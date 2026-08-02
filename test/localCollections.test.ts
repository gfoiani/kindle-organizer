import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import type { CalibreBook } from '../src/main/calibre'
import { AppError } from '../src/main/appErrors'
import {
  addBookToCollection,
  createCollection,
  deleteCollections,
  ensureCollectionsContain,
  getAllBookTags,
  getCollectionBooks,
  getCollections,
  importFromCalibre,
  renameCollections
} from '../src/main/localCollections'

// Each test gets an isolated userData dir (fresh collections.db).
beforeEach(() => {
  freshUserData()
})

afterAll(() => {
  cleanupUserDataDirs()
})

function findCollection(name: string) {
  return getCollections().find((c) => c.name === name)
}

describe('getAllBookTags — authoritative seeding (H1)', () => {
  test('seeds every known relpath with an empty array', () => {
    // Arrange — a book the app knows about but that is in no collection.
    const known = ['A/Untagged.azw3', 'B/AlsoUntagged.azw3']

    // Act
    const map = getAllBookTags(known)

    // Assert — each known book is present with [] so the write clears its tags.
    expect(map.get('A/Untagged.azw3')).toEqual([])
    expect(map.get('B/AlsoUntagged.azw3')).toEqual([])
  })

  test('layers current collection membership on top of the seeded relpaths', () => {
    // Arrange
    const fiction = createCollection('Fiction')
    const favorites = createCollection('Favorites')
    addBookToCollection(fiction.id, 'A/Book.azw3')
    addBookToCollection(favorites.id, 'A/Book.azw3')

    // Act — the book is known AND tagged.
    const map = getAllBookTags(['A/Book.azw3', 'B/Untagged.azw3'])

    // Assert
    expect([...(map.get('A/Book.azw3') ?? [])].sort()).toEqual(['Favorites', 'Fiction'])
    expect(map.get('B/Untagged.azw3')).toEqual([])
  })

  test('H1: a known book with no remaining membership resolves to [] (present, not absent)', () => {
    // Arrange — a collection exists but the de-tagged book is in NO collection.
    createCollection('Fiction')
    const known = 'A/RemovedFromAll.azw3'

    // Act — the relpath is still a known device book, just untagged now.
    const map = getAllBookTags([known])

    // Assert — it is present with [] (so the device write clears its stale tags),
    // not absent (which would have left the old tags on the device — the H1 bug).
    expect(map.has(known)).toBe(true)
    expect(map.get(known)).toEqual([])
  })

  test('includes books with DB membership even when not in knownRelpaths', () => {
    // Arrange
    const fiction = createCollection('Fiction')
    addBookToCollection(fiction.id, 'Orphan/Book.azw3')

    // Act — knownRelpaths does NOT include the orphan.
    const map = getAllBookTags([])

    // Assert — manual DB membership is preserved.
    expect(map.get('Orphan/Book.azw3')).toEqual(['Fiction'])
  })

  test('does not mutate the array stored in the map across reads', () => {
    const fiction = createCollection('Fiction')
    addBookToCollection(fiction.id, 'A/Book.azw3')

    const first = getAllBookTags(['A/Book.azw3']).get('A/Book.azw3')
    const second = getAllBookTags(['A/Book.azw3']).get('A/Book.azw3')

    expect(first).toEqual(['Fiction'])
    expect(second).toEqual(['Fiction'])
  })

  test('defaults to an empty map when no relpaths are known and no membership exists', () => {
    expect(getAllBookTags().size).toBe(0)
  })
})

describe('importFromCalibre — upsert + reconcile (H2)', () => {
  test('creates a calibre-sourced collection per tag with its books', () => {
    // Arrange
    const books: CalibreBook[] = [
      { lpath: 'documents/A/Book.azw3', tags: ['Sci-Fi'] },
      { lpath: 'documents/B/Book.azw3', tags: ['Sci-Fi', 'Favorites'] }
    ]

    // Act
    importFromCalibre(books)

    // Assert
    const sciFi = findCollection('Sci-Fi')
    expect(sciFi?.source).toBe('calibre')
    expect(getCollectionBooks(sciFi!.id).sort()).toEqual(['A/Book.azw3', 'B/Book.azw3'])
    expect(findCollection('Favorites')?.bookCount).toBe(1)
  })

  test('H2: keeps a STABLE id across re-imports (upsert by name, not delete+recreate)', () => {
    // Arrange
    const books: CalibreBook[] = [{ lpath: 'documents/A/Book.azw3', tags: ['Sci-Fi'] }]
    importFromCalibre(books)
    const idBefore = findCollection('Sci-Fi')!.id

    // Act — re-sync the same export (happens on every load/refresh/hot-plug).
    importFromCalibre(books)
    const idAfter = findCollection('Sci-Fi')!.id

    // Assert — the id is preserved, so UI state keyed on it stays valid.
    expect(idAfter).toBe(idBefore)
  })

  test('H2: preserves a manually-added collection_books row across a re-import', () => {
    // Arrange — import a calibre collection, then the user manually adds a book.
    importFromCalibre([{ lpath: 'documents/A/FromCalibre.azw3', tags: ['Sci-Fi'] }])
    const sciFiId = findCollection('Sci-Fi')!.id
    addBookToCollection(sciFiId, 'Z/ManuallyAdded.azw3')

    // Act — the next sync re-imports the same (unchanged) calibre export.
    importFromCalibre([{ lpath: 'documents/A/FromCalibre.azw3', tags: ['Sci-Fi'] }])

    // Assert — the manually-added membership survives (the H2 regression target).
    expect(getCollectionBooks(sciFiId).sort()).toEqual([
      'A/FromCalibre.azw3',
      'Z/ManuallyAdded.azw3'
    ])
  })

  test('drops a calibre collection only when its tag vanishes from the export', () => {
    // Arrange
    importFromCalibre([
      { lpath: 'documents/A/Book.azw3', tags: ['KeepTag'] },
      { lpath: 'documents/B/Book.azw3', tags: ['DropTag'] }
    ])
    expect(findCollection('DropTag')).toBeDefined()

    // Act — re-import without DropTag.
    importFromCalibre([{ lpath: 'documents/A/Book.azw3', tags: ['KeepTag'] }])

    // Assert
    expect(findCollection('KeepTag')).toBeDefined()
    expect(findCollection('DropTag')).toBeUndefined()
  })

  test('does not touch local (non-calibre) collections during import', () => {
    // Arrange
    const local = createCollection('My Local List')
    addBookToCollection(local.id, 'L/Book.azw3')

    // Act
    importFromCalibre([{ lpath: 'documents/A/Book.azw3', tags: ['Sci-Fi'] }])

    // Assert — the local collection and its books are untouched.
    const after = findCollection('My Local List')
    expect(after?.id).toBe(local.id)
    expect(after?.source).toBe('local')
    expect(getCollectionBooks(local.id)).toEqual(['L/Book.azw3'])
  })

  test('strips the documents/ prefix from calibre lpaths when storing membership', () => {
    importFromCalibre([{ lpath: 'documents/Nested/Dir/Book.azw3', tags: ['Tag'] }])
    const id = findCollection('Tag')!.id
    expect(getCollectionBooks(id)).toEqual(['Nested/Dir/Book.azw3'])
  })

  test('an empty export removes all calibre collections but is otherwise a no-op', () => {
    importFromCalibre([{ lpath: 'documents/A/Book.azw3', tags: ['Sci-Fi'] }])
    importFromCalibre([])
    expect(findCollection('Sci-Fi')).toBeUndefined()
  })
})

describe('ensureCollectionsContain — generic batch writer', () => {
  test('creates a new local collection holding the given books', () => {
    // Act
    ensureCollectionsContain([
      { name: 'Thriller / Glenn Cooper', relpaths: ['Cooper/A.azw3', 'Cooper/B.azw3'] }
    ])

    // Assert
    const sub = findCollection('Thriller / Glenn Cooper')
    expect(sub?.source).toBe('local')
    expect(getCollectionBooks(sub!.id).sort()).toEqual(['Cooper/A.azw3', 'Cooper/B.azw3'])
  })

  test('re-running with the same payload is an idempotent no-op (no throw, no dupes)', () => {
    // Arrange
    const payload = [{ name: 'Thriller / Lee Child', relpaths: ['Child/A.azw3'] }]
    ensureCollectionsContain(payload)
    const idBefore = findCollection('Thriller / Lee Child')!.id

    // Act — re-run.
    ensureCollectionsContain(payload)

    // Assert — same collection, same single membership row.
    const after = findCollection('Thriller / Lee Child')!
    expect(after.id).toBe(idBefore)
    expect(after.bookCount).toBe(1)
  })

  test('adds books to an existing collection without duplicating membership', () => {
    // Arrange — a pre-existing collection with one book.
    const existing = createCollection('Thriller / Glenn Cooper')
    addBookToCollection(existing.id, 'Cooper/A.azw3')

    // Act — re-add A and add a new B.
    ensureCollectionsContain([
      { name: 'Thriller / Glenn Cooper', relpaths: ['Cooper/A.azw3', 'Cooper/B.azw3'] }
    ])

    // Assert — id preserved, A not duplicated, B added.
    const after = findCollection('Thriller / Glenn Cooper')!
    expect(after.id).toBe(existing.id)
    expect(getCollectionBooks(after.id).sort()).toEqual(['Cooper/A.azw3', 'Cooper/B.azw3'])
  })

  test('processes multiple entries and skips blank names / relpaths', () => {
    // Act
    ensureCollectionsContain([
      { name: 'Thriller / Glenn Cooper', relpaths: ['Cooper/A.azw3', ''] },
      { name: '   ', relpaths: ['ignored.azw3'] },
      { name: 'Thriller / Lee Child', relpaths: ['Child/B.azw3'] }
    ])

    // Assert
    expect(getCollectionBooks(findCollection('Thriller / Glenn Cooper')!.id)).toEqual([
      'Cooper/A.azw3'
    ])
    expect(findCollection('Thriller / Lee Child')?.bookCount).toBe(1)
    expect(getCollections().some((c) => c.name.trim() === '')).toBe(false)
  })

  test('returns the refreshed collection list', () => {
    const result = ensureCollectionsContain([
      { name: 'Thriller / Glenn Cooper', relpaths: ['Cooper/A.azw3'] }
    ])
    expect(result.find((c) => c.name === 'Thriller / Glenn Cooper')?.bookCount).toBe(1)
  })
})

describe('createCollection — name validation', () => {
  test('rejects a duplicate name with COLLECTION_NAME_TAKEN', () => {
    // Arrange
    createCollection('Thriller')

    // Act / Assert — a raw SQLITE_CONSTRAINT leaks an untranslatable message,
    // so the store maps it to a code the renderer can localize.
    expect(() => createCollection('Thriller')).toThrow(AppError)
    expect(() => createCollection('Thriller')).toThrow('COLLECTION_NAME_TAKEN')
  })

  test('rejects a blank name with COLLECTION_NAME_EMPTY', () => {
    expect(() => createCollection('   ')).toThrow('COLLECTION_NAME_EMPTY')
    expect(getCollections()).toHaveLength(0)
  })

  test('stores the trimmed name', () => {
    const created = createCollection('  Sci-Fi  ')
    expect(created.name).toBe('Sci-Fi')
    expect(findCollection('Sci-Fi')).toBeDefined()
  })
})

describe('renameCollections — name validation', () => {
  test('rejects a rename onto an existing name with COLLECTION_NAME_TAKEN', () => {
    // Arrange
    const thriller = createCollection('Thriller')
    createCollection('Horror')

    // Act / Assert
    expect(() => renameCollections([{ id: thriller.id, newName: 'Horror' }])).toThrow(
      'COLLECTION_NAME_TAKEN'
    )
    expect(findCollection('Thriller')).toBeDefined()
  })

  test('rejects a blank name with COLLECTION_NAME_EMPTY', () => {
    const thriller = createCollection('Thriller')
    expect(() => renameCollections([{ id: thriller.id, newName: '  ' }])).toThrow(
      'COLLECTION_NAME_EMPTY'
    )
    expect(findCollection('Thriller')).toBeDefined()
  })

  test('allows renaming a collection to its own (trimmed) name', () => {
    const thriller = createCollection('Thriller')
    expect(() => renameCollections([{ id: thriller.id, newName: ' Thriller ' }])).not.toThrow()
    expect(findCollection('Thriller')?.id).toBe(thriller.id)
  })
})

describe('deleteCollections — transactional batch', () => {
  test('deletes every id in one call and returns the refreshed list', () => {
    // Arrange — a genre plus its author sub-collections (the cascade-delete shape).
    const genre = createCollection('Thriller')
    const a = createCollection('Thriller / Glenn Cooper')
    const b = createCollection('Thriller / Lee Child')
    createCollection('Horror')

    // Act
    const remaining = deleteCollections([genre.id, a.id, b.id])

    // Assert
    expect(remaining.map((c) => c.name)).toEqual(['Horror'])
  })

  test('ignores unknown ids instead of throwing', () => {
    createCollection('Horror')
    expect(() => deleteCollections(['does-not-exist'])).not.toThrow()
    expect(getCollections()).toHaveLength(1)
  })

  test('cascades the membership rows of the deleted collections', () => {
    const genre = createCollection('Thriller')
    addBookToCollection(genre.id, 'A/Book.azw3')

    deleteCollections([genre.id])

    expect(getAllBookTags(['A/Book.azw3']).get('A/Book.azw3')).toEqual([])
  })

  test('an empty id list is a no-op', () => {
    createCollection('Horror')
    expect(deleteCollections([])).toHaveLength(1)
  })
})

describe('renameCollections — transactional batch', () => {
  test('renames a genre and its author sub-collections in one call', () => {
    // Arrange
    const genre = createCollection('Thriller')
    const child = createCollection('Thriller / Glenn Cooper')

    // Act
    const after = renameCollections([
      { id: genre.id, newName: 'Giallo' },
      { id: child.id, newName: 'Giallo / Glenn Cooper' }
    ])

    // Assert — ids are stable, so UI state keyed on them survives.
    expect(after.map((c) => c.name).sort()).toEqual(['Giallo', 'Giallo / Glenn Cooper'])
    expect(findCollection('Giallo')?.id).toBe(genre.id)
    expect(findCollection('Giallo / Glenn Cooper')?.id).toBe(child.id)
  })

  test('rolls back ENTIRELY when one target collides with an existing name', () => {
    // Arrange — "Horror" is taken, so the second rename must fail...
    const genre = createCollection('Thriller')
    const child = createCollection('Thriller / Glenn Cooper')
    createCollection('Horror')

    // Act / Assert
    expect(() =>
      renameCollections([
        { id: child.id, newName: 'Giallo / Glenn Cooper' },
        { id: genre.id, newName: 'Horror' }
      ])
    ).toThrow('COLLECTION_NAME_TAKEN')

    // ...and the FIRST rename must not survive: a half-renamed tree is the bug
    // the per-item loop used to leave behind.
    expect(findCollection('Thriller')?.id).toBe(genre.id)
    expect(findCollection('Thriller / Glenn Cooper')?.id).toBe(child.id)
    expect(findCollection('Giallo / Glenn Cooper')).toBeUndefined()
  })

  test('tolerates a rename sequence that reuses a name freed within the batch', () => {
    // Arrange — "Thriller" is only free because the first target vacates it.
    const first = createCollection('Thriller')
    const second = createCollection('Giallo')

    // Act
    renameCollections([
      { id: first.id, newName: 'Crime' },
      { id: second.id, newName: 'Thriller' }
    ])

    // Assert
    expect(findCollection('Crime')?.id).toBe(first.id)
    expect(findCollection('Thriller')?.id).toBe(second.id)
  })

  test('rejects a blank target name with COLLECTION_NAME_EMPTY', () => {
    const genre = createCollection('Thriller')
    expect(() => renameCollections([{ id: genre.id, newName: '  ' }])).toThrow(
      'COLLECTION_NAME_EMPTY'
    )
    expect(findCollection('Thriller')).toBeDefined()
  })

  test('an empty target list is a no-op', () => {
    createCollection('Horror')
    expect(renameCollections([])).toHaveLength(1)
  })
})

describe('connection caching', () => {
  test('a userData switch retires the stale handle instead of writing the old DB', () => {
    // Arrange — populate the first profile.
    createCollection('Thriller')
    expect(getCollections()).toHaveLength(1)

    // Act — the app never swaps userData, but the test harness does; the cached
    // handle must follow the path or every later test would read this DB.
    freshUserData()

    // Assert
    expect(getCollections()).toEqual([])
    createCollection('Thriller')
    expect(getCollections()).toHaveLength(1)
  })
})
