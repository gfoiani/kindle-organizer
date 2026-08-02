import type { ClassifierErrorCode } from './messages'

/**
 * Availability failures: the model files themselves are not there.
 *
 * transformers.js prefixes a fixed sentence per HTTP status before throwing
 * (`ERROR_MAPPING` in `@xenova/transformers/src/utils/hub.js`), and uses a
 * dedicated message when remote fetching is disabled — so the cause has to be
 * recovered from the message text. Anchored on the stable prefixes only.
 */
const MISSING_MODEL_PATTERNS: RegExp[] = [
  /could not locate file/i, // 404 — not bundled with the app and not on the Hub
  /not found locally/i, // local-only mode and nothing was bundled
  /unauthorized access to file/i, // 401
  /forbidden access to file/i // 403
]

/** Transport failures: the model exists, we could not reach or receive it. */
const DOWNLOAD_FAILURE_PATTERNS: RegExp[] = [
  /failed to fetch/i, // Chromium's offline / blocked-request TypeError
  /networkerror/i,
  /net::err/i,
  /load failed/i,
  /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo/i,
  /request timeout error/i, // 408
  /internal server error/i, // 500
  /bad gateway/i, // 502
  /service unavailable/i, // 503
  /gateway timeout/i // 504
]

/**
 * Turns a model-initialization failure into a code the UI can explain.
 *
 * Model loading is the one step that fails for reasons the user can act on — the
 * ~110 MB model is not bundled with every build, so a first run downloads it —
 * and "the model isn't there" needs a different message from "the engine broke".
 * Anything unrecognized stays a generic load failure rather than guessing.
 */
export function modelErrorCode(err: unknown): ClassifierErrorCode {
  const message = err instanceof Error ? err.message : String(err)

  if (MISSING_MODEL_PATTERNS.some((pattern) => pattern.test(message))) return 'MODEL_MISSING'
  if (DOWNLOAD_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'MODEL_DOWNLOAD_FAILED'
  }
  return 'MODEL_LOAD_FAILED'
}
