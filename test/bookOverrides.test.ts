import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import path from 'path'
import { cleanupUserDataDirs, freshUserData } from './setup/electron-mock'
import { applyOverrides, setOverride } from '../src/main/bookOverrides'
import type { KindleBook } from '../src/main/kindle'

beforeEach(() => {
  freshUserData()
})

afterAll(() => {
  cleanupUserDataDirs()
})

function deviceBook(overrides: Partial<KindleBook> = {}): KindleBook {
  return {
    filename: 'Dune.azw3',
    title: 'dune',
    extension: 'AZW3',
    size: 1,
    path: '/Volumes/Kindle/documents/Author/Dune.azw3',
    relpath: 'Author/Dune.azw3',
    ...overrides
  }
}

describe('applyOverrides', () => {
  test('replaces the title and author the user edited', () => {
    // Arrange
    setOverride('Author/Dune.azw3', 'Dune', 'Frank Herbert')

    // Act
    const [book] = applyOverrides([deviceBook()])

    // Assert
    expect(book.title).toBe('Dune')
    expect(book.author).toBe('Frank Herbert')
  })

  test('leaves books without an edit untouched', () => {
    setOverride('Other.azw3', 'Other', undefined)
    const original = deviceBook()

    expect(applyOverrides([original])).toEqual([original])
  })

  test('finds the edit of a book on Windows, whose path uses a drive letter and backslashes', () => {
    setOverride('Author/Dune.azw3', 'Dune', undefined)
    const book = deviceBook({ path: 'E:\\documents\\Author\\Dune.azw3' })

    expect(applyOverrides([book])[0].title).toBe('Dune')
  })

  test('an edit saved on Windows under the whole book path still applies', () => {
    // Arrange: overrides.db as an older version wrote it on Windows.
    const old = new Database(path.join(freshUserData(), 'overrides.db'))
    old.exec('CREATE TABLE book_override (book_path TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT)')
    old.prepare('INSERT INTO book_override VALUES (?, ?, ?)').run('E:\\documents\\Author\\Dune.azw3', 'Dune', null)
    old.close()

    // Act
    const [book] = applyOverrides([deviceBook()])

    // Assert
    expect(book.title).toBe('Dune')
  })
})
