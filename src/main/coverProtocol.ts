import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { protocol } from 'electron'
import { getCachePath } from './coverPaths'

/**
 * Custom `cover-cache://` protocol that streams cached cover JPEGs straight from
 * disk to Chromium — no base64, no heavy IPC. Replaces the old data-URL delivery
 * that re-read + re-encoded the whole image on the main thread for every card.
 *
 * URL shape: `cover-cache://covers/<key>?v=<n>` — fixed host `covers`, the sha256
 * key in the path (dodging the 63-char label limit on hostnames), and a `?v=`
 * cache-buster that makes the aggressive `immutable` caching safe.
 */
export const COVER_SCHEME = 'cover-cache'

// PATH-TRAVERSAL GUARD: only a bare sha256 hex string is ever turned into a file
// path. Anything with `.`, `/`, `%2e`, wrong length, or non-hex is rejected.
const KEY_RE = /^[0-9a-f]{64}$/

/** Must run BEFORE app `ready` (top-level in index.ts). */
export function registerCoverSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    // Minimal privileges: a standard, secure scheme. No bypassCSP / fetch / CORS.
    { scheme: COVER_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

/** Must run inside `app.whenReady()`. */
export function registerCoverProtocol(): void {
  protocol.handle(COVER_SCHEME, handleCoverRequest)
}

/**
 * Pure request handler (unit-testable without Electron). Validates the URL,
 * then streams the file or returns 404 (missing / negative-cache marker) / 400
 * (malformed or traversal attempt).
 */
export async function handleCoverRequest(request: Request): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response('Bad request', { status: 400 })
  }

  if (url.hostname !== 'covers') {
    return new Response('Not found', { status: 404 })
  }

  const key = url.pathname.replace(/^\/+/, '')
  if (!KEY_RE.test(key)) {
    return new Response('Bad request', { status: 400 })
  }

  const filePath = getCachePath(key)
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch {
    return new Response('Not found', { status: 404 }) // no file yet
  }
  if (size === 0) {
    return new Response('No cover', { status: 404 }) // negative-cache marker
  }

  const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      // Safe to be immutable ONLY because the renderer appends ?v=<n> that
      // changes whenever the bytes change (cover:updated bumps the version).
      'Cache-Control': 'max-age=31536000, immutable'
    }
  })
}
