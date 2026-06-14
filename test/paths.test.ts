import { describe, expect, test } from 'vitest'
import { stripDocumentsPrefix, stripDocumentsBase } from '../src/main/paths'

describe('stripDocumentsPrefix', () => {
  test('strips a leading documents/ prefix from a Calibre lpath', () => {
    // Arrange
    const lpath = 'documents/Author/Book.azw3'

    // Act
    const relpath = stripDocumentsPrefix(lpath)

    // Assert
    expect(relpath).toBe('Author/Book.azw3')
  })

  test('returns the lpath unchanged when there is no documents/ prefix', () => {
    expect(stripDocumentsPrefix('Author/Book.azw3')).toBe('Author/Book.azw3')
  })

  test('only strips the leading occurrence, not a nested documents/', () => {
    expect(stripDocumentsPrefix('documents/documents/Book.azw3')).toBe('documents/Book.azw3')
  })

  test('does not strip a partial prefix match', () => {
    // "documentsX/" is not the "documents/" prefix.
    expect(stripDocumentsPrefix('documentsX/Book.azw3')).toBe('documentsX/Book.azw3')
  })

  test('handles an empty string', () => {
    expect(stripDocumentsPrefix('')).toBe('')
  })
})

describe('stripDocumentsBase', () => {
  const base = '/Volumes/Kindle/documents/'

  test('strips the full mountpoint documents base off an absolute book path', () => {
    // Arrange
    const bookPath = `${base}Author/Book.azw3`

    // Act
    const relpath = stripDocumentsBase(bookPath, base)

    // Assert
    expect(relpath).toBe('Author/Book.azw3')
  })

  test('returns the path unchanged when it does not start with the base', () => {
    const bookPath = '/some/other/path/Book.azw3'
    expect(stripDocumentsBase(bookPath, base)).toBe(bookPath)
  })

  test('handles a book directly in the documents root', () => {
    expect(stripDocumentsBase(`${base}Book.azw3`, base)).toBe('Book.azw3')
  })

  test('is exact-prefix sensitive (a different mountpoint is untouched)', () => {
    const bookPath = '/Volumes/Other/documents/Book.azw3'
    expect(stripDocumentsBase(bookPath, base)).toBe(bookPath)
  })
})
