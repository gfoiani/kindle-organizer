import { ipcRenderer, webUtils } from 'electron'
import type { KindleDrive, KindleBook, Collection } from '../main/kindle'
import type { BookMetadata, CoverStatus, EnsureCoverResult } from '../main/covers'
import type { KindleFormat } from '../main/settings'
import type { LibraryBook } from '../main/library'
import type { AddResult, SendProgress } from '../main/libraryService'
import type { RenameTarget } from '../main/localCollections'
import type { AppErrorCode } from '../main/appErrors'

export type {
  KindleDrive,
  KindleBook,
  Collection,
  BookMetadata,
  CoverStatus,
  EnsureCoverResult,
  KindleFormat,
  LibraryBook,
  AddResult,
  SendProgress,
  RenameTarget,
  AppErrorCode
}

export interface KindleAPI {
  /**
   * The host OS (`process.platform`). The renderer needs it to lay out the
   * custom title bar: macOS keeps its traffic lights on the left, Windows and
   * Linux draw their window controls on the right.
   */
  platform: NodeJS.Platform
  detectKindleDrives: () => Promise<KindleDrive[]>
  readDocuments: (kindleMountpoint: string) => Promise<KindleBook[]>
  syncCalibre: (mountpoint: string) => Promise<void>
  writeToKindle: (mountpoint: string) => Promise<boolean>
  /** Unmounts and powers down the connected Kindle so it can be safely unplugged. */
  ejectKindle: (mountpoint: string) => Promise<void>
  getLocalCollections: () => Promise<Collection[]>
  getCollectionBooks: (collectionId: string) => Promise<string[]>
  getBookCollections: (bookRelpath: string) => Promise<string[]>
  createCollection: (name: string) => Promise<Collection>
  /**
   * Renames collections atomically (a genre + its author sub-collections; a
   * single rename is a one-element batch). Rejects with COLLECTION_NAME_TAKEN /
   * COLLECTION_NAME_EMPTY without applying ANY of them. Returns the refreshed
   * collection list, so the caller needs no follow-up read.
   */
  renameCollections: (targets: RenameTarget[]) => Promise<Collection[]>
  /** Deletes collections in one transaction. Returns the refreshed list. */
  deleteCollections: (ids: string[]) => Promise<Collection[]>
  addBookToCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  removeBookFromCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  /** Ensures each named collection exists and contains the given relpaths (idempotent batch). */
  ensureCollectionsContain: (
    entries: { name: string; relpaths: string[] }[]
  ) => Promise<Collection[]>
  /** Returns a relpath → collection-name[] map for the given known book relpaths. */
  getBookTags: (relpaths: string[]) => Promise<Record<string, string[]>>
  /** Ensures a cover exists on disk; returns its cache key + status. Never blocks on the network. */
  ensureCover: (title: string, author?: string, isbn?: string) => Promise<EnsureCoverResult>
  /** Cancels an in-flight cover download (e.g. when a card scrolls out of view). */
  cancelCover: (title: string, author?: string, isbn?: string) => void
  getBookMetadata: (title: string, author?: string) => Promise<BookMetadata | null>
  updateBookMetadata: (bookRelpath: string, title: string, author?: string) => Promise<void>
  clearCoverCache: () => Promise<void>
  /** Aligns the iTunes cover storefront with the app's UI language (e.g. 'it', 'en'). */
  setLocale: (lang: string) => Promise<void>
  /** Returns the running app version (from package.json via app.getVersion()). */
  getAppVersion: () => Promise<string>
  /** Reads the configured Kindle conversion format (default 'azw3'). */
  getFormat: () => Promise<KindleFormat>
  /** Persists the Kindle conversion format. Rejects on an invalid value. */
  setFormat: (format: KindleFormat) => Promise<void>
  /**
   * Resolves the absolute filesystem path of a dropped/selected File. Electron
   * removed `File.path`; `webUtils.getPathForFile` is the sandbox-safe
   * replacement. Synchronous — returns the path directly, not a Promise.
   */
  getPathForFile: (file: File) => string
  /** Imports dropped files into the staging library; one AddResult per input path. */
  addBooks: (filePaths: string[]) => Promise<AddResult[]>
  /** Lists every book in the staging library (newest first). */
  getLibrary: () => Promise<LibraryBook[]>
  /** Removes a library book: its DB row, conversions, and on-disk files. */
  removeLibraryBook: (id: string) => Promise<void>
  /**
   * Converts (EPUB → format) and uploads a library book to the connected device.
   * Format omitted → the persisted default. Progress arrives via
   * onConvertProgress / onUploadProgress (keyed by libraryId).
   */
  uploadBook: (id: string, mountpoint: string, format?: KindleFormat) => Promise<{ targetRelpath: string }>
  /** Subscribe to conversion progress (libraryId + percent). Returns unsubscribe. */
  onConvertProgress: (callback: (progress: SendProgress) => void) => () => void
  /** Subscribe to upload progress (libraryId + percent). Returns unsubscribe. */
  onUploadProgress: (callback: (progress: SendProgress) => void) => () => void
  /** Rebuilds the native menu's custom labels in the active UI language. */
  setMenuLabels: (about: string, learnMore: string) => Promise<void>
  /**
   * Opens the application menu at the given window coordinates. Needed only on
   * Windows/Linux, where hiding the native title bar also removes the menu bar
   * Electron would otherwise draw (see `popupAppMenu` in `main/menu.ts`).
   */
  popupAppMenu: (x: number, y: number) => Promise<void>
  /** Fired when the "About" menu item is selected. Returns an unsubscribe function. */
  onShowAbout: (callback: () => void) => () => void
  /**
   * Subscribe to cover-ready pushes from the main process. The callback receives
   * only the cache key; the renderer re-fetches the image over cover-cache://.
   * Returns an unsubscribe function.
   */
  onCoverUpdated: (callback: (cacheKey: string) => void) => () => void
  /**
   * Subscribe to cover-missing pushes: a cover resolved to "none available"
   * (confirmed not-found or retries exhausted). The callback receives only the
   * cache key so the renderer can drop that card out of its pending state.
   * Returns an unsubscribe function.
   */
  onCoverMissing: (callback: (cacheKey: string) => void) => () => void
  /** Fired after the cover cache is cleared so the renderer can reset. Returns unsubscribe. */
  onCoverCacheCleared: (callback: () => void) => () => void
  /** Fired when a Kindle is plugged in while the app is running. */
  onKindleConnected: (callback: (drive: KindleDrive) => void) => () => void
  /** Fired when a Kindle is unplugged while the app is running. */
  onKindleDisconnected: (callback: (drive: KindleDrive) => void) => () => void
}

