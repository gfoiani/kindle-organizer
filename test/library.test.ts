import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import path from 'path'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import {
  deleteLibraryBook,
  deleteLibraryFolder,
  findByContentHash,
  getConversion,
  getLibraryBook,
  getLibraryFolder,
  insertLibraryBook,
  insertLibraryFolder,
  listFolderBooks,
  listLibraryBooks,
  listLibraryFolders,
  setUploaded,
  updateFolderBookContent,
  updateFolderBookLocation,
  upsertConversion,
  type LibraryBookInput
} from '../src/main/library'

// Each test gets an isolated userData dir (fresh library.db).
beforeEach(() => {
  freshUserData()
})

afterAll(() => {
  cleanupUserDataDirs()
})

function sampleInput(overrides: Partial<LibraryBookInput> = {}): LibraryBookInput {
  return {
    id: 'book-1',
    contentHash: 'hash-1',
    originalPath: '/lib/book-1/original.epub',
    filename: 'book.epub',
    title: 'A Sample Book',
    author: 'Sample Author',
    sourceFormat: 'epub',
    ...overrides
  }
}

describe('insertLibraryBook / findByContentHash', () => {
  test('persists a book and reads it back by content hash', () => {
    // Act
    const inserted = insertLibraryBook(sampleInput())

    // Assert
    expect(inserted.id).toBe('book-1')
    expect(inserted.contentHash).toBe('hash-1')
    expect(inserted.title).toBe('A Sample Book')
    expect(inserted.author).toBe('Sample Author')
    expect(inserted.sourceFormat).toBe('epub')
    expect(typeof inserted.createdAt).toBe('number')

    const found = findByContentHash('hash-1')
    expect(found?.id).toBe('book-1')
  })

  test('returns null for an unknown content hash', () => {
    expect(findByContentHash('nope')).toBeNull()
  })

  test('omits author when none was provided', () => {
    const book = insertLibraryBook(sampleInput({ id: 'b2', contentHash: 'h2', author: undefined }))
    expect(book.author).toBeUndefined()
    expect(findByContentHash('h2')?.author).toBeUndefined()
  })

  test('rejects a duplicate content hash (UNIQUE constraint)', () => {
    insertLibraryBook(sampleInput())
    expect(() => insertLibraryBook(sampleInput({ id: 'other-id' }))).toThrow()
  })

  test('carries coverKey and targetRelpath through', () => {
    const book = insertLibraryBook(
      sampleInput({ id: 'b3', contentHash: 'h3', coverKey: 'abc123', targetRelpath: 'book.azw3' })
    )
    expect(book.coverKey).toBe('abc123')
    expect(findByContentHash('h3')?.targetRelpath).toBe('book.azw3')
  })
})

describe('listLibraryBooks / getLibraryBook', () => {
  test('lists every stored book', () => {
    insertLibraryBook(sampleInput({ id: 'a', contentHash: 'ha' }))
    insertLibraryBook(sampleInput({ id: 'b', contentHash: 'hb' }))

    const ids = listLibraryBooks().map((b) => b.id)
    expect(ids).toHaveLength(2)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
  })

  test('getLibraryBook returns the book by id, or null when absent', () => {
    insertLibraryBook(sampleInput({ id: 'x', contentHash: 'hx' }))
    expect(getLibraryBook('x')?.id).toBe('x')
    expect(getLibraryBook('missing')).toBeNull()
  })

  test('returns an empty list when nothing is stored', () => {
    expect(listLibraryBooks()).toEqual([])
  })
})

