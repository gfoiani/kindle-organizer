/**
 * Shared book-path helpers.
 *
 * Book relpaths are the load-bearing key that links a device book to its
 * collections, tag overrides, and cover cache. Two strip shapes exist:
 *
 *  - `stripDocumentsBase` — strips the full `{mountpoint}/documents/` prefix
 *    off an absolute device path (used where we hold the live mountpoint).
 *  - `stripDocumentsPrefix` — strips the bare `documents/` prefix off a
 *    Calibre `lpath` (which is always relative to the device root).
 *
 * Centralising them keeps the relpath invariant in one place instead of
 * re-deriving it at every call site.
 */

const DOCUMENTS_PREFIX = 'documents/'

/** Strips a leading `documents/` from a Calibre `lpath`, leaving the relpath. */
export function stripDocumentsPrefix(lpath: string): string {
  return lpath.startsWith(DOCUMENTS_PREFIX) ? lpath.slice(DOCUMENTS_PREFIX.length) : lpath
}

/** Strips the full `{mountpoint}/documents/` base off an absolute book path. */
export function stripDocumentsBase(bookPath: string, documentsBase: string): string {
  return bookPath.startsWith(documentsBase) ? bookPath.slice(documentsBase.length) : bookPath
}
