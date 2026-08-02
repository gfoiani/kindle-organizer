import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

/** How long the pointer must stay down before the press counts as "long". */
const DEFAULT_DELAY_MS = 500
/** Travel beyond this turns the gesture into a scroll or drag and cancels it. */
const MOVE_TOLERANCE_PX = 10

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onPointerCancel: () => void
}

export interface UseLongPressReturn {
  /** Spread onto the pressable element. */
  handlers: LongPressHandlers
  /**
   * Whether the click now being handled was produced by releasing a long press.
   * Reading it clears the flag, so the gesture cannot leak into the next plain
   * click.
   */
  consumeClick: () => boolean
}

/**
 * Fires `onLongPress` when the pointer is held still on an element.
 *
 * Pointer events (not mouse) so trackpad, mouse and touch behave the same. The
 * gesture is abandoned once the pointer travels — otherwise starting a scroll
 * from a card would select it — and only a primary button arms it, so a
 * right-click still reaches the context menu instead of selecting.
 */
export function useLongPress(
  onLongPress: () => void,
  delayMs: number = DEFAULT_DELAY_MS
): UseLongPressReturn {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)

  // Read live, so a re-render with a fresh callback does not have to rebuild
  // (and thereby re-attach) every handler.
  const callbackRef = useRef(onLongPress)
  callbackRef.current = onLongPress

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    originRef.current = null
  }, [])

  // A card unmounts as soon as it scrolls out of the virtualizer's window, which
  // can easily happen mid-press.
  useEffect(() => cancel, [cancel])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      firedRef.current = false
      originRef.current = { x: e.clientX, y: e.clientY }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        firedRef.current = true
        callbackRef.current()
      }, delayMs)
    },
    [delayMs]
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const origin = originRef.current
      if (!origin) return
      const travelled =
        Math.abs(e.clientX - origin.x) > MOVE_TOLERANCE_PX ||
        Math.abs(e.clientY - origin.y) > MOVE_TOLERANCE_PX
      if (travelled) cancel()
    },
    [cancel]
  )

  const consumeClick = useCallback(() => {
    const fired = firedRef.current
    firedRef.current = false
    return fired
  }, [])

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel
    },
    consumeClick
  }
}
