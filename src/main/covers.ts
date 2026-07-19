import * as fs from 'fs-extra'
import * as path from 'path'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { getCoverCacheDir, getCachePath, getCacheKey, normalizeIsbn } from './coverPaths'
import { fetchJson, fetchUrlWithRetry } from './httpClient'
import { resetScheduler } from './requestScheduler'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

// ─── Tuning knobs ─────────────────────────────────────────────────────────────
/** Relative weights when scoring a candidate by title vs author similarity. */
const TITLE_WEIGHT = 0.75
const AUTHOR_WEIGHT = 0.25
/** A buffer smaller than this can't be a real cover image (it's an error page). */
const MIN_IMAGE_BYTES = 500

// ─── iTunes storefront ──────────────────────────────────────────────────────
// iTunes search results depend on the storefront country. Matching it to the
// app language greatly improves hit rate for non-US books (e.g. Italian titles).
const LANG_TO_ITUNES_COUNTRY: Record<string, string> = { it: 'it', en: 'us' }
let itunesCountry = 'us'

/** Set by the renderer (via IPC) to align the iTunes storefront with the UI language. */
export function setCoverLocale(lang: string): void {
  itunesCountry = LANG_TO_ITUNES_COUNTRY[lang] ?? 'us'
  debug(`[cover] iTunes storefront set to "${itunesCountry}" for lang "${lang}"`)
}

// ─── Abort helper ─────────────────────────────────────────────────────────────
// Cancellation flows as an AbortError (name-matched so it survives realm/module
// boundaries). It must NEVER be treated as a network failure — an aborted
// download schedules no retry and writes no negative cache.
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// ─── Retry registry ───────────────────────────────────────────────────────────
// Tracks books whose cover download failed due to network errors (not "no cover found").
// Retried with exponential backoff; on success pushes cover:updated to the renderer.

// Delays: 30s → 2min → 5min → 15min → 1hr
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000, 900_000, 3_600_000]

interface RetryEntry {
  title: string
  author: string | undefined
  isbn: string | undefined
  /** How many retries have been scheduled so far (0 = first retry pending). */
  attempts: number
  /** Epoch ms after which this entry is eligible for retry. Infinity = in-progress. */
  nextRetry: number
}

const retryRegistry = new Map<string, RetryEntry>()

function scheduleRetry(
  key: string,
  title: string,
  author: string | undefined,
  isbn: string | undefined,
  prevAttempts: number
): void {
  if (prevAttempts >= RETRY_DELAYS_MS.length) return // max retries reached
  retryRegistry.set(key, {
    title,
    author,
    isbn,
    attempts: prevAttempts,
    nextRetry: Date.now() + RETRY_DELAYS_MS[prevAttempts]
  })
  debug(
    `[cover] Scheduled retry #${prevAttempts + 1} for "${title}" in ${RETRY_DELAYS_MS[prevAttempts] / 1000}s`
  )
}

// ─── Match verification ───────────────────────────────────────────────────────
// Providers return several candidates; we only accept one whose title (and
// author, when available) actually matches the book, instead of blindly taking
// the first result. This is the main defense against wrong covers.

interface CoverCandidate {
  imageUrl: string
  title: string
  author?: string
}

// Combined match score must clear this, and the title alone must clear MIN_TITLE_SCORE.
const MATCH_THRESHOLD = 0.5
const MIN_TITLE_SCORE = 0.34

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
}

