# Changelog

<!-- markdownlint-disable MD024 -->

All notable changes to this project will be documented in this file.

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
