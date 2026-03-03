import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import { app } from 'electron'

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
    return null
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
    return null
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface BookMetadata {
  year?: string
  genre?: string
  description?: string
}

const metadataCache = new Map<string, BookMetadata | null>()

// ─── Open Library metadata search ─────────────────────────────────────────────

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

    // Fetch description from the works endpoint
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
    // Try Open Library first (no aggressive rate limiting)
    let result = await searchOpenLibraryMetadata(title, author)

    // Fall back to Google Books
    if (!result) {
      result = await searchGoogleBooksMetadata(title, author)
    }

    metadataCache.set(key, result)
    return result
  }).catch(() => null)
}

export async function getCover(title: string, author: string | undefined): Promise<string | null> {
  console.log(`[getCover] Searching for cover: title="${title}", author="${author}"`)
  const key = getCacheKey(title, author)
  const cachePath = getCachePath(key)

  // Cache hit — no slot needed
  if (fs.existsSync(cachePath)) {
    console.log(`[getCover] Cache hit for key ${key}`)
    const data = fs.readFileSync(cachePath)
    if (data.length === 0) return null // negative cache marker
    return `data:image/jpeg;base64,${data.toString('base64')}`
  }

  fs.mkdirSync(getCoverCacheDir(), { recursive: true })

  return scheduleRequest(async () => {
    let imageUrl: string | null = null

    // Try Open Library first (no aggressive rate limiting)
    try {
      imageUrl = await searchOpenLibrary(title, author)
    } catch (err) {
      console.log(`[getCover] Open Library search failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Fall back to Google Books
    if (!imageUrl) {
      try {
        imageUrl = await searchGoogleBooks(title, author)
      } catch (err) {
        console.log(`[getCover] Google Books search failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    }

    if (!imageUrl) {
      console.log(`[getCover] No image URL found, writing negative cache`)
      fs.writeFileSync(cachePath, Buffer.alloc(0))
      return null
    }

    console.log(`[getCover] Downloading image from ${imageUrl}`)
    const imageData = await fetchUrlWithRetry(imageUrl)
    if (imageData.length < 500) {
      console.log(`[getCover] Image too small (${imageData.length} bytes), writing negative cache`)
      fs.writeFileSync(cachePath, Buffer.alloc(0))
      return null
    }

    console.log(`[getCover] Successfully cached image (${imageData.length} bytes)`)
    fs.writeFileSync(cachePath, imageData)
    return `data:image/jpeg;base64,${imageData.toString('base64')}`
  }).catch((err) => {
    console.error(`Failed to fetch cover for "${title}":`, err)
    return null
  })
}

export async function clearCoverCache(): Promise<void> {
  const cacheDir = getCoverCacheDir()
  if (fs.existsSync(cacheDir)) {
    const files = fs.readdirSync(cacheDir)
    for (const file of files) {
      fs.unlinkSync(path.join(cacheDir, file))
    }
  }
}