function tokenize(s: string): string[] {
  return normalize(s)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

/** Fraction of the query's tokens that appear in the candidate text (0..1). */
function containment(query: string, candidate: string): number {
  const q = tokenize(query)
  if (q.length === 0) return 0
  const c = new Set(tokenize(candidate))
  let hit = 0
  for (const t of q) if (c.has(t)) hit++
  return hit / q.length
}

function matchScore(candidate: CoverCandidate, qTitle: string, qAuthor: string | undefined): number {
  const titleScore = containment(qTitle, candidate.title)
  if (titleScore < MIN_TITLE_SCORE) return 0
  if (qAuthor && candidate.author) {
    const authorScore = containment(qAuthor, candidate.author)
    return titleScore * TITLE_WEIGHT + authorScore * AUTHOR_WEIGHT
  }
  return titleScore
}

/** Picks the best-matching candidate above the acceptance threshold, or null. */
function pickBestMatch(
  candidates: CoverCandidate[],
  qTitle: string,
  qAuthor: string | undefined
): CoverCandidate | null {
  let best: CoverCandidate | null = null
  let bestScore = 0
  for (const candidate of candidates) {
    const score = matchScore(candidate, qTitle, qAuthor)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null
}

/** Validates that a buffer is a real image (JPEG/PNG/GIF/WEBP), not an HTML error page. */
function isValidImage(buf: Buffer): boolean {
  if (buf.length < MIN_IMAGE_BYTES) return false
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true
  // WEBP (RIFF....WEBP)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return true
  }
  return false
}

// ─── Search providers ─────────────────────────────────────────────────────────
// Each returns up to a handful of candidates (image URL + the title/author it
// belongs to) so the caller can verify the match before downloading.

interface GoogleBooksSearch {
  items?: { volumeInfo?: { title?: string; authors?: string[]; imageLinks?: { thumbnail?: string } } }[]
}

async function searchGoogleBooks(
  title: string,
  author: string | undefined,
  signal?: AbortSignal
): Promise<CoverCandidate[]> {
  let query = `intitle:${encodeURIComponent(title)}`
  if (author) query += `+inauthor:${encodeURIComponent(author)}`
  const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=5&fields=items(volumeInfo(title,authors,imageLinks/thumbnail))`

  const json = await fetchJson<GoogleBooksSearch>(url, signal)
  const items = json?.items ?? []

  const candidates: CoverCandidate[] = []
  for (const item of items) {
    const info = item.volumeInfo
    const thumbnail = info?.imageLinks?.thumbnail
    if (typeof info?.title !== 'string' || typeof thumbnail !== 'string') continue
    candidates.push({
      imageUrl: thumbnail.replace('http://', 'https://').replace('zoom=1', 'zoom=2'),
      title: info.title,
      author: info.authors?.join(' ')
    })
  }
  return candidates
}

interface OpenLibrarySearch {
  docs?: { title?: string; author_name?: string[]; cover_i?: number }[]
}

async function searchOpenLibrary(
  title: string,
  author: string | undefined,
  signal?: AbortSignal
): Promise<CoverCandidate[]> {
  let query = `title=${encodeURIComponent(title)}`
  if (author) query += `&author=${encodeURIComponent(author)}`
  const url = `https://openlibrary.org/search.json?${query}&limit=5&fields=title,author_name,cover_i`

  const json = await fetchJson<OpenLibrarySearch>(url, signal)
  const docs = json?.docs ?? []

  const candidates: CoverCandidate[] = []
  for (const doc of docs) {
    if (typeof doc.title !== 'string' || typeof doc.cover_i !== 'number') continue
    candidates.push({
      imageUrl: `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`,
      title: doc.title,
      author: doc.author_name?.join(' ')
    })
  }
  return candidates
}

interface ItunesSearch {
  results?: { trackName?: string; collectionName?: string; artistName?: string; artworkUrl100?: string }[]
}

async function searchItunes(
  title: string,
  author: string | undefined,
  country: string,
  signal?: AbortSignal
): Promise<CoverCandidate[]> {
  let term = title
  if (author) term += ` ${author}`
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=ebook&limit=5&country=${encodeURIComponent(country)}`

  const json = await fetchJson<ItunesSearch>(url, signal)
  const results = json?.results ?? []

  const candidates: CoverCandidate[] = []
  for (const r of results) {
    const candidateTitle = r.trackName ?? r.collectionName
    if (typeof candidateTitle !== 'string' || typeof r.artworkUrl100 !== 'string') continue
    candidates.push({
      // Bump resolution from 100x100 to 600x600
      imageUrl: r.artworkUrl100.replace('100x100bb', '600x600bb'),
      title: candidateTitle,
      author: r.artistName
    })
  }
  return candidates
}

// ─── Core download helper ─────────────────────────────────────────────────────

type DownloadResult =
  | { status: 'found'; data: Buffer }
  | { status: 'not-found' }
  | { status: 'error' }

type Provider = (
  title: string,
  author: string | undefined,
  country: string,
  signal?: AbortSignal
) => Promise<CoverCandidate[]>

const PROVIDERS: Array<{ name: string; search: Provider }> = [
  { name: 'iTunes', search: searchItunes },
  { name: 'OpenLibrary', search: (title, author, _country, signal) => searchOpenLibrary(title, author, signal) },
  { name: 'GoogleBooks', search: (title, author, _country, signal) => searchGoogleBooks(title, author, signal) }
]

/**
 * Fetches a cover directly by ISBN from Open Library — no search/matching needed.
 * Returns `'found'` (valid image), `'miss'` (404 / not an image → try providers),
 * or `'error'` (network/rate-limit blip → the caller should retry, not
 * negative-cache). An abort propagates as AbortError (never a miss).
 */
async function tryIsbnCover(
  isbn: string,
  signal?: AbortSignal
): Promise<{ status: 'found'; data: Buffer } | { status: 'miss' } | { status: 'error' }> {
  // `default=false` makes Open Library return 404 (not a blank placeholder) when missing.
  // ISBN is renderer-controlled and interpolated into the URL path, so re-validate it.
  const safeIsbn = normalizeIsbn(isbn)
  if (!safeIsbn) {
    debug(`[cover] Ignoring malformed ISBN "${isbn}"`)
    return { status: 'miss' }
  }
  const url = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(safeIsbn)}-L.jpg?default=false`
  try {
    const data = await fetchUrlWithRetry(url, signal)
    return isValidImage(data) ? { status: 'found', data } : { status: 'miss' }
  } catch (err) {
    if (isAbortError(err)) throw err
    // NetworkError/RateLimitError → transient (retry). HttpError (e.g. 404) → real miss.
    const transient = err instanceof Error && (err.name === 'NetworkError' || err.name === 'RateLimitError')
    debug(`[cover] ISBN ${safeIsbn} lookup ${transient ? 'failed (transient)' : 'missed'}: ${err instanceof Error ? err.message : String(err)}`)
    return transient ? { status: 'error' } : { status: 'miss' }
  }
}

/**
 * Attempts to download a cover image. When an ISBN is known it is tried first
 * (most reliable). Otherwise — or on miss — it falls back to the search
 * providers, accepting only a candidate that actually matches the book and is a
 * valid image. Distinguishes between "no match found" (not-found) and
 * "network/transient failure" (error) so the caller can decide whether to retry.
 *
 * `country` is captured once at enqueue time so a mid-queue locale change can't
 * shift the iTunes storefront for an in-flight request.
 */
async function downloadCoverData(
  title: string,
  author: string | undefined,
  isbn: string | undefined,
  country: string,
  signal?: AbortSignal
): Promise<DownloadResult> {
  let hadNetworkError = false

  if (isbn) {
    const isbnResult = await tryIsbnCover(isbn, signal)
    if (isbnResult.status === 'found') {
      debug(`[cover] ISBN ${isbn}: matched cover for "${title}"`)
      return { status: 'found', data: isbnResult.data }
    }
    if (isbnResult.status === 'error') hadNetworkError = true
  }

  for (const provider of PROVIDERS) {
    let candidates: CoverCandidate[]
    try {
      candidates = await provider.search(title, author, country, signal)
    } catch (err) {
      if (isAbortError(err)) throw err
      debug(`[cover] ${provider.name} error: ${err instanceof Error ? err.message : String(err)}`)
      // A malformed/HTTP response is "no candidate" (fetchJson already mapped a
      // parse error to null), a socket/timeout/429 is a transient network error.
      if (err instanceof Error && (err.name === 'NetworkError' || err.name === 'RateLimitError')) {
        hadNetworkError = true
      }
      continue
    }

    const best = pickBestMatch(candidates, title, author)
    if (!best) {
      debug(`[cover] ${provider.name}: no confident match for "${title}" (${candidates.length} candidates)`)
      continue
    }

    try {
      const data = await fetchUrlWithRetry(best.imageUrl, signal)
      if (!isValidImage(data)) {
        debug(`[cover] ${provider.name}: invalid/too-small image for "${title}"`)
        continue
      }
      debug(`[cover] ${provider.name}: matched "${best.title}" for "${title}"`)
      return { status: 'found', data }
    } catch (err) {
      if (isAbortError(err)) throw err
      debug(`[cover] ${provider.name} image fetch error: ${err instanceof Error ? err.message : String(err)}`)
      if (err instanceof Error && (err.name === 'NetworkError' || err.name === 'RateLimitError')) {
        hadNetworkError = true
      }
      continue
    }
  }

  return hadNetworkError ? { status: 'error' } : { status: 'not-found' }
}

// ─── Public cover API ─────────────────────────────────────────────────────────

export type CoverStatus = 'ready' | 'pending' | 'missing'
export interface EnsureCoverResult {
  key: string
  status: CoverStatus
}

// Renderer window provider — set once at startup. Both ensureCover (background
// download) and the retry loop push a lightweight 'cover:updated' (KEY ONLY,
// never bytes): the renderer re-fetches the file over the cover-cache:// protocol.
let getMainWindow: () => BrowserWindow | null = () => null

export function setCoverWindowProvider(fn: () => BrowserWindow | null): void {
  getMainWindow = fn
}

function notifyCoverReady(key: string): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send('cover:updated', key)
}

