import { ipcRenderer } from 'electron'
import type { KindleDrive, KindleBook, Collection } from '../main/kindle'
import type { BookMetadata } from '../main/covers'

export type { KindleDrive, KindleBook, Collection, BookMetadata }

export interface KindleAPI {
  detectKindleDrives: () => Promise<KindleDrive[]>
  readDocuments: (kindleMountpoint: string) => Promise<KindleBook[]>
  syncCalibre: (mountpoint: string) => Promise<void>
  writeToKindle: (mountpoint: string) => Promise<boolean>
  getLocalCollections: () => Promise<Collection[]>
  getCollectionBooks: (collectionId: string) => Promise<string[]>
  getBookCollections: (bookRelpath: string) => Promise<string[]>
  createCollection: (name: string) => Promise<Collection>
  renameCollection: (id: string, newName: string) => Promise<void>
  deleteCollection: (id: string) => Promise<void>
  addBookToCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  removeBookFromCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  getCover: (title: string, author?: string) => Promise<string | null>
  getBookMetadata: (title: string, author?: string) => Promise<BookMetadata | null>
  updateBookMetadata: (bookRelpath: string, title: string, author?: string) => Promise<void>
  clearCoverCache: () => Promise<void>
  onShowAbout: (callback: () => void) => void
  /** Subscribe to cover updates pushed by the retry loop. Returns an unsubscribe function. */
  onCoverUpdated: (
    callback: (title: string, author: string | undefined, dataUrl: string) => void
  ) => () => void
  /** Fired when a Kindle is plugged in while the app is running. */
  onKindleConnected: (callback: (drive: KindleDrive) => void) => () => void
  /** Fired when a Kindle is unplugged while the app is running. */
  onKindleDisconnected: (callback: (drive: KindleDrive) => void) => () => void
}

export const kindleAPI: KindleAPI = {
  detectKindleDrives: () => ipcRenderer.invoke('kindle:detect-drives'),

  readDocuments: (kindleMountpoint: string) =>
    ipcRenderer.invoke('kindle:read-documents', kindleMountpoint),

  syncCalibre: (mountpoint: string) => ipcRenderer.invoke('kindle:sync-calibre', mountpoint),

  writeToKindle: (mountpoint: string) => ipcRenderer.invoke('kindle:write-to-kindle', mountpoint),

  getLocalCollections: () => ipcRenderer.invoke('kindle:get-local-collections'),

  getCollectionBooks: (collectionId: string) =>
    ipcRenderer.invoke('kindle:get-collection-books', collectionId),

  getBookCollections: (bookRelpath: string) =>
    ipcRenderer.invoke('kindle:get-book-collections', bookRelpath),

  createCollection: (name: string) => ipcRenderer.invoke('kindle:create-collection', name),

  renameCollection: (id: string, newName: string) =>
    ipcRenderer.invoke('kindle:rename-collection', id, newName),

  deleteCollection: (id: string) => ipcRenderer.invoke('kindle:delete-collection', id),

  addBookToCollection: (collectionId: string, bookRelpath: string) =>
    ipcRenderer.invoke('kindle:add-book-to-collection', collectionId, bookRelpath),

  removeBookFromCollection: (collectionId: string, bookRelpath: string) =>
    ipcRenderer.invoke('kindle:remove-book-from-collection', collectionId, bookRelpath),

  getCover: (title: string, author?: string) =>
    ipcRenderer.invoke('kindle:get-cover', title, author),

  getBookMetadata: (title: string, author?: string) =>
    ipcRenderer.invoke('kindle:get-book-metadata', title, author),

  updateBookMetadata: (bookRelpath: string, title: string, author?: string) =>
    ipcRenderer.invoke('kindle:update-book-metadata', bookRelpath, title, author),

  clearCoverCache: () => ipcRenderer.invoke('kindle:clear-cover-cache'),

  onShowAbout: (callback: () => void) => {
    ipcRenderer.removeAllListeners('show-about')
    ipcRenderer.on('show-about', () => callback())
  },

  onCoverUpdated: (callback) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      title: string,
      author: string | undefined,
      dataUrl: string
    ) => callback(title, author, dataUrl)
    ipcRenderer.on('cover:updated', handler)
    return () => ipcRenderer.removeListener('cover:updated', handler)
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
