import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './components/Sidebar'
import { BooksGrid } from './components/BooksGrid'
import { Settings } from './components/Settings'
import { About } from './components/About'
import { AutoClassifyModal } from './components/AutoClassifyModal'
import { useClassifier, type ClassifyResult } from './hooks/useClassifier'
import { STATUS_RESET_MS } from './utils/constants'
import { toBookRelpath } from './utils/relpath'
import { mergeBooks } from './utils/mergeBooks'
import {
  buildAuthorSubcollections,
  isSubCollection,
  parseCollectionName,
  formatAuthorCollectionName,
  sanitizeNamePart,
  normalizeKey,
  type AuthoredBook
} from './utils/collectionHierarchy'
import type { KindleDrive, KindleBook, Collection, LibraryBook } from '../../preload/api'

/** How long the drag-and-drop add summary toast stays up (ms). */
const DROP_SUMMARY_RESET_MS = 6000

interface DropSummary {
  added: number
  duplicate: number
  unsupported: number
  error: number
}

export function App() {
  const { t, i18n } = useTranslation()
  const [kindle, setKindle] = useState<KindleDrive | null>(null)
  const [books, setBooks] = useState<KindleBook[]>([])
  const [libraryBooks, setLibraryBooks] = useState<LibraryBook[]>([])
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [dropSummary, setDropSummary] = useState<DropSummary | null>(null)
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
  const [isGroupingByAuthor, setIsGroupingByAuthor] = useState(false)

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

  const loadLibrary = useCallback(async () => {
    try {
      const result = await window.kindleAPI.getLibrary()
      setLibraryBooks(result)
    } catch (err) {
      console.error('Failed to load library:', err)
    }
  }, [])

  useEffect(() => {
    loadKindle()
    loadLibrary()
  }, [loadKindle, loadLibrary])

  // Import files dropped anywhere in the window into the staging library, then
  // refresh the library and announce a per-status summary.
  const handleDroppedFiles = useCallback(
    async (files: File[]) => {
      const paths = files
        .map((file) => window.kindleAPI.getPathForFile(file))
        .filter((p) => p.length > 0)
      if (paths.length === 0) return
      try {
        const results = await window.kindleAPI.addBooks(paths)
        await loadLibrary()
        setDropSummary({
          added: results.filter((r) => r.status === 'added').length,
          duplicate: results.filter((r) => r.status === 'duplicate').length,
          unsupported: results.filter((r) => r.status === 'unsupported').length,
          error: results.filter((r) => r.status === 'error').length
        })
        setTimeout(() => setDropSummary(null), DROP_SUMMARY_RESET_MS)
      } catch (err) {
        console.error('Failed to add dropped files:', err)
      }
    },
    [loadLibrary]
  )

  // Window-wide file dropzone. Prevents Chromium from navigating to a dropped
  // file (which would blow away the SPA), shows a translucent overlay while a
  // file drag is in progress (ref-counted across nested dragenter/leave), and
  // routes an actual drop into handleDroppedFiles.
  useEffect(() => {
    let dragDepth = 0
    const hasFiles = (e: DragEvent): boolean =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const onDragEnter = (e: DragEvent): void => {
      e.preventDefault()
      if (!hasFiles(e)) return
      dragDepth += 1
      setIsDraggingFiles(true)
    }
    const onDragOver = (e: DragEvent): void => e.preventDefault()
    const onDragLeave = (e: DragEvent): void => {
      e.preventDefault()
      if (!hasFiles(e)) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) setIsDraggingFiles(false)
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      dragDepth = 0
      setIsDraggingFiles(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) void handleDroppedFiles(Array.from(files))
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [handleDroppedFiles])

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
    deleteExisting: boolean,
    groupByAuthor: boolean
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

      // Optionally materialize author sub-collections (e.g. "Thriller / Glenn Cooper")
      // for genres with 2+ distinct authors. Routed through the idempotent batch
      // writer in one call so concurrent same-name creates can't throw.
      if (groupByAuthor) {
        const payload = buildAuthorSubcollections(
          filtered.map((s) => ({
            genre: s.label,
            author: s.book.author,
            relpath: toBookRelpath(s.book.path, documentsBase)
          }))
        )
        if (payload.length > 0) await window.kindleAPI.ensureCollectionsContain(payload)
      }

      await reloadCollections()
      setIsAIModalOpen(false)
    } catch (err) {
      console.error('Failed to apply AI suggestions:', err)
      // Re-throw so the modal can surface the failure to the user.
      throw err
    }
  }

  // Standalone "group by author": materialize author sub-collections for the
  // genres that already exist (including Calibre-imported ones) without re-running
  // the classifier. Reads current membership once, joins each book's author from
  // state, and lets the idempotent batch writer create the subs.
  async function handleGroupByAuthor() {
    if (collections.length === 0 || books.length === 0) return
    setIsGroupingByAuthor(true)
    try {
      const relpaths = books.map((b) => toBookRelpath(b.path, documentsBase))
      const authorByRelpath = new Map(relpaths.map((rp, i) => [rp, books[i].author]))
      const tagsByRelpath = await window.kindleAPI.getBookTags(relpaths)

      const authored: AuthoredBook[] = []
      for (const [relpath, names] of Object.entries(tagsByRelpath)) {
        const author = authorByRelpath.get(relpath)
        if (!author || !author.trim()) continue
        for (const name of names) {
          if (isSubCollection(name)) continue // only group under top-level genres
          authored.push({ genre: name, author, relpath })
        }
      }

      const payload = buildAuthorSubcollections(authored)
      if (payload.length > 0) {
        await window.kindleAPI.ensureCollectionsContain(payload)
        await reloadCollections()
      }
    } catch (err) {
      console.error('Failed to group by author:', err)
    } finally {
      setIsGroupingByAuthor(false)
    }
  }

  // Collections whose genre matches `genreName` (the bare genre row plus every
  // "<genre> / <author>" child), used for cascade rename/delete.
  function collectionsInGenre(genreName: string): Collection[] {
    const key = normalizeKey(genreName)
    return collections.filter((c) => normalizeKey(parseCollectionName(c.name).genre) === key)
  }

  // Delete a genre and every author sub-collection under it.
  async function handleDeleteGenre(genreName: string) {
    const toDelete = collectionsInGenre(genreName)
    try {
      for (const c of toDelete) await window.kindleAPI.deleteCollection(c.id)
    } catch (err) {
      console.error('Failed to delete genre:', err)
    }
    if (toDelete.some((c) => c.id === selectedCollectionId)) setSelectedCollectionId(null)
    await reloadCollections()
  }

  // Rename a genre and re-prefix its author sub-collections. Pre-checks for name
  // collisions so a mid-loop UNIQUE failure can't leave a half-renamed tree.
  async function handleRenameGenre(genreName: string, rawNewName: string) {
    const newGenre = sanitizeNamePart(rawNewName)
    if (!newGenre || normalizeKey(newGenre) === normalizeKey(genreName)) return

    const affected = collectionsInGenre(genreName)
    const targets = affected.map((c) => {
      const parsed = parseCollectionName(c.name)
      const newName =
        parsed.author === undefined ? newGenre : formatAuthorCollectionName(newGenre, parsed.author)
      return { id: c.id, oldName: c.name, newName }
    })

    const affectedIds = new Set(affected.map((c) => c.id))
    const existingNames = new Set(
      collections.filter((c) => !affectedIds.has(c.id)).map((c) => normalizeKey(c.name))
    )
    const collides = targets.some((tgt) => tgt.newName && existingNames.has(normalizeKey(tgt.newName)))
    if (collides) {
      console.error(`Rename of genre "${genreName}" would collide with an existing collection`)
      return
    }

    try {
      for (const tgt of targets) {
        if (tgt.newName && tgt.newName !== tgt.oldName) {
          await window.kindleAPI.renameCollection(tgt.id, tgt.newName)
        }
      }
    } catch (err) {
      console.error('Failed to rename genre:', err)
    }
    await reloadCollections()
  }

  const documentsBase = kindle ? `${kindle.mountpoint}/documents/` : ''

  // The base list the grid renders: device books + staging library, reconciled
  // so a book that's both on-device and in the library shows as a single card.
  const displayBooks = useMemo(
    () => mergeBooks(books, libraryBooks, documentsBase),
    [books, libraryBooks, documentsBase]
  )

  const filteredBooks =
    selectedCollectionId === null
      ? displayBooks
      : displayBooks.filter((book) =>
          collectionBookPaths.has(toBookRelpath(book.path, documentsBase))
        )

  const dropSummaryText = dropSummary
    ? [
        dropSummary.added > 0 ? t('library.added', { count: dropSummary.added }) : null,
        dropSummary.duplicate > 0 ? t('library.duplicate', { count: dropSummary.duplicate }) : null,
        dropSummary.unsupported > 0
          ? t('library.unsupported', { count: dropSummary.unsupported })
          : null,
        dropSummary.error > 0 ? t('library.addError', { count: dropSummary.error }) : null
      ]
        .filter(Boolean)
        .join(', ')
    : ''

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
        onRenameGenre={handleRenameGenre}
        onDeleteGenre={handleDeleteGenre}
        onGroupByAuthor={handleGroupByAuthor}
        isGroupingByAuthor={isGroupingByAuthor}
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

      {/* Drag-and-drop overlay while a file drag is over the window. */}
      {isDraggingFiles && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-indigo-950/70 backdrop-blur-sm pointer-events-none">
          <div className="border-2 border-dashed border-indigo-400 rounded-2xl px-10 py-8 text-center">
            <svg
              aria-hidden="true"
              className="w-10 h-10 mx-auto mb-3 text-indigo-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <p className="text-indigo-100 text-lg font-medium">{t('library.dropOverlay')}</p>
          </div>
        </div>
      )}

      {/* Visually-hidden live region announces the add-books summary. */}
      <div role="status" aria-live="polite" className="sr-only">
        {dropSummaryText}
      </div>

      {dropSummaryText && (
        <div className="fixed bottom-4 right-4 z-40 bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-sm text-gray-200 shadow-lg max-w-xs">
          {dropSummaryText}
        </div>
      )}
    </div>
  )
}
