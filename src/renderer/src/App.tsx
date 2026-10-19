import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { BooksGrid } from './components/BooksGrid'
import { Settings } from './components/Settings'
import { About } from './components/About'
import { AppHeader } from './components/AppHeader'
import { AutoClassifyModal } from './components/AutoClassifyModal'
import { DropOverlay } from './components/DropOverlay'
import { Toast } from './components/Toast'
import { useClassifier, type ClassifyResult } from './hooks/useClassifier'
import { useNotice } from './hooks/useNotice'
import { useReportedRun } from './hooks/useReportedRun'
import { useCollectionView } from './hooks/useCollectionView'
import { useKindleDevice } from './hooks/useKindleDevice'
import { useLibraryBooks } from './hooks/useLibraryBooks'
import { useFileDrop } from './hooks/useFileDrop'
import { useCollectionActions } from './hooks/useCollectionActions'
import { useDeviceActions } from './hooks/useDeviceActions'
import { useLibraryFolderSync } from './hooks/useLibraryFolderSync'
import { toBookRelpath } from './utils/relpath'
import { mergeBooks } from './utils/mergeBooks'
import { selectLoadingPhase } from './utils/loadingPhase'
import { isPresenceFiltered, type PresenceFilter } from './utils/presenceFilter'
import type { AvailableUpdate, KindleBook } from '../../preload/api'

const NO_PRESENCE_FILTER: PresenceFilter = { showOnDevice: false, showLibraryOnly: false }

