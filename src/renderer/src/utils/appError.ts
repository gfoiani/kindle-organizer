import type { AppErrorCode } from '../../../preload/api'

/**
 * i18n key for each machine-readable code the main process can reject with.
 *
 * Declared as a FULL `Record<AppErrorCode, string>` on purpose: adding a code to
 * `src/main/appErrors.ts` breaks this file's compile until the code is given a
 * message, so the two sides can never drift.
 */
const CODE_MESSAGE_KEYS: Record<AppErrorCode, string> = {
  COLLECTION_NAME_TAKEN: 'errors.collectionNameTaken',
  COLLECTION_NAME_EMPTY: 'errors.collectionNameEmpty'
}

/**
 * Picks the i18n key that best describes a rejected IPC call.
 *
 * Electron wraps a handler's rejection ("Error invoking remote method '…':
 * Error: COLLECTION_NAME_TAKEN") and drops custom fields, so the code has to be
 * recovered from the message text — a substring match, not equality. Anything
 * unrecognized (a SQLite failure, a disk error) falls back to the caller's
 * per-operation key, so the user still gets a meaningful message instead of the
 * silent console-only failure this replaces.
 */
export function errorMessageKey(err: unknown, fallbackKey: string): string {
  const message = err instanceof Error ? err.message : String(err)
  for (const code of Object.keys(CODE_MESSAGE_KEYS) as AppErrorCode[]) {
    if (message.includes(code)) return CODE_MESSAGE_KEYS[code]
  }
  return fallbackKey
}
