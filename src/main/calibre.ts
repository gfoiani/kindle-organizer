import * as fs from 'fs-extra'
import path from 'path'

export interface CalibreBook {
  lpath: string
  tags: string[]
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
  } catch {
    return []
  }
}