export function App() {
  const { t, i18n } = useTranslation()
  // The grid's search box and presence chips live here, next to the collection
  // filter: all three narrow the same list, so "All books" can lift all three at
  // once and the sidebar can highlight itself while any of them is on.
  const [query, setQuery] = useState('')
  const [presence, setPresence] = useState<PresenceFilter>(NO_PRESENCE_FILTER)
  const [isShowingSettings, setIsShowingSettings] = useState(false)
  const [isShowingAbout, setIsShowingAbout] = useState(false)
  const [isAIModalOpen, setIsAIModalOpen] = useState(false)
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null)

  // Lifted so the classifier worker (and its loaded model) persists across
  // modal open/close instead of being recreated every time the modal mounts.
  const classifier = useClassifier()

  const { notice, showInfo, showError, clear: clearNotice } = useNotice()
  const { reportError, run } = useReportedRun(showError)
  const view = useCollectionView(reportError)
  const { selectedCollectionId, setSelectedCollectionId, collectionBookPaths } = view
  const device = useKindleDevice(reportError, view.resetCollectionView)
  const { kindle, books, setBooks, collections, setCollections, loadKindle, reloadBooks } = device
  const { libraryBooks, loadLibrary, addDroppedFiles } = useLibraryBooks({ reportError, showInfo, showError })
  const actions = useCollectionActions({
    books,
    collections,
    setCollections,
    reloadCollections: device.reloadCollections,
    view,
    run,
    reportError
  })
  const deviceActions = useDeviceActions(kindle, showInfo, showError)
  const isDraggingFiles = useFileDrop(addDroppedFiles)

  useEffect(() => {
    loadKindle()
    loadLibrary()
  }, [loadKindle, loadLibrary])

  useLibraryFolderSync(loadLibrary)

  // Once per launch. The check resolves null on any failure (offline included),
  // so a rejection here can only be the IPC itself.
  useEffect(() => {
    window.kindleAPI
      .checkForUpdate()
      .then(setAvailableUpdate)
      .catch((err) => console.error('[update] Check failed:', err))
  }, [])

  // Keep the main process's cover storefront aligned with the UI language and
  // localize the native menu's custom items on every language change.
  useEffect(() => {
    const syncLocale = (lng: string) => {
      window.kindleAPI.setLocale(lng).catch((err) => console.error('Failed to set main-process locale:', err))
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

  const showAbout = useCallback(() => {
    setIsShowingAbout(true)
    setIsShowingSettings(false)
    setSelectedCollectionId(null)
  }, [setSelectedCollectionId])

  useEffect(() => window.kindleAPI.onShowAbout(showAbout), [showAbout])

  function handleBookUpdated(updatedBook: KindleBook) {
    setBooks((prev) => prev.map((b) => (b.path === updatedBook.path ? updatedBook : b)))
  }

  // After a send/remove, rescan the library and (if connected) the device so the
  // presence badges reconcile — a sent book flips from amber to green.
  async function handleLibraryChanged() {
    await loadLibrary()
    await reloadBooks()
  }

  async function handleApplySuggestions(
    suggestions: ClassifyResult[],
    threshold: number,
    deleteExisting: boolean,
    groupByAuthor: boolean
  ) {
    if (await actions.applySuggestions(suggestions, threshold, deleteExisting, groupByAuthor)) {
      setIsAIModalOpen(false)
    }
  }

  // The base list the grid renders: device books + staging library, reconciled
  // so a book that's both on-device and in the library shows as a single card.
  const displayBooks = useMemo(() => mergeBooks(books, libraryBooks), [books, libraryBooks])

  // The library reads from local SQLite in milliseconds while the device takes
  // seconds, so the grid waits for the first device answer before painting
  // anything — otherwise an already-uploaded book flashes as "library only"
  // and then reconciles away. Later refreshes never block.
  const loadingPhase = selectLoadingPhase({
    hasResolvedDevice: device.hasResolvedDevice,
    isDetectingDrive: device.isLoadingDrive,
    isReadingBooks: device.isLoadingBooks
  })

  const filteredBooks =
    selectedCollectionId === null
      ? displayBooks
      : displayBooks.filter((book) => collectionBookPaths.has(toBookRelpath(book)))

  // Drives the sidebar's "All books" entry: while anything is narrowing the list
  // it stops looking like the current view and becomes the way back out.
  const hasActiveFilters = selectedCollectionId !== null || query.trim() !== '' || isPresenceFiltered(presence)

  /** The one place that lifts every filter at once. */
  const handleShowAllBooks = useCallback(() => {
    setSelectedCollectionId(null)
    setQuery('')
    setPresence(NO_PRESENCE_FILTER)
    setIsShowingSettings(false)
    setIsShowingAbout(false)
  }, [setSelectedCollectionId])

  const headerTitle = selectedCollectionId
    ? (collections.find((c) => c.id === selectedCollectionId)?.name ?? t('header.collection'))
    : t('sidebar.allBooks')

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white overflow-hidden">
      <TitleBar />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          collections={collections}
          selectedCollectionId={selectedCollectionId}
          onSelectCollection={(id) => {
            setSelectedCollectionId(id)
            setIsShowingSettings(false)
            setIsShowingAbout(false)
          }}
          hasActiveFilters={hasActiveFilters}
          onShowAllBooks={handleShowAllBooks}
          isLoading={device.isLoadingCollections}
          booksCount={books.length}
          allBooksCount={displayBooks.length}
          onCreateCollection={actions.createCollection}
          onRenameCollection={actions.renameCollection}
          onDeleteCollection={actions.deleteCollection}
          onRenameGenre={actions.renameGenre}
          onDeleteGenre={actions.deleteGenre}
          onGroupByAuthor={actions.groupByAuthor}
          isGroupingByAuthor={actions.isGroupingByAuthor}
          onSelectSettings={() => {
            setIsShowingSettings(true)
            setIsShowingAbout(false)
            setSelectedCollectionId(null)
          }}
          onSelectAbout={showAbout}
          onAIOrganize={() => setIsAIModalOpen(true)}
          availableUpdate={availableUpdate}
        />

        <main className="flex-1 flex flex-col min-w-0">
          {isShowingSettings ? (
            <Settings mountpoint={kindle?.mountpoint ?? null} onCollectionsRestored={loadKindle} />
          ) : isShowingAbout ? (
            <About />
          ) : (
            <>
              <AppHeader
                title={headerTitle}
                kindle={kindle}
                isRefreshing={device.isLoadingDrive || device.isLoadingBooks}
                onRefresh={loadKindle}
                actions={deviceActions}
              />

              <BooksGrid
                books={filteredBooks}
                loadingPhase={loadingPhase}
                kindleConnected={kindle !== null}
                mountpoint={kindle?.mountpoint ?? null}
                collections={collections}
                query={query}
                onQueryChange={setQuery}
                presence={presence}
                onPresenceChange={setPresence}
                onAddBookToCollection={actions.addBookToCollection}
                onRemoveBookFromCollection={actions.removeBookFromCollection}
                onBookUpdated={handleBookUpdated}
                onLibraryChanged={handleLibraryChanged}
                onCollectionsChanged={setCollections}
                onNotify={(kind, message) => (kind === 'error' ? showError(message) : showInfo(message))}
              />
            </>
          )}
        </main>
      </div>
      {isAIModalOpen && (
        <AutoClassifyModal
          books={books}
          collections={collections}
          classifier={classifier}
          onApply={handleApplySuggestions}
          onClose={() => setIsAIModalOpen(false)}
        />
      )}

      {isDraggingFiles && <DropOverlay />}

      <Toast notice={notice} onDismiss={clearNotice} />
    </div>
  )
}
