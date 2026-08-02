import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { BooksGrid } from './components/BooksGrid'
import { Settings } from './components/Settings'
import { About } from './components/About'
import { AutoClassifyModal } from './components/AutoClassifyModal'
import { Toast } from './components/Toast'
import { useClassifier, type ClassifyResult } from './hooks/useClassifier'
import { useNotice } from './hooks/useNotice'
import { STATUS_RESET_MS } from './utils/constants'
import { toBookRelpath } from './utils/relpath'
import { mergeBooks } from './utils/mergeBooks'
import { selectLoadingPhase } from './utils/loadingPhase'
import { isPresenceFiltered, type PresenceFilter } from './utils/presenceFilter'
import { errorMessageKey } from './utils/appError'
import {
  buildAuthorSubcollections,
  isSubCollection,
  parseCollectionName,
  formatAuthorCollectionName,
  sanitizeNamePart,
  normalizeKey,
  type AuthoredBook,
  type CollectionMembership
} from './utils/collectionHierarchy'
import type { KindleDrive, KindleBook, Collection, LibraryBook } from '../../preload/api'

/** How long the drag-and-drop add summary toast stays up (ms). */
const DROP_SUMMARY_RESET_MS = 6000

/** Outcome of a guarded IPC mutation — `value` is only present on success. */
type RunOutcome<T> = { ok: true; value: T } | { ok: false }

