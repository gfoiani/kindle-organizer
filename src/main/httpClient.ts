import * as http from 'http'
import * as https from 'https'
import { app } from 'electron'
import { AbortError, hostKey, noteRateLimited, schedule } from './requestScheduler'

// Re-export so covers.ts and tests get the whole error taxonomy from one place.
export { AbortError }

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

// ─── Tuning knobs ─────────────────────────────────────────────────────────────
/** Per-request socket timeout. */
export const REQUEST_TIMEOUT_MS = 8000
/** Max HTTP redirects we will follow before giving up. */
export const MAX_REDIRECTS = 4
/** Hard cap on a single response body so a hostile/buggy host can't exhaust memory. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/** Exponential back-off floor on 429: 3s → 6s → 12s (Retry-After wins if larger). */
const BACKOFF_DELAYS = [3000, 6000, 12000]

// ─── Error taxonomy ───────────────────────────────────────────────────────────
// The retry/negative-cache decisions upstream hinge on WHY a request failed, so
// each failure mode gets a distinct type instead of a stringly-typed Error.

/** Non-2xx, non-429 HTTP status. NOT retryable, NOT a network blip. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** HTTP 429. Retryable, and pauses the OFFENDING host (see noteRateLimited). */
export class RateLimitError extends HttpError {
  constructor(
    public readonly retryAfterMs: number,
    /** Host that actually returned the 429 (may differ from the request's origin host after a redirect). */
    public readonly host: string
  ) {
    super(429, 'HTTP 429 Too Many Requests')
    this.name = 'RateLimitError'
  }
}

/** Socket error / timeout / body cap. Transient → retryable at the cover layer. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

/** Normalizes an arbitrary thrown value into our taxonomy (default: NetworkError). */
function toTransportError(err: unknown): Error {
  if (err instanceof AbortError || err instanceof NetworkError || err instanceof HttpError) {
    return err
  }
  return new NetworkError(err instanceof Error ? err.message : String(err))
}

// ─── Redirect / host allow-list ─────────────────────────────────────────────
// fetchUrl follows redirects; we only follow https redirects to known provider
// and CDN hosts to keep this off the SSRF surface (a compromised/MITM'd provider
// otherwise could redirect us to an arbitrary internal host).
export function isAllowedHost(hostname: string): boolean {
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

/** Retry-After is either delta-seconds or an HTTP-date; returns ms (0 if absent/unparseable). */
function parseRetryAfterMs(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(raw)
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  return 0
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

interface RawResponse {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/**
 * One raw HTTP round-trip. When `signal` is already aborted it rejects WITHOUT
 * opening a socket (so a caller's cancellation is honored even before dispatch);
 * an abort mid-flight destroys the socket. Socket/timeout/body-cap failures
 * surface as NetworkError; the full header set is returned (Retry-After et al.).
 */
function fetchRaw(url: string, signal?: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError())
      return
    }

    const mod = url.startsWith('https') ? https : http
    let settled = false
    let onAbort: (() => void) | undefined

    const cleanup = (): void => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
    }
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(toTransportError(err))
    }
    const succeed = (value: RawResponse): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const req = mod.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = []
      let received = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > MAX_RESPONSE_BYTES) {
          req.destroy(new NetworkError(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () =>
        succeed({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks)
        })
      )
      res.on('error', fail)
    })

    if (signal) {
      onAbort = () => req.destroy(new AbortError())
      signal.addEventListener('abort', onAbort, { once: true })
    }
    req.on('timeout', () => req.destroy(new NetworkError('Request timed out')))
    req.on('error', fail)
  })
}

/**
 * Fetches `url` as bytes, following (allow-listed https) redirects. EACH hop is
 * scheduled independently against its host, so a redirect never holds a slot
 * across the next round-trip and different books hit different hosts in parallel.
 */
export async function fetchUrl(
  url: string,
  signal?: AbortSignal,
  maxRedirects = MAX_REDIRECTS
): Promise<Buffer> {
  const host = new URL(url).hostname
  const result = await schedule(() => fetchRaw(url, signal), { host, signal })

  if ((result.statusCode === 301 || result.statusCode === 302) && maxRedirects > 0) {
    const location = result.headers.location
    if (location) {
      const next = resolveSafeRedirect(location, url)
      if (!next) throw new NetworkError(`Blocked redirect from ${url}`)
      return fetchUrl(next, signal, maxRedirects - 1)
    }
  }
  if (result.statusCode === 429) {
    // `url` here is the final hop, so its host is the one that actually 429'd.
    throw new RateLimitError(parseRetryAfterMs(result.headers['retry-after']), new URL(url).hostname)
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new HttpError(result.statusCode, `HTTP ${result.statusCode} for ${url}`)
  }
  return result.body
}

/**
 * fetchUrl + 429 handling: on RateLimitError pauses the whole host and retries
 * (the next scheduled hop waits out the per-host pause), up to BACKOFF_DELAYS.
 * AbortError is rethrown immediately (never retried). All other errors bubble.
 */
export async function fetchUrlWithRetry(url: string, signal?: AbortSignal): Promise<Buffer> {
  for (let attempt = 0; attempt <= BACKOFF_DELAYS.length; attempt++) {
    try {
      return await fetchUrl(url, signal)
    } catch (err) {
      if (err instanceof AbortError) throw err
      if (err instanceof RateLimitError && attempt < BACKOFF_DELAYS.length) {
        // Pause the host that actually 429'd (post-redirect it may not be url's origin host).
        noteRateLimited(hostKey(err.host), Math.max(err.retryAfterMs, BACKOFF_DELAYS[attempt]))
        continue
      }
      throw err
    }
  }
  throw new NetworkError('Max retries exceeded')
}

/**
 * Fetches + parses JSON. A malformed body is DATA loss, not a network failure,
 * so a JSON parse error resolves to `null` (never retried, never negative-cached
 * as a network blip). Transport errors (Network/RateLimit/Http/Abort) propagate.
 */
export async function fetchJson<T extends object>(
  url: string,
  signal?: AbortSignal
): Promise<T | null> {
  const body = await fetchUrlWithRetry(url, signal)
  try {
    const json: unknown = JSON.parse(body.toString('utf-8'))
    if (typeof json !== 'object' || json === null) return null
    return json as T
  } catch (err) {
    if (err instanceof SyntaxError) {
      debug(`[cover] Malformed JSON from ${url}: ${err.message}`)
      return null
    }
    throw err
  }
}
