# Whole-App Review — Kindle Organizer

**Reviewed:** 2026-06-14 · **Branch:** develop · **Method:** 8 specialized reviewers (security, main-process correctness, React correctness, performance/a11y, type safety, code quality, build/CI/deps, i18n) → every finding adversarially re-verified against the actual code → completeness critic → critic findings verified.

## Scorecard

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 6 |
| MEDIUM | 45 |
| LOW | 29 |

**Headline:** No security vulnerabilities or data-corruption bugs. The two findings that matter most are **silent data-inconsistency bugs in the core collection-sync feature** (stale tags + dropped manual edits). Everything else is robustness, UX, accessibility, type-safety, and build hygiene. The codebase is well-architected (clean 3-layer separation, context isolation on, CSP present, atomic device writes, immutability mostly respected).

> Note on "Security" findings: most were down-graded from the reviewer's initial severity. Because `contextIsolation: true` / `nodeIntegration: false` are set, a CSP exists, and the renderer only runs the app's own bundled code (no XSS sink, no untrusted remote input), the IPC/SSRF/openExternal items are **defense-in-depth hardening, not live exploits**. Worth doing; not urgent.

---

## HIGH (6)

### H1 · Removing a book from all collections never clears its tags on the device (additive-only sync)
`src/main/calibre.ts:29-44`, `src/main/localCollections.ts:93-118` · *Correctness*

`writeCalibreMetadata` only updates a book's `tags` if the book appears in `bookTagMap`. `getAllBookTags()` builds that map from `collection_books JOIN collections`, so a book the user removed from **every** collection produces no row → it's absent from the map → its **old tags stay on the device**. Sync is effectively additive-only.