// Pushed on any TERMINAL "no cover" outcome (confirmed not-found or retries
// exhausted). Key only — it moves a card out of its pending pulse and into the
// extension-placeholder state without waiting for a remount to re-read the marker.
function notifyCoverMissing(key: string): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send('cover:missing', key)
}

function notifyCoverCacheCleared(): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send('cover:cache-cleared')
}

/** Writes the 0-byte negative-cache marker for a key (ensuring the dir first). */
async function writeNegativeCache(key: string): Promise<void> {
  await fs.ensureDir(getCoverCacheDir())
  await fs.writeFile(getCachePath(key), Buffer.alloc(0))
}

// Active downloads keyed by cache key. `controllers` lets the renderer cancel a
// download when a card scrolls away; `inFlight` dedupes concurrent identical
// requests; `interest` ref-counts how many mounted cards are awaiting a given
// key, so a cover shared by two books (same title/author, e.g. two formats)
// is aborted only when the LAST interested card unmounts.
const controllers = new Map<string, AbortController>()
const inFlight = new Map<string, Promise<void>>()
const interest = new Map<string, number>()
// In-flight retry-loop downloads: cancellable by cancelAllCovers (teardown /
// cache-clear) but NOT by cancelCover (a card scrolling away), since retries are
// background work owned by no card.
const retryControllers = new Set<AbortController>()

