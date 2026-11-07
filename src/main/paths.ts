import path from 'path'

/**
 * Shared book-path helpers.
 *
 * A device book's **key** — what links it to its collections, title/author
 * overrides and `metadata.calibre` record — is its path under the device's
 * `documents/`, POSIX-style and composed (NFC): `Author/Book.azw3` on every OS.
 * `readDocuments` computes it once (`KindleBook.relpath`); everything else
 * passes it along instead of re-deriving it from the absolute path.
 *
 * Older versions keyed by the absolute path minus a `{mountpoint}/documents/`
 * prefix that never matched on Windows (the whole `E:\documents\…` path was
 * stored) and by whatever normalization macOS handed back. `canonicalBookKey`
 * rewrites those, and the stores apply it to their rows when they open.
 */

const DOCUMENTS_PREFIX = 'documents/'

/** Strips a leading `documents/` from a Calibre `lpath`, leaving the relpath. */
export function stripDocumentsPrefix(lpath: string): string {
  return lpath.startsWith(DOCUMENTS_PREFIX) ? lpath.slice(DOCUMENTS_PREFIX.length) : lpath
}

type PathApi = Pick<typeof path, 'join' | 'relative' | 'isAbsolute' | 'sep'>

/**
 * The book's path under the device's `documents/`, POSIX-style — a calibre
 * `lpath` without its `documents/` prefix. It holds on Windows, where book
 * paths use `\` and the mountpoint may be a bare `E:`: the base is joined
 * exactly as `readDocuments` joins it. Undefined for a path outside
 * `documents/`.
 */
export function toDeviceRelpath(bookPath: string, mountpoint: string, pathApi: PathApi = path): string | undefined {
  const relative = pathApi.relative(pathApi.join(mountpoint, 'documents'), bookPath)
  const outside = relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)
  return relative && !outside ? relative.split(pathApi.sep).join('/') : undefined
}

/** A book's key (see the top of this file): its path under `documents/`, composed. */
export function toBookKey(bookPath: string, mountpoint: string, pathApi: PathApi = path): string | undefined {
  return toDeviceRelpath(bookPath, mountpoint, pathApi)?.normalize('NFC')
}

/**
 * A whole Windows book path under a drive's `documents/`, as older versions
 * stored it: `E:\documents\A\B.azw3`, or `E:documents\B.azw3` when the
 * mountpoint was a bare `E:`. Group 1 is the path under `documents/`.
 */
const WINDOWS_DOCUMENTS_PATH = /^[a-z]:[\\/]?documents[\\/](.+)$/i

/**
 * The current form of a key stored by any version of the app. Only a whole
 * Windows path has its separators rewritten; any other key was stored on macOS
 * or Linux, where it already was the path under `documents/`, so it is only
 * composed.
 */
export function canonicalBookKey(key: string): string {
  const windows = WINDOWS_DOCUMENTS_PATH.exec(key)
  const relpath = windows ? windows[1].split(/[\\/]+/).join('/') : key
  return relpath.normalize('NFC')
}

/**
 * Whether a POSIX relpath really lies under `documents/`: an absolute path, a
 * drive letter or a `..` would become a bogus path next to the real books.
 */
export function isDocumentsRelpath(relpath: string): boolean {
  return relpath !== '' && !relpath.startsWith('/') && !/^[A-Za-z]:/.test(relpath) && !relpath.split('/').includes('..')
}

/**
 * The comparison key for a relpath. A Kindle's volume is FAT/exFAT, which
 * ignores case, so calibre's `Dune.AZW3` and a scanned `Dune.azw3` are one file.
 */
export function foldRelpath(relpath: string): string {
  // macOS hands back decomposed names (NFD) for a book recorded composed (NFC).
  return relpath.normalize('NFC').toLowerCase()
}