- **Impact:** Reorganizing the library (removing books from collections) shows in-app but the Kindle keeps the stale tag forever. Silent, persistent divergence in the app's core feature.
- **Fix:** Make the write authoritative for every book the app knows about. Pass the full set of device relpaths (from `readDocuments`) into `writeCalibreMetadata` and set `tags: bookTagMap.get(relpath) ?? []` for each known book, so de-tagged books get an explicit empty array. (Scope to known relpaths — don't blanket-clear unrelated entries.)
- **Scope note:** Only manifests when a book is removed from *all* its collections; removing from one of several still works.

### H2 · Re-syncing Calibre silently drops books the user manually added to a Calibre-sourced collection
`src/main/localCollections.ts:178-225` (`importFromCalibre`) · *Correctness*

`importFromCalibre` runs on every `loadCollections` (every Kindle load / refresh / hot-plug). It does `DELETE FROM collections WHERE source='calibre'` then recreates each with a **fresh `crypto.randomUUID()`**; `collection_books` rows CASCADE-delete. The `CollectionPicker` lets users add a book to a calibre-sourced collection, and on the very next sync that membership is wiped and the collection re-created under a new id.

- **Impact:** A manual addition to a Calibre-imported collection is lost on the next refresh/replug/restart — near-immediate, invisible data loss. Secondary: UI state keyed on the old id (`selectedCollectionId`) goes stale after each sync.
- **Fix:** Prefer the upsert path — there's already an `ON CONFLICT(name)` at line 188. Switch from DELETE+recreate to **upsert-by-name (keep stable id) + reconcile `collection_books`**, preserving locally-added rows. Alternatively, disable add/remove in the picker when `collection.source === 'calibre'`.

### H3 · BooksGrid renders the entire library with no virtualization
`src/renderer/src/components/BooksGrid.tsx:263-281` · *Performance*

The grid maps over the full filtered list and mounts one `BookCard` each. Every card mounts two effects: an IPC `getCover` fetch and an `onCoverUpdated` listener. For a large library this is hundreds–thousands of simultaneous DOM nodes, IPC round-trips, and listeners on mount.

- **Impact:** On a 1000+ book library, initial mount fires 1000+ `getCover` calls and registers 1000+ listeners → jank/freeze on load and high memory. (Tempered: cached covers return synchronously and the practical pain is at the upper end; typical libraries are smaller.)
- **Fix:** Virtualize the grid (e.g. `@tanstack/react-virtual`) so only visible cards mount; at minimum gate cover fetching with an `IntersectionObserver` so off-screen cards defer `getCover`. This also fixes the listener fan-out (see M-group).

### H4 · Modals lack Escape-to-close, focus trap, focus restore, and dialog roles
`src/renderer/src/components/AutoClassifyModal.tsx:145-150` (+ `CollectionPicker`, `BookDetailSidebar`) · *Accessibility*

`AutoClassifyModal` is a full overlay with no `role="dialog"`/`aria-modal`, no `aria-labelledby`, no Escape handler, no focus trap (Tab leaks into the obscured grid), no focus restore. `CollectionPicker` is dismissible only by outside mousedown (keyboard users can't dismiss). `BookDetailSidebar` has no Escape.

- **Impact:** Keyboard/screen-reader users can't escape these dialogs without a mouse and aren't told a dialog opened. WCAG 2.4.3 (Focus Order) and 4.1.2 (Name, Role, Value). *(Reviewer corrected the original 2.1.2 "keyboard trap" citation — the real issue is the inverse: focus leaks out.)*
- **Fix:** Add `role="dialog" aria-modal="true" aria-labelledby` to the modal, an Escape `onKeyDown` gated on the busy state, Tab focus containment, focus first element on mount, restore focus on unmount. Add Escape to `CollectionPicker` and `BookDetailSidebar`.

### H5 · Saving a metadata edit immediately closes the book detail sidebar
`src/renderer/src/components/BooksGrid.tsx:186-188` · *Correctness* *(also reported as a MEDIUM perf-a11y dup)*

`useEffect(() => setSelectedBook(null), [books])` clears the open panel when the book list is replaced. But `handleBookUpdated` (`App.tsx:195-197`) does `setBooks(prev => prev.map(...))` — a new array identity on **every** edit — so the effect fires after each save and slams the sidebar shut, undoing the keep-open update at lines 290-293.

- **Impact:** After editing a title/author and saving, the sidebar unexpectedly closes; the visual confirmation of the edit is lost.
- **Fix:** Stop keying the reset on `books` identity. Clear only when the selected book is gone:
  `useEffect(() => { setSelectedBook(prev => prev && books.some(b => b.path === prev.book.path) ? prev : null) }, [books, selectedBook])`. (Edited book keeps its `path`, so selection survives edits but still clears on a genuine reload.)

### H6 · `yarn type-check` aborts before checking `src/main` — the whole main process is effectively unchecked
`tsconfig.node.json:1-18` · *Type Safety / Build*

`tsc -p tsconfig.node.json` includes `["src/main", "electron.vite.config.ts"]` but uses `moduleResolution: node` / `module: CommonJS`. `electron.vite.config.ts` imports ESM-only plugins and uses electron-vite's `entry` field, so the pass fails with TS2307 + TS2769 and **exits before validating any `src/main` code**. Verified: checking `src/main/*.ts` alone with bundler resolution passes cleanly — the only blocker is this broken config. (Matches the documented "src/main not type-checked" gotcha; the real cause is config breakage.)

- **Impact:** The most privileged, data-loss-sensitive layer (Calibre/Kindle writes, SQLite, HTTP/JSON parsing) ships with **zero** compile-time checking; esbuild doesn't type-check either.
- **Fix (verified):** In `tsconfig.node.json` set `moduleResolution: "bundler"` + `module: "ESNext"` **and remove `electron.vite.config.ts` from `include`** (→ `["src/main"]`). This yields exit 0 and genuinely covers `src/main`. If you still want the Vite config checked, put it in its own tooling tsconfig. Then add `yarn type-check` to CI (currently absent). ⚠️ Sequencing: fix this *before* gating CI on type-check, and re-check the pre-existing baseline failure noted in project memory.

---

## MEDIUM (45)

### Data flow & correctness
- **`getCover` check-then-act allows duplicate downloads** — `covers.ts:432-478`. Concurrent identical (title+author) requests all miss the cache and each downloads. *(Verifier: the rate limiter serializes them, so NO parallel downloads and NO file-write race — it's wasted serial requests, not corruption.)* Fix: in-flight `Map<string, Promise>` keyed on the cache key, cleared in `.finally()`.
- **Concurrent `loadKindle()` on rapid plug/unplug leaves stale state** — `App.tsx:63-120`. Three triggers (mount, hot-plug, Refresh), nothing serializes/cancels; last-resolved wins. Fix: monotonic `useRef` request-id captured per call, re-checked before every `setState` — and threaded into `loadBooks`/`loadCollections`.
- **AI "delete existing" wipes Calibre collections that the next sync resurrects; partial failure half-applies** — `App.tsx:214-253`. Exclude `source==='calibre'` from the wipe, wrap in try/catch, ideally apply via one batched better-sqlite3 transaction in main.
- **Editing a book orphans its in-flight cover retry** — `covers.ts:438-477,507-508` + `BooksGrid.tsx:54-60`. Retry pushes `cover:updated` with the *pre-edit* title/author, matching no card. Fix: push a stable id (cache key / relpath) and match on it; re-key/drop the retry entry when `getCover` runs for a new key.
- **`handleApplySuggestions` has no error handling around N IPC writes** — `App.tsx:214-253`. A mid-sequence reject leaves collections half-applied; modal stays **open** with nothing shown/logged. Fix: try/catch + surface error; consider a transactional IPC.
- **Worker `onmessageerror` unhandled; `onerror` shows empty messages** — `useClassifier.ts:101-103`. Deserialize failures silently dropped; worker-script load failure yields a blank error (React `{error && …}` hides empty string → "Analyze appears to do nothing"). Fix: add `onmessageerror`, fall back to a non-empty message.
- **Collection delete + "delete all collections" are one-click destructive, no confirmation** — `Sidebar.tsx:62-65`, `AutoClassifyModal.tsx:130`. Fix: confirm step (especially the bulk path), show the count.

### Resource safety & lifecycle (cluster — fix together)
- **Cover retry `setInterval` never stored/cleared** — `covers.ts:484-537`. Runs for process lifetime incl. after window close (macOS keeps process alive). Fix: return `() => clearInterval(handle)`.
- **Kindle hot-plug watcher stop fn discarded** — `index.ts:50-53`. `startKindleWatcher` already returns a working stop fn; `index.ts` ignores it. 2500ms `blockDevices` poll never stops. Fix: capture it.
- **`bookOverrides` SQLite handle opened lazily, never closed** — `bookOverrides.ts:6-20`. Add `closeOverridesDb()`.
- **No `app.on('will-quit')` teardown** — `index.ts:45-66`. The structural reason the above three leak. Fix: have both loops return stop fns, add a single `will-quit` handler calling `stopRetryLoop()`, `stopWatcher()`, `closeOverridesDb()`.
- **Atomic write leaves orphaned `.tmp` on rename failure** — `calibre.ts:48-58`. (Single deterministic file, overwritten next time — not a growing pile.) Fix: cleanup the temp in catch.

### Security hardening (defense-in-depth — context isolation + CSP already mitigate)
- **`setWindowOpenHandler` forwards any URL to `shell.openExternal` without scheme allow-listing** — `index.ts:31-34`. Today only dev-hardcoded https URLs reach it. Fix: validate `protocol === 'https:'` (avoid the empty `catch {}` — log via `debug()`).
- **No `will-navigate` handler** locking the window to its origin — `index.ts:31-43`. Fix: capture allowed origin, `preventDefault` foreign navigations.
- **IPC handlers do no runtime arg validation** — `ipc.ts:24-111`. *(Verifier: NOT SQL injection — queries are parameterized; `path.join` throws on non-string. It's a robustness/convention gap, not a live vuln.)* Fix: shared `assertString(x, name)` / Zod at the boundary + central try/catch.
- **Renderer-controlled `isbn` interpolated into URL path unencoded** — `covers.ts:361-372`. Other providers use `encodeURIComponent`; this one doesn't. *(Host/scheme are hardcoded — path/query tampering against one trusted host only.)* Fix: re-validate via `normalizeIsbn` (10/13 digits/X) or at least `encodeURIComponent`.
- **`fetchUrl` follows redirects to arbitrary hosts (SSRF surface) + no response size cap** — `covers.ts:131-143`. Needs a compromised/MITM'd provider to trigger. Fix: on redirect require https + host allow-list (incl. provider CDNs: `is*-ssl.mzstatic.com`, `books.google.com`/`*.googleusercontent.com`, `covers.openlibrary.org`); add a byte cap in `fetchRaw`.

### React performance
- **Each `BookCard` registers its own `cover:updated` listener** — `BooksGrid.tsx:54-60`. N listeners on one channel → `MaxListenersExceededWarning` + O(N) dispatch per push. Fix: one listener at BooksGrid/App level routing via a `title|author` map.
- **`BookCard` not memoized; new `onSelect` closure per render** — `BooksGrid.tsx:264-278`. Typing in search re-renders every card. Fix: `React.memo` + `useCallback` the App handlers + stable `onSelect(book, relpath, cover)`.
- **Classifier worker (and loaded model) destroyed/recreated on every modal close/open** — `useClassifier.ts:68-109`. Each reopen pays full model load. Fix: lift `useClassifier` to App, or keep modal mounted + toggle visibility, or lazy-create the worker on first classify (avoids steady-state memory until used).

### Accessibility
- **`BookCard` is a clickable `<div>` with no keyboard support/role** — `BooksGrid.tsx:62-66`. WCAG 2.1.1. Fix: `role="button" tabIndex={0}` + Enter/Space `onKeyDown` + `aria-label` (don't use `<button>` — it nests a real button). Fall back accessible name when `title` is empty.
- **Async status has no `aria-live` / `role="progressbar"`** — `AutoClassifyModal.tsx:245-315`, `App.tsx:347-351`. WCAG 4.1.3. Fix: wrap status in `role="status" aria-live="polite"`; give bars `role="progressbar" aria-valuenow/min/max`; announce sync result in a visually-hidden live region.
- **Icon-only buttons rely on `title`/nothing instead of `aria-label`** — `BooksGrid.tsx:243-251`, `AutoClassifyModal.tsx:164-172,188-196`. Add `aria-label` (new i18n keys: `books.clearSearch`, `aiClassify.close`, `aiClassify.removeLabel` — the existing keys cited don't exist) + `aria-hidden="true"` on decorative SVGs.

### Internationalization
- **Hardcoded Italian tooltip `title="Gestisci collezioni"`** — `BooksGrid.tsx:98` *(reported 3× across i18n/quality/a11y — one fix)*. It's the button's only accessible name → English users hear Italian. Fix: add `books.manageCollections` to both locales, add `useTranslation()` inside `BookCard` (it doesn't currently call it), use `aria-label={t('books.manageCollections')}`.
- **Model loading status strings hardcoded English in the worker** — `classifier.worker.ts:70-75`. Fix: post a machine-readable discriminator + data, translate in renderer (`aiClassify.modelLoading/modelDownloading/modelReady`).
- **Count strings use flat templates, not plurals → "1 books"** — `en.json:49,70` (`booksCount`, `analyzeBooks`). Called with the reserved `count` var but only one form defined. Fix: `_one`/`_other` keys; remove the unused `books.book`/`books.books`.

### Code quality & maintainability
- **`covers.ts` mixes 6 concerns in 658 lines** — split under `src/main/covers/` (httpClient+rate-limiter, match, providers, retry, thin orchestrators). Share `getCacheKey` (used by metadata too).
- **Book-path→relpath stripping duplicated across ~8 sites** — `App.tsx:245-247,261-263`, `BooksGrid.tsx:265-267`, `ipc.ts:34-36`, `bookOverrides.ts:44-46`, `calibre.ts:35-37,146`, `localCollections.ts:211-213`. Load-bearing invariant with no single definition. Fix: two helpers — full-mountpoint base (App×2, BooksGrid, ipc, bookOverrides) and bare `documents/` prefix (calibre×2, localCollections).
- **`formatSize` duplicated verbatim** — `BooksGrid.tsx:18-22` & `BookDetailSidebar.tsx:13-17`. Extract to `utils/format.ts`.
- **`getDisplayLabel` is a no-op identity fn with one misleading comment** — `AutoClassifyModal.tsx:62-63`. (Vestigial after the worker started returning display labels.) Remove it + the stale line-125 comment; use `r.label` directly.
- **In-place `currentCollections.push` mutation** — `App.tsx:231-237` *(reported 2×)*. Convention violation (local array, no render bug). Fix: `let` + `[...currentCollections, created]`.
- **`getAllBookTags` mutates an array stored in the Map** — `localCollections.ts:108-114`. Fix: `result.set(key, [...tags, row.name])`.

### Type safety
- **Worker↔hook messages untyped (`event.data` + per-field `as`)** — `useClassifier.ts:78-99` & worker. Fix: shared discriminated-union `WorkerMessage`, type both `postMessage` and the cast.
- **`any` for the transformers pipeline/extractor** — `classifier.worker.ts:32-33,84-85`. Fix: import `FeatureExtractionPipeline`; type output as `Tensor` and `Float32Array.from(output.data)` (no cast — `Tensor.data` is `DataArray`).
- **External JSON parsed with 1-tuple types instead of arrays** — `covers.ts:573,616-628`. `docs`/`items` typed as length-1 tuples. Fix: `…[]` + `?.[0]`.

### Build / CI / deps
- **CI never runs type-check or any validation before packaging** — `build.yml:32-44`. Fix: `validate` job running `yarn type-check`, gate builds via `needs` (after H6 + baseline fix); ideally also on PR/push to develop, not just tags.
- **`yarn type-check` module settings don't reflect the bundler** — `tsconfig.node.json`/`tsconfig.json:23`. *(Verifier: main runs as CommonJS, so `module: CommonJS` is arguably correct — do NOT switch it to ESNext for the runtime; the real fixes are the H6 resolution change + correcting the stale AGENTS.md gotcha that claims main is unchecked.)*
- **Linux AppImage configured but never built/released** — `build.yml` has no `build-linux`. Fix: add the job + `dist:linux`, or remove the `linux` block.
- **Node 22 not enforced via `engines`/`packageManager`** — `package.json`. *(`.nvmrc` already exists with `22` — don't re-add.)* Add `engines.node` + `packageManager` (+ `engine-strict` to fail fast).
- **`release.mts`/`update-homebrew.mts` run via plain `ts-node` but are ESM `.mts`** — `package.json:19-20`. Breaks on `import.meta` (reproduced). Fix: switch to `tsx`. (Maintainer-only scripts; CI release uses `softprops/action-gh-release`.)
- **`update-homebrew.mts` logs but doesn't fail on cask write error** — `:100-103`. `release.mts` then commits/pushes a stale cask. Fix: `process.exit(1)` in the catch.
- **Model download has no checksum/size validation; partial file treated as cached** — `download-model.mjs:33-61`. Fix: pin `MODEL_REVISION` commit hash, verify SHA-256/size, temp-then-rename.
- **Universal macOS build of unpacked native module has no `x64ArchFiles`/`singleArchFiles` safety net** — `package.json:56-78`. *(Verifier: don't use `x64ArchFiles: "*"` — it would mask the guard and risk shipping a single-arch binary. Prefer verifying both-arch prebuilds, or split into separate x64/arm64 dmgs.)*
- **No automated tests anywhere** — pure logic (`sanitizeTitle`, Calibre parse/relpath, cover match scoring, classifier reducer) is 0% covered. Fix: add Vitest (fits the Vite toolchain), start with those pure functions + a `writeCalibreMetadata` round-trip fixture; wire `yarn test` into CI.

---

## LOW (29) — condensed

| # | File | Issue | Fix |
|---|---|---|---|
| L1 | `App.tsx:90-97` | `setLocale` IPC rejections unhandled | `.catch(console.error)` |
| L2 | `About.tsx:5` | Hardcoded `version='0.1.0'` (app is 0.2.0+) *(2×)* | IPC `getAppVersion()` via `app.getVersion()` |
| L3 | `About.tsx:133` | Untranslated footer tagline | `about.tagline` key |
| L4 | `menu.ts:13,46,56` | Native menu labels hardcoded English | IPC-driven rebuild on language change |
| L5 | `Settings.tsx`/`en.json:40` | `settings.selectLanguage` key unused | remove it |
| L6 | `CollectionPicker.tsx:26-32` | fetch `.catch(()=>…)` no logging | log before recover |
| L7 | `CollectionPicker.tsx:26-32` | membership fetch no cancellation guard | mirror `cancelled` flag (benign in React 19) |
| L8 | `App.tsx:206-207` | `handleWriteToKindle catch {}` drops error (most data-sensitive op) | `catch (err) { console.error(...) }` |
| L9 | `App.tsx:210` & `Settings.tsx:21` | `3000` toast delay magic number ×2 | `STATUS_RESET_MS` constant |
| L10 | `covers.ts` various | magic numbers (8000ms, 4 redirects, 0.75/0.25 weights, 500 bytes) | name the 4 tuning knobs; leave URL fragments inline |
| L11 | `covers.ts:256-343` | provider fetch+parse+guard boilerplate ×5 | `fetchJson<T>` helper |
| L12 | `covers.ts:17-23` | `itunesCountry` global read async mid-queue | capture country at enqueue |
| L13 | `covers.ts:111-129` | `fetchRaw` no size cap | byte counter + `req.destroy` (8s timeout already soft-caps) |
| L14 | `ipc.ts:24-57` | handlers don't log main-side throws | shared try/catch wrapper (Calibre layer already logs) |
| L15 | `BooksGrid.tsx:72-77` | covers lack `decoding="async"` | add it (pairs with virtualization) |
| L16 | `BooksGrid.tsx:115-117` etc. | low-contrast grays fail WCAG AA | bump `gray-500/600`→`gray-400` (only genuinely failing pairings) |
| L17 | `AutoClassifyModal.tsx:66-68` | derived sets recomputed each render | optional `useMemo` (YAGNI at real scale) |
| L18 | `worker:111-119` | `classify` payload `as`-cast, unvalidated | shared union + `labels.length>0` guard |
| L19 | `worker:72`, `index.tsx:7` | non-null assertions (`data.loaded!`, `getElementById!`) | explicit guards |
| L20 | `localCollections.ts:52…` | SQLite rows force-cast from `unknown` | `db.prepare<[], Row>(sql)` generic |
| L21 | `index.html:7-10` | CSP ships dev origin `http://localhost:5173` in `worker-src` | drop it (keep `blob:`) |
| L22 | `index.ts:19-24` | `sandbox: false` (ctx-isolation is the primary defense) | try `sandbox: true`, verify worker still loads |
| L23 | `download-model.mjs:66-68` | no top-level error handling | `main().catch(...)`; existence-only cache check is the real weakness |
| L24 | `build.yml:36-37` | model re-downloaded every CI run | `actions/cache` on `models/` |
| L25 | `worker:98-105` | single-label classify → every book 100% | require ≥2 labels in `canAnalyze` + UI hint (softmax fallback won't help — e5 sims cluster high) |

---

## Cross-cutting themes

1. **Collection-sync data integrity (H1, H2 + the AI-apply MEDIUMs)** — the most valuable fixes. The sync is additive-only and the import is destructive-recreate; together they make collection state diverge from the device silently. Treat as one workstream and add a round-trip test.
2. **Main-process lifecycle** — leaked timers, discarded stop fns, unclosed DB, no `will-quit`. One `will-quit` handler + returning stop fns resolves the cluster.
3. **Type-checking blind spot (H6)** — the entire main process is unchecked; fix the config, then gate CI.
4. **Renderer scale** — virtualization + single cover listener + memoization together make the grid scale to large libraries.
5. **Accessibility baseline** — dialogs, keyboard activation, live regions, labels: the app is currently mouse-only for its primary flows.
6. **i18n leaks** — hardcoded strings (Italian tooltip, model status, version, menu, tagline) + missing plurals.
7. **Release robustness** — no validation in CI, no tests, ESM script runner, model integrity, universal-build fragility.

## Strengths worth preserving
- Clean 3-layer separation; single IPC registry; typed `contextBridge`.
- Electron hardening largely correct: `contextIsolation: true`, `nodeIntegration: false`, a CSP present, `setWindowOpenHandler` denies in-app navigation.
- Atomic temp-then-rename for device writes (just needs failure cleanup).
- Immutability respected almost everywhere; the few violations are local working arrays.
- Cover fetching has a real rate limiter, retry/backoff, and disk cache.

## Suggested sequencing
1. **H1, H2** (data integrity) + the AI-apply error handling/transaction.
2. **H6** then add `yarn type-check` to CI (after the baseline failure is resolved).
3. **Lifecycle cluster** (one `will-quit` PR).
4. **H5** (one-line effect fix) + worker error handling.
5. **H3 + H4 + a11y** (UX/scale workstream).
6. MEDIUM quality/i18n/types sweeps; LOW as opportunistic cleanup.
7. Stand up **Vitest** early so all of the above can be verified.