/**
 * Seeds the cover cache directly from a locally-extracted image (e.g. an EPUB's
 * embedded cover), bypassing the network. Because the key is derived from
 * (title, author) exactly as in ensureCover, a later ensureCover(title, author)
 * finds this file already on disk and serves it via cover-cache:// with no
 * network round-trip.
 *
 * Returns the cache key on success, or null when the buffer is not a valid image
 * (the caller then falls back to the normal online lookup). The key omits ISBN:
 * library books are keyed on (title, author), so the renderer must read them back
 * with ensureCover(title, author) (no isbn) for the keys to agree.
 */
export async function importLocalCover(
  title: string,
  author: string | undefined,
  image: Buffer
): Promise<string | null> {
  if (!isValidImage(image)) return null

  const key = getCacheKey(title, author)

  // Cancel any in-flight download and drop any scheduled retry for this key so a
  // losing network race can't later overwrite the imported image (or stamp a
  // negative-cache marker over it).
  controllers.get(key)?.abort()
  retryRegistry.delete(key)

  await fs.ensureDir(getCoverCacheDir())
  await fs.writeFile(getCachePath(key), image)
  notifyCoverReady(key)
  return key
}

/**
 * Ensures a cover for (title, author, isbn) exists on disk, returning its cache
 * key and current status WITHOUT ever blocking on the network:
 *  - 'ready'   → a cached image is on disk (serve it via cover-cache://covers/<key>)
 *  - 'missing' → a negative-cache marker is on disk (no cover exists)
 *  - 'pending' → a download/retry is in flight; a 'cover:updated' push will
 *                arrive carrying this key when the image lands.
 * Any download runs in the background through the request scheduler.
 */
