# Cover Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare file-extension text shown when a book has no cover with generated SVG placeholder art, tinted deterministically per book.

**Architecture:** A pure utility hashes the book's identity to one of 8 curated colour pairs; a presentational React component paints that pair as an SVG gradient behind a low-opacity book silhouette. The two existing call sites swap their extension-text branch for the component. No IPC channel, no main-process change, nothing persisted.

**Tech Stack:** TypeScript, React 19.2.7, Tailwind CSS v4, Vitest (`environment: 'node'`).

**Spec:** `docs/superpowers/specs/2026-08-04-cover-placeholder-design.md`

## Global Constraints

- **Run `nvm use` before any `yarn` command.** Yarn enforces the engine range and refuses to run on an out-of-range Node; `.nvmrc` pins 24.
- **Immutability** — never mutate objects or arrays in place; return new copies.
- **No `console.log`.** Nothing in this change should log at all.
- **No new user-visible strings.** `src/renderer/locales/en.json` and `it.json` must stay untouched — the placeholder is decorative.
- **Palette is exactly these 8 pairs, in this order** (Tailwind 950 → 800):
  `#1e1b4b`/`#3730a3` indigo, `#042f2e`/`#115e59` teal, `#500724`/`#9d174d` pink, `#451a03`/`#92400e` amber, `#2e1065`/`#5b21b6` violet, `#082f49`/`#075985` sky, `#022c22`/`#065f46` emerald, `#020617`/`#334155` slate.
- **Colours are literal strings, never Tailwind classes.** They are consumed as SVG `stop-color`. Tailwind v4 scans source text at build time, so a runtime-interpolated `bg-[${tint.from}]` silently generates no CSS.
- **The hash key is NFC-normalized, trimmed and lowercased per part.** macOS returns decomposed (NFD) names from the Kindle volume while the staging library stores composed ones — see the comment block at `src/renderer/src/utils/mergeBooks.ts:20-30`.
- **The hash is unsigned (`>>> 0`).** In JavaScript `%` on a negative integer returns a negative result, which would index outside the palette and yield `undefined`.
- **The placeholder never renders in the `pending` state** — only on the terminal `missing` / pushed-missing / `imgFailed` outcomes. Otherwise a tile flashes placeholder → real cover as its download lands.
- **Component style:** `export function Name({ … }: Props) {` with no explicit return type annotation — matches every component in `src/renderer/src/components/`.
- `tsconfig.json` has `strict: true` but **not** `noUncheckedIndexedAccess`, so an indexed palette read types as `PlaceholderTint`, not `PlaceholderTint | undefined`. No non-null assertion is needed.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/renderer/src/utils/coverPlaceholder.ts` (create) | Pure: the palette, and `(title, author) → tint`. No React, no DOM. |
| `test/coverPlaceholder.test.ts` (create) | Unit tests for the above, under Node. |
| `src/renderer/src/components/CoverPlaceholder.tsx` (create) | Presentational: renders the tinted SVG. No data fetching, no state. |
| `src/renderer/src/components/BookCard.tsx` (modify) | Swap the extension-text branch for the component. |
| `src/renderer/src/components/BookDetailSidebar.tsx` (modify) | Same, plus the missing `pending` branch. |

Splitting the tint out of the component is what makes this testable at all: the project has no jsdom or testing-library dependency, so logic reachable only through a rendered component cannot be unit-tested. This mirrors how `coverSrc`, `gridLayout`, `presenceFilter` and `bulkSelection` are already covered.

---

### Task 1: Deterministic tint utility

**Files:**
- Create: `src/renderer/src/utils/coverPlaceholder.ts`
- Test: `test/coverPlaceholder.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PlaceholderTint { readonly from: string; readonly to: string }`
  - `const PLACEHOLDER_TINTS: readonly PlaceholderTint[]` — the 8 pairs, in the order listed in Global Constraints.
  - `function placeholderTint(title: string, author?: string): PlaceholderTint` — total over its input domain; never throws, never returns `undefined`.

- [ ] **Step 1: Write the failing test**

Create `test/coverPlaceholder.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { PLACEHOLDER_TINTS, placeholderTint } from '../src/renderer/src/utils/coverPlaceholder'

