import * as fs from 'fs-extra'
import path from 'path'
import { randomUUID } from 'crypto'
import { stripDocumentsPrefix } from './paths'
import { backupCalibreMetadata, hasRecentCalibreBackup, listCalibreBackups } from './calibreBackup'

export { CALIBRE_BACKUP_LIMIT, describeCalibreBackups, type CalibreBackupSummary } from './calibreBackup'

export interface CalibreBook {
  lpath: string
  tags: string[]
}

const METADATA_FILENAME = 'metadata.calibre'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function getMetadataPath(mountpoint: string): string {
  return path.join(mountpoint, METADATA_FILENAME)
}

/**
 * Reads `metadata.calibre` as its raw entry array. Returns null when the file is
 * absent, unreadable, malformed, or not the expected top-level array — callers
 * decide whether that means "nothing to do" or "refuse to write".
 */
function readEntryArray(metadataPath: string): unknown[] | null {
  if (!fs.existsSync(metadataPath)) return null

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
    return Array.isArray(parsed) ? parsed : null
  } catch (err) {
    console.error(`[calibre] Failed to read metadata from ${metadataPath}:`, errorText(err))
    return null
  }
}

/**
 * Atomic write: temp file then rename, so the device's `metadata.calibre` is
 * never left half-written if the Kindle is unplugged mid-write. A failed write
 * cleans up its temp file rather than leaving a stale `.tmp` on the device.
 * The file being replaced is backed up first (see calibreBackup.ts); when that
 * copy cannot be made, nothing is written. A `routine` write (registering a
 * just-sent book) skips the copy when a recent one exists, so a bulk send
 * keeps the pre-send file rather than ten copies of its own progress.
 */
function writeEntryArray(metadataPath: string, entries: unknown[], routine = false): boolean {
  const tempPath = `${metadataPath}.tmp`
  const mountpoint = path.dirname(metadataPath)

  if (fs.existsSync(metadataPath) && !(routine && hasRecentCalibreBackup(mountpoint))) {
    try {
      backupCalibreMetadata(mountpoint, metadataPath)
    } catch (err) {
      console.error(`[calibre] Not writing ${metadataPath}: the backup failed:`, errorText(err))
      return false
    }
  }

  try {
    fs.writeFileSync(tempPath, JSON.stringify(entries, null, 2), 'utf-8')
    fs.renameSync(tempPath, metadataPath)
    return true
  } catch (err) {
    console.error(`[calibre] Failed to write metadata to ${metadataPath}:`, errorText(err))
    try {
      fs.removeSync(tempPath)
    } catch (cleanupErr) {
      console.error(`[calibre] Failed to clean up temp file ${tempPath}:`, errorText(cleanupErr))
    }
    return false
  }
}

/** What the app knows about a book that is already in the device's `documents/`. */
export interface DeviceBookInfo {
  /** Path under `documents/` — the same key `bookTagMap` uses. */
  relpath: string
  title: string
  author?: string
  size: number
}

/** MIME types calibre records for the formats a Kindle reads. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  azw3: 'application/x-mobi8-ebook',
  azw: 'application/vnd.amazon.ebook',
  mobi: 'application/x-mobipocket-ebook',
  kfx: 'application/vnd.amazon.ebook',
  pdf: 'application/pdf',
  txt: 'text/plain',
  epub: 'application/epub+zip'
}

export function calibreMimeType(relpath: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(relpath).slice(1).toLowerCase()]
}

/** `lpath` is always posix-separated, whatever the host platform uses. */
function toPosixRelpath(relpath: string): string {
  return relpath.split(path.sep).join('/')
}

/**
 * Whether a POSIX relpath really lies under `documents/`: an absolute path, a
 * drive letter or a `..` would become a bogus `lpath` next to the real record.
 */
function isDocumentsRelpath(relpath: string): boolean {
  return relpath !== '' && !relpath.startsWith('/') && !/^[A-Za-z]:/.test(relpath) && !relpath.split('/').includes('..')
}

/**
 * The comparison key for a relpath. A Kindle's volume is FAT/exFAT, which
 * ignores case, so calibre's `Dune.AZW3` and a scanned `Dune.azw3` are one file.
 */
function foldRelpath(relpath: string): string {
  // macOS hands back decomposed names (NFD) for a book calibre recorded composed (NFC).
  return relpath.normalize('NFC').toLowerCase()
}

function entryRelpath(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const lpath = (entry as Record<string, unknown>)['lpath']
  return typeof lpath === 'string' ? stripDocumentsPrefix(lpath) : undefined
}

/**
 * Writes updated tags back to `metadata.calibre` on the Kindle.
 *
 * The write is authoritative for every book the app knows about: any book whose
 * relpath appears in `bookTagMap` has its `tags` set to that exact array — which
 * includes books removed from all collections (seeded with `[]` by the caller),
 * so de-tagging actually clears the tag on the device. Books the app does NOT
 * know about (absent from the map) keep their existing tags untouched.
 *
 * Calibre is not required: a book in a collection that the file does not list
 * (copied by hand, or on a Kindle calibre never touched — then there is no file
 * at all) gets a calibre-shaped record built from `deviceBooks`. Nothing is
 * created when no book is in any collection, and a file that exists but cannot
 * be parsed is still left untouched.
 *
 * Returns true if the device now reflects the map.
 */