export function App() {
  const { t, i18n } = useTranslation()
  const [kindle, setKindle] = useState<KindleDrive | null>(null)
  const [books, setBooks] = useState<KindleBook[]>([])
  const [libraryBooks, setLibraryBooks] = useState<LibraryBook[]>([])
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [collections, setCollections] = useState<Collection[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [collectionBookPaths, setCollectionBookPaths] = useState<Set<string>>(new Set())
  // The grid's search box and presence chips live here, next to the collection
  // filter: all three narrow the same list, so "All books" can lift all three at
  // once and the sidebar can highlight itself while any of them is on.
  const [query, setQuery] = useState('')
  const [presence, setPresence] = useState<PresenceFilter>({
    showOnDevice: false,
    showLibraryOnly: false
  })
  const [isLoadingDrive, setIsLoadingDrive] = useState(true)
  // Whether the first detect+scan cycle has finished. Gates the grid's initial
  // render (see utils/loadingPhase) and never goes back to false, so later
  // refreshes revalidate in place instead of blanking the list.
  const [hasResolvedDevice, setHasResolvedDevice] = useState(false)
  const [isLoadingBooks, setIsLoadingBooks] = useState(false)
  const [isLoadingCollections, setIsLoadingCollections] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isEjecting, setIsEjecting] = useState(false)
  const [syncResult, setSyncResult] = useState<'success' | 'error' | null>(null)
  const [isShowingSettings, setIsShowingSettings] = useState(false)
  const [isShowingAbout, setIsShowingAbout] = useState(false)
  const [isAIModalOpen, setIsAIModalOpen] = useState(false)
  const [isGroupingByAuthor, setIsGroupingByAuthor] = useState(false)

  // Lifted so the classifier worker (and its loaded model) persists across
  // modal open/close instead of being recreated every time the modal mounts.
  const classifier = useClassifier()

  const { notice, showInfo, showError, clear: clearNotice } = useNotice()

  // `t` gets a new identity on every language change. The loaders below are
  // memoized with stable deps (loadKindle MUST be stable — two effects depend on
  // it), so translation is read through a ref instead of a dependency.
  const tRef = useRef(t)
  tRef.current = t

  /**
   * Turns a rejected IPC call into a visible message. Every one of these used to
   * end at `console.error`, which is invisible in a packaged app — a duplicate
   * collection name just looked like nothing had happened. The raw error is
   * still logged for diagnosis; `fallbackKey` describes the operation and is
   * used unless the main process supplied a specific code (see utils/appError).
   */
  const reportError = useCallback(
    (err: unknown, fallbackKey: string): void => {
      console.error(`[${fallbackKey}]`, err)
      showError(tRef.current(errorMessageKey(err, fallbackKey)))
    },
    [showError]
  )

  /** Runs an IPC mutation, reporting any failure and telling the caller if it succeeded. */
  const run = useCallback(
    async <T,>(fallbackKey: string, action: () => Promise<T>): Promise<RunOutcome<T>> => {
      try {
        return { ok: true, value: await action() }
      } catch (err) {
        reportError(err, fallbackKey)
        return { ok: false }
      }
    },
    [reportError]
  )

  // Monotonic request id: rapid plug/unplug/Refresh can fire overlapping
  // loadKindle() calls. Each call captures the id at start and re-checks it
  // before every setState so only the most-recent load wins (stale ones no-op).
  const loadRequestId = useRef(0)

  const loadBooks = useCallback(
    async (mountpoint: string, requestId: number) => {
      setIsLoadingBooks(true)
      try {
        const result = await window.kindleAPI.readDocuments(mountpoint)
        if (loadRequestId.current === requestId) setBooks(result)
      } catch (err) {
        if (loadRequestId.current === requestId) {
          setBooks([])
          reportError(err, 'errors.loadBooks')
        }
      } finally {
        if (loadRequestId.current === requestId) setIsLoadingBooks(false)
      }
    },
    [reportError]
  )

  const loadCollections = useCallback(
    async (mountpoint: string, requestId: number) => {
      setIsLoadingCollections(true)
      try {
        await window.kindleAPI.syncCalibre(mountpoint)
        const result = await window.kindleAPI.getLocalCollections()
        if (loadRequestId.current === requestId) setCollections(result)
      } catch (err) {
        if (loadRequestId.current === requestId) {
          setCollections([])
          reportError(err, 'errors.loadCollections')
        }
      } finally {
        if (loadRequestId.current === requestId) setIsLoadingCollections(false)
      }
    },
    [reportError]
  )

  const reloadCollections = useCallback(async () => {
    try {
      setCollections(await window.kindleAPI.getLocalCollections())
    } catch (err) {
      reportError(err, 'errors.loadCollections')
    }
  }, [reportError])

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
      reportError(err, 'errors.detectDrives')
    } finally {
      // Resolved either way — a failed detection is still an answer, and the
      // grid must not stay stuck behind the loading gate because of it.
      if (loadRequestId.current === requestId) {
        setIsLoadingDrive(false)
        setHasResolvedDevice(true)
      }
    }
  }, [loadBooks, loadCollections, reportError])

  const loadLibrary = useCallback(async () => {
    try {
      setLibraryBooks(await window.kindleAPI.getLibrary())
    } catch (err) {
      reportError(err, 'errors.loadLibrary')
    }
  }, [reportError])

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

        const counts = {
          added: results.filter((r) => r.status === 'added').length,
          duplicate: results.filter((r) => r.status === 'duplicate').length,
          unsupported: results.filter((r) => r.status === 'unsupported').length,
          error: results.filter((r) => r.status === 'error').length
        }
        const summary = [
          counts.added > 0 ? t('library.added', { count: counts.added }) : null,
          counts.duplicate > 0 ? t('library.duplicate', { count: counts.duplicate }) : null,
          counts.unsupported > 0 ? t('library.unsupported', { count: counts.unsupported }) : null,
          counts.error > 0 ? t('library.addError', { count: counts.error }) : null
        ]
          .filter(Boolean)
          .join(', ')
        if (!summary) return

        // A rejected or unreadable file is a failure, not a confirmation.
        const hasFailures = counts.unsupported + counts.error > 0
        if (hasFailures) showError(summary, DROP_SUMMARY_RESET_MS)
        else showInfo(summary, DROP_SUMMARY_RESET_MS)
      } catch (err) {
        reportError(err, 'errors.addBooks')
      }
    },
    [loadLibrary, reportError, showError, showInfo, t]
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
        reportError(err, 'errors.loadCollections')
        setCollectionBookPaths(new Set())
      })
  }, [selectedCollectionId, reportError])

  async function handleCreateCollection(name: string) {
    const result = await run('errors.createCollection', () =>
      window.kindleAPI.createCollection(name)
    )
    if (result.ok) await reloadCollections()
  }

  async function handleRenameCollection(id: string, newName: string) {
    const result = await run('errors.renameCollection', () =>
      window.kindleAPI.renameCollections([{ id, newName }])
    )
    if (result.ok) setCollections(result.value)
  }

  async function handleDeleteCollection(id: string) {
    // The batch endpoint returns the refreshed list, so no follow-up read.
    const result = await run('errors.deleteCollection', () =>
      window.kindleAPI.deleteCollections([id])
    )
    if (!result.ok) return
    if (selectedCollectionId === id) setSelectedCollectionId(null)
    setCollections(result.value)
  }

  async function handleAddBookToCollection(collectionId: string, bookRelpath: string) {
    const result = await run('errors.addToCollection', () =>
      window.kindleAPI.addBookToCollection(collectionId, bookRelpath)
    )
    // Only reflect the membership once it actually landed — the optimistic
    // update used to stick even when the write had failed.
    if (!result.ok) return
    if (collectionId === selectedCollectionId) {
      setCollectionBookPaths((prev) => new Set([...prev, bookRelpath]))
    }
    await reloadCollections()
  }

  async function handleRemoveBookFromCollection(collectionId: string, bookRelpath: string) {
    const result = await run('errors.removeFromCollection', () =>
      window.kindleAPI.removeBookFromCollection(collectionId, bookRelpath)
    )
    if (!result.ok) return
    if (collectionId === selectedCollectionId) {
      setCollectionBookPaths((prev) => {
        const next = new Set(prev)
        next.delete(bookRelpath)
        return next
      })
    }
    await reloadCollections()
  }

  function handleBookUpdated(updatedBook: KindleBook) {
    setBooks((prev) => prev.map((b) => b.path === updatedBook.path ? updatedBook : b))
  }

  // After a send/remove, rescan the library and (if connected) the device so the
  // presence badges reconcile — a sent book flips from amber to green.
  async function handleLibraryChanged() {
    await loadLibrary()
    if (kindle) {
      const requestId = ++loadRequestId.current
      await loadBooks(kindle.mountpoint, requestId)
    }
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

  /**
   * Ejects the device. No optimistic clearing of `kindle`: the watcher's
   * disconnect push is what removes it, so a failed eject leaves the UI honest
   * about the device still being mounted.
   */
  async function handleEject() {
    if (!kindle) return
    setIsEjecting(true)
    try {
      await window.kindleAPI.ejectKindle(kindle.mountpoint)
      showInfo(t('header.ejected'))
    } catch (err) {
      console.error('Failed to eject the Kindle:', err)
      showError(t(errorMessageKey(err, 'errors.ejectFailed')))
    } finally {
      setIsEjecting(false)
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
      // deleting them here just churns state. One transactional call, so this
      // can no longer half-wipe the list part-way through.
      if (deleteExisting) {
        const ids = collections.filter((c) => c.source !== 'calibre').map((c) => c.id)
        if (ids.length > 0) await window.kindleAPI.deleteCollections(ids)
      }

      // Group the accepted suggestions by label, then hand every genre AND every
      // author sub-collection to the idempotent batch writer in ONE call. This
      // used to be a create-per-label plus an addBookToCollection PER BOOK, i.e.
      // one IPC round-trip and one SQLite transaction per suggestion.
      const byGenre = new Map<string, string[]>()
      for (const suggestion of filtered) {
        const relpath = toBookRelpath(suggestion.book.path, documentsBase)
        byGenre.set(suggestion.label, [...(byGenre.get(suggestion.label) ?? []), relpath])
      }
      const genreEntries: CollectionMembership[] = [...byGenre].map(([name, relpaths]) => ({
        name,
        relpaths
      }))

      // Author sub-collections (e.g. "Thriller / Glenn Cooper") for the genres
      // that have 2+ distinct authors.
      const authorEntries = groupByAuthor
        ? buildAuthorSubcollections(
            filtered.map((s) => ({
              genre: s.label,
              author: s.book.author,
              relpath: toBookRelpath(s.book.path, documentsBase)
            }))
          )
        : []

      const next = await window.kindleAPI.ensureCollectionsContain([
        ...genreEntries,
        ...authorEntries
      ])
      setCollections(next)
      // A wipe can delete the collection currently being viewed.
      setSelectedCollectionId((prev) => (prev && next.some((c) => c.id === prev) ? prev : null))
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
        setCollections(await window.kindleAPI.ensureCollectionsContain(payload))
      }
    } catch (err) {
      reportError(err, 'errors.groupByAuthor')
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

  // Delete a genre and every author sub-collection under it, in one transaction.
  async function handleDeleteGenre(genreName: string) {
    const toDelete = collectionsInGenre(genreName)
    if (toDelete.length === 0) return

    const result = await run('errors.deleteGenre', () =>
      window.kindleAPI.deleteCollections(toDelete.map((c) => c.id))
    )
    if (!result.ok) return
    if (toDelete.some((c) => c.id === selectedCollectionId)) setSelectedCollectionId(null)
    setCollections(result.value)
  }

  // Rename a genre and re-prefix its author sub-collections. The whole tree goes
  // in a single transaction: a name collision rolls every rename back (and is
  // reported), instead of the old per-item loop that could stop half-way — so
  // the renderer no longer needs its own pre-check against possibly-stale state.
  async function handleRenameGenre(genreName: string, rawNewName: string) {
    const newGenre = sanitizeNamePart(rawNewName)
    if (!newGenre || normalizeKey(newGenre) === normalizeKey(genreName)) return

    const targets = collectionsInGenre(genreName)
      .map((c) => {
        const parsed = parseCollectionName(c.name)
        return {
          id: c.id,
          newName:
            parsed.author === undefined
              ? newGenre
              : formatAuthorCollectionName(newGenre, parsed.author)
        }
      })
      .filter((target) => target.newName !== '')

    if (targets.length === 0) return

    const result = await run('errors.renameGenre', () =>
      window.kindleAPI.renameCollections(targets)
    )
    if (result.ok) setCollections(result.value)
  }

  const documentsBase = kindle ? `${kindle.mountpoint}/documents/` : ''

  // The base list the grid renders: device books + staging library, reconciled
  // so a book that's both on-device and in the library shows as a single card.
  const displayBooks = useMemo(
    () => mergeBooks(books, libraryBooks, documentsBase),
    [books, libraryBooks, documentsBase]
  )

  // The library reads from local SQLite in milliseconds while the device takes
  // seconds, so the grid waits for the first device answer before painting
  // anything — otherwise an already-uploaded book flashes as "library only"
  // and then reconciles away. Later refreshes never block.
  const loadingPhase = selectLoadingPhase({
    hasResolvedDevice,
    isDetectingDrive: isLoadingDrive,
    isReadingBooks: isLoadingBooks
  })

  // Any device reload in flight — drives the Refresh button's spinner, which is
  // the only progress cue left once the grid stops blanking itself.
  const isRefreshingDevice = isLoadingDrive || isLoadingBooks

  const filteredBooks =
    selectedCollectionId === null
      ? displayBooks
      : displayBooks.filter((book) =>
          collectionBookPaths.has(toBookRelpath(book.path, documentsBase))
        )

  // Drives the sidebar's "All books" entry: while anything is narrowing the list
  // it stops looking like the current view and becomes the way back out.
  const hasActiveFilters =
    selectedCollectionId !== null || query.trim() !== '' || isPresenceFiltered(presence)

  /** The one place that lifts every filter at once. */
  const handleShowAllBooks = useCallback(() => {
    setSelectedCollectionId(null)
    setQuery('')
    setPresence({ showOnDevice: false, showLibraryOnly: false })
    setIsShowingSettings(false)
    setIsShowingAbout(false)
  }, [])

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
          isLoading={isLoadingCollections}
          booksCount={books.length}
          allBooksCount={displayBooks.length}
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

                  {kindle && (
                    <button
                      onClick={handleEject}
                      disabled={isEjecting || isSyncing}
                      title={t('header.ejectHint')}
                      aria-label={t('header.eject')}
                      className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded-md text-sm text-gray-300 transition-colors disabled:opacity-50"
                    >
                      {isEjecting ? (
                        <svg aria-hidden="true" className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      ) : (
                        // The standard eject glyph: triangle over a bar.
                        <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l7-7 7 7H5zM5 18h14" />
                        </svg>
                      )}
                      {isEjecting ? t('header.ejecting') : t('header.eject')}
                    </button>
                  )}

                  <button
                    onClick={loadKindle}
                    disabled={isRefreshingDevice}
                    aria-label={t('header.refresh')}
                    className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded-md text-sm text-gray-300 transition-colors disabled:opacity-50"
                  >
                    <svg
                      aria-hidden="true"
                      className={`w-3.5 h-3.5 ${isRefreshingDevice ? 'animate-spin' : ''}`}
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
                loadingPhase={loadingPhase}
                kindleConnected={kindle !== null}
                mountpoint={kindle?.mountpoint ?? null}
                collections={collections}
                documentsBase={documentsBase}
                query={query}
                onQueryChange={setQuery}
                presence={presence}
                onPresenceChange={setPresence}
                onAddBookToCollection={handleAddBookToCollection}
                onRemoveBookFromCollection={handleRemoveBookFromCollection}
                onBookUpdated={handleBookUpdated}
                onLibraryChanged={handleLibraryChanged}
                onCollectionsChanged={setCollections}
                onNotify={(kind, message) =>
                  kind === 'error' ? showError(message) : showInfo(message)
                }
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

      <Toast notice={notice} onDismiss={clearNotice} />
    </div>
  )
}
