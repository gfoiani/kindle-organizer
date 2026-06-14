import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  readCalibreMetadata,
  writeCalibreMetadata,
  readCalibreIsbnMap
} from '../src/main/calibre'

let mountpoint: string

function writeMetadata(entries: unknown): void {
  writeFileSync(path.join(mountpoint, 'metadata.calibre'), JSON.stringify(entries, null, 2), 'utf-8')
}

function readMetadata(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(path.join(mountpoint, 'metadata.calibre'), 'utf-8'))
}

beforeEach(() => {
  mountpoint = mkdtempSync(path.join(tmpdir(), 'kindle-mount-'))
})

afterEach(() => {
  rmSync(mountpoint, { recursive: true, force: true })
})

describe('readCalibreMetadata', () => {
  test('returns only books that carry tags, normalizing the lpath and tags', () => {
    // Arrange
    writeMetadata([
      { lpath: 'documents/A/Tagged.azw3', tags: ['Sci-Fi', 'Favorites'] },
      { lpath: 'documents/B/Untagged.azw3', tags: [] },
      { lpath: 'documents/C/NoTagsField.azw3' }
    ])

    // Act
    const books = readCalibreMetadata(mountpoint)

    // Assert
    expect(books).toEqual([{ lpath: 'documents/A/Tagged.azw3', tags: ['Sci-Fi', 'Favorites'] }])
  })

  test('filters out non-string tags and skips entries without a string lpath', () => {
    writeMetadata([
      { lpath: 'documents/A/Book.azw3', tags: ['Good', 42, null, 'Keep'] },
      { lpath: 123, tags: ['Ignored'] }
    ])

    const books = readCalibreMetadata(mountpoint)

    expect(books).toEqual([{ lpath: 'documents/A/Book.azw3', tags: ['Good', 'Keep'] }])
  })

  test('returns [] when metadata.calibre is absent', () => {
    expect(readCalibreMetadata(mountpoint)).toEqual([])
  })

  test('returns [] on malformed JSON instead of throwing', () => {
    writeFileSync(path.join(mountpoint, 'metadata.calibre'), '{ not valid json', 'utf-8')
    expect(readCalibreMetadata(mountpoint)).toEqual([])
  })

  test('returns [] when the parsed root is not an array', () => {
    writeMetadata({ lpath: 'documents/A/Book.azw3', tags: ['X'] })
    expect(readCalibreMetadata(mountpoint)).toEqual([])
  })
})

