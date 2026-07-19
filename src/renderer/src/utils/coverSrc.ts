/** The custom protocol scheme that streams cached covers from disk (see coverProtocol.ts). */
export const COVER_SCHEME = 'cover-cache'

/**
 * Builds the `cover-cache://covers/<key>?v=<version>-<epoch>` URL the renderer
 * puts in an `<img src>`. The `?v=` query busts Chromium's (immutable) cache
 * whenever the bytes change:
 *  - `version` is bumped by each `cover:updated` push for the key, and
 *  - `epoch` is bumped whenever the cover cache is cleared.
 *
 * The epoch is load-bearing: a cache-clear resets the per-key version back to 0,
 * so WITHOUT it a re-downloaded cover would reuse an already-cached `?v=…` URL
 * and Chromium would serve the stale (pre-clear) image. Folding the epoch in
 * guarantees a distinct URL after every clear.
 */
export function buildCoverSrc(key: string, version = 0, epoch = 0): string {
  return `${COVER_SCHEME}://covers/${key}?v=${version}-${epoch}`
}
