# AGENTS.md

Guidance for AI coding agents working in this repository. (Claude Code loads this via `CLAUDE.md`.)

## Project

**Kindle Organizer** — an Electron + React 19 + TypeScript desktop app that detects a connected Kindle, browses its books, fetches covers, edits metadata, manages collections synced to Calibre's `metadata.calibre`, and auto-classifies books with an on-device ML model.

> The git repository root is this `app/` directory (the `.git` folder lives here, not in the parent).

## Node version

**Node 22 or 24 is required** (`package.json` pins `engines: ">=22 <23 || >=24 <25"` — both LTS lines; the odd/EOL 23 is excluded). The repo `.nvmrc` pins **24** for local dev.

**Always run `nvm use` before any `yarn` command** (`nvm install` on first setup to fetch the `.nvmrc` version, Node 24). This is not optional:

- `yarn` enforces the engine range and **refuses to run** on any out-of-range Node version (e.g. a default Node 18).
- The bundled Vite / Vitest toolchain needs Node 22+ — on older Node it fails to load its config with `ERR_REQUIRE_ESM`, so `yarn test`, `yarn build`, and `yarn dev` all break.
- Main-process code relies on Node 22+ globals (`crypto.randomUUID` / `crypto.createHash` via global Web Crypto).

CI runs on Node 22 (`.github/workflows/build.yml`); local dev uses Node 24 via `.nvmrc`. Both are covered by the engine range.

## Commands

```bash
nvm use               # switch to the .nvmrc Node (24) (REQUIRED — run before anything else)
yarn install          # install deps; postinstall rebuilds native better-sqlite3
yarn dev              # run the app in development (electron-vite)
yarn type-check       # tsc --noEmit for tsconfig.json + tsconfig.node.json
yarn test             # run the Vitest suite once (vitest run)
yarn test:watch       # Vitest in watch mode
yarn build            # production bundle
yarn dist             # build + package (electron-builder); dist:mac / dist:win for one OS
yarn rebuild          # rebuild better-sqlite3 native module if it breaks
yarn download-model   # download the AI model for auto-classification (one-time)
```

**Package manager: yarn (1.x) — use `yarn`, not `npm`.** A `yarn.lock` is committed; run scripts as `yarn <script>` (e.g. `yarn update-homebrew`). Remember `nvm use` first (see **Node version** above).

A **Vitest** suite lives in `test/` — unit tests for the main-process logic (`covers`, `httpClient`, `requestScheduler`, `coverProtocol`, `coverSrc`, `calibre`, `paths`, `localCollections`, `collectionHierarchy`), with mocks in `test/setup/` (`electron-mock.ts`, `httpMock.ts`). There is no lint script. Validate changes with `yarn type-check`, `yarn test`, and a manual `yarn dev` run.

**Shipping a release:** see [`RELEASE.md`](RELEASE.md) for the full runbook. In short: validate → update `CHANGELOG.md` → `yarn release <version>` (bumps, tags, pushes → CI builds & publishes the GitHub Release, then updates the Homebrew tap). The landing site (`../site`) auto-updates from `releases/latest`, so it needs no per-release change.

## Architecture

Three Electron layers, kept strictly separated:

- **`src/main/`** — main process (Node). All privileged work lives here:
  - `index.ts` — bootstrap, window; registers the `cover-cache://` scheme (privileged, before `ready`) and its protocol handler, starts the cover-retry loop and Kindle hot-plug watcher, and tears them down on `will-quit` (`cancelAllCovers`).
  - `ipc.ts` — the single registry of `ipcMain.handle` channels; the only bridge the renderer can call.
  - `kindle.ts` — drive detection (`systeminformation`), `documents/` scanning, filename→title sanitization, hot-plug watcher.
  - `calibre.ts` — read/write the device's `metadata.calibre` (atomic write).
  - `localCollections.ts` / `bookOverrides.ts` / `library.ts` — better-sqlite3 stores in `userData/` (collections; user title/author edits; staging library). All three go through `sqlite.ts`.
  - `sqlite.ts` — `createCachedDb(resolvePath, initSchema)`: one cached connection per store instead of an open/init/close cycle per call, keyed on the resolved path so a `userData` swap (the test harness) retires the stale handle. Closed from `will-quit`.
  - `appErrors.ts` — `AppError` + the `AppErrorCode` union for failures that must reach the UI. Electron drops custom fields when serializing an `ipcMain.handle` rejection, so the code travels IN THE MESSAGE; the renderer maps it in `utils/appError.ts`, whose `Record<AppErrorCode, string>` table makes a missing translation a compile error.
  - **Batch over loops** — mutations touching N collections have transactional batch endpoints (`ensureCollectionsContain`, `renameCollections`, `deleteCollections`), each returning the refreshed list. Prefer them: a per-item loop is N IPC round-trips and N transactions, and can leave a half-applied tree behind.
  - **Cover subsystem** (split into focused modules):
    - `covers.ts` — cover orchestration: `ensureCover` / `cancelCover` **never block on the network** — `ensureCover` returns a cache key + `ready` / `pending` / `missing` status and runs any download in the background; `cancelCover` aborts an in-flight download when a card scrolls away (interest-ref-counted). Owns the negative cache, the background retry loop (exponential back-off), and **key-only** `cover:updated` / `cover:cache-cleared` pushes to the renderer. Provider order iTunes → Open Library → Google Books.
    - `coverPaths.ts` — single source of truth for the on-disk cache layout and the sha256 cache key. **Back-compat–sensitive: do not change the key derivation** (it would orphan every cached `<hash>.jpg`).
    - `coverProtocol.ts` — custom `cover-cache://covers/<key>?v=<n>` protocol that streams cached JPEGs straight from disk to Chromium (replaces the old base64 data-URL delivery). Path-traversal guarded (bare-sha256 keys only); the scheme is registered **privileged before app `ready`** and handled inside `whenReady`.
    - `httpClient.ts` — HTTP fetch with a typed error taxonomy (`HttpError` / `RateLimitError` / `NetworkError` / `AbortError`), the redirect **SSRF allow-list**, `Retry-After`-aware 429 back-off, and the `fetchJson` helper.
    - `requestScheduler.ts` — concurrency-limited, **per-host** rate-limited scheduler. The scheduled unit is one HTTP round-trip, so different hosts run in parallel while same-host calls stay gap-limited; a 429 pauses only the offending host.
