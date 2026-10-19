import * as fs from 'fs-extra'
import * as path from 'path'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { getCoverCacheDir, getCachePath, getCacheKey } from './coverPaths'
import { isValidImage } from './coverMatch'
import { downloadCoverData } from './coverSearch'
import { isAbortError } from './httpClient'
import { itunesStorefront } from './itunesStorefront'
import { resetScheduler } from './requestScheduler'

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
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
  startCoverDownload(key, cachePath, title, author, isbn, itunesStorefront())
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
      itunesStorefront(),
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

/**
 * Empties the cover cache except the covers under `keep`: those taken from
 * the books' own files (`importLocalCover`), which no download can bring back.
 */
export async function clearCoverCache(keep: Iterable<string> = []): Promise<void> {
  // Abort in-flight downloads + drop the scheduler queue so nothing re-writes a
  // file we're about to wipe.
  cancelAllCovers()

  const kept = new Set([...keep].map((key) => path.basename(getCachePath(key))))
  const cacheDir = getCoverCacheDir()
  if (await fs.pathExists(cacheDir)) {
    const files = await fs.readdir(cacheDir)
    for (const file of files.filter((name) => !kept.has(name))) {
      await fs.remove(path.join(cacheDir, file))
    }
  }
  retryRegistry.clear()
  notifyCoverCacheCleared()
}

