import { useCallback, useEffect, useRef, useState } from 'react'

export type NoticeKind = 'info' | 'error'

export interface Notice {
  kind: NoticeKind
  message: string
}

/** How long a notice stays up before auto-dismissing (ms). */
const DEFAULT_DURATION_MS = 6000

export interface UseNoticeReturn {
  /** The notice currently on screen, or null. */
  notice: Notice | null
  showInfo: (message: string, durationMs?: number) => void
  showError: (message: string, durationMs?: number) => void
  clear: () => void
}

/**
 * One transient, auto-dismissing message for the whole window.
 *
 * Exists so a failed operation reaches the USER: the collection/library handlers
 * used to swallow every rejection into `console.error`, which in a packaged app
 * is invisible — a duplicate collection name simply looked like nothing had
 * happened. A single slot (not a queue) is deliberate: these are one-at-a-time
 * user actions, and the newest message is always the relevant one.
 *
 * The pending timer is replaced on each new notice and cleared on unmount, so a
 * stale timeout can never blank a fresher message or fire after teardown.
 */
export function useNotice(): UseNoticeReturn {
  const [notice, setNotice] = useState<Notice | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelPending = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const clear = useCallback(() => {
    cancelPending()
    setNotice(null)
  }, [cancelPending])

  const show = useCallback(
    (kind: NoticeKind, message: string, durationMs = DEFAULT_DURATION_MS) => {
      cancelPending()
      setNotice({ kind, message })
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        setNotice(null)
      }, durationMs)
    },
    [cancelPending]
  )

  const showInfo = useCallback(
    (message: string, durationMs?: number) => show('info', message, durationMs),
    [show]
  )

  const showError = useCallback(
    (message: string, durationMs?: number) => show('error', message, durationMs),
    [show]
  )

  useEffect(() => cancelPending, [cancelPending])

  return { notice, showInfo, showError, clear }
}
