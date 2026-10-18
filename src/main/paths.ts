import path from 'path'

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

type PathApi = Pick<typeof path, 'join' | 'relative' | 'isAbsolute' | 'sep'>

/**
 * The book's path under the device's `documents/`, POSIX-style — a calibre
 * `lpath` without its `documents/` prefix. Unlike `stripDocumentsBase` it
 * holds on Windows, where book paths use `\` and the mountpoint may be a bare
 * `E:`: the base is joined exactly as `readDocuments` joins it. Undefined for
 * a path outside `documents/`.
 */
export function toDeviceRelpath(bookPath: string, mountpoint: string, pathApi: PathApi = path): string | undefined {
  const relative = pathApi.relative(pathApi.join(mountpoint, 'documents'), bookPath)
  const outside = relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)
  return relative && !outside ? relative.split(pathApi.sep).join('/') : undefined
}
