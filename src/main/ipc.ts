import { app, ipcMain } from 'electron'
import { detectKindleDrives, readDocuments } from './kindle'
import { readCalibreMetadata, writeCalibreMetadata, readCalibreIsbnMap } from './calibre'
import { ensureCover, cancelCover, clearCoverCache, getBookMetadata, setCoverLocale } from './covers'
import { applyOverrides, setOverride } from './bookOverrides'
import { setMenuLabels } from './menu'
import { stripDocumentsBase } from './paths'
import { getSettings, setKindleFormat, isKindleFormat, type KindleFormat } from './settings'
import { addDroppedFiles, removeLibraryBook, sendToKindle, type SendProgress } from './libraryService'
import { listLibraryBooks } from './library'
import {
  getCollections,
  getCollectionBooks,
  getBookCollections,
  getAllBookTags,
  createCollection,
  renameCollection,
  deleteCollection,
  addBookToCollection,
  removeBookFromCollection,
  ensureCollectionsContain,
  importFromCalibre
} from './localCollections'

// ─── Boundary validation ────────────────────────────────────────────────────
// IPC arguments come from the renderer and are treated as untrusted. These tiny
// asserts fail fast with a clear message before any value reaches path.join or
// the SQLite layer. (Queries are already parameterized, so this is robustness /
// convention, not an injection fix.)

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected "${name}" to be a string, got ${typeof value}`)
  }
}

function assertOptionalString(value: unknown, name: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`Expected "${name}" to be a string or undefined, got ${typeof value}`)
  }
}

function assertStringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new TypeError(`Expected "${name}" to be a string[]`)
  }
}

function assertCollectionMemberships(
  value: unknown,
  name: string
): asserts value is { name: string; relpaths: string[] }[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected "${name}" to be an array`)
  }
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`Expected each "${name}" entry to be an object`)
    }
    const rec = entry as Record<string, unknown>
    assertString(rec.name, `${name}[].name`)
    assertStringArray(rec.relpaths, `${name}[].relpaths`)
  }
}

function assertKindleFormat(value: unknown, name: string): asserts value is KindleFormat {
  if (!isKindleFormat(value)) {
    throw new TypeError(`Expected "${name}" to be one of azw3, mobi, got ${String(value)}`)
  }
}

/**
 * Wraps an IPC handler so any thrown error is logged with the channel name and
 * context, then re-thrown (so the renderer's `invoke` promise still rejects and
 * the UI can surface it). Errors are never silently swallowed.
 */
