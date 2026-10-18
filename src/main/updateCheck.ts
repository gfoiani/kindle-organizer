import { app } from 'electron'

/**
 * Tells the user a newer release exists. There is no auto-updater (an
 * unsigned macOS build cannot replace itself), so without this a user who
 * installed from the DMG/EXE would never hear about a fix. One unauthenticated
 * GET to GitHub; nothing about the user or the library is sent.
 */

const REPOSITORY = 'gfoiani/kindle-organizer'
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
/** The only pages the app will offer to open. */
const RELEASE_PAGE_PREFIX = `https://github.com/${REPOSITORY}/releases/`
const REQUEST_TIMEOUT_MS = 10_000
/** Plain releases only: a pre-release tag (`0.5.0-beta.1`) is never offered. */
const RELEASE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

export interface AvailableUpdate {
  version: string
  /** The GitHub release page. */
  url: string
}

type FetchLatestRelease = () => Promise<unknown>

function parseVersion(version: string): number[] | undefined {
  const match = RELEASE_VERSION.exec(version.trim())
  return match ? match.slice(1).map(Number) : undefined
}

/** Whether `candidate` is a plain release newer than `current` (numeric, not string, comparison). */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (!next || !now) return false
  const firstDifference = next.findIndex((part, i) => part !== now[i])
  return firstDifference >= 0 && next[firstDifference] > now[firstDifference]
}

async function fetchLatestRelease(): Promise<unknown> {
  const response = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `KindleOrganizer/${app.getVersion()}` },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`)
  return response.json()
}

/** The release's version and page when the response is what GitHub sends for this repository. */
function readRelease(body: unknown): AvailableUpdate | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const { tag_name: tag, html_url: url } = body as Record<string, unknown>
  if (typeof tag !== 'string' || typeof url !== 'string' || !url.startsWith(RELEASE_PAGE_PREFIX)) return undefined
  return { version: tag.replace(/^v/, ''), url }
}

/**
 * The newer release, or null — also when the check cannot complete (offline,
 * rate-limited, unexpected answer): a missing notice is harmless, an error
 * popup at every offline start would not be.
 */
export async function checkForUpdate(
  currentVersion: string,
  fetchLatest: FetchLatestRelease = fetchLatestRelease
): Promise<AvailableUpdate | null> {
  try {
    const release = readRelease(await fetchLatest())
    return release && isNewerVersion(release.version, currentVersion) ? release : null
  } catch (err) {
    debug('[update] Check skipped:', err instanceof Error ? err.message : String(err))
    return null
  }
}
