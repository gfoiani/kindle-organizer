import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTranslation } from 'react-i18next'
import type { KindleBook, Collection } from '../../../preload/api'
import type { DisplayBook } from '../utils/mergeBooks'
import { BookCard } from './BookCard'
import { BookDetailSidebar } from './BookDetailSidebar'
import { toBookRelpath } from '../utils/relpath'
import { countPresence, filterByPresence } from '../utils/presenceFilter'
import type { LoadingPhase } from '../utils/loadingPhase'
import {
  bookKey,
  collectableBooks,
  removableBooks,
  selectedBooks,
  sendableBooks
} from '../utils/bulkSelection'
import { SelectionToolbar, type BulkProgress } from './SelectionToolbar'
import type { NoticeKind } from '../hooks/useNotice'
import {
  columnsForWidth,
  GRID_GAP_PX,
  GRID_PADDING_PX,
  CARD_INFO_HEIGHT_PX,
  COVER_ASPECT
} from '../utils/gridLayout'

interface BooksGridProps {
  books: DisplayBook[]
  /**
   * Non-null while the device state is still unknown — the grid holds its
   * content back, because presence badges would be wrong until then. Null on
   * every later refresh, so a populated grid is never blanked (see
   * utils/loadingPhase).
   */
  loadingPhase: LoadingPhase | null
  kindleConnected: boolean
  /** Connected device mountpoint, or null when no Kindle is attached. */
  mountpoint: string | null
  collections: Collection[]
  documentsBase: string
  onAddBookToCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onRemoveBookFromCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onBookUpdated: (updatedBook: KindleBook) => void
  /** Rescans device + library after a send/remove so badges reconcile. */
  onLibraryChanged: () => void
  /** Refreshed collection list after a bulk add-to-collection. */
  onCollectionsChanged: (collections: Collection[]) => void
  /** Surfaces a bulk-action outcome through the app-level toast. */
  onNotify: (kind: NoticeKind, message: string) => void
}

interface SelectedBook {
  book: DisplayBook
  cover: string | null
  bookRelpath: string
}

// Layout math (column count + row height) lives in utils/gridLayout so it stays
// unit-testable without a DOM; the row-height estimate is derived from the same
// constants the Tailwind gap/padding use, so it matches what actually renders.
const OVERSCAN_ROWS = 3


/** Which presence facet a toggle controls — mirrors the card badge it matches. */
type PresenceTone = 'device' | 'library'

const PRESENCE_TONES: Record<PresenceTone, string> = {
  device: 'bg-green-700/80 border-green-600 text-green-50',
  library: 'bg-amber-600/80 border-amber-500 text-amber-50'
}

/**
 * A presence filter chip, colour-matched to the badge it selects so the link
 * between chip and card is obvious.
 *
 * `aria-pressed` rather than a checkbox: it toggles a view, it does not submit a
 * value. Disabled at zero so the filter cannot produce a deliberately empty
 * grid — but never while active, or turning it back off would be impossible
 * once its count dropped to zero.
 */
