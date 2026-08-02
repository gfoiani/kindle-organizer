import type { DisplayBook } from './mergeBooks'

/** State of the two presence chips in the grid toolbar. */
export interface PresenceFilter {
  showOnDevice: boolean
  showLibraryOnly: boolean
}

export interface PresenceCounts {
  onDevice: number
  libraryOnly: number
}

/** Splits a list by presence. Every book is exactly one of the two. */
export function countPresence(books: DisplayBook[]): PresenceCounts {
  const onDevice = books.reduce((n, book) => (book.onDevice ? n + 1 : n), 0)
  return { onDevice, libraryOnly: books.length - onDevice }
}

/**
 * Applies the presence chips, read as a UNION of the selected facets: selecting
 * neither (the default) or both means "no filter", and selecting exactly one
 * narrows to that side. Modelling it as a union — rather than two independent
 * booleans that AND together — is what keeps "both on" from meaning "on the
 * device AND library-only", which is empty by construction.
 *
 * Returns the input array itself when nothing is excluded, so a `useMemo`
 * downstream keeps its reference and the grid does not re-render needlessly.
 */
export function filterByPresence(books: DisplayBook[], filter: PresenceFilter): DisplayBook[] {
  if (!isPresenceFiltered(filter)) return books
  return books.filter((book) => (filter.showOnDevice ? book.onDevice : !book.onDevice))
}

/**
 * Whether the chips actually narrow the list — the same union rule as above, so
 * "both on" counts as no filter. The sidebar reads this to decide whether its
 * "All books" entry has anything to clear.
 */
export function isPresenceFiltered(filter: PresenceFilter): boolean {
  return filter.showOnDevice !== filter.showLibraryOnly
}