export async function ensureCover(
  title: string,
  author: string | undefined,
  isbn?: string
): Promise<EnsureCoverResult> {
  const key = getCacheKey(title, author, isbn)
  const cachePath = getCachePath(key)

  // Cache hit / negative-cache marker — served straight from disk by the protocol.
  if (await fs.pathExists(cachePath)) {
    const stat = await fs.stat(cachePath)
    return { key, status: stat.size === 0 ? 'missing' : 'ready' }
  }

  // A background retry owns this key — the card just waits for the push.
  if (retryRegistry.has(key)) {
    return { key, status: 'pending' }
  }

  // An identical download is already running and NOT being torn down — join it
  // (ref-count the interest). A download whose controller is already aborted is
  // dying, so we fall through and start a fresh one instead of joining it.
  if (inFlight.has(key) && controllers.get(key)?.signal.aborted === false) {
    interest.set(key, (interest.get(key) ?? 0) + 1)
    return { key, status: 'pending' }
  }

  // Capture the storefront now so a mid-flight locale change can't shift it.
  startCoverDownload(key, cachePath, title, author, isbn, itunesCountry)
  return { key, status: 'pending' }
}

/**
 * Sets up the controller/interest bookkeeping for a fresh key and kicks off the
 * background download, wiring its terminal outcomes to the renderer pushes.
 * Split out of `ensureCover` so the latter stays a short dispatcher.
 */
function startCoverDownload(
  key: string,
  cachePath: string,
  title: string,
  author: string | undefined,
  isbn: string | undefined,
  country: string
): void {
  const controller = new AbortController()
  controllers.set(key, controller)
  interest.set(key, 1)

  const work = (async () => {
    const result = await downloadCoverData(title, author, isbn, country, controller.signal)

    if (result.status === 'found') {
      await fs.ensureDir(getCoverCacheDir())
      await fs.writeFile(cachePath, result.data)
      debug(`[cover] Cached "${title}" (${result.data.length} bytes)`)
      notifyCoverReady(key)
      return
    }
    if (result.status === 'not-found') {
      await writeNegativeCache(key)
      debug(`[cover] No cover found for "${title}" — negative-cached`)
      notifyCoverMissing(key)
      return
    }
    // Transient network error — retry later, never negative-cache.
    scheduleRetry(key, title, author, isbn, 0)
  })()
    .catch((err) => {
      if (isAbortError(err)) {
        debug(`[cover] Download aborted for "${title}"`)
        return // cancelled: no retry, no negative cache
      }
      console.error(
        `[cover] ensureCover failed for "${title}":`,
        err instanceof Error ? err.message : String(err)
      )
      scheduleRetry(key, title, author, isbn, 0)
    })
    .finally(() => {
      // Only clear state we still own — a remount after an abort may have
      // installed a fresh controller/work under the same key.
      if (controllers.get(key) === controller) {
        controllers.delete(key)
        interest.delete(key)
      }
      if (inFlight.get(key) === work) inFlight.delete(key)
    })

  inFlight.set(key, work)
}

/**
 * Called when a card unmounts (e.g. scrolled past the overscan window). Decrements
 * the interest count and aborts the shared download only when no other mounted
 * card is still awaiting the same key.
 */
export function cancelCover(title: string, author: string | undefined, isbn?: string): void {
  const key = getCacheKey(title, author, isbn)
  const remaining = interest.get(key)
  if (remaining === undefined) return // cache hit / retry-owned / already settled
  if (remaining <= 1) {
    interest.delete(key)
    controllers.get(key)?.abort()
  } else {
    interest.set(key, remaining - 1)
  }
}

/** Cancels every in-flight download (foreground + retry) and clears the scheduler queue. */
export function cancelAllCovers(): void {
  for (const controller of controllers.values()) controller.abort()
  for (const controller of retryControllers) controller.abort()
  controllers.clear()
  retryControllers.clear()
  interest.clear()
  resetScheduler()
}