- **`src/preload/`** — `contextBridge` exposes a typed `window.kindleAPI` (`api.ts`). Context isolation is on; the renderer has no direct Node access.
- **`src/renderer/src/`** — React UI (`App.tsx` orchestrates state), components, the `useClassifier` hook, and the ML `classifier.worker.ts` Web Worker. i18n via `react-i18next`. `BooksGrid.tsx` is **row-virtualized** with `@tanstack/react-virtual`; cover `<img>`s use `cover-cache://` URLs (built by `utils/coverSrc.ts`), so `img-src cover-cache:` is allow-listed in the renderer CSP (`renderer/index.html`). That CSP also needs **`worker-src 'self'`**: the classifier worker is fetched from a real URL (dev server / `assets/` under `file:`), and a CSP-blocked worker only fires an error event with an *empty* message — indistinguishable from a crash. Worker failures travel as `ClassifierErrorCode` values (`workers/messages.ts`) that `utils/classifierError.ts` maps to localized text through a full `Record`, so the model's own failure modes (not installed / not downloadable / won't load) never surface as a generic engine error.

  **Classification is corpus-relative** (`workers/scoring.ts`): raw e5 cosines sit in a narrow band (0.74–0.88), so a plain softmax returned ~1/N for every book. The worker therefore embeds the *whole* library first (emitting `progress`), then centers per label, blends per author and normalizes per book before softmax — measured on a real library, top-1 accuracy went 15–23% → 50% offline and 77% with online metadata. Two consequences: results **cannot** stream per book, and label text is sent with a gloss (`aiClassify.genreHints.*`), which is most of the offline gain. Online context comes from `getBookMetadata`, whose provider chain is **iTunes → Open Library → Google Books** — iTunes leads because it is the only one that covers localized editions (26/26 vs 3/16 on an Italian library).

Data flow: renderer → `window.kindleAPI.*` → `ipcRenderer.invoke` → `ipcMain.handle` in `ipc.ts` → a `src/main` module. Add a feature by adding the channel in `ipc.ts`, the wrapper + type in `preload/api.ts`, and the implementation in the relevant `src/main` module.

Cover delivery is **not** IPC/base64: the renderer calls `ensureCover` (IPC) to trigger a background download and gets back a cache key + status; when the image lands, the main process pushes `cover:updated` (key only) and the renderer re-fetches the bytes over the `cover-cache://` protocol (a `?v=` query busts Chromium's `immutable` cache).

## Conventions

- **Immutability** — never mutate objects/arrays in place; return new copies (spread). This is enforced project-wide.
- **Error handling** — handle errors at every level; **never silently swallow** (no empty `catch {}`). UI-facing failures get user-friendly handling; main-process failures are logged with context.
- **No `console.log` in production** — main-process modules use a dev-only `debug()` helper gated on `!app.isPackaged`; keep `console.error` for real errors.
- **Validate at boundaries** — treat IPC arguments and external API responses (iTunes/Open Library/Google Books, file contents) as untrusted.
- **File/function size** — prefer many small focused files; ~200–400 lines typical, 800 max; functions under ~50 lines.
- **Atomic device writes** — when writing to the Kindle filesystem, write to a temp file then `rename` so an unplug mid-write can't corrupt it (see `calibre.ts`).

## Gotchas

- `better-sqlite3` is a native module — run `yarn rebuild` if it fails to load after dependency or Node/Electron changes.
- The AI model is **not bundled**; run `yarn download-model` before using auto-classification (CI does this too).
- `yarn type-check` runs two passes: `tsconfig.json` (renderer + preload) and `tsconfig.node.json` (`src/main`, bundler resolution). Main-process code **is** type-checked now — but `electron-vite` still bundles via esbuild without type-checking, so always run `yarn type-check` (a green `yarn build` does not imply type safety).
- `crypto.randomUUID()` / `crypto.createHash` in main use Node's global Web Crypto (Node 22+) — no explicit import needed, this is intentional.
- `electron-vite` bundles via esbuild without type-checking, so a successful `yarn build` does not imply type safety — run `yarn type-check`.
- **Custom title bar.** The native title bar is hidden on every platform (`themedWindowChrome` in `main/index.ts`) so the top strip is the app theme colour rather than the OS appearance; `components/TitleBar.tsx` draws it. Three consequences:
  - Any interactive element inside the bar, **and any overlay that covers it** (a full-window modal backdrop), needs `.app-no-drag` — Chromium computes the draggable area as drag-rects minus no-drag-rects, so a drag region swallows pointer events no matter what paints on top.
  - `TITLE_BAR_HEIGHT` (main) and `TITLE_BAR_HEIGHT_PX` (`TitleBar.tsx`) must stay equal: on Windows/Linux the native control overlay is drawn at exactly that height.
  - Hiding the title bar makes the window **frameless on Windows/Linux**, and Electron does not draw a menu bar for frameless windows (accelerators still register). The title bar's menu button → `menu:popup` → `popupAppMenu` is the menu's only pointer affordance there; macOS keeps its menu in the system bar.