describe('placeholderTint', () => {
  test('returns the same tint for repeated calls with the same book', () => {
    const first = placeholderTint('Dune', 'Frank Herbert')
    const second = placeholderTint('Dune', 'Frank Herbert')

    expect(second).toEqual(first)
  })

  test('returns the same tint for the NFD and NFC forms of an accented title', () => {
    // macOS hands back NFD from the Kindle volume; the staging library stores NFC.
    // Without normalization the same book would change colour depending on which
    // side it was read from.
    const composed = 'Perché le nazioni falliscono'
    const decomposed = composed.normalize('NFD')

    expect(decomposed).not.toBe(composed) // guard: the two forms really differ
    expect(placeholderTint(decomposed)).toEqual(placeholderTint(composed))
  })

  test('ignores surrounding whitespace and letter case', () => {
    expect(placeholderTint('  DUNE  ', '  Frank Herbert ')).toEqual(
      placeholderTint('dune', 'frank herbert')
    )
  })

  test('treats an absent author the same as an empty one', () => {
    expect(placeholderTint('Dune')).toEqual(placeholderTint('Dune', ''))
  })

  test('returns a stable palette tint for an empty title', () => {
    expect(placeholderTint('')).toEqual(placeholderTint(''))
    expect(PLACEHOLDER_TINTS).toContainEqual(placeholderTint(''))
  })

  test('always returns a palette member, including for inputs whose raw hash overflows to negative', () => {
    for (let i = 0; i < 500; i++) {
      expect(PLACEHOLDER_TINTS).toContainEqual(placeholderTint(`Book ${i}`, `Author ${i}`))
    }
  })

  test('spreads distinct books across more than one tint', () => {
    const distinct = new Set(
      Array.from({ length: 40 }, (_, i) => placeholderTint(`Book ${i}`, `Author ${i}`).from)
    )

    expect(distinct.size).toBeGreaterThan(1)
  })

  test('exposes exactly the eight curated pairs', () => {
    expect(PLACEHOLDER_TINTS).toHaveLength(8)
    expect(PLACEHOLDER_TINTS[0]).toEqual({ from: '#1e1b4b', to: '#3730a3' })
  })
})
```

`toContainEqual`, not `toContain`: `toContain` compares by reference, which would keep passing only as long as the implementation happens to return the palette object itself rather than a copy. `toContainEqual` also fails loudly on `undefined`, which is the actual regression being guarded.

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use
yarn test coverPlaceholder
```

Expected: FAIL — the suite cannot resolve `../src/renderer/src/utils/coverPlaceholder`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/utils/coverPlaceholder.ts`:

```ts
/** A gradient pair for the placeholder shown when a book has no cover. */
export interface PlaceholderTint {
  readonly from: string
  readonly to: string
}

/**
 * Tailwind 950 → 800 pairs, so the placeholder reads as native to the gray/indigo
 * UI and stays dark enough that the white badges layered on top keep contrast.
 *
 * A fixed palette rather than `hsl(hash % 360, …)`: at fixed saturation and
 * lightness some hues come out muddy and fight the indigo accent colour.
 *
 * Literal strings, not Tailwind classes — these are consumed as SVG `stop-color`,
 * and Tailwind v4 scans source text at build time, so a runtime-interpolated
 * `bg-[${tint.from}]` would silently generate no CSS at all.
 */
export const PLACEHOLDER_TINTS: readonly PlaceholderTint[] = [
  { from: '#1e1b4b', to: '#3730a3' }, // indigo
  { from: '#042f2e', to: '#115e59' }, // teal
  { from: '#500724', to: '#9d174d' }, // pink
  { from: '#451a03', to: '#92400e' }, // amber
  { from: '#2e1065', to: '#5b21b6' }, // violet
  { from: '#082f49', to: '#075985' }, // sky
  { from: '#022c22', to: '#065f46' }, // emerald
  { from: '#020617', to: '#334155' } // slate
]

/**
 * FNV-1a, 32-bit. Kept unsigned with `>>> 0`: a signed overflow would make the
 * caller's `% length` negative and index outside the palette.
 */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Normalizes one part of the key. NFC because macOS returns decomposed names from
 * the Kindle volume while EPUB metadata and the staging library are composed —
 * the mismatch documented in mergeBooks.ts. Each part is normalized separately so
 * a trailing space in the title cannot leak across the `|` separator.
 */
function normalizePart(value: string): string {
  return value.normalize('NFC').trim().toLowerCase()
}

/**
 * Picks a stable tint for a book with no cover.
 *
 * Deterministic by construction — no randomness and no clock — so a book keeps
 * its colour across restarts, re-scans and cover-cache clears.
 */
