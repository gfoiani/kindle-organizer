import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './components/Sidebar'
import { BooksGrid } from './components/BooksGrid'
import { Settings } from './components/Settings'
import { About } from './components/About'
import type { KindleDrive, KindleBook, Collection } from '../../preload/api'

export function App() {
  const { t } = useTranslation()
  const [kindle, setKindle] = useState<KindleDrive | null>(null)
  const [books, setBooks] = useState<KindleBook[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [collectionBookPaths, setCollectionBookPaths] = useState<Set<string>>(new Set())
  const [isLoadingDrive, setIsLoadingDrive] = useState(true)
  const [isLoadingBooks, setIsLoadingBooks] = useState(false)
  const [isLoadingCollections, setIsLoadingCollections] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<'success' | 'error' | null>(null)
  const [isShowingSettings, setIsShowingSettings] = useState(false)
  const [isShowingAbout, setIsShowingAbout] = useState(false)

  const loadBooks = async (mountpoint: string) => {
    setIsLoadingBooks(true)
    try {
      const result = await window.kindleAPI.readDocuments(mountpoint)
      setBooks(result)
    } catch (err) {
      console.error('Failed to read documents:', err)
      setBooks([])
    } finally {
      setIsLoadingBooks(false)
    }
  }

  const loadCollections = async (mountpoint: string) => {
    setIsLoadingCollections(true)
    try {
      await window.kindleAPI.syncCalibre(mountpoint)
      const result = await window.kindleAPI.getLocalCollections()
      setCollections(result)
    } catch (err) {
      console.error('Failed to load collections:', err)
      setCollections([])
    } finally {
      setIsLoadingCollections(false)
    }
  }

  const reloadCollections = async () => {
    try {
      const result = await window.kindleAPI.getLocalCollections()
      setCollections(result)
    } catch (err) {
      console.error('Failed to reload collections:', err)
    }
  }

  const loadKindle = useCallback(async () => {
    setIsLoadingDrive(true)
    try {
      const drives = await window.kindleAPI.detectKindleDrives()
      const found = drives[0] ?? null
      setKindle(found)
      setSelectedCollectionId(null)
      setCollectionBookPaths(new Set())

      if (found) {
        await Promise.all([loadBooks(found.mountpoint), loadCollections(found.mountpoint)])
      } else {
        setBooks([])
        setCollections([])
      }
    } catch (err) {
      console.error('Failed to detect Kindle drives:', err)
    } finally {
      setIsLoadingDrive(false)
    }
  }, [])

  useEffect(() => {
    loadKindle()
  }, [loadKindle])

  useEffect(() => {
    window.kindleAPI.onShowAbout(() => {
      setIsShowingAbout(true)
      setIsShowingSettings(false)
      setSelectedCollectionId(null)
    })
  }, [])

  useEffect(() => {
    if (selectedCollectionId === null) {
      setCollectionBookPaths(new Set())
      return
    }

    window.kindleAPI
      .getCollectionBooks(selectedCollectionId)
      .then((paths) => setCollectionBookPaths(new Set(paths)))
      .catch((err) => {
        console.error('Failed to load collection books:', err)
        setCollectionBookPaths(new Set())
      })
  }, [selectedCollectionId])

  async function handleCreateCollection(name: string) {
    await window.kindleAPI.createCollection(name)
    await reloadCollections()
  }

  async function handleRenameCollection(id: string, newName: string) {
    await window.kindleAPI.renameCollection(id, newName)
    await reloadCollections()
  }

  async function handleDeleteCollection(id: string) {
    await window.kindleAPI.deleteCollection(id)
    if (selectedCollectionId === id) {
      setSelectedCollectionId(null)
    }
    await reloadCollections()
  }

  async function handleAddBookToCollection(collectionId: string, bookRelpath: string) {
    await window.kindleAPI.addBookToCollection(collectionId, bookRelpath)
    if (collectionId === selectedCollectionId) {
      setCollectionBookPaths((prev) => new Set([...prev, bookRelpath]))
    }
    await reloadCollections()
  }

  async function handleRemoveBookFromCollection(collectionId: string, bookRelpath: string) {
    await window.kindleAPI.removeBookFromCollection(collectionId, bookRelpath)
    if (collectionId === selectedCollectionId) {
      setCollectionBookPaths((prev) => {
        const next = new Set(prev)
        next.delete(bookRelpath)
        return next
      })
    }
    await reloadCollections()
  }

  async function handleWriteToKindle() {
    if (!kindle) return
    setIsSyncing(true)
    setSyncResult(null)
    try {
      const success = await window.kindleAPI.writeToKindle(kindle.mountpoint)
      setSyncResult(success ? 'success' : 'error')
    } catch {
      setSyncResult('error')
    } finally {
      setIsSyncing(false)
      setTimeout(() => setSyncResult(null), 3000)
    }
  }

  const documentsBase = kindle ? `${kindle.mountpoint}/documents/` : ''

  const filteredBooks =
    selectedCollectionId === null
      ? books
      : books.filter((book) => {
          const relPath = book.path.startsWith(documentsBase)
            ? book.path.slice(documentsBase.length)
            : book.path
          return collectionBookPaths.has(relPath)
        })

  return (
    <div className="flex h-screen bg-gray-900 text-white overflow-hidden">
      <Sidebar
        collections={collections}
        selectedCollectionId={selectedCollectionId}
        onSelectCollection={(id) => {
          setSelectedCollectionId(id)
          setIsShowingSettings(false)
          setIsShowingAbout(false)
        }}
        isLoading={isLoadingCollections}
        onCreateCollection={handleCreateCollection}
        onRenameCollection={handleRenameCollection}
        onDeleteCollection={handleDeleteCollection}
        onSelectSettings={() => {
          setIsShowingSettings(true)
          setIsShowingAbout(false)
          setSelectedCollectionId(null)
        }}
        onSelectAbout={() => {
          setIsShowingAbout(true)
          setIsShowingSettings(false)
          setSelectedCollectionId(null)
        }}
      />

      <main className="flex-1 flex flex-col min-w-0">
        {isShowingSettings ? (
          <Settings />
        ) : isShowingAbout ? (
          <About />
        ) : (
          <>
            <header className="flex items-center justify-between px-6 py-4 border-b border-gray-700 shrink-0">
              <div>
                <h2 className="text-white font-semibold">
                  {selectedCollectionId
                    ? collections.find((c) => c.id === selectedCollectionId)?.name ?? t('header.collection')
                    : t('sidebar.allBooks')}
                </h2>
                {kindle && (
                  <p className="text-gray-500 text-xs mt-0.5">
                    {kindle.description} — {kindle.mountpoint}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                {kindle && (
                  <button
                    onClick={handleWriteToKindle}
                    disabled={isSyncing}
                    title={t('header.writeToKindle')}
                    className={`flex items-center gap-2 px-3 py-1.5 border rounded-md text-sm transition-colors disabled:opacity-50 ${
                      syncResult === 'success'
                        ? 'bg-green-800 border-green-600 text-green-200'
                        : syncResult === 'error'
                          ? 'bg-red-900 border-red-700 text-red-300'
                          : 'bg-gray-800 hover:bg-gray-700 border-gray-600 text-gray-300'
                    }`}
                  >
                    {isSyncing ? (
                      <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    ) : syncResult === 'success' ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : syncResult === 'error' ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                    )}
                    {syncResult === 'success'
                      ? t('header.saved')
                      : syncResult === 'error'
                        ? t('header.error')
                        : t('header.writeKindle')}
                  </button>
                )}

                <button
                  onClick={loadKindle}
                  disabled={isLoadingDrive}
                  className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded-md text-sm text-gray-300 transition-colors disabled:opacity-50"
                >
                  <svg
                    className={`w-3.5 h-3.5 ${isLoadingDrive ? 'animate-spin' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  {t('header.refresh')}
                </button>
              </div>
            </header>

            <BooksGrid
              books={filteredBooks}
              isLoading={isLoadingBooks}
              kindleConnected={kindle !== null}
              collections={collections}
              documentsBase={documentsBase}
              onAddBookToCollection={handleAddBookToCollection}
              onRemoveBookFromCollection={handleRemoveBookFromCollection}
            />
          </>
        )}
      </main>
    </div>
  )
}
