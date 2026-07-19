/** The custom protocol scheme that streams cached covers from disk (see coverProtocol.ts). */
export const COVER_SCHEME = 'cover-cache'

/**
 * Builds the `cover-cache://covers/<key>?v=<n>` URL the renderer puts in an
 * `<img src>`. The `?v=` query busts Chromium's (immutable) cache whenever the
 * bytes change — the version is bumped by a `cover:updated` push or a
 * cache-clear epoch, so a re-downloaded cover is re-fetched instead of served
 * stale from the HTTP cache.
 */
export function buildCoverSrc(key: string, version = 0): string {
  return `${COVER_SCHEME}://covers/${key}?v=${version}`
}
