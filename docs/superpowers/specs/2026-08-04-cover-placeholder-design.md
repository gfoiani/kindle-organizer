# Cover placeholder for books with no cover

**Date:** 2026-08-04
**Status:** approved

## Problem

When cover resolution ends in the terminal "no cover" state, the cover area of a
book tile renders the file extension as bare text on a flat `bg-gray-900`:

- `src/renderer/src/components/BookCard.tsx:156-159` — `<span className="text-indigo-300 text-xl font-bold">{book.extension}</span>`
- `src/renderer/src/components/BookDetailSidebar.tsx:255-257` — the same, at `text-3xl`

That text is a duplicate in both places: the card already shows the format in the
top-left badge, and the sidebar shows it in the always-visible size/format row
(`BookDetailSidebar.tsx:393`). So the state spends a whole 2:3 tile displaying
information that is on screen twice already, and a grid of them reads as broken
rather than as "these books have no art".

Replace it with a generated placeholder illustration, tinted per book so a grid
of coverless books stays legible as distinct books.

## Decision: per-book tinted illustration

Chosen over two alternatives:

- **One static illustration for every book** — simplest, but 40 coverless books
  become 40 identical tiles, which reads as a stalled load.
- **A fake cover with the title printed inside the 2:3 area** — highest visual
  impact, but it prints title and author a second time in a card that already
  shows both underneath, and SVG has no `line-clamp`, so long titles would need
  manual truncation.

### Why an inline SVG component and not an `.svg` asset

The illustration is authored as SVG but embedded as a React component, not
imported as a file. Two reasons, both binding:

1. An `<img src="placeholder.svg">` cannot be tinted per book — CSS does not
   reach inside the image, so the per-book tint requirement would be lost.
2. Under Vite's default 4 kB `assetsInlineLimit` the file would be emitted as a
   base64 `data:` URI anyway, so "a real file on disk" is not what would ship.

It would also be the project's first image asset import; every icon in the
renderer today is inline SVG.

A monochrome `.svg` file could be produced additionally if a standalone asset is
ever wanted, but it cannot carry the per-book tint. It is not part of this change.

## Components

### 1. `src/renderer/src/utils/coverPlaceholder.ts` (new, pure)

```ts
export interface PlaceholderTint {
  readonly from: string
  readonly to: string
}

/** The 8 entries tabulated below. */
export const PLACEHOLDER_TINTS: readonly PlaceholderTint[]

export function placeholderTint(title: string, author?: string): PlaceholderTint
```

An FNV-1a 32-bit hash over `` `${title}|${author ?? ''}` `` indexes a curated
palette of 8 colour pairs.

**Palette** — Tailwind 950 → 800 pairs, so the result looks native to the
existing gray/indigo UI and stays dark enough that the white badges layered on
top keep their contrast:

| # | Tint | `from` | `to` |
| --- | --- | --- | --- |
| 0 | indigo | `#1e1b4b` | `#3730a3` |
| 1 | teal | `#042f2e` | `#115e59` |
| 2 | pink | `#500724` | `#9d174d` |
| 3 | amber | `#451a03` | `#92400e` |
| 4 | violet | `#2e1065` | `#5b21b6` |
| 5 | sky | `#082f49` | `#075985` |
| 6 | emerald | `#022c22` | `#065f46` |
| 7 | slate | `#020617` | `#334155` |

A fixed palette rather than `hsl(hash % 360, …)`: at fixed saturation and
lightness some hues come out muddy and fight the indigo accent colour. Eight
entries is enough to break up a grid and small enough to eyeball in review.

Colours are literal strings, not Tailwind classes, because they are consumed as
SVG `stop-color` values. Tailwind v4 scans source text at build time, so a
runtime-interpolated `bg-[${tint.from}]` would silently generate no CSS.

Two properties decide whether this works:

- **NFC normalization before hashing.** macOS returns decomposed (NFD) names
  from the Kindle volume — the problem `mergeBooks.ts:20-30` already documents.
  Without normalizing, the same accented title reached from the device and from
  the staging library would hash to two different tints, and one book would
  change colour depending on which side it was read from. The hash input is
  therefore `.normalize('NFC')`, trimmed and lowercased.
- **Unsigned hash (`>>> 0`).** In JavaScript `%` on a negative integer returns a
  negative result, which would index outside the palette and yield `undefined`.

Empty title and absent author are valid inputs: they normalize to a stable
string and select a stable tint rather than throwing.

### 2. `src/renderer/src/components/CoverPlaceholder.tsx` (new, presentational)

