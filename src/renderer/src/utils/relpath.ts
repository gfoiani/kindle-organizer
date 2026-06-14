/**
 * Strips the device's `documents/` mountpoint prefix from a full book path,
 * yielding the relpath the main process / Calibre use as a stable key.
 * Falls back to the original path when the prefix isn't present.
 */
export function toBookRelpath(fullPath: string, documentsBase: string): string {
  return documentsBase && fullPath.startsWith(documentsBase)
    ? fullPath.slice(documentsBase.length)
    : fullPath
}
