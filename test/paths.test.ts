import path from 'path'
import { describe, expect, test } from 'vitest'
import { stripDocumentsPrefix, toDeviceRelpath, toBookKey, canonicalBookKey } from '../src/main/paths'

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

describe('toDeviceRelpath', () => {
  test('gives the POSIX path under documents/ for a Windows book path', () => {
    // Arrange: how readDocuments joins on Windows.
    const bookPath = path.win32.join('E:\\', 'documents', 'Author', 'Book.azw3')

    // Act + Assert
    expect(toDeviceRelpath(bookPath, 'E:\\', path.win32)).toBe('Author/Book.azw3')
  })

  test('agrees with readDocuments for a bare drive-letter mountpoint', () => {
    const bookPath = path.win32.join(path.win32.join('E:', 'documents'), 'Book.azw3')

    expect(toDeviceRelpath(bookPath, 'E:', path.win32)).toBe('Book.azw3')
  })

  test('gives the path under documents/ on POSIX', () => {
    expect(toDeviceRelpath('/Volumes/Kindle/documents/A/B.azw3', '/Volumes/Kindle', path.posix)).toBe('A/B.azw3')
  })

  test('is undefined for a book outside documents/', () => {
    expect(toDeviceRelpath('/Volumes/Other/documents/B.azw3', '/Volumes/Kindle', path.posix)).toBeUndefined()
    expect(toDeviceRelpath('/Volumes/Kindle/B.azw3', '/Volumes/Kindle', path.posix)).toBeUndefined()
  })
})

describe('toBookKey', () => {
  test('is the composed path under documents/, with forward slashes on Windows', () => {
    const bookPath = path.win32.join('E:\\', 'documents', 'Niccolò'.normalize('NFD'), 'Book.azw3')

    expect(toBookKey(bookPath, 'E:\\', path.win32)).toBe('Niccolò/Book.azw3'.normalize('NFC'))
  })
})

describe('canonicalBookKey', () => {
  test('turns a key stored on Windows (the whole book path) into the path under documents/', () => {
    expect(canonicalBookKey('E:\\documents\\Author\\Book.azw3')).toBe('Author/Book.azw3')
    expect(canonicalBookKey('e:/documents/Book.azw3')).toBe('Book.azw3')
  })

  test('handles the drive-relative path a bare `E:` mountpoint produced', () => {
    expect(canonicalBookKey('E:documents\\Book.azw3')).toBe('Book.azw3')
  })

  test('composes a decomposed (NFD) key', () => {
    const key = 'Fabbri, Niccolò/Qualcosa.azw3'
    expect(canonicalBookKey(key.normalize('NFD'))).toBe(key.normalize('NFC'))
  })

  test('leaves a key that already is a path under documents/ alone, backslashes included', () => {
    expect(canonicalBookKey('Author/Book.azw3')).toBe('Author/Book.azw3')
    expect(canonicalBookKey('A\\B.azw3')).toBe('A\\B.azw3')
  })

  test('leaves a Windows path outside documents/ alone', () => {
    expect(canonicalBookKey('E:\\other\\Book.azw3')).toBe('E:\\other\\Book.azw3')
  })
})