export function placeholderTint(title: string, author?: string): PlaceholderTint {
  const key = `${normalizePart(title)}|${normalizePart(author ?? '')}`
  return PLACEHOLDER_TINTS[hash(key) % PLACEHOLDER_TINTS.length]
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test coverPlaceholder
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Type-check**

```bash
yarn type-check
```

Expected: clean (two passes, `tsconfig.json` and `tsconfig.node.json`). A green `yarn build` would not prove this — `electron-vite` bundles through esbuild without type-checking.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/utils/coverPlaceholder.ts test/coverPlaceholder.test.ts
git commit -m "feat(covers): deterministic tint for the coverless-book placeholder"
```

---

### Task 2: Placeholder component and both call sites

**Files:**
- Create: `src/renderer/src/components/CoverPlaceholder.tsx`
- Modify: `src/renderer/src/components/BookCard.tsx:156-159`
- Modify: `src/renderer/src/components/BookDetailSidebar.tsx:115` and `:253-257`

**Interfaces:**
- Consumes: `placeholderTint(title: string, author?: string): PlaceholderTint` from Task 1, whose result has `from` and `to` string fields.
- Produces: `function CoverPlaceholder({ title, author }: { title: string; author?: string })` — a self-sizing SVG filling its parent box.

The component and its two call sites ship together: a component with no consumer is dead code, and the call-site edits do not compile without it. There is no separate component unit test — the project has no jsdom or testing-library dependency, and adding that infrastructure is out of scope (see the spec's Testing section). Verification here is `yarn type-check`, the existing suite staying green, and a manual run.

- [ ] **Step 1: Create the component**

Create `src/renderer/src/components/CoverPlaceholder.tsx`:

```tsx
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
  // colour. React 19's useId returns ids containing colons (`:r0:`), so strip
  // everything outside the id-safe set before it reaches `url(#…)`.
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
```

- [ ] **Step 2: Wire it into the card**

In `src/renderer/src/components/BookCard.tsx`, add the import next to the existing ones:

```tsx
import { CoverPlaceholder } from './CoverPlaceholder'
```

Then replace this branch (lines 156-159):

```tsx
        ) : isMissing || imgFailed ? (
          <div className="flex flex-col items-center gap-1">
            <span className="text-indigo-300 text-xl font-bold">{book.extension}</span>
          </div>
        ) : (
```

with:

```tsx
        ) : isMissing || imgFailed ? (
          <CoverPlaceholder title={book.title} author={book.author} />
        ) : (
```

The duplicated extension text goes away; the top-left format badge (line 165) stays and is now the card's only format indicator. Do not touch the `isMissing` / `showImage` computation or the trailing `animate-pulse` branch — the three-state order is what keeps the placeholder out of `pending`.

- [ ] **Step 3: Wire it into the detail panel, adding its missing pending branch**

In `src/renderer/src/components/BookDetailSidebar.tsx`, add the import:

```tsx
import { CoverPlaceholder } from './CoverPlaceholder'
```

Take `status` from the hook — line 115 currently drops it:

```tsx
  const { coverSrc, status } = useCover(book, coverEpoch)
```

Then replace the two-branch render (lines 253-257):

```tsx
            {displaySrc ? (
              <img src={displaySrc} alt={book.title} className="w-full h-full object-cover" />
            ) : (
              <span className="text-indigo-300 text-3xl font-bold">{book.extension}</span>
            )}
```

with three branches:

```tsx
            {displaySrc ? (
              <img src={displaySrc} alt={book.title} className="w-full h-full object-cover" />
            ) : status === 'missing' ? (
              <CoverPlaceholder title={book.title} author={book.author} />
            ) : (
              <div className="w-full h-full bg-gray-900 animate-pulse" />
            )}
```

Without the third branch the panel would show placeholder art *during* the download and then swap to the real cover — the flash the spec forbids. Before the first resolve `status` is `null`, which correctly falls through to the skeleton. The format stays visible in the size/format row at line 393.

- [ ] **Step 4: Type-check**

```bash
nvm use
yarn type-check
```

Expected: clean. If it reports `status` as unused, Step 3's destructuring was applied without its consumer.

- [ ] **Step 5: Run the whole suite**

```bash
yarn test
```

Expected: PASS. No existing test asserts on the extension text in either component, so nothing should need updating — if something fails, read it rather than editing the test.

> If the DB-backed suites fail with a `NODE_MODULE_VERSION` mismatch, `better-sqlite3` is still built for Electron's ABI: run `npm rebuild better-sqlite3 --build-from-source`, re-run, then `yarn rebuild` afterwards to restore the Electron ABI for `yarn dev`.

- [ ] **Step 6: Verify the art visually**

```bash
yarn dev
```

Two checks:

1. **The art itself.** Temporarily force the branch in `BookCard.tsx` — change `isMissing || imgFailed` to `true` — and confirm the grid shows tinted book silhouettes, that neighbouring tiles differ in colour (this is what proves the `useId` gradient ids are not colliding), and that the format badge and presence badge stay readable on every tint. **Revert the forced condition before continuing.**
2. **The real path.** With the forced condition reverted, scroll a library that has books with no available cover and confirm those tiles show the placeholder while covers that do resolve still render normally — no tile should flash placeholder → cover. Open one placeholder book's detail panel and confirm it shows the same art, and that the size/format row still shows the format.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/CoverPlaceholder.tsx \
        src/renderer/src/components/BookCard.tsx \
        src/renderer/src/components/BookDetailSidebar.tsx
git commit -m "feat(covers): tinted placeholder art for books with no cover"
```

---

## Definition of done

- `yarn type-check` clean, `yarn test` green, `test/coverPlaceholder.test.ts` covering the 8 cases in Task 1.
- Neither locale file changed; no `console.log` added; no main-process file touched.
- The extension text is gone from both cover areas, while the card's badge and the panel's size/format row still show the format.
- A coverless book keeps the same colour across an app restart.
