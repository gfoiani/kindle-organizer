import { ipcRenderer, webUtils } from 'electron'
import type { KindleDrive, KindleBook, Collection } from '../main/kindle'
import type { CoverStatus, EnsureCoverResult } from '../main/covers'
import type { BookMetadata } from '../main/bookMetadata'
import type { KindleFormat } from '../main/settings'
import type { LibraryBook } from '../main/library'
import type { AddResult, SendProgress, SendResult, SendSidecar } from '../main/libraryService'
import type { RenameTarget } from '../main/localCollections'
import type { AppErrorCode } from '../main/appErrors'
import type { DeleteResult } from '../main/deviceDelete'
import type { AvailableUpdate } from '../main/updateCheck'
import type { CalibreBackupSummary } from '../main/calibreBackup'
import type { FolderSyncResult, LibraryFolderSummary } from '../main/libraryFolders'
import type { LinkedFolder } from '../main/libraryWatcher'
import type { KindleCollectionSummary, KindleSyncState } from '../main/kindleSync/service'
import type { FirstSyncAnswer } from '../main/kindleSync/firstSyncAnswers'
import type { DeviceStatus } from '../main/kindleSync/syncFiles'

export type {
  FolderSyncResult,
  LibraryFolderSummary,
  LinkedFolder,
  DeleteResult,
  CalibreBackupSummary,
  AvailableUpdate,
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
  SendResult,
  SendSidecar,
  RenameTarget,
  AppErrorCode,
  KindleSyncState,
  KindleCollectionSummary,
  FirstSyncAnswer,
  DeviceStatus
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
  /** The collection-sync state of a connected Kindle; writes the app's collections for the next unplug when the sync is installed. */
  refreshKindleSync: (mountpoint: string) => Promise<KindleSyncState>
  /** Answers the first-sync question (import the Kindle's collections, or discard them), then mirrors. */
  answerFirstSync: (mountpoint: string, answer: FirstSyncAnswer) => Promise<KindleSyncState>
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
  /** The format EPUBs are converted to before upload (always AZW3). */
  getFormat: () => Promise<KindleFormat>
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
  /** Removes a dropped library book: its DB row, conversions, and on-disk files. Refuses folder books. */
  removeLibraryBook: (id: string) => Promise<void>
  /** The library folders, with their book count and whether they can be reached. */
  listLibraryFolders: () => Promise<LibraryFolderSummary[]>
  /** Asks for a folder with the system dialog, then adds and reads it. Null when the dialog was cancelled. */
  addLibraryFolder: () => Promise<LinkedFolder | null>
  /** Drops a library folder and its books from the library; the files stay where they are. */
  removeLibraryFolder: (folderId: string) => Promise<void>
  /** Rescans every library folder (and re-arms their watchers). */
  syncLibraryFolders: () => Promise<FolderSyncResult[]>
  /** Shows the book's file in the system file manager. */
  revealLibraryBook: (id: string) => Promise<void>
  /** Fired when the library's books changed on disk (a library folder). Returns unsubscribe. */
  onLibraryChanged: (callback: () => void) => () => void
  /**
   * Deletes books from the Kindle (full paths as `readDocuments` returns them),
   * with their `.sdr` folder, thumbnail, metadata.calibre record and collection
   * memberships. Rejects with DEVICE_NOT_FOUND unless a Kindle is mounted there.
   */
  deleteDeviceBooks: (mountpoint: string, bookPaths: string[]) => Promise<DeleteResult>
  /** The metadata.calibre backups kept on the Kindle, newest first. */
  listCollectionsBackups: (mountpoint: string) => Promise<CalibreBackupSummary[]>
  /** Puts back the backup `id` (from listCollectionsBackups); null when it is not one of them. */
  restoreCollectionsBackup: (mountpoint: string, id: string) => Promise<{ takenAt: string } | null>
  /** Opens the folder holding `main.log` in the system file manager. */
  openLogsFolder: () => Promise<void>
  /** A newer GitHub release, or null (also when the check could not run). */
  checkForUpdate: () => Promise<AvailableUpdate | null>
  /**
   * Converts (EPUB → AZW3, in-process) and uploads a library book to the
   * connected device. Progress arrives via onConvertProgress / onUploadProgress
   * (keyed by libraryId).
   */
  uploadBook: (id: string, mountpoint: string) => Promise<SendResult>
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

  refreshKindleSync: (mountpoint: string) => ipcRenderer.invoke('kindle-sync:refresh', mountpoint),
  answerFirstSync: (mountpoint: string, answer: FirstSyncAnswer) =>
    ipcRenderer.invoke('kindle-sync:answer-first-sync', mountpoint, answer),
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

  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  addBooks: (filePaths: string[]) => ipcRenderer.invoke('kindle:add-books', filePaths),

  getLibrary: () => ipcRenderer.invoke('kindle:get-library'),

  removeLibraryBook: (id: string) => ipcRenderer.invoke('kindle:remove-library-book', id),
  listLibraryFolders: () => ipcRenderer.invoke('library:list-folders'),
  addLibraryFolder: () => ipcRenderer.invoke('library:add-folder'),
  removeLibraryFolder: (folderId: string) => ipcRenderer.invoke('library:remove-folder', folderId),
  syncLibraryFolders: () => ipcRenderer.invoke('library:sync-folders'),
  revealLibraryBook: (id: string) => ipcRenderer.invoke('library:reveal-book', id),
  onLibraryChanged: (callback) => {
    const handler = (): void => callback()
    ipcRenderer.on('library:changed', handler)
    return () => ipcRenderer.removeListener('library:changed', handler)
  },
  deleteDeviceBooks: (mountpoint: string, bookPaths: string[]) =>
    ipcRenderer.invoke('kindle:delete-device-books', mountpoint, bookPaths),
  listCollectionsBackups: (mountpoint: string) => ipcRenderer.invoke('kindle:list-collections-backups', mountpoint),
  restoreCollectionsBackup: (mountpoint: string, id: string) =>
    ipcRenderer.invoke('kindle:restore-collections-backup', mountpoint, id),
  openLogsFolder: () => ipcRenderer.invoke('kindle:open-logs-folder'),
  checkForUpdate: () => ipcRenderer.invoke('kindle:check-for-update'),

  uploadBook: (id: string, mountpoint: string) => ipcRenderer.invoke('kindle:upload-book', id, mountpoint),

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
