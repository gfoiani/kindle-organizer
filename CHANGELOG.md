# Changelog

<!-- markdownlint-disable MD024 -->

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.5.0] - 2026-11-08

### Added

- **Library folders** — add one or more folders on your computer in *Settings → Library folders* and their books (subfolders included) appear in the library without being copied. The app watches the folders while it is open: a book added, renamed, moved or deleted there shows up in the grid by itself, and a renamed or moved book keeps its link to the copy on the Kindle. The files are never changed or deleted; a folder on a disk that is not plugged in keeps its books until it comes back.
- **Delete from Kindle** — one book from its detail panel, or a whole selection. The book's reading data (`.sdr`), home-screen thumbnail, `metadata.calibre` record and collection memberships go with it.
- **Backups of `metadata.calibre`** — every change first copies the previous file to `.kindle-organizer/backups/` on the Kindle (the last 10). *Settings → Collections on the Kindle* restores the copy you pick, and a restore can itself be undone.
- **Sort the grid** by title, author or recently added.
- **Logs** — errors and warnings are written to `main.log`; *Settings → Diagnostics* opens its folder.
- **Update notice** — a link at the bottom of the sidebar when a newer release is out.
- **Collections on the Kindle (experimental)** — for a Kindle jailbroken with jb.sh: the header shows whether the Kindle holds the app's collections, and the first time it asks whether to import the collections already on the Kindle or let them go. A Kindle without the jailbreak gets a plain explanation and a link to the community guide; the app never jailbreaks a device. The part that runs on the Kindle and applies the collections at unplug is still being tested on real devices and is not offered yet: the header tells a jailbroken Kindle that it is coming.

### Changed

- **Calibre is no longer needed.** EPUBs are converted to AZW3 by a converter built into the app, so *Send to Kindle* works the same whether or not calibre is installed. The converted book carries the app's title, author and cover, internal links and the table of contents.
- Sending a book that cannot be converted now says why (DRM-protected, damaged EPUB) instead of only "failed".

### Removed

- *Write to Kindle*. It wrote collections into `metadata.calibre` as calibre tags, which a Kindle with firmware 5.x does not read for its collections, so they never appeared on the device. Collections will reach a jailbroken Kindle through the collection sync above; `metadata.calibre` is still updated when books are sent or deleted.
- The MOBI conversion option: books are always converted to AZW3 (KF8), which every Kindle reads from the Kindle Keyboard (with its 2012 firmware update) onwards. Kindle 1, 2 and DX are not supported for converted books.
- Embedded fonts are not carried over into converted books; the Kindle's own fonts are used.

### Fixed

- A damaged or half-written `metadata.calibre` no longer deletes every collection imported from calibre on the next sync.
- Books with accented titles no longer get a second `metadata.calibre` record on macOS (decomposed vs composed file names).
- Old EPUBs written in uppercase HTML (`<P>`, `<LI>` never closed) convert instead of being rejected as damaged.
- A hostile EPUB can no longer exhaust memory when it is added to the library or appears in a library folder, and a cover declaring an enormous size is not decoded for the Kindle thumbnail.
- A library folder on a disk or network share that stops answering no longer freezes the library; it shows as not reachable.
- The book panel follows a book after it is sent or deleted from the Kindle, instead of showing its old state.
- Refresh no longer spins forever when a book is sent or deleted while the Kindle is still being read.
- Removing a library book checks that the id belongs to the library before touching the disk.
- **Windows:** collections imported from calibre now show their books, title/author edits and ISBNs apply, and collections keep working when the Kindle gets a different drive letter. Collections and edits saved by earlier versions are carried over on first launch.
- Sending a book no longer overwrites a different book with the same name already on the Kindle; the new one is saved as `Title (2)`.
- A send that put the book on the Kindle but could not write its cover or its `metadata.calibre` record now says so instead of reporting full success.
- Deleting one copy of a book no longer removes the home-screen cover of another copy still on the Kindle.
- *Write to Kindle* and *Send* refuse a Kindle unplugged a moment earlier instead of reporting success.
- *Clear cover cache* keeps the covers taken from the books' own files, which could not be downloaded again.
- Dropping the same book twice at once no longer leaves an orphan copy in the library folder.
- On macOS, *About* in the menu bar works after the window has been closed.
- Converted books no longer carry undeclared namespaces (Word's `<o:p>`, `xlink:href` outside images), which a strict Kindle could refuse.
- Books that could not be deleted from the Kindle or removed from the library stay selected, so they can be retried; the selection only closes when everything succeeded.
- Typing in the search box no longer redraws every book card.
- Two library reloads finishing out of order no longer leave the older list on screen.
- A hostile EPUB can no longer freeze the app during a send: content documents over 8 MiB, oversized package files, runaway tables of contents and titles are refused or cut.
- **macOS:** the collections and edits of a book with an accented file name no longer depend on whether macOS spells the name composed or decomposed.

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