export const kindleAPI: KindleAPI = {
  platform: process.platform,

  detectKindleDrives: () => ipcRenderer.invoke('kindle:detect-drives'),

  readDocuments: (kindleMountpoint: string) =>
    ipcRenderer.invoke('kindle:read-documents', kindleMountpoint),

  syncCalibre: (mountpoint: string) => ipcRenderer.invoke('kindle:sync-calibre', mountpoint),

  writeToKindle: (mountpoint: string) => ipcRenderer.invoke('kindle:write-to-kindle', mountpoint),
  ejectKindle: (mountpoint: string) => ipcRenderer.invoke('kindle:eject', mountpoint),

  getLocalCollections: () => ipcRenderer.invoke('kindle:get-local-collections'),

  getCollectionBooks: (collectionId: string) =>
    ipcRenderer.invoke('kindle:get-collection-books', collectionId),

  getBookCollections: (bookRelpath: string) =>
    ipcRenderer.invoke('kindle:get-book-collections', bookRelpath),

  createCollection: (name: string) => ipcRenderer.invoke('kindle:create-collection', name),

  renameCollections: (targets: RenameTarget[]) =>
    ipcRenderer.invoke('kindle:rename-collections', targets),

  deleteCollections: (ids: string[]) => ipcRenderer.invoke('kindle:delete-collections', ids),

  addBookToCollection: (collectionId: string, bookRelpath: string) =>
    ipcRenderer.invoke('kindle:add-book-to-collection', collectionId, bookRelpath),

  removeBookFromCollection: (collectionId: string, bookRelpath: string) =>
    ipcRenderer.invoke('kindle:remove-book-from-collection', collectionId, bookRelpath),

  ensureCollectionsContain: (entries: { name: string; relpaths: string[] }[]) =>
    ipcRenderer.invoke('kindle:ensure-collections-contain', entries),

  getBookTags: (relpaths: string[]) => ipcRenderer.invoke('kindle:get-book-tags', relpaths),

  ensureCover: (title: string, author?: string, isbn?: string) =>
    ipcRenderer.invoke('kindle:ensure-cover', title, author, isbn),

  cancelCover: (title: string, author?: string, isbn?: string) => {
    void ipcRenderer.invoke('kindle:cancel-cover', title, author, isbn)
  },

  getBookMetadata: (title: string, author?: string) =>
    ipcRenderer.invoke('kindle:get-book-metadata', title, author),

  updateBookMetadata: (bookRelpath: string, title: string, author?: string) =>
    ipcRenderer.invoke('kindle:update-book-metadata', bookRelpath, title, author),

  clearCoverCache: () => ipcRenderer.invoke('kindle:clear-cover-cache'),

  setLocale: (lang: string) => ipcRenderer.invoke('kindle:set-locale', lang),

  getAppVersion: () => ipcRenderer.invoke('kindle:get-app-version'),

  getFormat: () => ipcRenderer.invoke('kindle:get-format'),

  setFormat: (format: KindleFormat) => ipcRenderer.invoke('kindle:set-format', format),

  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  addBooks: (filePaths: string[]) => ipcRenderer.invoke('kindle:add-books', filePaths),

  getLibrary: () => ipcRenderer.invoke('kindle:get-library'),

  removeLibraryBook: (id: string) => ipcRenderer.invoke('kindle:remove-library-book', id),

  uploadBook: (id: string, mountpoint: string, format?: KindleFormat) =>
    ipcRenderer.invoke('kindle:upload-book', id, mountpoint, format),

  onConvertProgress: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, progress: SendProgress) => callback(progress)
    ipcRenderer.on('convert:progress', handler)
    return () => ipcRenderer.removeListener('convert:progress', handler)
  },

  onUploadProgress: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, progress: SendProgress) => callback(progress)
    ipcRenderer.on('upload:progress', handler)
    return () => ipcRenderer.removeListener('upload:progress', handler)
  },

  setMenuLabels: (about: string, learnMore: string) =>
    ipcRenderer.invoke('menu:set-labels', about, learnMore),

  popupAppMenu: (x: number, y: number) => ipcRenderer.invoke('menu:popup', x, y),

  onShowAbout: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('show-about', handler)
    return () => ipcRenderer.removeListener('show-about', handler)
  },

  onCoverUpdated: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, cacheKey: string) => callback(cacheKey)
    ipcRenderer.on('cover:updated', handler)
    return () => ipcRenderer.removeListener('cover:updated', handler)
  },

  onCoverMissing: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, cacheKey: string) => callback(cacheKey)
    ipcRenderer.on('cover:missing', handler)
    return () => ipcRenderer.removeListener('cover:missing', handler)
  },

  onCoverCacheCleared: (callback) => {
    const handler = (): void => callback()
    ipcRenderer.on('cover:cache-cleared', handler)
    return () => ipcRenderer.removeListener('cover:cache-cleared', handler)
  },

  onKindleConnected: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, drive: KindleDrive) => callback(drive)
    ipcRenderer.on('kindle:connected', handler)
    return () => ipcRenderer.removeListener('kindle:connected', handler)
  },

  onKindleDisconnected: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, drive: KindleDrive) => callback(drive)
    ipcRenderer.on('kindle:disconnected', handler)
    return () => ipcRenderer.removeListener('kindle:disconnected', handler)
  }
}
