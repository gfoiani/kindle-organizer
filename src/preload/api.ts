import { ipcRenderer } from 'electron'
import type { KindleDrive, KindleBook, Collection } from '../main/kindle'

export type { KindleDrive, KindleBook, Collection }

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
    ipcRenderer.invoke('kindle:remove-book-from-collection', collectionId, bookRelpath)
}
