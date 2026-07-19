import { describe, expect, test } from 'vitest'
import { mergeBooks } from '../src/renderer/src/utils/mergeBooks'
import type { KindleBook, LibraryBook } from '../src/preload/api'

const BASE = '/mnt/kindle/documents/'

function deviceBook(overrides: Partial<KindleBook> = {}): KindleBook {
  return {
    filename: 'Book.azw3',
    title: 'A Device Book',
    author: 'Device Author',
    extension: 'AZW3',
    size: 1234,
    path: `${BASE}Book.azw3`,
    ...overrides
  }
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
    const result = mergeBooks([deviceBook()], [], BASE)

    expect(result).toHaveLength(1)
    expect(result[0].onDevice).toBe(true)
    expect(result[0].libraryId).toBeUndefined()
  })

  test('a library-only book becomes its own card (onDevice false, libraryId set)', () => {
    const lib = libraryBook({ id: 'only-1', title: 'Solo', sourceFormat: 'epub' })

    const result = mergeBooks([], [lib], BASE)

    expect(result).toHaveLength(1)
    expect(result[0].onDevice).toBe(false)
    expect(result[0].libraryId).toBe('only-1')
    expect(result[0].title).toBe('Solo')
    expect(result[0].extension).toBe('EPUB')
  })

  test('reconciles a library book to a device book by targetRelpath (single card)', () => {
    const device = deviceBook({ path: `${BASE}Dune.azw3`, title: 'Dune' })
    const lib = libraryBook({ id: 'dune', title: 'Dune (epub source)', targetRelpath: 'Dune.azw3' })

    const result = mergeBooks([device], [lib], BASE)

    // One card only — the device card, now carrying the libraryId.
    expect(result).toHaveLength(1)
    expect(result[0].onDevice).toBe(true)
    expect(result[0].libraryId).toBe('dune')
  })

  test('reconciles by normalized title|author for a previously-uploaded library book', () => {
    const device = deviceBook({ path: `${BASE}whatever.azw3`, title: 'The Hobbit', author: 'J.R.R. Tolkien' })
    // uploadedAt set → this staged book really was sent, so an identity match is trusted.
    const lib = libraryBook({ id: 'hob', title: '  the hobbit ', author: 'j.r.r. tolkien', uploadedAt: 111 })

    const result = mergeBooks([device], [lib], BASE)

    expect(result).toHaveLength(1)
    expect(result[0].libraryId).toBe('hob')
    expect(result[0].onDevice).toBe(true)
  })

  test('a never-uploaded staged book sharing a title|author stays library-only (not hidden)', () => {
    const device = deviceBook({ path: `${BASE}whatever.azw3`, title: 'The Hobbit', author: 'J.R.R. Tolkien' })
    // Same identity but never sent (no uploadedAt / targetRelpath): must NOT be
    // swallowed by the device card, or the user loses all send/remove UI for it.
    const lib = libraryBook({ id: 'hob', title: 'The Hobbit', author: 'J.R.R. Tolkien' })

    const result = mergeBooks([device], [lib], BASE)

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

    const result = mergeBooks([dupA, dupB], [lib], BASE)

    expect(result).toHaveLength(2)
    // The libraryId lands on exactly one card — no two cards share a React key.
    expect(result.filter((b) => b.libraryId === 'dune')).toHaveLength(1)
    const keys = result.map((b) => b.libraryId ?? b.path)
    expect(new Set(keys).size).toBe(result.length)
  })

  test('does not merge two genuinely different titles', () => {
    const device = deviceBook({ path: `${BASE}a.azw3`, title: 'Book A', author: 'X' })
    const lib = libraryBook({ id: 'b', title: 'Book B', author: 'Y' })

    const result = mergeBooks([device], [lib], BASE)

    expect(result).toHaveLength(2)
  })

  test('with no device connected (empty documentsBase), all library books are library-only', () => {
    const libs = [libraryBook({ id: 'l1', contentHash: 'h1' }), libraryBook({ id: 'l2', contentHash: 'h2' })]

    const result = mergeBooks([], libs, '')

    expect(result).toHaveLength(2)
    expect(result.every((b) => b.onDevice === false)).toBe(true)
  })

  test('mixed: device-only, reconciled, and library-only in one pass', () => {
    const deviceOnly = deviceBook({ path: `${BASE}DeviceOnly.azw3`, title: 'Device Only', author: 'D' })
    const reconciledDevice = deviceBook({ path: `${BASE}Shared.azw3`, title: 'Shared', author: 'S' })
    const reconciledLib = libraryBook({ id: 'shared', title: 'Shared', author: 'S', targetRelpath: 'Shared.azw3' })
    const libOnly = libraryBook({ id: 'libonly', title: 'Library Only', author: 'L' })

    const result = mergeBooks([deviceOnly, reconciledDevice], [reconciledLib, libOnly], BASE)

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
