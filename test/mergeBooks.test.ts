import { describe, expect, test } from 'vitest'
import { mergeBooks } from '../src/renderer/src/utils/mergeBooks'
import type { KindleBook, LibraryBook } from '../src/preload/api'

const BASE = '/mnt/kindle/documents/'

/** A device book whose key is its path under BASE, as readDocuments would give it. */
function deviceBook(overrides: Partial<KindleBook> = {}): KindleBook {
  const book: KindleBook = {
    filename: 'Book.azw3',
    title: 'A Device Book',
    author: 'Device Author',
    extension: 'AZW3',
    size: 1234,
    path: `${BASE}Book.azw3`,
    ...overrides
  }
  return { relpath: book.path.slice(BASE.length), ...book }
}

function libraryBook(overrides: Partial<LibraryBook> = {}): LibraryBook {
  return {
    id: 'lib-1',
    contentHash: 'h1',
    originalPath: '/lib/lib-1/original.epub',
    filename: 'Book.epub',
    title: 'A Library Book',
    author: 'Library Author',
    sourceFormat: 'epub',
    createdAt: 1,
    ...overrides
  }
}

describe('mergeBooks', () => {
  test('device books are marked onDevice with no libraryId when nothing reconciles', () => {
    const result = mergeBooks([deviceBook()], [])

    expect(result).toHaveLength(1)
    expect(result[0].onDevice).toBe(true)
    expect(result[0].libraryId).toBeUndefined()
  })

  test('a library-only book becomes its own card (onDevice false, libraryId set)', () => {
    const lib = libraryBook({ id: 'only-1', title: 'Solo', sourceFormat: 'epub' })

    const result = mergeBooks([], [lib])

    expect(result).toHaveLength(1)
    expect(result[0].onDevice).toBe(false)
    expect(result[0].libraryId).toBe('only-1')
    expect(result[0].title).toBe('Solo')
    expect(result[0].extension).toBe('EPUB')
  })

  test('reconciles a library book to a device book by targetRelpath (single card)', () => {
    const device = deviceBook({ path: `${BASE}Dune.azw3`, title: 'Dune' })
    const lib = libraryBook({ id: 'dune', title: 'Dune (epub source)', targetRelpath: 'Dune.azw3' })

    const result = mergeBooks([device], [lib])

    // One card only — the device card, now carrying the libraryId.
    expect(result).toHaveLength(1)
    expect(result[0].onDevice).toBe(true)
    expect(result[0].libraryId).toBe('dune')
  })

  test('reconciles by normalized title|author for a previously-uploaded library book', () => {
    const device = deviceBook({ path: `${BASE}whatever.azw3`, title: 'The Hobbit', author: 'J.R.R. Tolkien' })
    // uploadedAt set → this staged book really was sent, so an identity match is trusted.
    const lib = libraryBook({ id: 'hob', title: '  the hobbit ', author: 'j.r.r. tolkien', uploadedAt: 111 })

    const result = mergeBooks([device], [lib])

    expect(result).toHaveLength(1)
    expect(result[0].libraryId).toBe('hob')
    expect(result[0].onDevice).toBe(true)
  })

  test('a never-uploaded staged book sharing a title|author stays library-only (not hidden)', () => {
    const device = deviceBook({ path: `${BASE}whatever.azw3`, title: 'The Hobbit', author: 'J.R.R. Tolkien' })
    // Same identity but never sent (no uploadedAt / targetRelpath): must NOT be
    // swallowed by the device card, or the user loses all send/remove UI for it.
    const lib = libraryBook({ id: 'hob', title: 'The Hobbit', author: 'J.R.R. Tolkien' })

    const result = mergeBooks([device], [lib])

    expect(result).toHaveLength(2)
    const deviceCard = result.find((b) => b.onDevice)
    const libraryCard = result.find((b) => !b.onDevice)
    expect(deviceCard?.libraryId).toBeUndefined()
    expect(libraryCard?.libraryId).toBe('hob')
  })

  test('a matched library book attaches to only one of several identical device books (unique keys)', () => {
    const dupA = deviceBook({ path: `${BASE}Dune-1.azw3`, title: 'Dune', author: 'Herbert' })
    const dupB = deviceBook({ path: `${BASE}Dune-2.azw3`, title: 'Dune', author: 'Herbert' })
    const lib = libraryBook({ id: 'dune', title: 'Dune', author: 'Herbert', uploadedAt: 222 })

    const result = mergeBooks([dupA, dupB], [lib])

    expect(result).toHaveLength(2)
    // The libraryId lands on exactly one card — no two cards share a React key.
    expect(result.filter((b) => b.libraryId === 'dune')).toHaveLength(1)
    const keys = result.map((b) => b.libraryId ?? b.path)
    expect(new Set(keys).size).toBe(result.length)
  })

  test('does not merge two genuinely different titles', () => {
    const device = deviceBook({ path: `${BASE}a.azw3`, title: 'Book A', author: 'X' })
    const lib = libraryBook({ id: 'b', title: 'Book B', author: 'Y' })

    const result = mergeBooks([device], [lib])

    expect(result).toHaveLength(2)
  })

  test('with no device connected, all library books are library-only', () => {
    const libs = [libraryBook({ id: 'l1', contentHash: 'h1' }), libraryBook({ id: 'l2', contentHash: 'h2' })]

    const result = mergeBooks([], libs)

    expect(result).toHaveLength(2)
    expect(result.every((b) => b.onDevice === false)).toBe(true)
  })

  // macOS hands back decomposed (NFD) filenames from the Kindle volume while the
  // app writes and records composed (NFC) ones, so "Non è ciò che volevo" read
  // off the device is a different string from the identical-looking one in the
  // library DB. Without normalization the book was uploaded, recorded, and still
  // showed up twice: once green on the device, once amber as "library only".
  test('reconciles by targetRelpath when the device path is NFD and the record is NFC', () => {
    const nfc = 'Non è ciò che volevo.azw3'.normalize('NFC')
    const nfd = 'Non è ciò che volevo.azw3'.normalize('NFD')
    const device = deviceBook({ path: `${BASE}${nfd}`, title: 'Non è ciò che volevo'.normalize('NFD') })
    const lib = libraryBook({ id: 'accented', title: 'Non è ciò che volevo', targetRelpath: nfc })

    const result = mergeBooks([device], [lib])

    expect(result).toHaveLength(1)
    expect(result[0].onDevice).toBe(true)
    expect(result[0].libraryId).toBe('accented')
  })

  test('reconciles by identity when device and library titles differ only in Unicode form', () => {
    const device = deviceBook({
      path: `${BASE}elsewhere.azw3`,
      title: 'Non è ciò che volevo'.normalize('NFD'),
      author: 'Enzo Celli'
    })
    const lib = libraryBook({
      id: 'accented-id',
      title: 'Non è ciò che volevo'.normalize('NFC'),
      author: 'Enzo Celli',
      uploadedAt: 222
    })

    const result = mergeBooks([device], [lib])

    expect(result).toHaveLength(1)
    expect(result[0].libraryId).toBe('accented-id')
  })

  test('mixed: device-only, reconciled, and library-only in one pass', () => {
    const deviceOnly = deviceBook({ path: `${BASE}DeviceOnly.azw3`, title: 'Device Only', author: 'D' })
    const reconciledDevice = deviceBook({ path: `${BASE}Shared.azw3`, title: 'Shared', author: 'S' })
    const reconciledLib = libraryBook({ id: 'shared', title: 'Shared', author: 'S', targetRelpath: 'Shared.azw3' })
    const libOnly = libraryBook({ id: 'libonly', title: 'Library Only', author: 'L' })

    const result = mergeBooks([deviceOnly, reconciledDevice], [reconciledLib, libOnly])

    expect(result).toHaveLength(3)
    const byTitle = Object.fromEntries(result.map((b) => [b.title, b]))
    expect(byTitle['Device Only'].onDevice).toBe(true)
    expect(byTitle['Device Only'].libraryId).toBeUndefined()
    expect(byTitle['Shared'].onDevice).toBe(true)
    expect(byTitle['Shared'].libraryId).toBe('shared')
    expect(byTitle['Library Only'].onDevice).toBe(false)
    expect(byTitle['Library Only'].libraryId).toBe('libonly')
  })
})

