import { bookKey } from './bulkSelection'
import type { DisplayBook } from './mergeBooks'

/**
 * The open book as the grid now shows it, or null when it is gone.
 *
 * Cards are matched by identity (`bookKey`: the library id, else the device
 * path), never by path alone — every library-only card has the placeholder
 * path '' — so a book that was just sent, or deleted from the Kindle, is shown
 * in its new state instead of as a stale snapshot. A device card that gained a
 * library link since it was opened is still found by its path.
 */
export function refreshSelectedBook(books: readonly DisplayBook[], selected: DisplayBook): DisplayBook | null {
  const key = bookKey(selected)
  const byKey = books.find((book) => bookKey(book) === key)
  if (byKey) return byKey
  return (selected.path && books.find((book) => book.path === selected.path)) || null
}