function withErrorLogging<Args extends unknown[], Result>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result
): (event: Electron.IpcMainInvokeEvent, ...args: Args) => Promise<Result> {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (err) {
      console.error(
        `[ipc] Handler for "${channel}" threw:`,
        err instanceof Error ? err.message : String(err)
      )
      throw err
    }
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(
    'kindle:detect-drives',
    withErrorLogging('kindle:detect-drives', async () => detectKindleDrives())
  )

  ipcMain.handle(
    'kindle:read-documents',
    withErrorLogging('kindle:read-documents', async (_, kindleMountpoint: unknown) => {
      assertString(kindleMountpoint, 'kindleMountpoint')
      const books = await readDocuments(kindleMountpoint)
      const documentsBase = `${kindleMountpoint}/documents/`
      const withOverrides = applyOverrides(books, documentsBase)

      // Attach ISBNs from Calibre metadata (when present) for reliable cover lookup.
      const isbnMap = readCalibreIsbnMap(kindleMountpoint)
      if (isbnMap.size === 0) return withOverrides

      return withOverrides.map((book) => {
        const relpath = stripDocumentsBase(book.path, documentsBase)
        const isbn = isbnMap.get(relpath)
        return isbn ? { ...book, isbn } : book
      })
    })
  )

  ipcMain.handle(
    'kindle:update-book-metadata',
    withErrorLogging(
      'kindle:update-book-metadata',
      async (_, bookRelpath: unknown, title: unknown, author: unknown) => {
        assertString(bookRelpath, 'bookRelpath')
        assertString(title, 'title')
        assertOptionalString(author, 'author')
        setOverride(bookRelpath, title, author)
      }
    )
  )

  ipcMain.handle(
    'kindle:sync-calibre',
    withErrorLogging('kindle:sync-calibre', async (_, mountpoint: unknown) => {
      assertString(mountpoint, 'mountpoint')
      const calibreBooks = readCalibreMetadata(mountpoint)
      importFromCalibre(calibreBooks)
    })
  )

  ipcMain.handle(
    'kindle:write-to-kindle',
    withErrorLogging('kindle:write-to-kindle', async (_, mountpoint: unknown) => {
      assertString(mountpoint, 'mountpoint')
      // Seed the tag map with every book actually on the device so books removed
      // from all collections are written back with an explicit empty tag list
      // (authoritative sync — H1 fix).
      const books = await readDocuments(mountpoint)
      const documentsBase = `${mountpoint}/documents/`
      const knownRelpaths = books.map((book) => stripDocumentsBase(book.path, documentsBase))
      const bookTagMap = getAllBookTags(knownRelpaths)
      return writeCalibreMetadata(mountpoint, bookTagMap)
    })
  )

  ipcMain.handle(
    'kindle:get-local-collections',
    withErrorLogging('kindle:get-local-collections', async () => getCollections())
  )

  ipcMain.handle(
    'kindle:get-collection-books',
    withErrorLogging('kindle:get-collection-books', async (_, collectionId: unknown) => {
      assertString(collectionId, 'collectionId')
      return getCollectionBooks(collectionId)
    })
  )

  ipcMain.handle(
    'kindle:get-book-collections',
    withErrorLogging('kindle:get-book-collections', async (_, bookRelpath: unknown) => {
      assertString(bookRelpath, 'bookRelpath')
      return getBookCollections(bookRelpath)
    })
  )

  ipcMain.handle(
    'kindle:create-collection',
    withErrorLogging('kindle:create-collection', async (_, name: unknown) => {
      assertString(name, 'name')
      return createCollection(name)
    })
  )

  ipcMain.handle(
    'kindle:rename-collection',
    withErrorLogging('kindle:rename-collection', async (_, id: unknown, newName: unknown) => {
      assertString(id, 'id')
      assertString(newName, 'newName')
      renameCollection(id, newName)
    })
  )

  ipcMain.handle(
    'kindle:delete-collection',
    withErrorLogging('kindle:delete-collection', async (_, id: unknown) => {
      assertString(id, 'id')
      deleteCollection(id)
    })
  )

  ipcMain.handle(
    'kindle:add-book-to-collection',
    withErrorLogging(
      'kindle:add-book-to-collection',
      async (_, collectionId: unknown, bookRelpath: unknown) => {
        assertString(collectionId, 'collectionId')
        assertString(bookRelpath, 'bookRelpath')
        addBookToCollection(collectionId, bookRelpath)
      }
    )
  )

  ipcMain.handle(
    'kindle:remove-book-from-collection',
    withErrorLogging(
      'kindle:remove-book-from-collection',
      async (_, collectionId: unknown, bookRelpath: unknown) => {
        assertString(collectionId, 'collectionId')
        assertString(bookRelpath, 'bookRelpath')
        removeBookFromCollection(collectionId, bookRelpath)
      }
    )
  )

  ipcMain.handle(
    'kindle:ensure-collections-contain',
    withErrorLogging('kindle:ensure-collections-contain', async (_, entries: unknown) => {
      assertCollectionMemberships(entries, 'entries')
      return ensureCollectionsContain(entries)
    })
  )

  ipcMain.handle(
    'kindle:get-book-tags',
    withErrorLogging('kindle:get-book-tags', async (_, relpaths: unknown) => {
      assertStringArray(relpaths, 'relpaths')
      // Serialize the Map as a plain object — Maps don't survive the IPC structured clone cleanly.
      return Object.fromEntries(getAllBookTags(relpaths))
    })
  )

  ipcMain.handle(
    'kindle:ensure-cover',
    withErrorLogging(
      'kindle:ensure-cover',
      async (_, title: unknown, author: unknown, isbn: unknown) => {
        assertString(title, 'title')
        assertOptionalString(author, 'author')
        assertOptionalString(isbn, 'isbn')
        return ensureCover(title, author, isbn)
      }
    )
  )

  ipcMain.handle(
    'kindle:cancel-cover',
    withErrorLogging(
      'kindle:cancel-cover',
      async (_, title: unknown, author: unknown, isbn: unknown) => {
        assertString(title, 'title')
        assertOptionalString(author, 'author')
        assertOptionalString(isbn, 'isbn')
        cancelCover(title, author, isbn)
      }
    )
  )

  ipcMain.handle(
    'kindle:get-book-metadata',
    withErrorLogging('kindle:get-book-metadata', async (_, title: unknown, author: unknown) => {
      assertString(title, 'title')
      assertOptionalString(author, 'author')
      return getBookMetadata(title, author)
    })
  )

  ipcMain.handle(
    'kindle:clear-cover-cache',
    withErrorLogging('kindle:clear-cover-cache', async () => {
      await clearCoverCache()
    })
  )

  ipcMain.handle(
    'kindle:set-locale',
    withErrorLogging('kindle:set-locale', async (_, lang: unknown) => {
      assertString(lang, 'lang')
      setCoverLocale(lang)
    })
  )

  ipcMain.handle(
    'kindle:get-app-version',
    withErrorLogging('kindle:get-app-version', async () => app.getVersion())
  )

  ipcMain.handle(
    'kindle:get-format',
    withErrorLogging('kindle:get-format', async () => getSettings().kindleFormat)
  )

  ipcMain.handle(
    'kindle:set-format',
    withErrorLogging('kindle:set-format', async (_, format: unknown) => {
      assertKindleFormat(format, 'format')
      setKindleFormat(format)
    })
  )

  ipcMain.handle(
    'kindle:add-books',
    withErrorLogging('kindle:add-books', async (_, filePaths: unknown) => {
      assertStringArray(filePaths, 'filePaths')
      return addDroppedFiles(filePaths)
    })
  )

  ipcMain.handle(
    'kindle:get-library',
    withErrorLogging('kindle:get-library', async () => listLibraryBooks())
  )

  ipcMain.handle(
    'kindle:remove-library-book',
    withErrorLogging('kindle:remove-library-book', async (_, id: unknown) => {
      assertString(id, 'id')
      await removeLibraryBook(id)
    })
  )

  ipcMain.handle(
    'kindle:upload-book',
    withErrorLogging(
      'kindle:upload-book',
      async (event, id: unknown, mountpoint: unknown, format: unknown) => {
        assertString(id, 'id')
        assertString(mountpoint, 'mountpoint')
        assertOptionalString(format, 'format')
        // Omitted/invalid format falls back to the persisted default.
        const fmt = isKindleFormat(format) ? format : getSettings().kindleFormat
        // This push is request-scoped (tied to this invoke), so event.sender is
        // the right target — guarded against a renderer that navigated away.
        const emit = (channel: string, payload: SendProgress): void => {
          if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
        }
        return sendToKindle(id, mountpoint, fmt, emit)
      }
    )
  )

  ipcMain.handle(
    'menu:set-labels',
    withErrorLogging('menu:set-labels', async (_, about: unknown, learnMore: unknown) => {
      assertString(about, 'about')
      assertString(learnMore, 'learnMore')
      setMenuLabels({ about, learnMore })
    })
  )
}
