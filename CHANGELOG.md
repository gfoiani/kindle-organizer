# Changelog

<!-- markdownlint-disable MD024 -->

All notable changes to this project will be documented in this file.

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
