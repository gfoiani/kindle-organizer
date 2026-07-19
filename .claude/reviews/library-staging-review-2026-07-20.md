# Branch Review: `feat/library-staging-send-to-kindle` → `develop`

**Reviewed**: 2026-07-20
**Author**: Giovanni Foiani
**Base**: `develop` (== `main` == `origin/main`, all at `50c37c5`)
**Scope**: 7 commits, +3144 / −28 across 29 files
**Decision**: ✅ APPROVE with comments (no CRITICAL/HIGH; validation passes)

## Summary

A well-structured staging-library feature: drag-drop import → EPUB metadata/cover
extraction → convert (Calibre/bundled) → atomic upload to the device. Layer
separation, boundary validation, error taxonomy, and test coverage of the
main-process logic are all strong. Findings are edge-case correctness in the
device+library merge and a few minor polish items — nothing blocking.

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM

**M1 — Duplicate React keys when two device books share a normalized identity**
`src/renderer/src/utils/mergeBooks.ts:57-67` → `BooksGrid.tsx:482`
`mergeBooks` matches each device book to a library book by `targetRelpath` OR a
normalized `title|author` identity. If two device books have the same normalized
identity and one library book matches it, **both** device cards get
`libraryId: match.id`. `BookCard` then keys on `key={book.libraryId ?? book.path}`,
so both cards render with the **same key** → React reconciliation collision (state
bleed between cards: picker-open, cover epoch). Plausible in real Kindle libraries
that hold duplicate uploads. Not covered by `test/mergeBooks.test.ts`.
*Fix*: only attach the first identity match (track matched device book), or fall
back the key to `path` when the card is on-device (`book.onDevice ? book.path : book.libraryId`).

**M2 — Identity reconciliation can hide an unrelated staged book**
`src/renderer/src/utils/mergeBooks.ts:57-61`
A staged library book that coincidentally shares `title|author` with an unrelated
device book is silently reconciled: no "in library only" card is produced, its
`libraryId` is attached to the device card, and the only send/remove UI lives in
the library-only sidebar — so the user has **no way to send or remove** that staged
copy. Consider requiring `targetRelpath` for reconciliation, or reconciling by
content identity only when the book was actually uploaded (`uploadedAt` set).

### LOW

**L1 — Duplicate `titleFromFilename` helper** — identical function in
`src/main/epub.ts:22` and `src/main/libraryService.ts:52`. Extract to a shared util.

**L2 — Brief "Converting 0%" flash for non-EPUB sends** —
`BookDetailSidebar.handleSend` hardcodes `setSendPhase('converting')` before any
progress even when `willConvert` is false (AZW3/MOBI/PDF go straight to upload).
Initialize to `'uploading'` when `!willConvert`.

**L3 — Conversion cancellation is wired but unreachable** — `convert.ts` supports
an `AbortSignal` (kill + `ConversionAbortError`), but `sendToKindle` never passes
one and there's no cancel affordance in the UI. Dead path today (harmless; note for
when a cancel button lands).

## Security notes (checked, all clear)

- **No shell / command injection** — `convert.ts` uses `execFile` with an argv, never a shell.
- **No path traversal on upload** — device `targetFilename` is either `sanitizeFilename(title)`
  (strips `/\:*?"<>|`) or a stored `path.basename`; both are separator-free before `path.join`.
- **No zip-slip / XXE from untrusted EPUBs** — cover href is used only for in-archive
  `zip.entryData` lookups (never host-FS writes by entry name); `fast-xml-parser` does not
  resolve external DTD entities.
- **Atomic writes** — settings.json (temp+rename) and device upload (hidden `.tmp` staged on the
  same FS, then rename, with best-effort cleanup) both correct.
- **Boundary validation** — every new IPC channel asserts arg types before use; SQL is parameterized.

## Validation

| Check | Result |
|---|---|
| Type check (`yarn type-check`, both tsconfigs) | ✅ Pass |
| Tests (`yarn test`) | ✅ Pass — 173/173 (after rebuilding `better-sqlite3` for the Node ABI) |
| Lint | — (no lint script in repo) |
| Build | Skipped (type-check is the real gate; esbuild bundles without types) |

> Note: an initial `yarn test` failed 41 tests with a `NODE_MODULE_VERSION 148 vs 137`
> mismatch — the known better-sqlite3 Electron/Node ABI issue, not branch code.
> `npm rebuild better-sqlite3 --build-from-source` under Node 24 → all green. The
> Electron ABI build was restored afterward so `yarn dev` still runs.

## Files reviewed

Main (new): `convert.ts`, `deviceUpload.ts`, `epub.ts`, `library.ts`, `libraryService.ts`, `settings.ts`
Main (modified): `ipc.ts`, `covers.ts` (`importLocalCover`), `kindle.ts` (exported `SUPPORTED_EXTENSIONS`)
Preload: `api.ts`
Renderer: `App.tsx`, `BooksGrid.tsx`, `BookDetailSidebar.tsx`, `Settings.tsx`, `utils/mergeBooks.ts`
Tests: `convert`, `deviceUpload`, `epub`, `library`, `libraryService`, `mergeBooks`, `settings`, `covers` (+ `setup/epubFixture`)
Config/docs: `package.json` (+`fast-xml-parser`, `node-stream-zip`), `yarn.lock`, `TODO.md`
