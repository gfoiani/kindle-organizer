import { app } from 'electron'
import { getCacheKey } from './coverPaths'
import { fetchJson, isAbortError } from './httpClient'
import { itunesStorefront } from './itunesStorefront'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}


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

interface ItunesMetadataSearch {
  results?: { description?: string; genres?: string[]; releaseDate?: string }[]
}

/** Strips the HTML iTunes wraps its blurbs in, and collapses the whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The storefront's own genre words ("Thriller e gialli", "Fantascienza") are the
// strongest single signal the classifier gets, so they lead the metadata string.
const MAX_ITUNES_GENRES = 3

/**
 * iTunes metadata, queried against the storefront already used for covers.
 *
 * First in the chain because it is the only provider with real coverage of
 * localized editions: on a 26-book Italian library it returned a genre AND a
 * description for 26/26, against 3/16 for Open Library (Google Books answers
 * with HTTP 429 once its keyless daily quota is spent).
 */
async function searchItunesMetadata(
  title: string,
  author: string | undefined
): Promise<BookMetadata | null> {
  let term = title
  if (author) term += ` ${author}`
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=ebook&limit=3&country=${encodeURIComponent(itunesStorefront())}`

  try {
    const json = await fetchJson<ItunesMetadataSearch>(url)
    const hit = json?.results?.find((r) => r.description || r.genres?.length)
    if (!hit) return null

    // "Libri"/"Books" is the storefront's top-level bucket, not a genre.
    const genres = (hit.genres ?? []).filter((g) => !/^(libri|books)$/i.test(g))
    const metadata: BookMetadata = {
      year: hit.releaseDate?.slice(0, 4),
      genre: genres.slice(0, MAX_ITUNES_GENRES).join(', ') || undefined,
      description: hit.description ? stripHtml(hit.description) : undefined
    }

    if (!metadata.year && !metadata.genre && !metadata.description) return null

    debug(
      `[searchItunesMetadata] Found: genre=${metadata.genre}, desc=${metadata.description ? 'yes' : 'no'}`
    )
    return metadata
  } catch (err) {
    // Transient failures and aborts must propagate so the caller never caches
    // "not found" for a lookup that didn't actually complete.
    if (
      err instanceof Error &&
      (err.name === 'NetworkError' || err.name === 'RateLimitError' || err.name === 'AbortError')
    ) {
      throw err
    }
    debug(`[searchItunesMetadata] Error: ${err instanceof Error ? err.message : String(err)}`)
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
    let result = await searchItunesMetadata(title, author)
    if (!result) {
      result = await searchOpenLibraryMetadata(title, author)
    }
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