export function writeCalibreMetadata(
  mountpoint: string,
  bookTagMap: Map<string, string[]>,
  deviceBooks: readonly DeviceBookInfo[] = []
): boolean {
  const metadataPath = getMetadataPath(mountpoint)
  const exists = fs.existsSync(metadataPath)
  const entries = exists ? readEntryArray(metadataPath) : []
  if (!entries) return false

  const tagsByFoldedPath = new Map([...bookTagMap].map(([relpath, tags]) => [foldRelpath(relpath), tags]))
  const updated = entries.map((entry) => {
    const relpath = entryRelpath(entry)
    const tags =
      relpath === undefined ? undefined : (bookTagMap.get(relpath) ?? tagsByFoldedPath.get(foldRelpath(relpath)))
    return tags !== undefined ? { ...(entry as Record<string, unknown>), tags } : entry
  })

  const listed = new Set(entries.flatMap((entry) => entryRelpath(entry) ?? []).map(foldRelpath))
  const added = deviceBooks.flatMap((book) => {
    const relpath = toPosixRelpath(book.relpath)
    const tags = bookTagMap.get(book.relpath)
    if (!tags || tags.length === 0 || listed.has(foldRelpath(relpath)) || !isDocumentsRelpath(relpath)) return []
    const input = { ...book, relpath, mime: calibreMimeType(relpath), uuid: randomUUID() }
    return [{ ...buildEntry(input, relpath, undefined), tags }]
  })

  if (!exists && added.length === 0) return true
  return writeEntryArray(metadataPath, [...updated, ...added])
}

/**
 * Puts back the backup of `metadata.calibre` named `id` (one of
 * `describeCalibreBackups`). The file it replaces is backed up in turn, so a
 * restore can itself be undone by choosing that copy. `id` comes from the
 * renderer, so it is only ever matched against the device's own backups —
 * never used as a path. Null when it is not one of them; throws when the copy
 * is damaged or the restored file cannot be written.
 */
export function restoreCalibreBackup(mountpoint: string, id: string): { takenAt: string } | null {
  const backup = listCalibreBackups(mountpoint).find((candidate) => path.basename(candidate.file) === id)
  if (!backup) return null
  const entries = readEntryArray(backup.file)
  if (!entries) throw new Error(`The ${backup.takenAt} backup of ${METADATA_FILENAME} is not readable`)
  if (!writeEntryArray(getMetadataPath(mountpoint), entries)) {
    throw new Error(`Could not restore the ${backup.takenAt} backup of ${METADATA_FILENAME}`)
  }
  return { takenAt: backup.takenAt }
}

/**
 * Drops the records of books deleted from the device (relpaths under
 * `documents/`, compared case-insensitively). A device without the file has
 * nothing to drop; a file that will not parse is left untouched (false).
 */
export function removeCalibreEntries(mountpoint: string, relpaths: readonly string[]): boolean {
  const metadataPath = getMetadataPath(mountpoint)
  if (!fs.existsSync(metadataPath)) return true
  const entries = readEntryArray(metadataPath)
  if (!entries) return false

  const removed = new Set(relpaths.map((relpath) => foldRelpath(toPosixRelpath(relpath))))
  const kept = entries.filter((entry) => {
    const relpath = entryRelpath(entry)
    return relpath === undefined || !removed.has(foldRelpath(relpath))
  })
  return kept.length === entries.length || writeEntryArray(metadataPath, kept)
}

/**
 * The tagged books in `metadata.calibre`: [] when the Kindle has no file, null
 * when it has one that cannot be read. The difference matters — importing []
 * deletes every collection that came from calibre.
 */
export function readCalibreMetadata(mountpoint: string): CalibreBook[] | null {
  const metadataPath = getMetadataPath(mountpoint)
  if (!fs.existsSync(metadataPath)) return []
  const entries = readEntryArray(metadataPath)
  if (!entries) return null

  const books: CalibreBook[] = []

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue

    const lpath = (entry as Record<string, unknown>)['lpath']
    const tags = (entry as Record<string, unknown>)['tags']

    if (typeof lpath !== 'string') continue

    const normalizedTags = Array.isArray(tags)
      ? tags.filter((t): t is string => typeof t === 'string')
      : []

    if (normalizedTags.length > 0) {
      books.push({ lpath, tags: normalizedTags })
    }
  }

  return books
}

/** Normalizes a raw ISBN string; returns it only if it looks like an ISBN-10/13. */
function normalizeIsbn(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase()
  return cleaned.length === 10 || cleaned.length === 13 ? cleaned : undefined
}

/** Pulls an ISBN out of a Calibre record's `identifiers` dict (or a top-level `isbn`). */
function extractIsbn(rec: Record<string, unknown>): string | undefined {
  const identifiers = rec['identifiers']
  if (identifiers && typeof identifiers === 'object') {
    const isbn = normalizeIsbn((identifiers as Record<string, unknown>)['isbn'])
    if (isbn) return isbn
  }
  return normalizeIsbn(rec['isbn'])
}

