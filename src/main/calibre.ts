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
