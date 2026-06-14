import { describe, expect, test } from 'vitest'
import {
  SUBCOLLECTION_SEPARATOR,
  sanitizeNamePart,
  formatAuthorCollectionName,
  parseCollectionName,
  isSubCollection,
  normalizeKey,
  buildAuthorSubcollections
} from '../src/renderer/src/utils/collectionHierarchy'

describe('sanitizeNamePart', () => {
  test('trims and collapses internal whitespace', () => {
    expect(sanitizeNamePart('  Glenn   Cooper  ')).toBe('Glenn Cooper')
  })

  test('strips the separator substring out of a part', () => {
    expect(sanitizeNamePart('Emilio / Salgari')).toBe('Emilio Salgari')
  })

  test('returns an empty string when nothing meaningful remains', () => {
    expect(sanitizeNamePart('   ')).toBe('')
  })
})

describe('formatAuthorCollectionName', () => {
  test('composes "<genre> / <author>"', () => {
    expect(formatAuthorCollectionName('Thriller', 'Glenn Cooper')).toBe('Thriller / Glenn Cooper')
  })

  test('sanitizes both parts so the result has exactly one separator', () => {
    // Act
    const name = formatAuthorCollectionName('Sci / Fi', 'King / Stephen')

    // Assert — only one composed separator remains.
    expect(name).toBe('Sci Fi / King Stephen')
    expect(name.split(SUBCOLLECTION_SEPARATOR)).toHaveLength(2)
  })

  test('returns empty string when either part is blank', () => {
    expect(formatAuthorCollectionName('Thriller', '   ')).toBe('')
    expect(formatAuthorCollectionName('', 'Glenn Cooper')).toBe('')
  })
})

describe('parseCollectionName', () => {
  test('returns only a genre when there is no separator', () => {
    expect(parseCollectionName('Thriller')).toEqual({ genre: 'Thriller' })
  })

  test('splits a genre and author', () => {
    expect(parseCollectionName('Thriller / Glenn Cooper')).toEqual({
      genre: 'Thriller',
      author: 'Glenn Cooper'
    })
  })

  test('splits on the FIRST separator only', () => {
    // A malformed name with multiple separators keeps everything after the
    // first as the author rather than dropping the tail.
    expect(parseCollectionName('Thriller / Glenn / Cooper')).toEqual({
      genre: 'Thriller',
      author: 'Glenn / Cooper'
    })
  })
})

describe('isSubCollection', () => {
  test('is true for a composed name and false for a bare genre', () => {
    expect(isSubCollection('Thriller / Glenn Cooper')).toBe(true)
    expect(isSubCollection('Thriller')).toBe(false)
  })
})

describe('normalizeKey', () => {
  test('folds case and whitespace so variants share a key', () => {
    expect(normalizeKey('  Glenn   COOPER ')).toBe(normalizeKey('glenn cooper'))
  })

  test('does not merge genuinely different spellings', () => {
    expect(normalizeKey('Stephen King')).not.toBe(normalizeKey('King, Stephen'))
  })
})

describe('buildAuthorSubcollections', () => {
  test('groups a genre with 2+ distinct authors into per-author sub-collections', () => {
    // Arrange
    const books = [
      { genre: 'Thriller', author: 'Glenn Cooper', relpath: 'Cooper/A.azw3' },
      { genre: 'Thriller', author: 'Glenn Cooper', relpath: 'Cooper/B.azw3' },
      { genre: 'Thriller', author: 'Lee Child', relpath: 'Child/C.azw3' }
    ]

    // Act
    const payload = buildAuthorSubcollections(books)

    // Assert
    expect(payload).toContainEqual({
      name: 'Thriller / Glenn Cooper',
      relpaths: ['Cooper/A.azw3', 'Cooper/B.azw3']
    })
    expect(payload).toContainEqual({ name: 'Thriller / Lee Child', relpaths: ['Child/C.azw3'] })
    expect(payload).toHaveLength(2)
  })

  test('skips a genre with only one distinct author', () => {
    const books = [
      { genre: 'Horror', author: 'Stephen King', relpath: 'King/A.azw3' },
      { genre: 'Horror', author: 'Stephen King', relpath: 'King/B.azw3' }
    ]
    expect(buildAuthorSubcollections(books)).toEqual([])
  })

  test('excludes books with no author', () => {
    const books = [
      { genre: 'Thriller', author: 'Glenn Cooper', relpath: 'Cooper/A.azw3' },
      { genre: 'Thriller', author: undefined, relpath: 'loose.azw3' },
      { genre: 'Thriller', author: '   ', relpath: 'blank.azw3' },
      { genre: 'Thriller', author: 'Lee Child', relpath: 'Child/C.azw3' }
    ]

    const payload = buildAuthorSubcollections(books)
    const allRelpaths = payload.flatMap((p) => p.relpaths)

    expect(allRelpaths).not.toContain('loose.azw3')
    expect(allRelpaths).not.toContain('blank.azw3')
  })

  test('merges case/whitespace author variants under one sub-collection (first-seen casing)', () => {
    const books = [
      { genre: 'Thriller', author: 'Glenn Cooper', relpath: 'a.azw3' },
      { genre: 'Thriller', author: 'glenn  cooper', relpath: 'b.azw3' },
      { genre: 'Thriller', author: 'Lee Child', relpath: 'c.azw3' }
    ]

    const payload = buildAuthorSubcollections(books)
    const cooper = payload.find(
      (p) => normalizeKey(p.name) === normalizeKey('Thriller / Glenn Cooper')
    )

    expect(cooper?.name).toBe('Thriller / Glenn Cooper')
    expect(cooper?.relpaths.sort()).toEqual(['a.azw3', 'b.azw3'])
  })
})
