import { app } from 'electron'
import { normalizeIsbn } from './coverPaths'
import { type CoverCandidate, isValidImage, pickBestMatch } from './coverMatch'
import { fetchJson, fetchUrlWithRetry, isAbortError } from './httpClient'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
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

export type DownloadResult =
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
export async function downloadCoverData(
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