async function rescheduleOrGiveUp(
  key: string,
  entry: RetryEntry,
  nextAttempts: number
): Promise<void> {
  if (nextAttempts < RETRY_DELAYS_MS.length) {
    scheduleRetry(key, entry.title, entry.author, entry.isbn, nextAttempts)
    return
  }
  // Retries exhausted. Negative-cache so a later remount doesn't re-run the full
  // provider search on every scroll-in, and push cover:missing so the card can
  // leave its pulse now (the cache can be cleared to try again later).
  await writeNegativeCache(key)
  retryRegistry.delete(key)
  notifyCoverMissing(key)
  debug(`[cover] Max retries reached for "${entry.title}", giving up (negative-cached)`)
}

/**
 * Runs one due retry: re-attempts the download and, on success, writes the file
 * and pushes 'cover:updated' (key only). Errors are logged, never swallowed.
 */
async function runRetry(key: string, entry: RetryEntry, nextAttempts: number): Promise<void> {
  const cachePath = getCachePath(key)
  // A controller so cancelAllCovers (teardown / cache-clear) can abort a retry
  // that's already mid-request, preventing it from resurrecting a cleared cover.
  const controller = new AbortController()
  retryControllers.add(controller)
  try {
    const result = await downloadCoverData(
      entry.title,
      entry.author,
      entry.isbn,
      itunesCountry,
      controller.signal
    )

    if (result.status === 'found') {
      await fs.ensureDir(getCoverCacheDir())
      await fs.writeFile(cachePath, result.data)
      retryRegistry.delete(key)
      debug(`[cover] Retry #${nextAttempts} succeeded for "${entry.title}"`)
      notifyCoverReady(key)
      return
    }
    if (result.status === 'not-found') {
      await writeNegativeCache(key)
      retryRegistry.delete(key)
      debug(`[cover] Retry #${nextAttempts}: confirmed no cover for "${entry.title}"`)
      notifyCoverMissing(key)
      return
    }
    await rescheduleOrGiveUp(key, entry, nextAttempts)
  } catch (err) {
    if (isAbortError(err)) {
      // Cancelled (teardown / cache-clear). Drop the registry entry; if the app
      // is still running the next ensureCover for this key starts fresh.
      retryRegistry.delete(key)
      return
    }
    console.error(
      `[cover] Retry #${nextAttempts} for "${entry.title}" errored:`,
      err instanceof Error ? err.message : String(err)
    )
    await rescheduleOrGiveUp(key, entry, nextAttempts)
  } finally {
    retryControllers.delete(controller)
  }
}

/**
 * Starts the background retry loop and wires the renderer window provider. Call
 * once after app is ready. On a successful retry it pushes 'cover:updated' (key
 * only). Returns a stop function that clears the interval.
 */
export function startCoverRetryLoop(getWindow: () => BrowserWindow | null): () => void {
  setCoverWindowProvider(getWindow)
  const LOOP_INTERVAL_MS = 15_000

  const handle = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of retryRegistry) {
      if (entry.nextRetry > now) continue
      // Mark as in-progress to prevent double-scheduling.
      retryRegistry.set(key, { ...entry, nextRetry: Infinity })
      void runRetry(key, entry, entry.attempts + 1)
    }
  }, LOOP_INTERVAL_MS)

  return () => clearInterval(handle)
}

export async function clearCoverCache(): Promise<void> {
  // Abort in-flight downloads + drop the scheduler queue so nothing re-writes a
  // file we're about to wipe.
  cancelAllCovers()

  const cacheDir = getCoverCacheDir()
  if (await fs.pathExists(cacheDir)) {
    const files = await fs.readdir(cacheDir)
    for (const file of files) {
      await fs.remove(path.join(cacheDir, file))
    }
  }
  retryRegistry.clear()
  notifyCoverCacheCleared()
}

// ─── Book metadata ────────────────────────────────────────────────────────────

export interface BookMetadata {
  year?: string
  genre?: string
  description?: string
}