/**
 * Reads `metadata.calibre` and returns a map of book relative path → ISBN for
 * every entry that has one. Used to fetch covers by ISBN (the most reliable
 * source). Unlike readCalibreMetadata, this is not limited to tagged books.
 */
export function readCalibreIsbnMap(mountpoint: string): Map<string, string> {
  const result = new Map<string, string>()
  const entries = readEntryArray(getMetadataPath(mountpoint))
  if (!entries) return result

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as Record<string, unknown>
    const lpath = rec['lpath']
    if (typeof lpath !== 'string') continue

    const isbn = extractIsbn(rec)
    if (!isbn) continue

    result.set(stripDocumentsPrefix(lpath), isbn)
  }

  return result
}

// ─── Registering an uploaded book ─────────────────────────────────────────────

/** What the app knows about a book it has just copied into `documents/`. */
export interface CalibreEntryInput {
  /** Path under `documents/`, e.g. `Dune.azw3` (platform separators are fine). */
  relpath: string
  title: string
  author?: string
  /** Size of the uploaded file in bytes. */
  size: number
  /** MIME type of the uploaded format, when known. */
  mime?: string
  /** Stable identity for the book — the UUID stamped inside it when available. */
  uuid: string
}

/** Calibre's placeholder for a book with no author. */
const UNKNOWN_AUTHOR = 'Unknown'

/** Renders `Frank Herbert` as `Herbert, Frank`, the way calibre sorts authors. */
function toAuthorSort(author: string): string {
  const parts = author.trim().split(/\s+/)
  if (parts.length < 2) return author.trim()
  const last = parts[parts.length - 1]
  return `${last}, ${parts.slice(0, -1).join(' ')}`
}

/** Preserves an existing string array (tags, collections) across a re-upload. */
function keepStringArray(rec: Record<string, unknown> | undefined, field: string): string[] {
  const value = rec?.[field]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The explicit nulls calibre writes for the fields it has no value for. */
function emptyCalibreFields(): Record<string, unknown> {
  return {
    application_id: null,
    book_producer: null,
    comments: null,
    cover: null,
    identifiers: {},
    languages: [],
    pubdate: null,
    publisher: null,
    rating: null,
    series: null,
    series_index: null,
    thumbnail: null
  }
}

/**
 * Builds the record calibre would write for this book: the fields the app
 * owns are set, everything else is what an existing record already holds
 * (calibre's ISBN, series, publisher… survive a re-upload — the ISBN feeds the
 * cover lookup) or the explicit nulls calibre emits, so the entry round-trips
 * through its reader (and through ours) unchanged.
 */
function buildEntry(
  input: CalibreEntryInput,
  relpath: string,
  existing: Record<string, unknown> | undefined
): Record<string, unknown> {
  const author = input.author?.trim() || UNKNOWN_AUTHOR

  return {
    ...emptyCalibreFields(),
    ...existing,
    lpath: `documents/${relpath}`,
    title: input.title,
    title_sort: input.title,
    authors: [author],
    author_sort: toAuthorSort(author),
    // Tags ARE collections for this app (see writeCalibreMetadata) — a re-upload
    // must not silently drop the book out of every collection it belongs to.
    tags: keepStringArray(existing, 'tags'),
    device_collections: keepStringArray(existing, 'device_collections'),
    uuid: input.uuid,
    size: input.size,
    mime: input.mime ?? null,
    last_modified: new Date().toISOString()
  }
}

/**
 * Registers a freshly uploaded book in the device's `metadata.calibre`, creating
 * the file when the device has none — this is the bookkeeping calibre does after
 * copying a book, and what lets the book take part in collections.
 *
 * Re-uploading the same relpath updates that record in place (keeping its tags
 * and collections) instead of duplicating it. A `metadata.calibre` we cannot
 * parse is left strictly untouched: overwriting it would wipe every collection
 * on the device. Returns whether the file now contains the entry.
 */
export function upsertCalibreEntry(mountpoint: string, input: CalibreEntryInput): boolean {
  const metadataPath = getMetadataPath(mountpoint)
  const exists = fs.existsSync(metadataPath)
  const entries = exists ? readEntryArray(metadataPath) : []

  if (!entries) {
    console.error(
      `[calibre] Refusing to register "${input.relpath}": ${metadataPath} is not readable JSON`
    )
    return false
  }

  const relpath = toPosixRelpath(input.relpath)

  const index = entries.findIndex((entry) => {
    const entryPath = entryRelpath(entry)
    return entryPath !== undefined && foldRelpath(entryPath) === foldRelpath(relpath)
  })

  const existing = index >= 0 ? (entries[index] as Record<string, unknown>) : undefined
  const entry = buildEntry(input, relpath, existing)
  const updated = index >= 0 ? entries.map((e, i) => (i === index ? entry : e)) : [...entries, entry]

  return writeEntryArray(metadataPath, updated, true)
}
