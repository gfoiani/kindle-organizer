import { ipcRenderer } from 'electron'
import type { KindleDrive, KindleBook, Collection } from '../main/kindle'

export type { KindleDrive, KindleBook, Collection }

export interface KindleAPI {
  detectKindleDrives: () => Promise<KindleDrive[]>
  readDocuments: (kindleMountpoint: string) => Promise<KindleBook[]>
  syncCalibre: (mountpoint: string) => Promise<void>
  getLocalCollections: () => Promise<Collection[]>
  getCollectionBooks: (collectionId: string) => Promise<string[]>
}

export const kindleAPI: KindleAPI = {
  detectKindleDrives: () => ipcRenderer.invoke('kindle:detect-drives'),

  readDocuments: (kindleMountpoint: string) =>
    ipcRenderer.invoke('kindle:read-documents', kindleMountpoint),

  syncCalibre: (mountpoint: string) => ipcRenderer.invoke('kindle:sync-calibre', mountpoint),

  getLocalCollections: () => ipcRenderer.invoke('kindle:get-local-collections'),

  getCollectionBooks: (collectionId: string) =>
    ipcRenderer.invoke('kindle:get-collection-books', collectionId)
}