// Insertion-ordered Map used as a FIFO LRU so a large library can't grow the
// metadata cache without bound.
const MAX_METADATA_ENTRIES = 500
const metadataCache = new Map<string, BookMetadata | null>()

function cacheMetadata(key: string, value: BookMetadata | null): void {
  if (metadataCache.size >= MAX_METADATA_ENTRIES) {
    const oldest = metadataCache.keys().next().value
    if (oldest !== undefined) metadataCache.delete(oldest)
  }
  metadataCache.set(key, value)
}

interface OpenLibraryMetadataSearch {
  docs?: { first_publish_year?: number; subject?: string[]; key?: string }[]
}

interface OpenLibraryWork {
  description?: string | { value?: string }
}

async function searchOpenLibraryMetadata(
  title: string,
  author: string | undefined
): Promise<BookMetadata | null> {
  let query = `title=${encodeURIComponent(title)}`
  if (author) query += `&author=${encodeURIComponent(author)}`
  const url = `https://openlibrary.org/search.json?${query}&limit=1&fields=first_publish_year,subject,key`

  try {
    const json = await fetchJson<OpenLibraryMetadataSearch>(url)
    const doc = json?.docs?.[0]
    if (!doc) return null

    const year = doc.first_publish_year ? String(doc.first_publish_year) : undefined
    const genre = doc.subject?.[0]

    let description: string | undefined
    if (doc.key) {
      try {
        const workJson = await fetchJson<OpenLibraryWork>(`https://openlibrary.org${doc.key}.json`)
        const desc = workJson?.description
        description = typeof desc === 'string' ? desc : desc?.value
      } catch (err) {
        debug(`[searchOpenLibraryMetadata] Works fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (!year && !genre && !description) return null

    debug(`[searchOpenLibraryMetadata] Found: year=${year}, genre=${genre}, desc=${description ? 'yes' : 'no'}`)
    return { year, genre, description }
  } catch (err) {
    // Transient failures and aborts must propagate so the caller never caches
    // "not found" for a lookup that didn't actually complete.
    if (
      err instanceof Error &&
      (err.name === 'NetworkError' || err.name === 'RateLimitError' || err.name === 'AbortError')
    ) {
      throw err
    }
    debug(`[searchOpenLibraryMetadata] Error: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

interface GoogleBooksMetadataSearch {
  items?: { volumeInfo?: { publishedDate?: string; categories?: string[]; description?: string } }[]
}

async function searchGoogleBooksMetadata(
  title: string,
  author: string | undefined
): Promise<BookMetadata | null> {
  let query = `intitle:${encodeURIComponent(title)}`
  if (author) query += `+inauthor:${encodeURIComponent(author)}`
  const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1&fields=items(volumeInfo(publishedDate,categories,description))`

  try {
    const json = await fetchJson<GoogleBooksMetadataSearch>(url)
    const volumeInfo = json?.items?.[0]?.volumeInfo

    if (!volumeInfo) return null

    return {
      year: volumeInfo.publishedDate?.slice(0, 4),
      genre: volumeInfo.categories?.[0],
      description: volumeInfo.description
    }
  } catch (err) {
    // Transient failures and aborts must propagate so the caller never caches
    // "not found" for a lookup that didn't actually complete.
    if (
      err instanceof Error &&
      (err.name === 'NetworkError' || err.name === 'RateLimitError' || err.name === 'AbortError')
    ) {
      throw err
    }
    debug(`[searchGoogleBooksMetadata] Error: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export async function getBookMetadata(
  title: string,
  author: string | undefined
): Promise<BookMetadata | null> {
  const key = getCacheKey(title, author)
  if (metadataCache.has(key)) return metadataCache.get(key) ?? null

  try {
    let result = await searchOpenLibraryMetadata(title, author)
    if (!result) {
      result = await searchGoogleBooksMetadata(title, author)
    }
    // Cache the resolved answer (including a confirmed "not found") but never a
    // transient failure or abort — the providers throw those up here.
    cacheMetadata(key, result)
    return result
  } catch (err) {
    if (isAbortError(err)) return null // cancelled — never cache
    console.error(
      `[cover] getBookMetadata failed for "${title}":`,
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}