describe('deleteLibraryBook', () => {
  test('removes the book row', () => {
    insertLibraryBook(sampleInput({ id: 'del', contentHash: 'hdel' }))
    deleteLibraryBook('del')
    expect(getLibraryBook('del')).toBeNull()
  })

  test('cascades to the book conversions (FK ON DELETE CASCADE)', () => {
    insertLibraryBook(sampleInput({ id: 'c', contentHash: 'hc' }))
    upsertConversion({ libraryId: 'c', format: 'azw3', status: 'done', outputPath: '/out.azw3' })
    expect(getConversion('c', 'azw3')).not.toBeNull()

    deleteLibraryBook('c')

    expect(getConversion('c', 'azw3')).toBeNull()
  })
})

describe('upsertConversion / getConversion', () => {
  test('inserts a conversion then updates it in place (same PK)', () => {
    insertLibraryBook(sampleInput({ id: 'conv', contentHash: 'hconv' }))

    upsertConversion({ libraryId: 'conv', format: 'azw3', status: 'converting' })
    expect(getConversion('conv', 'azw3')?.status).toBe('converting')

    upsertConversion({
      libraryId: 'conv',
      format: 'azw3',
      status: 'done',
      outputPath: '/lib/conv/azw3.azw3'
    })
    const done = getConversion('conv', 'azw3')
    expect(done?.status).toBe('done')
    expect(done?.outputPath).toBe('/lib/conv/azw3.azw3')
  })

  test('records an error message on a failed conversion', () => {
    insertLibraryBook(sampleInput({ id: 'err', contentHash: 'herr' }))
    upsertConversion({ libraryId: 'err', format: 'mobi', status: 'error', error: 'boom' })
    const c = getConversion('err', 'mobi')
    expect(c?.status).toBe('error')
    expect(c?.error).toBe('boom')
  })

  test('getConversion returns null for an unknown pair', () => {
    expect(getConversion('nobody', 'azw3')).toBeNull()
  })
})

describe('setUploaded', () => {
  test('stamps uploaded_at and target_relpath on the book', () => {
    insertLibraryBook(sampleInput({ id: 'up', contentHash: 'hup' }))

    setUploaded('up', 'A Sample Book.azw3')

    const book = getLibraryBook('up')
    expect(book?.targetRelpath).toBe('A Sample Book.azw3')
    expect(typeof book?.uploadedAt).toBe('number')
  })
})

