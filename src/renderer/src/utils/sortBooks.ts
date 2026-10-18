import type { DisplayBook } from './mergeBooks'

/** How the grid can order its books. */
export type BookSortOrder = 'title' | 'author' | 'recent'

export const BOOK_SORT_ORDERS: readonly BookSortOrder[] = ['title', 'author', 'recent']

/** Case- and accent-insensitive, with "Libro 2" before "Libro 10". */
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

function byTitle(a: DisplayBook, b: DisplayBook): number {
  return collator.compare(a.title, b.title)
}

/** Books without an author go last rather than first. */
function byAuthor(a: DisplayBook, b: DisplayBook): number {
  if (!a.author !== !b.author) return a.author ? -1 : 1
  return collator.compare(a.author ?? '', b.author ?? '') || byTitle(a, b)
}

/** Newest first; a book with no known date goes last. */
function byRecent(a: DisplayBook, b: DisplayBook): number {
  if ((a.addedAt === undefined) !== (b.addedAt === undefined)) return a.addedAt === undefined ? 1 : -1
  return (b.addedAt ?? 0) - (a.addedAt ?? 0) || byTitle(a, b)
}

const COMPARATORS: Record<BookSortOrder, (a: DisplayBook, b: DisplayBook) => number> = {
  title: byTitle,
  author: byAuthor,
  recent: byRecent
}

/** A sorted copy of `books`; the input is left untouched. */
export function sortBooks(books: readonly DisplayBook[], order: BookSortOrder): DisplayBook[] {
  return [...books].sort(COMPARATORS[order])
}

export function isBookSortOrder(value: unknown): value is BookSortOrder {
  return typeof value === 'string' && (BOOK_SORT_ORDERS as readonly string[]).includes(value)
}
