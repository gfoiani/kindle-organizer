import { ipcMain } from 'electron'
import { detectKindleDrives, readDocuments } from './kindle'
import { readCalibreMetadata } from './calibre'
import { getCollections, getCollectionBooks, importFromCalibre } from './localCollections'

export function registerIpcHandlers(): void {
  ipcMain.handle('kindle:detect-drives', async () => {
    return detectKindleDrives()
  })

  ipcMain.handle('kindle:read-documents', async (_, kindleMountpoint: string) => {
    return readDocuments(kindleMountpoint)
  })

  ipcMain.handle('kindle:sync-calibre', async (_, mountpoint: string) => {
    const calibreBooks = readCalibreMetadata(mountpoint)
    importFromCalibre(calibreBooks)
  })

  ipcMain.handle('kindle:get-local-collections', async () => {
    return getCollections()
  })

  ipcMain.handle('kindle:get-collection-books', async (_, collectionId: string) => {
    return getCollectionBooks(collectionId)
  })
}
