import path from 'path'

/**
 * Derives a human-readable title from a file path: drops the directory and
 * extension, turns underscores into spaces, and falls back to the bare basename
 * when the cleaned string is empty. Shared by the EPUB parser (metadata fallback)
 * and the library importer (non-EPUB titles).
 */
export function titleFromFilename(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath))
  return base.replace(/_/g, ' ').trim() || base
}
