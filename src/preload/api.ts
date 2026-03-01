import { ipcRenderer } from 'electron'
import type {
  KindleDrive,
  KindleBook,
  Collection,
  CollectionItem
} from '../main/kindle'

export type { KindleDrive, KindleBook, Collection, CollectionItem }

export interface KindleAPI {
  detectKindleDrives: () => Promise<KindleDrive[]>
  readDocuments: (kindleMountpoint: string) => Promise<KindleBook[]>
  queryCollections: (dbPath: string) => Promise<Collection[]>
  queryCollectionItems: (dbPath: string, collectionId: string) => Promise<CollectionItem[]>
}

export const kindleAPI: KindleAPI = {
  detectKindleDrives: () => ipcRenderer.invoke('kindle:detect-drives'),

  readDocuments: (kindleMountpoint: string) =>
    ipcRenderer.invoke('kindle:read-documents', kindleMountpoint),

  queryCollections: (dbPath: string) =>
    ipcRenderer.invoke('kindle:query-collections', dbPath),

  queryCollectionItems: (dbPath: string, collectionId: string) =>
    ipcRenderer.invoke('kindle:query-collection-items', { dbPath, collectionId })
}
