import { ipcMain } from 'electron'
import { detectKindleDrives, readDocuments } from './kindle'
import { readCalibreMetadata, writeCalibreMetadata } from './calibre'
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
  importFromCalibre
} from './localCollections'

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

  ipcMain.handle('kindle:write-to-kindle', async (_, mountpoint: string) => {
    const bookTagMap = getAllBookTags()
    return writeCalibreMetadata(mountpoint, bookTagMap)
  })

  ipcMain.handle('kindle:get-local-collections', async () => {
    return getCollections()
  })

  ipcMain.handle('kindle:get-collection-books', async (_, collectionId: string) => {
    return getCollectionBooks(collectionId)
  })

  ipcMain.handle('kindle:get-book-collections', async (_, bookRelpath: string) => {
    return getBookCollections(bookRelpath)
  })

  ipcMain.handle('kindle:create-collection', async (_, name: string) => {
    return createCollection(name)
  })

  ipcMain.handle('kindle:rename-collection', async (_, id: string, newName: string) => {
    renameCollection(id, newName)
  })

  ipcMain.handle('kindle:delete-collection', async (_, id: string) => {
    deleteCollection(id)
  })

  ipcMain.handle(
    'kindle:add-book-to-collection',
    async (_, collectionId: string, bookRelpath: string) => {
      addBookToCollection(collectionId, bookRelpath)
    }
  )

  ipcMain.handle(
    'kindle:remove-book-from-collection',
    async (_, collectionId: string, bookRelpath: string) => {
      removeBookFromCollection(collectionId, bookRelpath)
    }
  )
}
