import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessageKey } from '../utils/appError'

/** Outcome of a guarded IPC mutation — `value` is only present on success. */
export type RunOutcome<T> = { ok: true; value: T } | { ok: false }

export interface ReportedRun {
  /** Logs `err` and shows it, in the main process's words when it supplied a code. */
  reportError: (err: unknown, fallbackKey: string) => void
  /** Runs an IPC mutation, reporting any failure and telling the caller if it succeeded. */
  run: <T>(fallbackKey: string, action: () => Promise<T>) => Promise<RunOutcome<T>>
}

/**
 * Turns a rejected IPC call into a visible message. Every one of these used to
 * end at `console.error`, which is invisible in a packaged app — a duplicate
 * collection name just looked like nothing had happened. `fallbackKey`
 * describes the operation and is used unless the main process supplied a
 * specific code (see utils/appError). Both functions are stable.
 */
export function useReportedRun(showError: (message: string) => void): ReportedRun {
  const { t } = useTranslation()
  // `t` gets a new identity on every language change; loaders that depend on
  // these must stay stable, so translation is read through a ref.
  const tRef = useRef(t)
  tRef.current = t

  const reportError = useCallback(
    (err: unknown, fallbackKey: string): void => {
      console.error(`[${fallbackKey}]`, err)
      showError(tRef.current(errorMessageKey(err, fallbackKey)))
    },
    [showError]
  )

  const run = useCallback(
    async <T,>(fallbackKey: string, action: () => Promise<T>): Promise<RunOutcome<T>> => {
      try {
        return { ok: true, value: await action() }
      } catch (err) {
        reportError(err, fallbackKey)
        return { ok: false }
      }
    },
    [reportError]
  )

  return { reportError, run }
}