describe('mergeBooks — Windows', () => {
  test('reconciles by the book key even when the path uses backslashes and a drive letter', () => {
    // Arrange: what readDocuments returns on Windows, and the base the grid used to strip.
    const device = deviceBook({ path: 'E:\\documents\\Dune.azw3', relpath: 'Dune.azw3', title: 'Dune' })
    const lib = libraryBook({ id: 'dune', title: 'Another title', targetRelpath: 'Dune.azw3' })

    // Act
    const result = mergeBooks([device], [lib])

    // Assert
    expect(result).toHaveLength(1)
    expect(result[0].libraryId).toBe('dune')
  })
})

describe('mergeBooks — dates', () => {
  test('a library-only card is dated by when it entered the library', () => {
    const [card] = mergeBooks([], [libraryBook({ createdAt: 1234 })])

    expect(card.addedAt).toBe(1234)
  })
})

describe('mergeBooks — library folders', () => {
  test('a library-only card read from a library folder says so', () => {
    const lib = libraryBook({ id: 'f-1', folderId: 'folder-1' })

    const [card] = mergeBooks([], [lib])

    expect(card.libraryFolderId).toBe('folder-1')
  })

  test('a device card reconciled with a folder book keeps the folder link', () => {
    const lib = libraryBook({ id: 'f-1', folderId: 'folder-1', targetRelpath: 'Book.azw3' })

    const [card] = mergeBooks([deviceBook()], [lib])

    expect(card.onDevice).toBe(true)
    expect(card.libraryId).toBe('f-1')
    expect(card.libraryFolderId).toBe('folder-1')
  })

  test('a dropped book has no folder link', () => {
    const [card] = mergeBooks([], [libraryBook()])

    expect(card.libraryFolderId).toBeUndefined()
  })
})