describe('writeCalibreMetadata — authoritative tag write (H1)', () => {
  test('sets tags for a known book to the exact array from the map', () => {
    // Arrange
    writeMetadata([{ lpath: 'documents/A/Book.azw3', tags: ['Old'] }])
    const map = new Map<string, string[]>([['A/Book.azw3', ['Sci-Fi', 'Read']]])

    // Act
    const ok = writeCalibreMetadata(mountpoint, map)

    // Assert
    expect(ok).toBe(true)
    expect(readMetadata()[0].tags).toEqual(['Sci-Fi', 'Read'])
  })

  test('H1: a book seeded with [] (removed from all collections) has its stale tags cleared', () => {
    // Arrange — book currently tagged on the device, now de-tagged in the app.
    writeMetadata([{ lpath: 'documents/A/Book.azw3', tags: ['StaleTag'] }])
    const map = new Map<string, string[]>([['A/Book.azw3', []]])

    // Act
    const ok = writeCalibreMetadata(mountpoint, map)

    // Assert — the write is authoritative, so the old tag is gone.
    expect(ok).toBe(true)
    expect(readMetadata()[0].tags).toEqual([])
  })

  test('leaves books NOT present in the map untouched (does not blanket-clear)', () => {
    // Arrange
    writeMetadata([
      { lpath: 'documents/A/Known.azw3', tags: ['Old'] },
      { lpath: 'documents/B/Unknown.azw3', tags: ['KeepMe'] }
    ])
    const map = new Map<string, string[]>([['A/Known.azw3', ['New']]])

    // Act
    writeCalibreMetadata(mountpoint, map)

    // Assert
    const after = readMetadata()
    expect(after.find((e) => e.lpath === 'documents/A/Known.azw3')?.tags).toEqual(['New'])
    expect(after.find((e) => e.lpath === 'documents/B/Unknown.azw3')?.tags).toEqual(['KeepMe'])
  })

  test('preserves other fields on a record when updating tags', () => {
    writeMetadata([
      { lpath: 'documents/A/Book.azw3', tags: ['Old'], title: 'A Title', author: 'Someone' }
    ])
    const map = new Map<string, string[]>([['A/Book.azw3', ['New']]])

    writeCalibreMetadata(mountpoint, map)

    const entry = readMetadata()[0]
    expect(entry).toMatchObject({ title: 'A Title', author: 'Someone', tags: ['New'] })
  })

  test('returns false (no write) when metadata.calibre is absent', () => {
    const ok = writeCalibreMetadata(mountpoint, new Map([['A/Book.azw3', ['X']]]))
    expect(ok).toBe(false)
  })

  test('returns false on malformed metadata.calibre', () => {
    writeFileSync(path.join(mountpoint, 'metadata.calibre'), 'not json', 'utf-8')
    const ok = writeCalibreMetadata(mountpoint, new Map([['A/Book.azw3', ['X']]]))
    expect(ok).toBe(false)
  })

  test('leaves no orphaned .tmp file after a successful write', () => {
    writeMetadata([{ lpath: 'documents/A/Book.azw3', tags: ['Old'] }])
    writeCalibreMetadata(mountpoint, new Map([['A/Book.azw3', ['New']]]))
    expect(() => readFileSync(path.join(mountpoint, 'metadata.calibre.tmp'))).toThrow()
  })
})

describe('writeCalibreMetadata + readCalibreMetadata round-trip', () => {
  test('a re-org (add one book, clear another) round-trips through the device file', () => {
    // Arrange — two books, each tagged.
    writeMetadata([
      { lpath: 'documents/A/One.azw3', tags: ['Initial'] },
      { lpath: 'documents/B/Two.azw3', tags: ['Initial'] }
    ])

    // Act — One keeps a tag, Two is removed from all collections (seeded []).
    const map = new Map<string, string[]>([
      ['A/One.azw3', ['Fiction']],
      ['B/Two.azw3', []]
    ])
    writeCalibreMetadata(mountpoint, map)

    // Assert — read-back only surfaces the still-tagged book.
    const books = readCalibreMetadata(mountpoint)
    expect(books).toEqual([{ lpath: 'documents/A/One.azw3', tags: ['Fiction'] }])
  })
})

describe('readCalibreIsbnMap', () => {
  test('extracts ISBNs from identifiers and top-level isbn, keyed by relpath', () => {
    writeMetadata([
      { lpath: 'documents/A/Book.azw3', identifiers: { isbn: '978-3-16-148410-0' } },
      { lpath: 'documents/B/Book.azw3', isbn: '0306406152' },
      { lpath: 'documents/C/NoIsbn.azw3' }
    ])

    const map = readCalibreIsbnMap(mountpoint)

    expect(map.get('A/Book.azw3')).toBe('9783161484100')
    expect(map.get('B/Book.azw3')).toBe('0306406152')
    expect(map.has('C/NoIsbn.azw3')).toBe(false)
  })

  test('ignores values that are not valid ISBN-10/13 lengths', () => {
    writeMetadata([{ lpath: 'documents/A/Book.azw3', isbn: '12345' }])
    expect(readCalibreIsbnMap(mountpoint).size).toBe(0)
  })

  test('returns an empty map when the file is absent', () => {
    expect(readCalibreIsbnMap(mountpoint).size).toBe(0)
  })
})
