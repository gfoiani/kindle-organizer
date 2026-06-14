import * as crypto from 'crypto'
import * as fs from 'fs-extra'
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import { app, BrowserWindow } from 'electron'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

// ─── Tuning knobs ─────────────────────────────────────────────────────────────
/** Per-request socket timeout. */
const REQUEST_TIMEOUT_MS = 8000
/** Max HTTP redirects we will follow before giving up. */
const MAX_REDIRECTS = 4
/** Hard cap on a single response body so a hostile/buggy host can't exhaust memory. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/** Relative weights when scoring a candidate by title vs author similarity. */
const TITLE_WEIGHT = 0.75
const AUTHOR_WEIGHT = 0.25
/** A buffer smaller than this can't be a real cover image (it's an error page). */
const MIN_IMAGE_BYTES = 500

// ─── Redirect / host allow-list ─────────────────────────────────────────────
// fetchUrl follows redirects; we only follow https redirects to known provider
// and CDN hosts to keep this off the SSRF surface (a compromised/MITM'd provider
// otherwise could redirect us to an arbitrary internal host).
function isAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    h === 'itunes.apple.com' ||
    h === 'openlibrary.org' ||
    h === 'covers.openlibrary.org' ||
    h === 'www.googleapis.com' ||
    h === 'books.google.com' ||
    h.endsWith('.googleusercontent.com') ||
    /^is\d+-ssl\.mzstatic\.com$/.test(h) ||
    h.endsWith('.mzstatic.com')
  )
}

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

// ─── Rate limiter ─────────────────────────────────────────────────────────────
// Serial queue: one outbound request at a time, with a guaranteed minimum gap.
// On 429 all queued requests also wait (globalPauseUntil).
const MIN_GAP_MS = 600

let lastRequestStart = 0
let globalPauseUntil = 0
let requestChain: Promise<void> = Promise.resolve()

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function scheduleRequest<T>(fn: () => Promise<T>): Promise<T> {
  const result: Promise<T> = requestChain.then(async () => {
    const pauseWait = Math.max(0, globalPauseUntil - Date.now())
    const gapWait = Math.max(0, lastRequestStart + MIN_GAP_MS - Date.now())
    const wait = Math.max(pauseWait, gapWait)
    if (wait > 0) await delay(wait)
    lastRequestStart = Date.now()
    return fn()
  })
  // Swallow errors so a failed request doesn't break the chain for subsequent ones
  requestChain = result.then(
    () => {},
    () => {}
  )
  return result
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function getCoverCacheDir(): string {
  return path.join(app.getPath('userData'), 'covers')
}

function getCacheKey(title: string, author: string | undefined): string {
  const normalized = `${title.toLowerCase().trim()}|${(author ?? '').toLowerCase().trim()}`
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

function getCachePath(key: string): string {
  return path.join(getCoverCacheDir(), `${key}.jpg`)
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

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

function fetchRaw(url: string): Promise<{ statusCode: number; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = []
      let received = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          location: res.headers.location,
          body: Buffer.concat(chunks)
        })
      )
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('Request timed out')))
    req.on('error', reject)
  })
}

