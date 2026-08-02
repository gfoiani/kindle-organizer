import { describe, expect, test } from 'vitest'
import { countPresence, filterByPresence } from '../src/renderer/src/utils/presenceFilter'
import type { DisplayBook } from '../src/renderer/src/utils/mergeBooks'

function book(title: string, onDevice: boolean): DisplayBook {
  return {
    filename: `${title}.azw3`,
    title,
    extension: 'AZW3',
    size: 1024,
    path: onDevice ? `/Volumes/Kindle/documents/${title}.azw3` : '',
    onDevice,
    ...(onDevice ? {} : { libraryId: `lib-${title}` })
  }
}

const BOOKS: DisplayBook[] = [
  book('Dune', true),
  book('Open', true),
  book('Troppo comodi', false)
]

describe('countPresence', () => {
  test('splits the list into on-device and library-only', () => {
    expect(countPresence(BOOKS)).toEqual({ onDevice: 2, libraryOnly: 1 })
  })

  test('an empty list counts zero on both sides', () => {
    expect(countPresence([])).toEqual({ onDevice: 0, libraryOnly: 0 })
  })

  test('the two counts always add up to the input length', () => {
    const counts = countPresence(BOOKS)
    expect(counts.onDevice + counts.libraryOnly).toBe(BOOKS.length)
  })
})

describe('filterByPresence', () => {
  test('neither chip selected shows everything', () => {
    const result = filterByPresence(BOOKS, { showOnDevice: false, showLibraryOnly: false })
    expect(result).toBe(BOOKS) // same reference — nothing was excluded
  })

  test('BOTH chips selected also shows everything (union, not intersection)', () => {
    // The trap this guards: ANDing the two flags would ask for a book that is
    // simultaneously on the device and library-only, which is empty by
    // construction — the grid would go blank instead of showing all books.
    const result = filterByPresence(BOOKS, { showOnDevice: true, showLibraryOnly: true })
    expect(result).toBe(BOOKS)
  })

  test('only the on-Kindle chip narrows to device books', () => {
    const result = filterByPresence(BOOKS, { showOnDevice: true, showLibraryOnly: false })
    expect(result.map((b) => b.title)).toEqual(['Dune', 'Open'])
  })

  test('only the library-only chip narrows to staged books', () => {
    const result = filterByPresence(BOOKS, { showOnDevice: false, showLibraryOnly: true })
    expect(result.map((b) => b.title)).toEqual(['Troppo comodi'])
  })

  test('yields an empty list when the selected side has no books', () => {
    const deviceOnly = [book('Dune', true)]
    expect(filterByPresence(deviceOnly, { showOnDevice: false, showLibraryOnly: true })).toEqual([])
  })

  test('does not mutate the input', () => {
    const input = [...BOOKS]
    filterByPresence(input, { showOnDevice: true, showLibraryOnly: false })
    expect(input).toEqual(BOOKS)
  })
})
