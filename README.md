# Kindle Organizer

A desktop application for managing and organizing your Kindle library — browse books, enrich them with cover art and metadata, build collections, and sync everything back to your device.

## Why this exists

The Kindle's built-in library is awkward to organize: there's no fast visual overview, cover art is often missing for sideloaded books, and grouping titles into collections on the device is slow. [Calibre](https://calibre-ebook.com/) is powerful but heavyweight for the common case of "just let me see my books and tidy them up."

**Kindle Organizer** fills that gap. Plug in your Kindle and it gives you an instant, visual grid of every book on the device, automatically fetches missing covers, lets you fix messy titles and authors, and builds collections that sync back to the Kindle through Calibre's metadata format. It can even sort your library into genre collections automatically using an on-device AI model — no data ever leaves your machine.

## Features

- **Auto-detect Kindle** — plug in via USB and the device is detected automatically using drive labels and models
- **Book browser** — scans the `documents/` folder and displays all supported ebooks in a visual grid
- **Book covers** — fetches cover art automatically (iTunes primary, Open Library and Google Books as fallbacks), caches them locally, and retries failed downloads in the background
- **Metadata editing** — edit a book's title and author directly in the detail sidebar; changes persist across sessions
- **Metadata lookup** — the detail sidebar pulls publication year, genre, and description for the selected book
- **Collections** — create, rename, and delete custom collections; assign books to one or more collections
- **AI auto-classification** — sort your library into genre collections with an on-device, zero-shot ML model ([`@xenova/transformers`](https://github.com/xenova/transformers.js), running in a Web Worker). Define your own genre labels, set a confidence threshold, preview the suggestions, and apply them in one batch. **Everything runs locally — no book data is sent to any server.**
- **Calibre integration** — on connect, imports tag-based collections from Calibre's `metadata.calibre` file on the Kindle root
- **Write to Kindle** — saves collection assignments back to `metadata.calibre` (via an atomic write) so Calibre can read them on the next sync
- **Hot-plug detection** — automatically refreshes the library when a Kindle is connected or disconnected while the app is running
- **Settings** — clear the local cover cache when you want covers re-fetched from scratch
- **System menu integration** — custom "About" menu item that opens the internal app section instead of a default dialog

## Supported formats

`MOBI` · `AZW` · `AZW3` · `KFX` · `EPUB` · `PDF`

## Usage

1. **Connect your Kindle** via USB. The app detects it automatically and lists every book in a grid (or click **Refresh** to re-scan).
2. **Browse** your library. Covers load in the background; click a book to open the detail sidebar with its cover and metadata, plus an edit button for fixing the title/author.
3. **Build collections.** Create a collection in the sidebar, then assign books to it from the grid (a book can belong to several collections).
4. **Let AI organize it for you (optional).** Open **AI Organize**, adjust the genre labels and confidence threshold, run the classifier, review the suggestions, and apply them — the app creates the matching collections and assigns the books.
5. **Write to Kindle.** Click **Write to Kindle** to save your collections back to `metadata.calibre`. Calibre picks them up on its next sync.

## Screenshots

<!-- TODO: add screenshots of the book grid, detail sidebar, and AI Organize modal -->

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Electron](https://www.electronjs.org/) |
| Bundler | [electron-vite](https://electron-vite.github.io/) |
| UI | React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Local DB | better-sqlite3 (SQLite) |
| Drive detection | systeminformation |
| On-device AI | [@xenova/transformers](https://github.com/xenova/transformers.js) (zero-shot classification) |

## Architecture

```
src/
├── main/
│   ├── index.ts              # Electron main process bootstrap
│   ├── ipc.ts                # IPC handler registry
│   ├── menu.ts               # Custom system menu setup
│   ├── kindle.ts             # Kindle drive detection + document scanning
│   ├── calibre.ts            # Read/write metadata.calibre
│   ├── localCollections.ts   # SQLite collections DB (CRUD)
│   ├── bookOverrides.ts      # SQLite store for user-edited title/author overrides
│   └── covers.ts             # Cover fetching + file cache (iTunes → Open Library → Google Books)
├── preload/
│   ├── index.ts              # Context bridge setup
│   └── api.ts                # KindleAPI interface + ipcRenderer wrappers
└── renderer/
    └── src/
        ├── App.tsx
        ├── components/
        │   ├── Sidebar.tsx              # Collections sidebar with CRUD
        │   ├── BooksGrid.tsx            # Book grid with cover previews
        │   ├── BookDetailSidebar.tsx    # Slide-in detail panel with metadata editing
        │   ├── CollectionPicker.tsx     # Per-book collection assignment popover
        │   ├── Settings.tsx             # Settings panel (clear cover cache)
        │   ├── About.tsx                # About panel
        │   └── AutoClassifyModal.tsx    # AI genre-classification modal
        ├── hooks/
        │   └── useClassifier.ts         # Model loading + classification state
        └── workers/
            └── classifier.worker.ts     # Web Worker running the ML model
```

### Collections

Collections are stored in a local SQLite database (`userData/collections.db`). Two sources coexist:

- **calibre** — auto-imported from `metadata.calibre` on every Kindle connect; read-only in the UI
- **local** — created manually in the app; fully editable; written back to `metadata.calibre` when you click *Write to Kindle*

### Cover cache

Covers are fetched once per book (keyed by `sha256(title|author)`) and saved to `userData/covers/`. A zero-byte file is written when no cover is found, acting as a negative-cache marker to avoid redundant API calls. Network failures are retried in the background with exponential back-off.

## Development

**Requirements:** Node.js 22+, yarn 1.x

```bash
# Install dependencies (rebuilds native modules automatically)
yarn install

# Download the AI model used for auto-classification (one-time)
yarn download-model

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

## Installation

### macOS — Homebrew (recommended)

```bash
brew tap gfoiani/kindle-organizer
brew install --cask kindle-organizer
```

### Manual download

Download the latest release from the [Releases](https://github.com/gfoiani/kindle-organizer/releases) page.

> [!NOTE]
> The app is currently **not code-signed**. Both macOS and Windows will show a security warning on first launch. This is normal for open-source apps distributed without a paid developer certificate.

### macOS — Gatekeeper warning

When you open the `.dmg` and try to launch the app, macOS will show *"Kindle Organizer can't be opened because Apple cannot check it for malicious software"*.

**Option A — Right-click to open (recommended):**
1. Open the app folder in Finder
2. **Right-click** (or Control+click) on **Kindle Organizer.app**
3. Select **Open** from the context menu
4. Click **Open** in the dialog — macOS will remember your choice

**Option B — System Settings:**
1. Try to open the app normally (it will be blocked)
2. Go to **System Settings → Privacy & Security**
3. Scroll down — you'll see *"Kindle Organizer was blocked"*
4. Click **Open Anyway** and confirm

**Option C — Terminal (one-time):**
```bash
xattr -cr /Applications/Kindle\ Organizer.app
```

### Windows — SmartScreen warning

When you run the `.exe` installer, Windows will show *"Windows protected your PC"*.

1. Click **More info**
2. Click **Run anyway**

Windows will remember your choice and won't ask again.

## Releasing & publishing to Homebrew

The Homebrew tap is a **separate repository**
([`gfoiani/homebrew-kindle-organizer`](https://github.com/gfoiani/homebrew-kindle-organizer)),
expected to be checked out next to this app folder at `../homebrew`.

### One command

```bash
yarn release X.Y.Z
```

The version is the only thing the script can't infer. [`scripts/release.mts`](scripts/release.mts) then:

1. bumps `package.json` to `X.Y.Z`, commits, tags `vX.Y.Z`, and pushes — which triggers
   CI ([build.yml](.github/workflows/build.yml)) to build the macOS DMG (`yarn dist:mac`,
   universal) + Windows installer, ad-hoc-sign the app, and publish a **GitHub Release**;
2. waits for that release's `.dmg` asset, downloads it, computes its SHA-256, and writes
   `version` + `sha256` into the tap cask (`../homebrew/Casks/kindle-organizer.rb`);
3. commits and pushes the tap repo.

Downloading the asset from the **private** repo needs a token — set `GITHUB_TOKEN` (or
`GH_TOKEN`) in `.env` or the environment. The tap path defaults to `$HOMEBREW_DIR` or `../homebrew`.

> The SHA-256 is taken from the **released** DMG (the CI-built asset), never a local
> `yarn dist:mac` build — local bytes differ and `brew` would reject the download.

### Useful flags

```bash
yarn release X.Y.Z --no-homebrew    # stop after tag/push (CI only)
yarn release X.Y.Z --homebrew-only  # skip bump/tag; just update the tap (e.g. after CI finishes)
yarn release X.Y.Z --dmg /tmp/ko.dmg  # use a local/downloaded DMG instead of fetching
yarn release X.Y.Z --sha <hash>     # provide the SHA-256 directly (no download)
yarn release X.Y.Z --no-wait        # don't poll; fail fast if the release isn't ready
yarn release X.Y.Z --no-push        # do everything except git push
```

No code signing with a paid certificate: to sign & notarize, add the Apple/Windows
credentials as GitHub Secrets (see the commented `env:` block in the workflow).

Users upgrade with `brew update && brew upgrade --cask kindle-organizer`.

## License

MIT
