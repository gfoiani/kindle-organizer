import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  readCalibreMetadata,
  readCalibreIsbnMap,
  upsertCalibreEntry
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

  // An unreadable file must not look like "no collections": the import would
  // then delete every collection that came from calibre.
  test('returns null on malformed JSON instead of throwing', () => {
    writeFileSync(path.join(mountpoint, 'metadata.calibre'), '{ not valid json', 'utf-8')
    expect(readCalibreMetadata(mountpoint)).toBeNull()
  })

  test('returns null when the parsed root is not an array', () => {
    writeMetadata({ lpath: 'documents/A/Book.azw3', tags: ['X'] })
    expect(readCalibreMetadata(mountpoint)).toBeNull()
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

describe('upsertCalibreEntry', () => {
  const DUNE = {
    relpath: 'Dune.azw3',
    title: 'Dune',
    author: 'Frank Herbert',
    size: 2048,
    mime: 'application/x-mobi8-ebook',
    uuid: '3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33'
  }

  test('creates metadata.calibre with a calibre-shaped record when the device has none', () => {
    // Act
    const ok = upsertCalibreEntry(mountpoint, DUNE)

    // Assert
    expect(ok).toBe(true)
    const [entry] = readMetadata()
    expect(entry).toMatchObject({
      lpath: 'documents/Dune.azw3',
      title: 'Dune',
      title_sort: 'Dune',
      authors: ['Frank Herbert'],
      author_sort: 'Herbert, Frank',
      tags: [],
      device_collections: [],
      uuid: DUNE.uuid,
      size: 2048,
      mime: 'application/x-mobi8-ebook'
    })
    expect(typeof entry['last_modified']).toBe('string')
  })

  test('falls back to Unknown when the book has no author', () => {
    upsertCalibreEntry(mountpoint, { ...DUNE, author: undefined })

    expect(readMetadata()[0]).toMatchObject({ authors: ['Unknown'], author_sort: 'Unknown' })
  })

  test('appends to an existing list without disturbing the other books', () => {
    writeMetadata([{ lpath: 'documents/Other.azw3', tags: ['Keep'] }])

    upsertCalibreEntry(mountpoint, DUNE)

    const entries = readMetadata()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ lpath: 'documents/Other.azw3', tags: ['Keep'] })
    expect(entries[1]['lpath']).toBe('documents/Dune.azw3')
  })

  test('updates the record in place on re-upload, preserving its collections', () => {
    writeMetadata([
      {
        lpath: 'documents/Dune.azw3',
        title: 'Old title',
        tags: ['Sci-Fi'],
        device_collections: ['Sci-Fi'],
        size: 1
      }
    ])

    upsertCalibreEntry(mountpoint, DUNE)

    const entries = readMetadata()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      title: 'Dune',
      size: 2048,
      tags: ['Sci-Fi'],
      device_collections: ['Sci-Fi']
    })
  })

  test('matches an existing record whose lpath omits the documents/ prefix', () => {
    writeMetadata([{ lpath: 'Dune.azw3', tags: ['Sci-Fi'] }])

    upsertCalibreEntry(mountpoint, DUNE)

    const entries = readMetadata()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ tags: ['Sci-Fi'], title: 'Dune' })
  })

  test('normalizes a nested relpath to a posix lpath', () => {
    upsertCalibreEntry(mountpoint, { ...DUNE, relpath: path.join('Sci-Fi', 'Dune.azw3') })

    expect(readMetadata()[0]['lpath']).toBe('documents/Sci-Fi/Dune.azw3')
  })

  test('refuses to touch a corrupt metadata.calibre rather than overwriting it', () => {
    const raw = '{ this is not json'
    writeFileSync(path.join(mountpoint, 'metadata.calibre'), raw, 'utf-8')

    const ok = upsertCalibreEntry(mountpoint, DUNE)

    expect(ok).toBe(false)
    expect(readFileSync(path.join(mountpoint, 'metadata.calibre'), 'utf-8')).toBe(raw)
  })

  test('leaves no orphaned .tmp file after a successful write', () => {
    writeMetadata([{ lpath: 'documents/Dune.azw3', tags: ['SF'] }])

    upsertCalibreEntry(mountpoint, DUNE)

    expect(() => readFileSync(path.join(mountpoint, 'metadata.calibre.tmp'))).toThrow()
  })
})

describe('calibre records survive the app', () => {
  const DUNE = {
    relpath: 'Dune.azw3',
    title: 'Dune',
    author: 'Frank Herbert',
    size: 2048,
    mime: 'application/x-mobi8-ebook',
    uuid: '3f6d9a1e-1c4b-4a2d-8f77-0b9c2e5d1a33'
  }

  test('re-uploading keeps the fields calibre filled in', () => {
    // Arrange
    writeMetadata([
      {
        lpath: 'documents/Dune.azw3',
        title: 'Old title',
        identifiers: { isbn: '9788834739679' },
        series: 'Dune',
        series_index: 1,
        publisher: 'Fanucci',
        tags: ['SF']
      }
    ])

    // Act
    upsertCalibreEntry(mountpoint, DUNE)

    // Assert
    const [entry] = readMetadata()
    expect(entry).toMatchObject({
      title: 'Dune',
      size: 2048,
      identifiers: { isbn: '9788834739679' },
      series: 'Dune',
      series_index: 1,
      publisher: 'Fanucci',
      tags: ['SF']
    })
  })

  test('re-uploading updates a record whose lpath differs only in case', () => {
    writeMetadata([{ lpath: 'documents/Dune.AZW3', tags: ['SF'] }])

    upsertCalibreEntry(mountpoint, DUNE)

    expect(readMetadata().map((e) => [e.lpath, e.tags])).toEqual([['documents/Dune.azw3', ['SF']]])
  })
})

describe('accented names (macOS hands back decomposed names)', () => {
  test('re-uploading under a decomposed name updates the composed record, keeping its collections', () => {
    // Arrange
    writeMetadata([{ lpath: 'documents/Citt\u00e0.azw3', title: 'Città', uuid: 'u-1', tags: ['Viaggi'] }])
    const decomposed = 'Citta\u0300.azw3'

    // Act
    const ok = upsertCalibreEntry(mountpoint, { relpath: decomposed, title: 'Città', size: 1, uuid: 'u-1' })

    // Assert
    expect(ok).toBe(true)
    const entries = readMetadata()
    expect(entries).toHaveLength(1)
    expect(entries[0].tags).toEqual(['Viaggi'])
  })
})
