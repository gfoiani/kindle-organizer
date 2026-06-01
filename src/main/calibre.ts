import * as fs from 'fs-extra'
import path from 'path'

export interface CalibreBook {
  lpath: string
  tags: string[]
}

/**
 * Writes updated tags back to `metadata.calibre` on the Kindle.
 * Only updates the `tags` field for books already present in the file.
 * Books not in `bookTagMap` keep their existing tags.
 * Returns true if the file was successfully updated.
 */
export function writeCalibreMetadata(
  mountpoint: string,
  bookTagMap: Map<string, string[]>
): boolean {
  const metadataPath = path.join(mountpoint, 'metadata.calibre')

  if (!fs.existsSync(metadataPath)) return false

  try {
    const raw = fs.readFileSync(metadataPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)

    if (!Array.isArray(parsed)) return false

    const updated = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry
      const rec = entry as Record<string, unknown>
      const lpath = rec['lpath']
      if (typeof lpath !== 'string') return entry

      const relpath = lpath.startsWith('documents/')
        ? lpath.slice('documents/'.length)
        : lpath

      const tags = bookTagMap.get(relpath)
      if (tags !== undefined) {
        return { ...rec, tags }
      }
      return entry
    })

    // Atomic write: write to a temp file then rename, so the device's
    // metadata.calibre is never left half-written if the Kindle is unplugged mid-write.
    const tempPath = `${metadataPath}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(updated, null, 2), 'utf-8')
    fs.renameSync(tempPath, metadataPath)
    return true
  } catch (err) {
    console.error(
      `[calibre] Failed to write metadata to ${metadataPath}:`,
      err instanceof Error ? err.message : String(err)
    )
    return false
  }
}

export function readCalibreMetadata(mountpoint: string): CalibreBook[] {
  const metadataPath = path.join(mountpoint, 'metadata.calibre')

  if (!fs.existsSync(metadataPath)) {
    return []
  }

  try {
    const raw = fs.readFileSync(metadataPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)

    if (!Array.isArray(parsed)) {
      return []
    }

    const books: CalibreBook[] = []

    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue

      const lpath = (entry as Record<string, unknown>)['lpath']
      const tags = (entry as Record<string, unknown>)['tags']

      if (typeof lpath !== 'string') continue

      const normalizedTags =
        Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : []

      if (normalizedTags.length > 0) {
        books.push({ lpath, tags: normalizedTags })
      }
    }

    return books
  } catch (err) {
    console.error(
      `[calibre] Failed to read metadata from ${metadataPath}:`,
      err instanceof Error ? err.message : String(err)
    )
    return []
  }
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
  const metadataPath = path.join(mountpoint, 'metadata.calibre')
  const result = new Map<string, string>()

  if (!fs.existsSync(metadataPath)) return result

  try {
    const raw = fs.readFileSync(metadataPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return result

    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const rec = entry as Record<string, unknown>
      const lpath = rec['lpath']
      if (typeof lpath !== 'string') continue

      const isbn = extractIsbn(rec)
      if (!isbn) continue

      const relpath = lpath.startsWith('documents/') ? lpath.slice('documents/'.length) : lpath
      result.set(relpath, isbn)
    }
  } catch (err) {
    console.error(
      `[calibre] Failed to read ISBNs from ${metadataPath}:`,
      err instanceof Error ? err.message : String(err)
    )
  }

  return result
}
