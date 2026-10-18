import { describe, expect, test } from 'vitest'
import { sortBooks } from '../src/renderer/src/utils/sortBooks'
import type { DisplayBook } from '../src/renderer/src/utils/mergeBooks'

function book(title: string, overrides: Partial<DisplayBook> = {}): DisplayBook {
  return { filename: `${title}.azw3`, title, extension: 'AZW3', size: 1, path: `/k/documents/${title}.azw3`, onDevice: true, ...overrides }
}

const titles = (books: DisplayBook[]): string[] => books.map((b) => b.title)

describe('sortBooks', () => {
  test('by title: case- and accent-insensitive, numbers in numeric order', () => {
    const books = [book('libro 10'), book('Èlite'), book('Libro 2'), book('azzurro')]

    expect(titles(sortBooks(books, 'title'))).toEqual(['azzurro', 'Èlite', 'Libro 2', 'libro 10'])
  })

  test('by author, then title; books without an author last', () => {
    const books = [
      book('Z', { author: 'Asimov' }),
      book('Senza autore'),
      book('B', { author: 'Eco' }),
      book('A', { author: 'Asimov' })
    ]

    expect(titles(sortBooks(books, 'author'))).toEqual(['A', 'Z', 'B', 'Senza autore'])
  })

  test('recently added first; books with no date last', () => {
    const books = [book('Old', { addedAt: 1 }), book('Undated'), book('New', { addedAt: 3 }), book('Mid', { addedAt: 2 })]

    expect(titles(sortBooks(books, 'recent'))).toEqual(['New', 'Mid', 'Old', 'Undated'])
  })

  test('returns a new array and leaves the input alone', () => {
    const books = [book('B'), book('A')]

    const sorted = sortBooks(books, 'title')

    expect(sorted).not.toBe(books)
    expect(titles(books)).toEqual(['B', 'A'])
  })
})
