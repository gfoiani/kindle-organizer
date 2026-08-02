import type { DisplayBook } from './mergeBooks'

/**
 * Stable identity for a selected card.
 *
 * Deliberately the same expression the grid uses as its React key: a library
 * book keeps its id after it lands on the device (mergeBooks reconciles the two
 * into one card), so a selection survives the rescan that follows a send.
 */
export function bookKey(book: DisplayBook): string {
  return book.libraryId ?? book.path
}

/** The selected books, in the order they appear in `books`. */
export function selectedBooks(books: DisplayBook[], selected: ReadonlySet<string>): DisplayBook[] {
  return books.filter((book) => selected.has(bookKey(book)))
}

/**
 * Books that can be sent: staged in the library and not yet on the device.
 * A device-only card has no library copy to convert and upload.
 */
export function sendableBooks(books: DisplayBook[]): DisplayBook[] {
  return books.filter((book) => book.libraryId !== undefined && !book.onDevice)
}

/**
 * Books with a library entry to delete. Unlike sending, this includes books
 * already on the device — removing the staged copy leaves the device file alone.
 */
export function removableBooks(books: DisplayBook[]): DisplayBook[] {
  return books.filter((book) => book.libraryId !== undefined)
}

/**
 * Books that can join a collection. Collections are device tags written into
 * metadata.calibre, so a book that never reached the device has nothing to tag —
 * the same rule the per-card collection button already applies.
 */
export function collectableBooks(books: DisplayBook[]): DisplayBook[] {
  return books.filter((book) => book.onDevice)
}