```ts
interface CoverPlaceholderProps {
  title: string
  author?: string
}
```

Renders an `<svg viewBox="0 0 200 300">` filling the existing cover container,
painting a rect with a linear gradient between the tint's two stops, and over it
the silhouette of a book (cover outline, spine, two short "text" lines) stroked
in white at ~14% opacity.

Sized with `w-full h-full`, not `absolute inset-0`: the card's cover box is
`relative` (`BookCard.tsx:145`) but the panel's is not
(`BookDetailSidebar.tsx:252`), so an absolutely-positioned placeholder would
anchor to the panel's `<aside>` and break its layout. `w-full h-full` depends on
nothing about the parent's positioning and works in both without touching the
panel's container classes. The container is already `aspect-[2/3]`, matching the
viewBox exactly, so nothing letterboxes.

Illustration only — no SVG text. That keeps it scaling cleanly from the card's
~180 px to the sidebar's ~400 px with no per-call-site font sizing, and avoids
the manual truncation printed titles would need.

`aria-hidden="true"`: the graphic is decorative and must not add an announcement.
The card already exposes `aria-label={accessibleName}` and the sidebar has the
title in its header.

**The gradient's `id` comes from `useId()`.** SVG ids are document-global, so a
hardcoded `id="tint"` across the ~40 mounted cards would collide, later
definitions winning, and every tile would render the same colour regardless of
its book. `useId` is already the pattern in `BookDetailSidebar.tsx:125`.

### 3. Call sites (edits, no state-logic change)

Replace the extension-text branch with `<CoverPlaceholder title={book.title}
author={book.author} />` in both places, dropping the duplicated extension text.
The card's top-left format badge and the sidebar's size/format row both stay.

| Cover state | Today | After |
| --- | --- | --- |
| `ready`, or a pushed version | real `<img>` | unchanged |
| `pending` | `animate-pulse` skeleton | **unchanged** |
| `missing` / pushed-missing / `imgFailed` | extension text | **`CoverPlaceholder`** |

The placeholder must stay out of the `pending` state, or a tile would flash
placeholder → real cover as its download lands.

In the card that is already guaranteed: the branch order in
`BookCard.tsx:146-162` separates all three states, so only the middle branch
changes.

**The sidebar needs a third branch added.** Today it renders only
`displaySrc ? <img> : <extension text>` — there is no skeleton, so a pending
cover currently shows the extension text. Dropping the placeholder into that
`else` would make it show placeholder art during the download and then swap to
the real cover, which is the flash this rule forbids. `useCover` already returns
`status` alongside `coverSrc` (the panel destructures only `coverSrc` today), so
the panel gains:

```tsx
{displaySrc ? (
  <img … />
) : status === 'missing' ? (
  <CoverPlaceholder title={book.title} author={book.author} />
) : (
  <div className="w-full h-full bg-gray-900 animate-pulse" />
)}
```

Before the first resolve `status` is `null`, which falls to the skeleton —
correct. This also brings the panel's loading state in line with the card's,
which it never had.

## Data flow

Unchanged. `ensureCover` still drives everything; the renderer still follows the
`cover:updated` / `cover:missing` pushes. The placeholder is a pure function of
`(title, author)` computed at render time — no IPC channel, no preload wrapper,
no main-process change, nothing cached or persisted.

## Error handling

No new failure modes: a pure function plus inline SVG, with no I/O and no
network. The placeholder *is* the handling for the existing `imgFailed` case — a
cached file that will not decode — and `placeholderTint` is total over its input
domain, so it has nothing to throw.

## Testing

`test/coverPlaceholder.test.ts`, under the existing Vitest `environment: 'node'`
setup, matching how the other renderer utilities (`coverSrc`, `gridLayout`,
`presenceFilter`, `bulkSelection`) are already covered:

- repeated calls with the same title and author return the same tint
- the NFD and NFC forms of one accented title return the same tint
- the returned tint is always a palette member (never `undefined`), including
  for inputs whose raw hash is negative
- an absent author, and an empty title, both return a stable tint
- a set of distinct titles spreads across more than one palette entry

Component rendering is not unit-tested: the project has no jsdom or
testing-library dependency, and adding that infrastructure is out of scope here.
The visual result is verified with a manual `yarn dev` run.

## Out of scope

- No new user-visible strings, so `en.json` / `it.json` are untouched.
- No change to cover fetching, caching, the retry loop, or the `cover-cache://`
  protocol.
- No standalone `.svg` asset file.
