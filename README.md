# Kindle Manager

A desktop application for managing and organizing your Kindle library — browse books, create collections, and sync them back to your device.

## Features

- **Auto-detect Kindle** — plugs via USB and is detected automatically using drive labels and models
- **Book browser** — scans the `documents/` folder and displays all supported ebooks in a visual grid
- **Book covers** — fetches cover art automatically (Google Books API + Open Library fallback) and caches them locally
- **Collections** — create, rename, and delete custom collections; assign books to one or more collections
- **Calibre integration** — on connect, imports tag-based collections from Calibre's `metadata.calibre` file on the Kindle root
- **Write to Kindle** — saves collection assignments back to `metadata.calibre` so Calibre can read them on the next sync

## Supported formats

`MOBI` · `AZW` · `AZW3` · `KFX` · `EPUB` · `PDF`

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Electron](https://www.electronjs.org/) |
| Bundler | [electron-vite](https://electron-vite.github.io/) |
| UI | React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Local DB | better-sqlite3 (SQLite) |
| Drive detection | systeminformation |

## Architecture

```
src/
├── main/
│   ├── index.ts              # Electron main process bootstrap
│   ├── ipc.ts                # IPC handler registry
│   ├── kindle.ts             # Kindle drive detection + document scanning
│   ├── calibre.ts            # Read/write metadata.calibre
│   ├── localCollections.ts   # SQLite collections DB (CRUD)
│   └── covers.ts             # Cover fetching + file cache
├── preload/
│   ├── index.ts              # Context bridge setup
│   └── api.ts                # KindleAPI interface + ipcRenderer wrappers
└── renderer/
    └── src/
        ├── App.tsx
        └── components/
            ├── Sidebar.tsx          # Collections sidebar with CRUD
            ├── BooksGrid.tsx        # Book grid with cover previews
            └── CollectionPicker.tsx # Per-book collection assignment popover
```

### Collections

Collections are stored in a local SQLite database (`userData/collections.db`). Two sources coexist:

- **calibre** — auto-imported from `metadata.calibre` on every Kindle connect; read-only in the UI
- **local** — created manually in the app; fully editable; written back to `metadata.calibre` when you click *Write to Kindle*

### Cover cache

Covers are fetched once per book (keyed by `sha256(title|author)`) and saved to `userData/covers/`. A zero-byte file is written when no cover is found, acting as a negative-cache marker to avoid redundant API calls.

## Development

**Requirements:** Node.js 22+, yarn 1.x

```bash
# Install dependencies (rebuilds native modules automatically)
yarn install

# Start in development mode
yarn dev

# Type check
yarn type-check

# Production build
yarn build

# Package as distributable (macOS DMG, Windows NSIS, Linux AppImage)
yarn dist
```

> On macOS, make sure Xcode Command Line Tools are installed for native module compilation (`xcode-select --install`).

## License

MIT
