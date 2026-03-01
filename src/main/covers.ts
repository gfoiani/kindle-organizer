import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import { app } from 'electron'

// ─── Concurrency limiter ──────────────────────────────────────────────────────
// Limit simultaneous outbound HTTP requests to avoid 429 rate-limit errors.
const MAX_CONCURRENT = 3
let activeRequests = 0
const waitQueue: Array<() => void> = []

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeRequests < MAX_CONCURRENT) {
      activeRequests++
      resolve()
    } else {
      waitQueue.push(resolve)
    }
  })
}

function releaseSlot(): void {
  const next = waitQueue.shift()
  if (next) {
    // slot stays "acquired", hand it directly to the next waiter
    next()
  } else {
    activeRequests--
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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

// Retry once on 429 with a 2-second back-off
async function fetchUrlWithRetry(url: string): Promise<Buffer> {
  try {
    return await fetchUrl(url)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('HTTP 429')) {
      await delay(2000)
      return fetchUrl(url)
    }
    throw err
  }
}

// ─── Search providers ─────────────────────────────────────────────────────────

async function searchGoogleBooks(
  title: string,
  author: string | undefined
): Promise<string | null> {
  let query = `intitle:${encodeURIComponent(title)}`
  if (author) query += `+inauthor:${encodeURIComponent(author)}`
  const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1&fields=items(volumeInfo/imageLinks)`

  const body = await fetchUrlWithRetry(url)
  const json = JSON.parse(body.toString('utf-8')) as unknown
  if (typeof json !== 'object' || json === null) return null

  const thumbnail = (
    json as { items?: [{ volumeInfo?: { imageLinks?: { thumbnail?: string } } }] }
  )?.items?.[0]?.volumeInfo?.imageLinks?.thumbnail
  if (typeof thumbnail !== 'string') return null

  return thumbnail.replace('http://', 'https://').replace('zoom=1', 'zoom=2')
}

async function searchOpenLibrary(
  title: string,
  author: string | undefined
): Promise<string | null> {
  let query = `title=${encodeURIComponent(title)}`
  if (author) query += `&author=${encodeURIComponent(author)}`
  const url = `https://openlibrary.org/search.json?${query}&limit=1&fields=cover_i`

  const body = await fetchUrlWithRetry(url)
  const json = JSON.parse(body.toString('utf-8')) as unknown
  if (typeof json !== 'object' || json === null) return null

  const coverId = (json as { docs?: [{ cover_i?: number }] })?.docs?.[0]?.cover_i
  if (typeof coverId !== 'number') return null

  return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getCover(title: string, author: string | undefined): Promise<string | null> {
  const key = getCacheKey(title, author)
  const cachePath = getCachePath(key)

  // Cache hit — no slot needed
  if (fs.existsSync(cachePath)) {
    const data = fs.readFileSync(cachePath)
    if (data.length === 0) return null // negative cache marker
    return `data:image/jpeg;base64,${data.toString('base64')}`
  }

  fs.mkdirSync(getCoverCacheDir(), { recursive: true })

  // Throttle: wait for a free slot before making any outbound requests
  await acquireSlot()
  try {
    let imageUrl: string | null = null
    try {
      imageUrl = await searchGoogleBooks(title, author)
    } catch {
      // Google Books failed; try Open Library
    }

    if (!imageUrl) {
      try {
        imageUrl = await searchOpenLibrary(title, author)
      } catch {
        // Open Library also failed; give up for this session (no negative cache)
        return null
      }
    }

    if (!imageUrl) {
      fs.writeFileSync(cachePath, Buffer.alloc(0)) // negative cache
      return null
    }

    const imageData = await fetchUrlWithRetry(imageUrl)
    if (imageData.length < 500) {
      // Too small — likely a placeholder/error image
      fs.writeFileSync(cachePath, Buffer.alloc(0))
      return null
    }

    fs.writeFileSync(cachePath, imageData)
    // Small courtesy delay after each successful network operation
    await delay(100)
    return `data:image/jpeg;base64,${imageData.toString('base64')}`
  } catch (err) {
    console.error(`Failed to fetch cover for "${title}":`, err)
    return null
  } finally {
    releaseSlot()
  }
}
