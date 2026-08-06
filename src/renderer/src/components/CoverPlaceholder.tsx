import { useId } from 'react'
import { placeholderTint } from '../utils/coverPlaceholder'

interface CoverPlaceholderProps {
  title: string
  author?: string
}

/**
 * Stand-in art for a book whose cover could not be found.
 *
 * Illustration only, no SVG text: that keeps it scaling from the card's ~180px to
 * the detail panel's ~400px with no per-call-site font sizing, and avoids the
 * manual truncation a printed title would need (SVG has no `line-clamp`).
 *
 * `aria-hidden` because it is decorative — the card already carries the book's
 * accessible name and the detail panel has the title in its header. Sized with
 * `w-full h-full` rather than `absolute inset-0` so it does not depend on the
 * parent being positioned: the card's cover box is `relative`, the panel's is not.
 */
export function CoverPlaceholder({ title, author }: CoverPlaceholderProps) {
  const tint = placeholderTint(title, author)

  // SVG ids are document-global, so a hardcoded gradient id would collide across
  // the ~40 mounted cards — later definitions win and every tile paints one
  // colour. Despite appearances, `useId()` does not need the sanitizing below:
  // verified against the installed react-dom (19.2), a client-rendered id is
  // already `[a-zA-Z0-9_-]` only (e.g. `_r_0_`) — no colons, unlike the `:r0:`
  // shape sometimes shown in older docs/examples. The regex is a defensive
  // guard against a future id-format change, not a fix for anything colons do
  // today.
  const gradientId = `cover-tint-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  return (
    <svg aria-hidden="true" viewBox="0 0 200 300" className="w-full h-full">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={tint.from} />
          <stop offset="100%" stopColor={tint.to} />
        </linearGradient>
      </defs>
      <rect width="200" height="300" fill={`url(#${gradientId})`} />
      <g
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.14"
        strokeWidth="3"
        strokeLinecap="round"
      >
        {/* Closed book seen front-on: cover, spine, two lines of "title". */}
        <rect x="66" y="104" width="68" height="92" rx="4" />
        <line x1="82" y1="104" x2="82" y2="196" />
        <line x1="94" y1="132" x2="122" y2="132" />
        <line x1="94" y1="148" x2="114" y2="148" />
      </g>
    </svg>
  )
}