function PresenceToggle({
  tone,
  label,
  count,
  active,
  onToggle
}: {
  tone: PresenceTone
  label: string
  count: number
  active: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={count === 0 && !active}
      aria-pressed={active}
      title={label}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 border rounded-md text-xs whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? PRESENCE_TONES[tone]
          : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
      }`}
    >
      <svg aria-hidden="true" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {tone === 'device' ? (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        )}
      </svg>
      {label}
      <span
        className={`px-1 rounded text-[10px] font-medium ${
          active ? 'bg-black/25' : 'bg-gray-900/70 text-gray-500'
        }`}
      >
        {count}
      </span>
    </button>
  )
}

/**
 * Shown while the device state is still unknown. Says which of the two waits is
 * running — drive detection or the documents scan — because they have very
 * different durations and a bare spinner for both reads as a hang.
 */
function LoadingState({ phase }: { phase: LoadingPhase }) {
  const { t } = useTranslation()

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center h-full text-center p-8"
    >
      <svg
        aria-hidden="true"
        className="w-8 h-8 text-gray-500 animate-spin mb-4"
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
      <p className="text-gray-400 text-sm">
        {phase === 'detecting' ? t('books.detectingDevice') : t('books.readingBooks')}
      </p>
    </div>
  )
}

function EmptyState({ kindleConnected }: { kindleConnected: boolean }) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mb-4">
        <svg
          aria-hidden="true"
          className="w-8 h-8 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
          />
        </svg>
      </div>
      {kindleConnected ? (
        <>
          <p className="text-gray-300 font-medium">{t('emptyState.noBooks')}</p>
          <p className="text-gray-400 text-sm mt-1">{t('emptyState.emptyDocuments')}</p>
        </>
      ) : (
        <>
          <p className="text-gray-300 font-medium">{t('emptyState.noKindleDetected')}</p>
          <p className="text-gray-400 text-sm mt-1">{t('emptyState.connectKindle')}</p>
        </>
      )}
      <p className="text-gray-500 text-xs mt-3">{t('library.emptyHint')}</p>
    </div>
  )
}

export function BooksGrid({
  books,
  loadingPhase,
  kindleConnected,
  mountpoint,
  collections,
  documentsBase,
  onAddBookToCollection,
  onRemoveBookFromCollection,
  onBookUpdated,
  onLibraryChanged,
  onCollectionsChanged,
  onNotify
}: BooksGridProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // Presence facets. Both false (the default) means "show everything".
  const [showOnDevice, setShowOnDevice] = useState(false)
  const [showLibraryOnly, setShowLibraryOnly] = useState(false)
  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null)

  // Multi-selection. `isSelectionMode` is explicit rather than derived from a
  // non-empty set, so clearing the last card keeps the toolbar up instead of
  // silently dropping the user back out of the mode.
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [isRunning, setIsRunning] = useState(false)
  const [progress, setProgress] = useState<BulkProgress | null>(null)
  /** libraryId of the book currently being sent, for its card badge. */
  const [sendingId, setSendingId] = useState<string | null>(null)
  // A ref, not state: the running loop reads it between books and must see the
  // latest value without waiting for a re-render.
  const stopRef = useRef(false)
  // Cover cache-buster versions keyed on cache key: bumped by a retry-loop push.
  const [coverVersions, setCoverVersions] = useState<Map<string, number>>(new Map())
  // Keys that resolved to "no cover" (not-found / retries exhausted): a terminal
  // push that lets a pending card fall through to the extension placeholder.
  const [coverMissing, setCoverMissing] = useState<Set<string>>(new Set())
  // Bumped when the cover cache is cleared, forcing every card to re-ensure.
  const [coverEpoch, setCoverEpoch] = useState(0)

  const [containerWidth, setContainerWidth] = useState(0)

  // Route pushed cover updates into the version/missing maps (one listener pair
  // for the whole grid); reset everything when the cache is cleared.
  useEffect(() => {
    const offUpdated = window.kindleAPI.onCoverUpdated((cacheKey) => {
      setCoverVersions((prev) => {
        const next = new Map(prev)
        next.set(cacheKey, (prev.get(cacheKey) ?? 0) + 1)
        return next
      })
      // A cover arriving supersedes any prior "missing" verdict for the key.
      setCoverMissing((prev) => {
        if (!prev.has(cacheKey)) return prev
        const next = new Set(prev)
        next.delete(cacheKey)
        return next
      })
    })
    const offMissing = window.kindleAPI.onCoverMissing((cacheKey) => {
      setCoverMissing((prev) => {
        if (prev.has(cacheKey)) return prev
        const next = new Set(prev)
        next.add(cacheKey)
        return next
      })
    })
    const offCleared = window.kindleAPI.onCoverCacheCleared(() => {
      setCoverVersions(new Map())
      setCoverMissing(new Set())
      setCoverEpoch((e) => e + 1)
    })
    return () => {
      offUpdated()
      offMissing()
      offCleared()
    }
  }, [])

  // Clear the detail sidebar only when the selected book is actually gone
  // (e.g. a genuine reload), not on every edit that replaces the books array.
  useEffect(() => {
    setSelectedBook((prev) =>
      prev && books.some((b) => b.path === prev.book.path) ? prev : null
    )
  }, [books])

  // The scroll container only renders once there are books to show, so it is
  // absent at mount. A one-shot effect keyed on `[]` would run against a null
  // ref and never re-run when the container finally appears — leaving
  // containerWidth stuck at 0 (→ a fixed fallback column count, no resize
  // reflow). A callback ref instead fires exactly when the element mounts/
  // unmounts, so we (re)attach the ResizeObserver at the right moment.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const setScrollEl = useCallback((el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    scrollRef.current = el
    if (!el) return
    const measure = (): void => setContainerWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    resizeObserverRef.current = ro
  }, [])

  const handleSelect = useCallback(
    (book: DisplayBook, bookRelpath: string, cover: string | null) => {
      setSelectedBook({ book, cover, bookRelpath })
    },
    []
  )

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return books
    return books.filter(
      (b) =>
        b.title.toLowerCase().includes(q) || (b.author ?? '').toLowerCase().includes(q)
    )
  }, [books, query])

  // Facet counts are taken AFTER the search so they stay truthful while typing.
  const presenceCounts = useMemo(() => countPresence(searched), [searched])

  const filtered = useMemo(
    () => filterByPresence(searched, { showOnDevice, showLibraryOnly }),
    [searched, showOnDevice, showLibraryOnly]
  )

  const hasQuery = query.trim() !== ''

  const clearFilters = useCallback(() => {
    setQuery('')
    setShowOnDevice(false)
    setShowLibraryOnly(false)
  }, [])

  // ─── Multi-selection ───────────────────────────────────────────────────────
  // Selection is keyed by bookKey, NOT by index or object identity: cards unmount
  // as they scroll out of the virtualizer, and the whole list is rebuilt after
  // every rescan. Keys also mean a selection survives the search/presence
  // filters — a filtered-out book stays selected and still counts.

  // The chosen books, resolved against the full (unfiltered) list so nothing is
  // silently dropped by a filter the user changed after selecting.
  const chosen = useMemo(() => selectedBooks(books, selectedKeys), [books, selectedKeys])
  const sendable = useMemo(() => sendableBooks(chosen), [chosen])
  const removable = useMemo(() => removableBooks(chosen), [chosen])
  const collectable = useMemo(() => collectableBooks(chosen), [chosen])

  const enterSelection = useCallback((book: DisplayBook) => {
    setIsSelectionMode(true)
    setSelectedKeys(new Set([bookKey(book)]))
  }, [])

  const toggleSelect = useCallback((book: DisplayBook) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      const key = bookKey(book)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const exitSelection = useCallback(() => {
    setIsSelectionMode(false)
    setSelectedKeys(new Set())
  }, [])

  // Escape leaves selection mode, matching the modals. Ignored mid-run: the
  // toolbar's explicit Stop is the way out of a send in progress.
  useEffect(() => {
    if (!isSelectionMode) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !isRunning) exitSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isSelectionMode, isRunning, exitSelection])

  // ─── Bulk actions ──────────────────────────────────────────────────────────

  /**
   * Sends the eligible books ONE AT A TIME.
   *
   * Not parallel on purpose: each send spawns Calibre (CPU-bound) and then
   * streams to a single FAT32 volume, so concurrency would only make them
   * contend. Stopping takes effect between books — `sendToKindle` does not yet
   * accept an AbortSignal, so a conversion already running is left to finish.
   */
  const runBulkSend = useCallback(async () => {
    if (!mountpoint || sendable.length === 0) return
    stopRef.current = false
    setIsRunning(true)

    const total = sendable.length
    let sent = 0
    let failed = 0
    let stopped = false

    for (const [index, book] of sendable.entries()) {
      if (stopRef.current) {
        stopped = true
        break
      }
      const libraryId = book.libraryId
      if (libraryId === undefined) continue

      setSendingId(libraryId)
      setProgress({ done: index, total, phase: 'converting', percent: 0 })
      try {
        await window.kindleAPI.uploadBook(libraryId, mountpoint)
        sent++
      } catch (err) {
        console.error(`[bulk-send] "${book.title}" failed:`, err)
        failed++
      }
    }

    setSendingId(null)
    setProgress(null)
    setIsRunning(false)

    const summary = [
      sent > 0 ? t('selection.sentCount', { count: sent }) : null,
      failed > 0 ? t('selection.failedCount', { count: failed }) : null,
      stopped ? t('selection.stopped') : null
    ]
      .filter(Boolean)
      .join(' · ')
    if (summary) onNotify(failed > 0 ? 'error' : 'info', summary)

    if (sent > 0) {
      onLibraryChanged()
      exitSelection()
    }
  }, [mountpoint, sendable, t, onNotify, onLibraryChanged, exitSelection])

  const runBulkRemove = useCallback(async () => {
    if (removable.length === 0) return
    if (!window.confirm(t('selection.confirmRemove', { count: removable.length }))) return

    setIsRunning(true)
    let removed = 0
    let failed = 0
    for (const book of removable) {
      if (book.libraryId === undefined) continue
      try {
        await window.kindleAPI.removeLibraryBook(book.libraryId)
        removed++
      } catch (err) {
        console.error(`[bulk-remove] "${book.title}" failed:`, err)
        failed++
      }
    }
    setIsRunning(false)

    const summary = [
      removed > 0 ? t('selection.removedCount', { count: removed }) : null,
      failed > 0 ? t('selection.failedCount', { count: failed }) : null
    ]
      .filter(Boolean)
      .join(' · ')
    if (summary) onNotify(failed > 0 ? 'error' : 'info', summary)

    onLibraryChanged()
    exitSelection()
  }, [removable, t, onNotify, onLibraryChanged, exitSelection])

  /**
   * Adds every eligible selected book to one collection in a SINGLE transaction
   * (ensureCollectionsContain is idempotent, so re-adding a member is a no-op).
   */
  const runBulkAddToCollection = useCallback(
    async (collectionId: string) => {
      const collection = collections.find((c) => c.id === collectionId)
      if (!collection || collectable.length === 0) return

      setIsRunning(true)
      try {
        const relpaths = collectable.map((book) => toBookRelpath(book.path, documentsBase))
        const next = await window.kindleAPI.ensureCollectionsContain([
          { name: collection.name, relpaths }
        ])
        onCollectionsChanged(next)
        onNotify(
          'info',
          t('selection.addedToCollection', { count: relpaths.length, name: collection.name })
        )
        exitSelection()
      } catch (err) {
        console.error('[bulk-add-to-collection] failed:', err)
        onNotify('error', t('errors.addToCollection'))
      } finally {
        setIsRunning(false)
      }
    },
    [collections, collectable, documentsBase, onCollectionsChanged, onNotify, t, exitSelection]
  )

  // Follow the convert/upload pushes for the book currently being sent, so the
  // toolbar shows both which book it is on and how far into that book it is.
  useEffect(() => {
    if (sendingId === null) return
    const applyPhase = (phase: 'converting' | 'uploading', libraryId: string, percent: number) => {
      if (libraryId !== sendingId) return
      setProgress((prev) => (prev ? { ...prev, phase, percent } : prev))
    }
    const offConvert = window.kindleAPI.onConvertProgress((p) =>
      applyPhase('converting', p.libraryId, p.percent)
    )
    const offUpload = window.kindleAPI.onUploadProgress((p) =>
      applyPhase('uploading', p.libraryId, p.percent)
    )
    return () => {
      offConvert()
      offUpload()
    }
  }, [sendingId])

  const columns = columnsForWidth(containerWidth)
  const rowCount = Math.ceil(filtered.length / columns)

  // Row height estimate: cover height (card width × aspect) + info block + gap.
  const usableWidth = Math.max(0, (containerWidth || 1280) - GRID_PADDING_PX * 2)
  const cardWidth = (usableWidth - GRID_GAP_PX * (columns - 1)) / columns
  const estimatedRowHeight = Math.round(cardWidth * COVER_ASPECT + CARD_INFO_HEIGHT_PX + GRID_GAP_PX)

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: OVERSCAN_ROWS
  })

  // Re-measure rows when the column count (and thus row height) changes.
  useEffect(() => {
    rowVirtualizer.measure()
  }, [columns, estimatedRowHeight, rowVirtualizer])

  if (loadingPhase) {
    return <LoadingState phase={loadingPhase} />
  }

  if (books.length === 0) {
    return <EmptyState kindleConnected={kindleConnected} />
  }

  const virtualRows = rowVirtualizer.getVirtualItems()

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 flex flex-col p-6 overflow-hidden">
        {isSelectionMode ? (
          <SelectionToolbar
            selectedCount={chosen.length}
            sendableCount={sendable.length}
            removableCount={removable.length}
            collectableCount={collectable.length}
            collections={collections}
            isDeviceConnected={mountpoint !== null}
            progress={progress}
            isRunning={isRunning}
            onSelectAll={() => setSelectedKeys(new Set(filtered.map(bookKey)))}
            onClear={() => setSelectedKeys(new Set())}
            onExit={exitSelection}
            onSend={runBulkSend}
            onRemove={runBulkRemove}
            onAddToCollection={runBulkAddToCollection}
            onStop={() => {
              stopRef.current = true
            }}
          />
        ) : (
        <div className="flex items-center justify-between gap-3 mb-4 shrink-0">
          <p className="text-gray-400 text-sm shrink-0">
            {filtered.length === books.length
              ? t('books.booksCount', { count: books.length })
              : t('books.booksCountFiltered', { filtered: filtered.length, total: books.length })}
          </p>

          <div className="flex items-center gap-2 shrink-0">
            {/* A long press is undiscoverable on its own, and unreachable from a
                keyboard — this is the visible way into selection mode. */}
            <button
              type="button"
              onClick={() => setIsSelectionMode(true)}
              title={t('selection.enterHint')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md text-xs text-gray-400 hover:text-gray-200 whitespace-nowrap transition-colors"
            >
              <svg aria-hidden="true" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {t('selection.enter')}
            </button>
            <PresenceToggle
              tone="device"
              label={t('books.onKindle')}
              count={presenceCounts.onDevice}
              active={showOnDevice}
              onToggle={() => setShowOnDevice((v) => !v)}
            />
            <PresenceToggle
              tone="library"
              label={t('books.inLibraryOnly')}
              count={presenceCounts.libraryOnly}
              active={showLibraryOnly}
              onToggle={() => setShowLibraryOnly((v) => !v)}
            />

          <div className="relative w-56">
            <svg
              aria-hidden="true"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
              />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('books.searchPlaceholder')}
              aria-label={t('books.searchPlaceholder')}
              className="w-full bg-gray-800 border border-gray-700 rounded-md pl-8 pr-8 py-1.5 text-xs text-gray-200 placeholder-gray-400 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label={t('books.clearSearch')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300 transition-colors"
              >
                <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            </div>
          </div>
        </div>
        )}

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            {/* Without a query the old message read 'No books found for ""'. */}
            <p className="text-gray-300 text-sm">
              {hasQuery ? t('books.noResults', { query }) : t('books.noResultsFilter')}
            </p>
            <button onClick={clearFilters} className="mt-2 text-indigo-400 text-xs hover:underline">
              {t('books.removeFilter')}
            </button>
          </div>
        ) : (
          <div ref={setScrollEl} className="flex-1 overflow-y-auto">
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualRows.map((virtualRow) => {
                const start = virtualRow.index * columns
                const rowBooks = filtered.slice(start, start + columns)
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    className="grid gap-4"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                      paddingBottom: GRID_GAP_PX
                    }}
                  >
                    {rowBooks.map((book) => (
                      <BookCard
                        key={bookKey(book)}
                        book={book}
                        bookRelpath={toBookRelpath(book.path, documentsBase)}
                        collections={collections}
                        coverVersions={coverVersions}
                        coverMissing={coverMissing}
                        coverEpoch={coverEpoch}
                        isSelectionMode={isSelectionMode}
                        isSelected={selectedKeys.has(bookKey(book))}
                        sendPhase={
                          sendingId !== null && book.libraryId === sendingId
                            ? progress?.phase ?? 'converting'
                            : null
                        }
                        onLongPress={enterSelection}
                        onToggleSelect={toggleSelect}
                        onAddToCollection={onAddBookToCollection}
                        onRemoveFromCollection={onRemoveBookFromCollection}
                        onSelect={handleSelect}
                      />
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {selectedBook && (
        <BookDetailSidebar
          book={selectedBook.book}
          cover={selectedBook.cover}
          coverEpoch={coverEpoch}
          bookRelpath={selectedBook.bookRelpath}
          mountpoint={mountpoint}
          onClose={() => setSelectedBook(null)}
          onBookUpdated={(updatedBook) => {
            // Merge the edited KindleBook fields onto the DisplayBook so
            // onDevice/libraryId survive a metadata edit.
            setSelectedBook((prev) =>
              prev ? { ...prev, book: { ...prev.book, ...updatedBook } } : null
            )
            onBookUpdated(updatedBook)
          }}
          onSent={onLibraryChanged}
          onRemoved={onLibraryChanged}
        />
      )}
    </div>
  )
}
