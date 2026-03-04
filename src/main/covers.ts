import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import { app, BrowserWindow } from 'electron'

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
  prevAttempts: number
): void {
  if (prevAttempts >= RETRY_DELAYS_MS.length) return // max retries reached
  retryRegistry.set(key, {
    title,
    author,
    attempts: prevAttempts,
    nextRetry: Date.now() + RETRY_DELAYS_MS[prevAttempts]
  })
  console.log(
    `[cover] Scheduled retry #${prevAttempts + 1} for "${title}" in ${RETRY_DELAYS_MS[prevAttempts] / 1000}s`
  )
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

function fetchRaw(url: string): Promise<{ statusCode: number; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
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

async function fetchUrl(url: string, maxRedirects = 4): Promise<Buffer> {
  const result = await fetchRaw(url)
  if ((result.statusCode === 301 || result.statusCode === 302) && maxRedirects > 0) {
    if (result.location) return fetchUrl(result.location, maxRedirects - 1)
  }
  if (result.statusCode === 429) {
    throw new Error('HTTP 429 Too Many Requests')
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`HTTP ${result.statusCode} for ${url}`)
  }
  return result.body
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

// ─── Search providers ─────────────────────────────────────────────────────────

async function searchGoogleBooks(
  title: string,
  author: string | undefined
): Promise<string | null> {
  let query = `intitle:${encodeURIComponent(title)}`
  if (author) query += `+inauthor:${encodeURIComponent(author)}`
  const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1&fields=items(volumeInfo/imageLinks)`

  try {
    const body = await fetchUrlWithRetry(url)
    const json = JSON.parse(body.toString('utf-8')) as unknown
    if (typeof json !== 'object' || json === null) {
      console.log(`[searchGoogleBooks] Invalid JSON response`)
      return null
    }

    const thumbnail = (
      json as { items?: [{ volumeInfo?: { imageLinks?: { thumbnail?: string } } }] }
    )?.items?.[0]?.volumeInfo?.imageLinks?.thumbnail
    if (typeof thumbnail !== 'string') {
      console.log(`[searchGoogleBooks] No thumbnail found`)
      return null
    }

    const result = thumbnail.replace('http://', 'https://').replace('zoom=1', 'zoom=2')
    console.log(`[searchGoogleBooks] Found thumbnail: ${result}`)
    return result
  } catch (err) {
    console.log(`[searchGoogleBooks] Error: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

async function searchOpenLibrary(
  title: string,
  author: string | undefined
): Promise<string | null> {
  let query = `title=${encodeURIComponent(title)}`
  if (author) query += `&author=${encodeURIComponent(author)}`
  const url = `https://openlibrary.org/search.json?${query}&limit=1&fields=cover_i`

  try {
    const body = await fetchUrlWithRetry(url)
    const json = JSON.parse(body.toString('utf-8')) as unknown
    if (typeof json !== 'object' || json === null) {
      console.log(`[searchOpenLibrary] Invalid JSON response`)
      return null
    }

    const coverId = (json as { docs?: [{ cover_i?: number }] })?.docs?.[0]?.cover_i
    if (typeof coverId !== 'number') {
      console.log(`[searchOpenLibrary] No cover_i found`)
      return null
    }

    const result = `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`
    console.log(`[searchOpenLibrary] Found cover: ${result}`)
    return result
  } catch (err) {
    console.log(`[searchOpenLibrary] Error: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

async function searchItunes(
  title: string,
  author: string | undefined
): Promise<string | null> {
  let term = title
  if (author) term += ` ${author}`
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=ebook&limit=5&country=us`

  try {
    const body = await fetchUrlWithRetry(url)
    const json = JSON.parse(body.toString('utf-8')) as unknown
    if (typeof json !== 'object' || json === null) {
      console.log(`[searchItunes] Invalid JSON response`)
      return null
    }

    const results = (json as { results?: { artworkUrl100?: string }[] })?.results
    const artwork = results?.[0]?.artworkUrl100
    if (typeof artwork !== 'string') {
      console.log(`[searchItunes] No artwork found`)
      return null
    }

    // Bump resolution from 100x100 to 600x600
    const result = artwork.replace('100x100bb', '600x600bb')
    console.log(`[searchItunes] Found artwork: ${result}`)
    return result
  } catch (err) {
    console.log(`[searchItunes] Error: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

// ─── Core download helper ─────────────────────────────────────────────────────

type DownloadResult =
  | { status: 'found'; data: Buffer }
  | { status: 'not-found' }
  | { status: 'error' }

/**
 * Attempts to download a cover image from all providers.
 * Distinguishes between "provider confirmed no cover" (not-found) and
 * "network/transient failure" (error) so the caller can decide whether to retry.
 */
async function downloadCoverData(
  title: string,
  author: string | undefined
): Promise<DownloadResult> {
  let imageUrl: string | null = null
  let hadNetworkError = false

  try {
    imageUrl = await searchItunes(title, author)
  } catch {
    hadNetworkError = true
  }

  if (!imageUrl) {
    try {
      imageUrl = await searchOpenLibrary(title, author)
    } catch {
      hadNetworkError = true
    }
  }

  if (!imageUrl) {
    try {
      imageUrl = await searchGoogleBooks(title, author)
    } catch {
      hadNetworkError = true
    }
  }

  if (!imageUrl) {
    return hadNetworkError ? { status: 'error' } : { status: 'not-found' }
  }

  try {
    const data = await fetchUrlWithRetry(imageUrl)
    if (data.length < 500) {
      console.log(`[cover] Image too small (${data.length} bytes) for "${title}"`)
      return { status: 'not-found' }
    }
    return { status: 'found', data }
  } catch {
    return { status: 'error' }
  }
}

// ─── Public cover API ─────────────────────────────────────────────────────────

export async function getCover(title: string, author: string | undefined): Promise<string | null> {
  console.log(`[getCover] Searching for cover: title="${title}", author="${author}"`)
  const key = getCacheKey(title, author)
  const cachePath = getCachePath(key)

  // Cache hit — no slot needed
  if (fs.existsSync(cachePath)) {
    const data = fs.readFileSync(cachePath)
    if (data.length === 0) return null // negative cache marker
    return `data:image/jpeg;base64,${data.toString('base64')}`
  }

  // Retry already pending — don't re-queue, renderer will receive push when ready
  if (retryRegistry.has(key)) {
    return null
  }

  fs.mkdirSync(getCoverCacheDir(), { recursive: true })

  return scheduleRequest(async () => {
    const result = await downloadCoverData(title, author)

    if (result.status === 'found') {
      console.log(`[getCover] Successfully cached image (${result.data.length} bytes)`)
      fs.writeFileSync(cachePath, result.data)
      return `data:image/jpeg;base64,${result.data.toString('base64')}`
    }

    if (result.status === 'not-found') {
      console.log(`[getCover] No cover found, writing negative cache`)
      fs.writeFileSync(cachePath, Buffer.alloc(0))
      return null
    }

    // Network error — schedule retry, don't write negative cache
    scheduleRetry(key, title, author, 0)
    return null
  }).catch((err) => {
    console.error(`[getCover] Unexpected error for "${title}":`, err)
    scheduleRetry(key, title, author, 0)
    return null
  })
}

/**
 * Starts the background retry loop. Call once after app is ready.
 * On successful retry, sends 'cover:updated' to the renderer.
 */
export function startCoverRetryLoop(getWindow: () => BrowserWindow | null): void {
  const LOOP_INTERVAL_MS = 15_000

  setInterval(() => {
    const now = Date.now()

    for (const [key, entry] of retryRegistry) {
      if (entry.nextRetry > now) continue

      // Mark as in-progress to prevent double-scheduling
      retryRegistry.set(key, { ...entry, nextRetry: Infinity })
      const nextAttempts = entry.attempts + 1

      scheduleRequest(async () => {
        const cachePath = getCachePath(key)
        const result = await downloadCoverData(entry.title, entry.author)

        if (result.status === 'found') {
          fs.mkdirSync(getCoverCacheDir(), { recursive: true })
          fs.writeFileSync(cachePath, result.data)
          retryRegistry.delete(key)
          console.log(`[cover] Retry #${nextAttempts} succeeded for "${entry.title}"`)

          const dataUrl = `data:image/jpeg;base64,${result.data.toString('base64')}`
          getWindow()?.webContents.send('cover:updated', entry.title, entry.author, dataUrl)
          return
        }

        if (result.status === 'not-found') {
          // Provider confirmed no cover — write negative cache and stop retrying
          fs.mkdirSync(getCoverCacheDir(), { recursive: true })
          fs.writeFileSync(cachePath, Buffer.alloc(0))
          retryRegistry.delete(key)
          console.log(`[cover] Retry #${nextAttempts}: confirmed no cover for "${entry.title}"`)
          return
        }

        // Still a network error — reschedule if attempts remain
        if (nextAttempts < RETRY_DELAYS_MS.length) {
          scheduleRetry(key, entry.title, entry.author, nextAttempts)
        } else {
          retryRegistry.delete(key)
          console.log(`[cover] Max retries reached for "${entry.title}", giving up`)
        }
      }).catch(() => {
        if (nextAttempts < RETRY_DELAYS_MS.length) {
          scheduleRetry(key, entry.title, entry.author, nextAttempts)
        } else {
          retryRegistry.delete(key)
        }
      })
    }
  }, LOOP_INTERVAL_MS)
}

export async function clearCoverCache(): Promise<void> {
  const cacheDir = getCoverCacheDir()
  if (fs.existsSync(cacheDir)) {
    const files = fs.readdirSync(cacheDir)
    for (const file of files) {
      fs.unlinkSync(path.join(cacheDir, file))
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

async function searchOpenLibraryMetadata(
  title: string,
  author: string | undefined
): Promise<BookMetadata | null> {
  let query = `title=${encodeURIComponent(title)}`
  if (author) query += `&author=${encodeURIComponent(author)}`
  const url = `https://openlibrary.org/search.json?${query}&limit=1&fields=first_publish_year,subject,key`

  try {
    const body = await fetchUrlWithRetry(url)
    const json = JSON.parse(body.toString('utf-8')) as unknown
    if (typeof json !== 'object' || json === null) return null

    const doc = (json as { docs?: [{ first_publish_year?: number; subject?: string[]; key?: string }] })?.docs?.[0]
    if (!doc) return null

    const year = doc.first_publish_year ? String(doc.first_publish_year) : undefined
    const genre = doc.subject?.[0]

    let description: string | undefined
    if (doc.key) {
      try {
        const workBody = await fetchUrlWithRetry(`https://openlibrary.org${doc.key}.json`)
        const workJson = JSON.parse(workBody.toString('utf-8')) as unknown
        if (typeof workJson === 'object' && workJson !== null) {
          const desc = (workJson as { description?: string | { value?: string } }).description
          description = typeof desc === 'string' ? desc : desc?.value
        }
      } catch (err) {
        console.log(`[searchOpenLibraryMetadata] Works fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (!year && !genre && !description) return null

    console.log(`[searchOpenLibraryMetadata] Found: year=${year}, genre=${genre}, desc=${description ? 'yes' : 'no'}`)
    return { year, genre, description }
  } catch (err) {
    console.log(`[searchOpenLibraryMetadata] Error: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function searchGoogleBooksMetadata(
  title: string,
  author: string | undefined
): Promise<BookMetadata | null> {
  let query = `intitle:${encodeURIComponent(title)}`
  if (author) query += `+inauthor:${encodeURIComponent(author)}`
  const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1&fields=items(volumeInfo(publishedDate,categories,description))`

  try {
    const body = await fetchUrlWithRetry(url)
    const json = JSON.parse(body.toString('utf-8')) as unknown
    if (typeof json !== 'object' || json === null) return null

    const volumeInfo = (
      json as {
        items?: [
          {
            volumeInfo?: {
              publishedDate?: string
              categories?: string[]
              description?: string
            }
          }
        ]
      }
    )?.items?.[0]?.volumeInfo

    if (!volumeInfo) return null

    return {
      year: volumeInfo.publishedDate?.slice(0, 4),
      genre: volumeInfo.categories?.[0],
      description: volumeInfo.description
    }
  } catch (err) {
    console.log(`[searchGoogleBooksMetadata] Error: ${err instanceof Error ? err.message : String(err)}`)
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
