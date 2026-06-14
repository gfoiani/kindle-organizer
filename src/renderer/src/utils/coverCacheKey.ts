/**
 * Recomputes the cover cache key the main process uses (SHA-256 of
 * `title|author`, lowercased + trimmed). Lets the renderer match a
 * retry-pushed `cover:updated` event to the right card on a stable key.
 * Must stay in sync with getCacheKey() in src/main/covers.ts.
 */
export async function computeCoverCacheKey(title: string, author?: string): Promise<string> {
  const normalized = `${title.toLowerCase().trim()}|${(author ?? '').toLowerCase().trim()}`
  const bytes = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
