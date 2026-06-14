import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

interface FocusTrapOptions {
  /** When provided, Escape calls this; omit to disable Escape (e.g. while busy). */
  onEscape?: () => void
  /**
   * Full modal behavior: focus the first element on mount, contain Tab within
   * the container, and restore focus on unmount. Defaults to false (Escape-only,
   * suitable for non-modal panels/dropdowns that must not steal Tab order).
   */
  trapTab?: boolean
}

/**
 * Accessible keyboard behavior for an overlay element.
 * - Always: optionally closes on Escape (read live, so toggling it doesn't re-run).
 * - When `trapTab` is true: focuses the first focusable element on mount,
 *   contains Tab/Shift+Tab within the container, and restores focus on unmount.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  { onEscape, trapTab = false }: FocusTrapOptions = {}
): void {
  // Keep the latest onEscape without re-running the effect.
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )

    if (trapTab) {
      const first = focusables()[0]
      if (first) first.focus()
      else container.focus()
    }

    function handleContainerKeyDown(e: KeyboardEvent) {
      const escapeHandler = onEscapeRef.current
      if (e.key === 'Escape' && escapeHandler) {
        e.stopPropagation()
        escapeHandler()
        return
      }
      if (!trapTab || e.key !== 'Tab') return

      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      const active = document.activeElement

      if (e.shiftKey && active === firstItem) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && active === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }

    // Escape-only panels (non-modal) listen at document level so Escape works
    // even when focus hasn't entered the panel; trapping panels listen locally.
    function handleDocumentEscape(e: KeyboardEvent) {
      const escapeHandler = onEscapeRef.current
      if (e.key === 'Escape' && escapeHandler) escapeHandler()
    }

    if (trapTab) {
      container.addEventListener('keydown', handleContainerKeyDown)
    } else {
      document.addEventListener('keydown', handleDocumentEscape)
    }
    return () => {
      container.removeEventListener('keydown', handleContainerKeyDown)
      document.removeEventListener('keydown', handleDocumentEscape)
      if (trapTab) previouslyFocused?.focus?.()
    }
  }, [containerRef, trapTab])
}
