import { ipcMain } from 'electron'
import {
  detectKindleDrives,
  readDocuments,
  queryCollections,
  queryCollectionItems
} from './kindle'

export function registerIpcHandlers(): void {
  ipcMain.handle('kindle:detect-drives', async () => {
    return detectKindleDrives()
  })

  ipcMain.handle('kindle:read-documents', async (_, kindleMountpoint: string) => {
    return readDocuments(kindleMountpoint)
  })

  ipcMain.handle('kindle:query-collections', async (_, dbPath: string) => {
    return queryCollections(dbPath)
  })

  ipcMain.handle(
    'kindle:query-collection-items',
    async (_, { dbPath, collectionId }: { dbPath: string; collectionId: string }) => {
      return queryCollectionItems(dbPath, collectionId)
    }
  )
}
