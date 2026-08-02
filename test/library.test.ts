import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import {
  deleteLibraryBook,
  findByContentHash,
  getConversion,
  getLibraryBook,
  insertLibraryBook,
  listLibraryBooks,
  setUploaded,
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