describe('library folders', () => {
  test('stores folders and reads them back in the order they were added', () => {
    // Act
    insertLibraryFolder('f1', '/books/novels')
    insertLibraryFolder('f2', '/books/essays')

    // Assert
    expect(listLibraryFolders().map((f) => [f.id, f.path])).toEqual([
      ['f1', '/books/novels'],
      ['f2', '/books/essays']
    ])
    expect(getLibraryFolder('f2')?.path).toBe('/books/essays')
    expect(typeof getLibraryFolder('f2')?.addedAt).toBe('number')
    expect(getLibraryFolder('nope')).toBeNull()
  })

  test('refuses the same folder twice', () => {
    insertLibraryFolder('f1', '/books')

    expect(() => insertLibraryFolder('f2', '/books')).toThrow()
  })

  test('a folder book carries its folder and file signature', () => {
    // Arrange
    insertLibraryFolder('f1', '/books')

    // Act
    insertLibraryBook(
      sampleInput({ id: 'fb', contentHash: 'hfb', originalPath: '/books/a.epub', folderId: 'f1', fileSize: 42, fileMtime: 1000 })
    )

    // Assert
    const book = getLibraryBook('fb')
    expect(book?.folderId).toBe('f1')
    expect(book?.fileSize).toBe(42)
    expect(book?.fileMtime).toBe(1000)
    expect(listFolderBooks('f1').map((b) => b.id)).toEqual(['fb'])
  })

  test('a dropped book belongs to no folder', () => {
    insertLibraryBook(sampleInput())

    expect(getLibraryBook('book-1')?.folderId).toBeUndefined()
  })

  test('deleting a folder drops its books and nothing else', () => {
    // Arrange
    insertLibraryFolder('f1', '/books')
    insertLibraryBook(sampleInput({ id: 'fb', contentHash: 'hfb', folderId: 'f1', fileSize: 1, fileMtime: 1 }))
    insertLibraryBook(sampleInput({ id: 'dropped', contentHash: 'hd' }))

    // Act
    deleteLibraryFolder('f1')

    // Assert
    expect(listLibraryFolders()).toEqual([])
    expect(listLibraryBooks().map((b) => b.id)).toEqual(['dropped'])
  })

  test('moving a folder book keeps its id, upload stamp and conversions', () => {
    // Arrange
    insertLibraryFolder('f1', '/a')
    insertLibraryFolder('f2', '/b')
    insertLibraryBook(sampleInput({ id: 'fb', contentHash: 'h', originalPath: '/a/x.epub', folderId: 'f1', fileSize: 1, fileMtime: 1 }))
    setUploaded('fb', 'x.azw3')

    // Act
    updateFolderBookLocation('fb', { folderId: 'f2', originalPath: '/b/y.epub', filename: 'y.epub', fileSize: 1, fileMtime: 2 })

    // Assert
    const book = getLibraryBook('fb')
    expect(book?.folderId).toBe('f2')
    expect(book?.originalPath).toBe('/b/y.epub')
    expect(book?.filename).toBe('y.epub')
    expect(book?.fileMtime).toBe(2)
    expect(book?.targetRelpath).toBe('x.azw3')
  })

  test('new content at the same path replaces hash and metadata, clearing a stale author and cover', () => {
    // Arrange
    insertLibraryFolder('f1', '/a')
    insertLibraryBook(
      sampleInput({ id: 'fb', contentHash: 'old', folderId: 'f1', fileSize: 1, fileMtime: 1, coverKey: 'k' })
    )

    // Act
    updateFolderBookContent('fb', {
      contentHash: 'new',
      title: 'New Title',
      sourceFormat: 'epub',
      fileSize: 9,
      fileMtime: 5
    })

    // Assert
    const book = getLibraryBook('fb')
    expect(book?.contentHash).toBe('new')
    expect(book?.title).toBe('New Title')
    expect(book?.author).toBeUndefined()
    expect(book?.coverKey).toBeUndefined()
    expect(book?.fileSize).toBe(9)
    expect(findByContentHash('old')).toBeNull()
  })
})

describe('schema upgrade', () => {
  test('a library.db from before folders existed keeps its books and gains folder support', () => {
    // Arrange: the 0.4.0 schema, written before the store ever opens the file.
    const dir = freshUserData()
    const old = new Database(path.join(dir, 'library.db'))
    old.exec(`
      CREATE TABLE library_books (
        id TEXT PRIMARY KEY, content_hash TEXT UNIQUE NOT NULL, original_path TEXT NOT NULL,
        filename TEXT NOT NULL, title TEXT NOT NULL, author TEXT, source_format TEXT NOT NULL,
        cover_key TEXT, target_relpath TEXT, uploaded_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE library_conversions (
        library_id TEXT NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
        format TEXT NOT NULL, output_path TEXT, status TEXT NOT NULL, error TEXT,
        PRIMARY KEY (library_id, format)
      );
    `)
    old
      .prepare(
        `INSERT INTO library_books (id, content_hash, original_path, filename, title, source_format, created_at)
         VALUES ('legacy', 'hl', '/lib/legacy/original.epub', 'l.epub', 'Legacy', 'epub', 1)`
      )
      .run()
    old.close()

    // Act
    const books = listLibraryBooks()
    insertLibraryFolder('f1', '/books')
    insertLibraryBook(sampleInput({ id: 'fb', contentHash: 'hfb', folderId: 'f1', fileSize: 1, fileMtime: 1 }))

    // Assert
    expect(books.map((b) => b.id)).toEqual(['legacy'])
    expect(books[0].folderId).toBeUndefined()
    expect(listFolderBooks('f1').map((b) => b.id)).toEqual(['fb'])
  })
})
