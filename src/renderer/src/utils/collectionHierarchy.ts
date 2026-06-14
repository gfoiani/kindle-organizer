/**
 * Author sub-collections.
 *
 * The Kindle/Calibre device model has no nested collections — a collection is a
 * flat tag string. So "group an author's books together inside a genre" is
 * represented as a normal collection whose NAME encodes the hierarchy:
 *
 *     "Thriller / Glenn Cooper"
 *
 * These pure helpers are the single source of truth for building and reading
 * that convention. The main process stays hierarchy-agnostic (it just writes the
 * names verbatim as device tags); only the renderer parses them for display.
 */

/** Separator between the genre and the author in a sub-collection name. */
export const SUBCOLLECTION_SEPARATOR = ' / '

/** A "<collection name> contains these book relpaths" instruction for the batch writer. */
export interface CollectionMembership {
  name: string
  relpaths: string[]
}

/** A book reduced to what author-grouping needs: its genre, author, and relpath key. */
export interface AuthoredBook {
  /** The top-level genre/collection name the book belongs to. */
  genre: string
  /** The book's author; empty/undefined books are excluded from grouping. */
  author?: string
  /** The book's stable relpath key. */
  relpath: string
}

export interface ParsedCollectionName {
  genre: string
  /** Present only when the name encodes an author sub-collection. */
  author?: string
}

/**
 * Strips the separator out of a single name part and collapses whitespace, so a
 * composed name always contains exactly one separator to split back on. Returns
 * '' when nothing meaningful remains (callers skip empty parts).
 */
export function sanitizeNamePart(part: string): string {
  return part
    .split(SUBCOLLECTION_SEPARATOR)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Builds a "<Genre> / <Author>" sub-collection name. Returns '' when either part
 * is empty after sanitization (the caller then skips creating the sub-collection).
 */
export function formatAuthorCollectionName(genre: string, author: string): string {
  const g = sanitizeNamePart(genre)
  const a = sanitizeNamePart(author)
  if (!g || !a) return ''
  return `${g}${SUBCOLLECTION_SEPARATOR}${a}`
}

/**
 * Splits a collection name on the FIRST separator only, so an author that itself
 * contains the separator (or a malformed multi-separator name) still parses to a
 * single genre + author pair.
 */
export function parseCollectionName(name: string): ParsedCollectionName {
  const i = name.indexOf(SUBCOLLECTION_SEPARATOR)
  if (i === -1) return { genre: name }
  return {
    genre: name.slice(0, i),
    author: name.slice(i + SUBCOLLECTION_SEPARATOR.length)
  }
}

/** True when the name encodes an author sub-collection. */
export function isSubCollection(name: string): boolean {
  return name.includes(SUBCOLLECTION_SEPARATOR)
}

/**
 * Case/whitespace-insensitive key for deduping genre/author variants. Used only
 * for matching — display names keep their first-seen casing.
 */
export function normalizeKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Builds author sub-collection membership payloads from a flat list of
 * (genre, author, relpath) tuples.
 *
 * Rules:
 *  - books without an author are skipped (they stay in the genre only);
 *  - a genre with fewer than 2 distinct authors is skipped — a single-author
 *    sub-collection would just duplicate its parent and bloat the device tags;
 *  - books are grouped by normalized author so "Glenn Cooper" / "glenn cooper"
 *    land in one sub-collection (named with the first-seen casing).
 *
 * The returned names are pre-composed and ready for the main-process batch writer.
 */
export function buildAuthorSubcollections(books: AuthoredBook[]): CollectionMembership[] {
  // genre name → its authored books
  const byGenre = new Map<string, AuthoredBook[]>()
  for (const book of books) {
    if (!book.author || !book.author.trim()) continue
    const existing = byGenre.get(book.genre) ?? []
    byGenre.set(book.genre, [...existing, book])
  }

  const result: CollectionMembership[] = []
  for (const [genre, genreBooks] of byGenre) {
    const distinctAuthors = new Set(genreBooks.map((b) => normalizeKey(b.author as string)))
    if (distinctAuthors.size < 2) continue

    // author dedup key → membership entry (built immutably)
    const bySubName = new Map<string, CollectionMembership>()
    for (const book of genreBooks) {
      const name = formatAuthorCollectionName(genre, book.author as string)
      if (!name) continue
      const key = normalizeKey(name)
      const existing = bySubName.get(key)
      bySubName.set(key, {
        name: existing?.name ?? name,
        relpaths: existing ? [...existing.relpaths, book.relpath] : [book.relpath]
      })
    }
    result.push(...bySubName.values())
  }
  return result
}
