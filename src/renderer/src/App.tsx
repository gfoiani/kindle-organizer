import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './components/Sidebar'
import { BooksGrid } from './components/BooksGrid'
import { Settings } from './components/Settings'
import { About } from './components/About'
import { AutoClassifyModal } from './components/AutoClassifyModal'
import { useClassifier, type ClassifyResult } from './hooks/useClassifier'
import { STATUS_RESET_MS } from './utils/constants'
import { toBookRelpath } from './utils/relpath'
import type { KindleDrive, KindleBook, Collection } from '../../preload/api'

export function App() {
  const { t, i18n } = useTranslation()
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
  const [isAIModalOpen, setIsAIModalOpen] = useState(false)

  // Lifted so the classifier worker (and its loaded model) persists across
  // modal open/close instead of being recreated every time the modal mounts.
  const classifier = useClassifier()

  // Monotonic request id: rapid plug/unplug/Refresh can fire overlapping
  // loadKindle() calls. Each call captures the id at start and re-checks it
  // before every setState so only the most-recent load wins (stale ones no-op).
  const loadRequestId = useRef(0)

  const loadBooks = async (mountpoint: string, requestId: number) => {
    setIsLoadingBooks(true)
    try {
      const result = await window.kindleAPI.readDocuments(mountpoint)
      if (loadRequestId.current === requestId) setBooks(result)
    } catch (err) {
      console.error('Failed to read documents:', err)
      if (loadRequestId.current === requestId) setBooks([])
    } finally {
      if (loadRequestId.current === requestId) setIsLoadingBooks(false)
    }
  }

  const loadCollections = async (mountpoint: string, requestId: number) => {
    setIsLoadingCollections(true)
    try {
      await window.kindleAPI.syncCalibre(mountpoint)
      const result = await window.kindleAPI.getLocalCollections()
      if (loadRequestId.current === requestId) setCollections(result)
    } catch (err) {
      console.error('Failed to load collections:', err)
      if (loadRequestId.current === requestId) setCollections([])
    } finally {
      if (loadRequestId.current === requestId) setIsLoadingCollections(false)
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
    const requestId = ++loadRequestId.current
    setIsLoadingDrive(true)
    try {
      const drives = await window.kindleAPI.detectKindleDrives()
      if (loadRequestId.current !== requestId) return
      const found = drives[0] ?? null
      setKindle(found)
      setSelectedCollectionId(null)
      setCollectionBookPaths(new Set())

      if (found) {
        await Promise.all([
          loadBooks(found.mountpoint, requestId),
          loadCollections(found.mountpoint, requestId)
        ])
      } else {
        setBooks([])
        setCollections([])
      }
    } catch (err) {
      console.error('Failed to detect Kindle drives:', err)
    } finally {
      if (loadRequestId.current === requestId) setIsLoadingDrive(false)
    }
  }, [])

  useEffect(() => {
    loadKindle()
  }, [loadKindle])

  // Keep the main process's cover storefront aligned with the UI language and
  // localize the native menu's custom items on every language change.
  useEffect(() => {
    const syncLocale = (lng: string) => {
      window.kindleAPI
        .setLocale(lng)
        .catch((err) => console.error('Failed to set main-process locale:', err))
      window.kindleAPI
        .setMenuLabels(t('menu.about'), t('menu.learnMore'))
        .catch((err) => console.error('Failed to localize native menu:', err))
    }
    syncLocale(i18n.language)
    i18n.on('languageChanged', syncLocale)
    return () => {
      i18n.off('languageChanged', syncLocale)
    }
  }, [i18n, t])

  useEffect(() => {
    const unsubShowAbout = window.kindleAPI.onShowAbout(() => {
      setIsShowingAbout(true)
      setIsShowingSettings(false)
      setSelectedCollectionId(null)
    })
    return () => unsubShowAbout()
  }, [])

  // Auto-detect Kindle connect/disconnect while the app is running
  useEffect(() => {
    const unsubConnect = window.kindleAPI.onKindleConnected(() => {
      loadKindle()
    })
    const unsubDisconnect = window.kindleAPI.onKindleDisconnected(() => {
      loadKindle()
    })
    return () => {
      unsubConnect()
      unsubDisconnect()
    }
  }, [loadKindle])

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
    try {
      await window.kindleAPI.createCollection(name)
    } catch (err) {
      console.error('Failed to create collection:', err)
    }
    await reloadCollections()
  }

  async function handleRenameCollection(id: string, newName: string) {
    try {
      await window.kindleAPI.renameCollection(id, newName)
    } catch (err) {
      console.error('Failed to rename collection:', err)
    }
    await reloadCollections()
  }

  async function handleDeleteCollection(id: string) {
    try {
      await window.kindleAPI.deleteCollection(id)
    } catch (err) {
      console.error('Failed to delete collection:', err)
    }
    if (selectedCollectionId === id) {
      setSelectedCollectionId(null)
    }
    await reloadCollections()
  }

  async function handleAddBookToCollection(collectionId: string, bookRelpath: string) {
    try {
      await window.kindleAPI.addBookToCollection(collectionId, bookRelpath)
      if (collectionId === selectedCollectionId) {
        setCollectionBookPaths((prev) => new Set([...prev, bookRelpath]))
      }
    } catch (err) {
      console.error('Failed to add book to collection:', err)
    }
    await reloadCollections()
  }

  async function handleRemoveBookFromCollection(collectionId: string, bookRelpath: string) {
    try {
      await window.kindleAPI.removeBookFromCollection(collectionId, bookRelpath)
      if (collectionId === selectedCollectionId) {
        setCollectionBookPaths((prev) => {
          const next = new Set(prev)
          next.delete(bookRelpath)
          return next
        })
      }
    } catch (err) {
      console.error('Failed to remove book from collection:', err)
    }
    await reloadCollections()
  }

  function handleBookUpdated(updatedBook: KindleBook) {
    setBooks((prev) => prev.map((b) => b.path === updatedBook.path ? updatedBook : b))
  }

  async function handleWriteToKindle() {
    if (!kindle) return
    setIsSyncing(true)
    setSyncResult(null)
    try {
      const success = await window.kindleAPI.writeToKindle(kindle.mountpoint)
      setSyncResult(success ? 'success' : 'error')
    } catch (err) {
      console.error('Failed to write collections to Kindle:', err)
      setSyncResult('error')
    } finally {
      setIsSyncing(false)
      setTimeout(() => setSyncResult(null), STATUS_RESET_MS)
    }
  }

  async function handleApplySuggestions(
    suggestions: ClassifyResult[],
    threshold: number,
    deleteExisting: boolean
  ) {
    const filtered = suggestions.filter((s) => s.score * 100 >= threshold)
    if (filtered.length === 0) return

    try {
      // Optionally wipe existing collections before creating new ones. Skip
      // Calibre-sourced collections: the next sync resurrects them anyway, so
      // deleting them here just churns state and risks half-applied wipes.
      if (deleteExisting) {
        for (const col of collections.filter((c) => c.source !== 'calibre')) {
          await window.kindleAPI.deleteCollection(col.id)
        }
      }

      // Collect labels that don't already have a matching collection.
      const uniqueLabels = [...new Set(filtered.map((s) => s.label))]
      const survivingCollections = deleteExisting
        ? collections.filter((c) => c.source === 'calibre')
        : collections
      let currentCollections = [...survivingCollections]

      for (const label of uniqueLabels) {
        if (!currentCollections.some((c) => c.name === label)) {
          const created = await window.kindleAPI.createCollection(label)
          currentCollections = [...currentCollections, created]
        }
      }

      for (const suggestion of filtered) {
        const collection = currentCollections.find((c) => c.name === suggestion.label)
        if (!collection) continue
        const relpath = toBookRelpath(suggestion.book.path, documentsBase)
        await window.kindleAPI.addBookToCollection(collection.id, relpath)
      }

      await reloadCollections()
      setIsAIModalOpen(false)
    } catch (err) {
      console.error('Failed to apply AI suggestions:', err)
      // Re-throw so the modal can surface the failure to the user.
      throw err
    }
  }

  const documentsBase = kindle ? `${kindle.mountpoint}/documents/` : ''

  const filteredBooks =
    selectedCollectionId === null
      ? books
      : books.filter((book) => collectionBookPaths.has(toBookRelpath(book.path, documentsBase)))

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
        booksCount={books.length}
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
        onAIOrganize={() => setIsAIModalOpen(true)}
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
                    aria-label={t('header.writeToKindle')}
                    className={`flex items-center gap-2 px-3 py-1.5 border rounded-md text-sm transition-colors disabled:opacity-50 ${
                      syncResult === 'success'
                        ? 'bg-green-800 border-green-600 text-green-200'
                        : syncResult === 'error'
                          ? 'bg-red-900 border-red-700 text-red-300'
                          : 'bg-gray-800 hover:bg-gray-700 border-gray-600 text-gray-300'
                    }`}
                  >
                    {isSyncing ? (
                      <svg aria-hidden="true" className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    ) : syncResult === 'success' ? (
                      <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : syncResult === 'error' ? (
                      <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    ) : (
                      <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                  aria-label={t('header.refresh')}
                  className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded-md text-sm text-gray-300 transition-colors disabled:opacity-50"
                >
                  <svg
                    aria-hidden="true"
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

            {/* Visually-hidden live region announces the write-to-Kindle result. */}
            <div role="status" aria-live="polite" className="sr-only">
              {syncResult === 'success'
                ? t('header.saved')
                : syncResult === 'error'
                  ? t('header.error')
                  : ''}
            </div>

            <BooksGrid
              books={filteredBooks}
              isLoading={isLoadingBooks}
              kindleConnected={kindle !== null}
              collections={collections}
              documentsBase={documentsBase}
              onAddBookToCollection={handleAddBookToCollection}
              onRemoveBookFromCollection={handleRemoveBookFromCollection}
              onBookUpdated={handleBookUpdated}
            />
          </>
        )}
      </main>
      {isAIModalOpen && (
        <AutoClassifyModal
          books={books}
          collections={collections}
          classifier={classifier}
          onApply={handleApplySuggestions}
          onClose={() => setIsAIModalOpen(false)}
        />
      )}
    </div>
  )
}
