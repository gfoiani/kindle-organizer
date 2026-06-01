# AGENTS.md

Guidance for AI coding agents working in this repository. (Claude Code loads this via `CLAUDE.md`.)

## Project

**Kindle Organizer** — an Electron + React 19 + TypeScript desktop app that detects a connected Kindle, browses its books, fetches covers, edits metadata, manages collections synced to Calibre's `metadata.calibre`, and auto-classifies books with an on-device ML model.

> The git repository root is this `app/` directory (the `.git` folder lives here, not in the parent).

## Commands

```bash
yarn install          # install deps; postinstall rebuilds native better-sqlite3
yarn dev              # run the app in development (electron-vite)
yarn type-check       # tsc --noEmit for tsconfig.json + tsconfig.node.json
yarn build            # production bundle
yarn dist             # build + package (electron-builder); dist:mac / dist:win for one OS
yarn rebuild          # rebuild better-sqlite3 native module if it breaks
yarn download-model   # download the AI model for auto-classification (one-time)
```

**Package manager: yarn (1.x) — use `yarn`, not `npm`.** A `yarn.lock` is committed; run scripts as `yarn <script>` (e.g. `yarn update-homebrew`).

There is **no test suite or test runner configured yet**, and no lint script. Validate changes with `yarn type-check` and a manual `yarn dev` run.

## Architecture

Three Electron layers, kept strictly separated:

- **`src/main/`** — main process (Node). All privileged work lives here:
  - `index.ts` — bootstrap, window, starts the cover-retry loop and Kindle hot-plug watcher.
  - `ipc.ts` — the single registry of `ipcMain.handle` channels; the only bridge the renderer can call.
  - `kindle.ts` — drive detection (`systeminformation`), `documents/` scanning, filename→title sanitization, hot-plug watcher.
  - `calibre.ts` — read/write the device's `metadata.calibre` (atomic write).
  - `localCollections.ts` / `bookOverrides.ts` — better-sqlite3 stores in `userData/` (collections; user title/author edits).
  - `covers.ts` — cover fetch (iTunes → Open Library → Google Books), file cache, rate limiter, background retry loop.
- **`src/preload/`** — `contextBridge` exposes a typed `window.kindleAPI` (`api.ts`). Context isolation is on; the renderer has no direct Node access.
- **`src/renderer/src/`** — React UI (`App.tsx` orchestrates state), components, the `useClassifier` hook, and the ML `classifier.worker.ts` Web Worker. i18n via `react-i18next`.

Data flow: renderer → `window.kindleAPI.*` → `ipcRenderer.invoke` → `ipcMain.handle` in `ipc.ts` → a `src/main` module. Add a feature by adding the channel in `ipc.ts`, the wrapper + type in `preload/api.ts`, and the implementation in the relevant `src/main` module.

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
- `tsconfig.json`'s `include` currently covers `src/renderer/src` and `src/preload` but **not `src/main`** — main-process code is not type-checked. Be extra careful editing `src/main`.
- `crypto.randomUUID()` / `crypto.createHash` in main use Node's global Web Crypto (Node 22) — no explicit import needed, this is intentional.
- `electron-vite` bundles via esbuild without type-checking, so a successful `yarn build` does not imply type safety — run `yarn type-check`.