/** Resolves a (possibly relative) redirect target and verifies it is https + an allowed host. */
function resolveSafeRedirect(location: string, base: string): string | null {
  try {
    const target = new URL(location, base)
    if (target.protocol !== 'https:' || !isAllowedHost(target.hostname)) {
      debug(`[cover] Refusing redirect to disallowed location "${target.href}"`)
      return null
    }
    return target.href
  } catch (err) {
    debug(`[cover] Malformed redirect "${location}": ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function fetchUrl(url: string, maxRedirects = MAX_REDIRECTS): Promise<Buffer> {
  const result = await fetchRaw(url)
  if ((result.statusCode === 301 || result.statusCode === 302) && maxRedirects > 0) {
    if (result.location) {
      const next = resolveSafeRedirect(result.location, url)
      if (!next) throw new Error(`Blocked redirect from ${url}`)
      return fetchUrl(next, maxRedirects - 1)
    }
  }
  if (result.statusCode === 429) {
    throw new Error('HTTP 429 Too Many Requests')
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`HTTP ${result.statusCode} for ${url}`)
  }
  return result.body
}

// ─── JSON fetch helper ──────────────────────────────────────────────────────
// Every provider does the same fetch → parse → object-guard dance. This wraps it
// so each provider only owns the URL it builds and the shape it expects.
async function fetchJson<T extends object>(url: string): Promise<T | null> {
  const body = await fetchUrlWithRetry(url)
  const json: unknown = JSON.parse(body.toString('utf-8'))
  if (typeof json !== 'object' || json === null) return null
  return json as T
}

// Exponential back-off on 429: 3s → 6s → 12s.
// Also sets globalPauseUntil so all queued requests respect the cooldown.
const BACKOFF_DELAYS = [3000, 6000, 12000]

async function fetchUrlWithRetry(url: string): Promise<Buffer> {
  for (let attempt = 0; attempt <= BACKOFF_DELAYS.length; attempt++) {
    try {
      return await fetchUrl(url)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('HTTP 429') && attempt < BACKOFF_DELAYS.length) {
        const backoff = BACKOFF_DELAYS[attempt]
        globalPauseUntil = Date.now() + backoff
        await delay(backoff)
        continue
      }
      throw err
    }
  }
  throw new Error('Max retries exceeded')
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

/** Normalizes a raw ISBN; returns it only if it looks like an ISBN-10/13. */
function normalizeIsbn(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase()
  return cleaned.length === 10 || cleaned.length === 13 ? cleaned : undefined
}

// ─── Search providers ─────────────────────────────────────────────────────────
// Each returns up to a handful of candidates (image URL + the title/author it
// belongs to) so the caller can verify the match before downloading.

interface GoogleBooksSearch {
  items?: { volumeInfo?: { title?: string; authors?: string[]; imageLinks?: { thumbnail?: string } } }[]
}

async function searchGoogleBooks(
  title: string,
  author: string | undefined
): Promise<CoverCandidate[]> {
  let query = `intitle:${encodeURIComponent(title)}`
  if (author) query += `+inauthor:${encodeURIComponent(author)}`
  const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=5&fields=items(volumeInfo(title,authors,imageLinks/thumbnail))`

  const json = await fetchJson<GoogleBooksSearch>(url)
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
  author: string | undefined
): Promise<CoverCandidate[]> {
  let query = `title=${encodeURIComponent(title)}`
  if (author) query += `&author=${encodeURIComponent(author)}`
  const url = `https://openlibrary.org/search.json?${query}&limit=5&fields=title,author_name,cover_i`

  const json = await fetchJson<OpenLibrarySearch>(url)
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
  country: string
): Promise<CoverCandidate[]> {
  let term = title
  if (author) term += ` ${author}`
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=ebook&limit=5&country=${encodeURIComponent(country)}`

  const json = await fetchJson<ItunesSearch>(url)
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
  country: string
) => Promise<CoverCandidate[]>

const PROVIDERS: Array<{ name: string; search: Provider }> = [
  { name: 'iTunes', search: searchItunes },
  { name: 'OpenLibrary', search: (title, author) => searchOpenLibrary(title, author) },
  { name: 'GoogleBooks', search: (title, author) => searchGoogleBooks(title, author) }
]

/** Fetches a cover directly by ISBN from Open Library — no search/matching needed. */
async function tryIsbnCover(isbn: string): Promise<Buffer | null> {
  // `default=false` makes Open Library return 404 (not a blank placeholder) when missing.
  // ISBN is renderer-controlled and interpolated into the URL path, so re-validate it.
  const safeIsbn = normalizeIsbn(isbn)
  if (!safeIsbn) {
    debug(`[cover] Ignoring malformed ISBN "${isbn}"`)
    return null
  }
  const url = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(safeIsbn)}-L.jpg?default=false`
  try {
    const data = await fetchUrlWithRetry(url)
    return isValidImage(data) ? data : null
  } catch (err) {
    // A 404 (no cover for this ISBN) or transient failure — fall back to search providers.
    debug(`[cover] ISBN ${safeIsbn} lookup failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
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
  country: string
): Promise<DownloadResult> {
  let hadNetworkError = false

  if (isbn) {
    const data = await tryIsbnCover(isbn)
    if (data) {
      debug(`[cover] ISBN ${isbn}: matched cover for "${title}"`)
      return { status: 'found', data }
    }
  }

  for (const provider of PROVIDERS) {
    let candidates: CoverCandidate[]
    try {
      candidates = await provider.search(title, author, country)
    } catch (err) {
      debug(`[cover] ${provider.name} error: ${err instanceof Error ? err.message : String(err)}`)
      hadNetworkError = true
      continue
    }

    const best = pickBestMatch(candidates, title, author)
    if (!best) {
      debug(`[cover] ${provider.name}: no confident match for "${title}" (${candidates.length} candidates)`)
      continue
    }

    try {
      const data = await fetchUrlWithRetry(best.imageUrl)
      if (!isValidImage(data)) {
        debug(`[cover] ${provider.name}: invalid/too-small image for "${title}"`)
        continue
      }
      debug(`[cover] ${provider.name}: matched "${best.title}" for "${title}"`)
      return { status: 'found', data }
    } catch (err) {
      debug(`[cover] ${provider.name} image fetch error: ${err instanceof Error ? err.message : String(err)}`)
      hadNetworkError = true
      continue
    }
  }

  return hadNetworkError ? { status: 'error' } : { status: 'not-found' }
}

// ─── Public cover API ─────────────────────────────────────────────────────────

// Dedupes concurrent identical getCover calls: a second request for the same
// cache key (e.g. the same book mounted twice in the grid) reuses the first
// request's promise instead of scheduling its own network round-trip.
const inFlight = new Map<string, Promise<string | null>>()

export async function getCover(
  title: string,
  author: string | undefined,
  isbn?: string
): Promise<string | null> {
  debug(`[getCover] Searching for cover: title="${title}", author="${author}", isbn="${isbn ?? ''}"`)
  const key = getCacheKey(title, author)
  const cachePath = getCachePath(key)

  // Cache hit — no slot needed
  if (await fs.pathExists(cachePath)) {
    const data = await fs.readFile(cachePath)
    if (data.length === 0) return null // negative cache marker
    return `data:image/jpeg;base64,${data.toString('base64')}`
  }

  // Retry already pending — don't re-queue, renderer will receive push when ready
  if (retryRegistry.has(key)) {
    return null
  }

  // Identical request already in flight — share its promise.
  const existing = inFlight.get(key)
  if (existing) return existing

  // Capture the iTunes storefront now so a mid-flight locale change can't shift it.
  const country = itunesCountry

  await fs.ensureDir(getCoverCacheDir())

  const work = scheduleRequest(async () => {
    const result = await downloadCoverData(title, author, isbn, country)

    if (result.status === 'found') {
      debug(`[getCover] Successfully cached image (${result.data.length} bytes)`)
      await fs.writeFile(cachePath, result.data)
      return `data:image/jpeg;base64,${result.data.toString('base64')}`
    }

    if (result.status === 'not-found') {
      debug(`[getCover] No cover found, writing negative cache`)
      await fs.writeFile(cachePath, Buffer.alloc(0))
      return null
    }

    // Network error — schedule retry, don't write negative cache
    scheduleRetry(key, title, author, isbn, 0)
    return null
  })
    .catch((err) => {
      console.error(`[getCover] Unexpected error for "${title}":`, err)
      scheduleRetry(key, title, author, isbn, 0)
      return null
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, work)
  return work
}

/**
 * Starts the background retry loop. Call once after app is ready.
 * On successful retry, sends 'cover:updated' to the renderer with the cache
 * key (so the renderer can match an edited book reliably) plus title/author
 * (kept for back-compat). Returns a stop function that clears the interval.
 */
export function startCoverRetryLoop(getWindow: () => BrowserWindow | null): () => void {
  const LOOP_INTERVAL_MS = 15_000

  const sendCoverUpdated = (key: string, entry: RetryEntry, dataUrl: string): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('cover:updated', entry.title, entry.author, dataUrl, key)
    }
  }

  const handle = setInterval(() => {
    const now = Date.now()

    for (const [key, entry] of retryRegistry) {
      if (entry.nextRetry > now) continue

      // Mark as in-progress to prevent double-scheduling
      retryRegistry.set(key, { ...entry, nextRetry: Infinity })
      const nextAttempts = entry.attempts + 1

      scheduleRequest(async () => {
        const cachePath = getCachePath(key)
        const result = await downloadCoverData(entry.title, entry.author, entry.isbn, itunesCountry)

        if (result.status === 'found') {
          await fs.ensureDir(getCoverCacheDir())
          await fs.writeFile(cachePath, result.data)
          retryRegistry.delete(key)
          debug(`[cover] Retry #${nextAttempts} succeeded for "${entry.title}"`)

          const dataUrl = `data:image/jpeg;base64,${result.data.toString('base64')}`
          sendCoverUpdated(key, entry, dataUrl)
          return
        }

        if (result.status === 'not-found') {
          // Provider confirmed no cover — write negative cache and stop retrying
          await fs.ensureDir(getCoverCacheDir())
          await fs.writeFile(cachePath, Buffer.alloc(0))
          retryRegistry.delete(key)
          debug(`[cover] Retry #${nextAttempts}: confirmed no cover for "${entry.title}"`)
          return
        }

        // Still a network error — reschedule if attempts remain
        if (nextAttempts < RETRY_DELAYS_MS.length) {
          scheduleRetry(key, entry.title, entry.author, entry.isbn, nextAttempts)
        } else {
          retryRegistry.delete(key)
          debug(`[cover] Max retries reached for "${entry.title}", giving up`)
        }
      }).catch(() => {
        if (nextAttempts < RETRY_DELAYS_MS.length) {
          scheduleRetry(key, entry.title, entry.author, entry.isbn, nextAttempts)
        } else {
          retryRegistry.delete(key)
        }
      })
    }
  }, LOOP_INTERVAL_MS)

  return () => clearInterval(handle)
}

export async function clearCoverCache(): Promise<void> {
  const cacheDir = getCoverCacheDir()
  if (await fs.pathExists(cacheDir)) {
    const files = await fs.readdir(cacheDir)
    for (const file of files) {
      await fs.remove(path.join(cacheDir, file))
    }
  }
  retryRegistry.clear()
}

// ─── Book metadata ────────────────────────────────────────────────────────────

export interface BookMetadata {
  year?: string
  genre?: string
  description?: string
}

const metadataCache = new Map<string, BookMetadata | null>()

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

  return scheduleRequest(async () => {
    let result = await searchOpenLibraryMetadata(title, author)
    if (!result) {
      result = await searchGoogleBooksMetadata(title, author)
    }
    metadataCache.set(key, result)
    return result
  }).catch(() => null)
}
