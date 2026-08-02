# Changelog

<!-- markdownlint-disable MD024 -->

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-08-03

### Added

- **Staging library** — drag books into the app and keep them there whether or not a Kindle is attached. Device and library are merged into one grid with presence badges ("on Kindle" / "in library only"), and books can be converted and sent to the device on demand, in the format you choose (AZW3 or MOBI).
- **EPUB support in the library** — EPUB metadata is parsed on import and the cover cache is seeded from the file's own embedded artwork, so staged books look right before they ever reach the device.
- **Bulk actions** — turn on multi-selection (or long-press a book) to send, remove or add many books to a collection at once, with progress and a stop button.
- **Eject** — a button next to "Write to Kindle" unmounts the device so it can be safely unplugged.
- **One-click filter reset** — the sidebar's "All books" entry is now pinned to the top and, while anything is narrowing the grid, turns into a "clear filters" action that lifts the collection, the search box and the presence chips together.
- A custom title bar and in-app notices, replacing silent console-only failures.

### Changed

- **AI organization is genuinely usable** — the confidence score was recalibrated (per-label centering, an author prior and per-book normalization), genres are sent to the model with a short gloss, and online book descriptions are used by default. Measured on a real library: top-1 accuracy went from 15–23% to 50% offline and 77% with online metadata, and the median confidence from 8% to ~59%, so the threshold slider finally means something.
- **Better book metadata** — the lookup chain now asks the iTunes storefront first, which is the only provider with real coverage of localized editions (26/26 vs 3/16 for Open Library on an Italian library).
- Collections, overrides and the library share one cached SQLite connection per store instead of opening and closing the database on every call.

### Fixed

- **AI organization could not start at all** — the renderer's Content-Security-Policy refused to create the classifier worker, and a CSP-blocked worker reports an empty error, so the failure surfaced as a generic "could not start the classification engine".
- A missing or undownloadable AI model now says so, instead of sharing the generic engine-failure message.
- Device and library reconciliation: duplicate entries after a send, stale presence badges, and the book count settling as a refresh completes.

### Internal

- Main-process failures travel to the UI as machine-readable codes mapped through an exhaustive table, so a missing translation is a compile error.
- New unit tests for scoring, error mapping, eject argv construction, bulk selection, presence filtering and loading phases.
- `yarn fix-electron` repairs a missing Electron binary without a full reinstall.

## [0.3.0] - 2026-07-19

### Added

- **Author sub-collections** — books can be grouped by author within a genre through synced sub-collections that are written back to Calibre's `metadata.calibre`.

### Changed

- **Faster, cancelable cover downloads** — covers now stream from disk over a dedicated `cover-cache://` protocol instead of base64 data URLs, with concurrent, per-host rate-limited fetching. In-flight downloads are canceled when a card scrolls off-screen, and all cover file I/O is asynchronous so the main-process event loop is never blocked.
- **Node 22 & 24 support** — the toolchain now runs on both LTS lines (Node 22 in CI, Node 24 for local dev via `.nvmrc`); dependencies pinned to their latest compatible versions.

### Fixed

- Main process: collection-sync integrity, lifecycle cleanup, IPC input validation and security hardening.
- Renderer: accessibility, render performance, classifier worker lifecycle, i18n completeness and data-flow robustness.
- Responsive cover grid and correct handling of the terminal "cover missing" state.

### Internal

- `yarn type-check` now also covers `src/main` via `tsconfig.node.json`.
- Added a Vitest suite for data-integrity logic; CI validates (type-check + tests), builds a Linux AppImage, and publishes releases through a single job with deterministic asset names.

## [0.2.0] - 2026-06-01

### Added

- **On-device book classification** — auto-classify books into genre collections with a multilingual model that runs entirely on your machine, optionally using book descriptions.
- **Automated release & Homebrew publishing** — a one-command flow that bumps, tags, triggers the CI build, and updates the Homebrew tap cask.

### Changed

- More reliable cover fetching.
- Standardized the toolchain on Yarn.

### Fixed

- Hardened error handling and atomic device writes.
- Windows build: corrected the wasm copy path and excluded bundled-only native dependencies.

## [0.1.2] - 2026-03-04

### Added

- **Book metadata editing** — pencil icon in the detail sidebar to edit a book's title and author directly in the app; changes persist across sessions in a local SQLite override store.
- **Kindle hot-plug detection** — the app now detects when a Kindle is connected or disconnected while running and refreshes the library automatically.
- **iTunes cover source** — iTunes Search API added as the primary cover provider; Open Library is the first fallback, Google Books the second.

### Changed

- Cover provider order is now: iTunes → Open Library → Google Books.

## [0.1.1] - 2026-03-01

### Added

- System menu integration: the "About" menu item now opens the internal application "About" section.
- Custom application menu for macOS and other platforms.

### Changed

- Bumped version to 0.1.1.

## [0.1.0] - 2026-03-01

### Added

- Initial release of Kindle Organizer.
- Kindle drive auto-detection.
- Book browsing with cover art fetching.
- Collection management (create/rename/delete).
- Calibre metadata integration (read/write).
