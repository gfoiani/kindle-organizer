import type { KindleBook } from '../../../preload/api'

/**
 * A book's key for collections and title/author edits: its path under the
 * device's `documents/`, computed by the main process (`KindleBook.relpath`).
 * Empty for a book that is not on the device, which therefore can join no
 * collection.
 */
export function toBookRelpath(book: Pick<KindleBook, 'relpath'>): string {
  return book.relpath ?? ''
}
