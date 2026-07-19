import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTranslation } from 'react-i18next'
import type { KindleBook, Collection, CoverStatus } from '../../../preload/api'
import type { DisplayBook } from '../utils/mergeBooks'
import { CollectionPicker } from './CollectionPicker'
import { BookDetailSidebar } from './BookDetailSidebar'
import { formatSize } from '../utils/format'
import { buildCoverSrc } from '../utils/coverSrc'
import { toBookRelpath } from '../utils/relpath'
import {
  columnsForWidth,
  GRID_GAP_PX,
  GRID_PADDING_PX,
  CARD_INFO_HEIGHT_PX,
  COVER_ASPECT
} from '../utils/gridLayout'

interface BooksGridProps {
  books: DisplayBook[]
  isLoading: boolean
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

const BookCard = memo(function BookCard({
  book,
  bookRelpath,
  collections,
  coverVersions,
  coverMissing,
  coverEpoch,
  onAddToCollection,
  onRemoveFromCollection,
  onSelect
}: {
  book: DisplayBook
  bookRelpath: string
  collections: Collection[]
  coverVersions: Map<string, number>
  coverMissing: Set<string>
  coverEpoch: number
  onAddToCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onRemoveFromCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onSelect: (book: DisplayBook, bookRelpath: string, cover: string | null) => void
}) {
  const { t } = useTranslation()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [coverKey, setCoverKey] = useState<string | null>(null)
  const [status, setStatus] = useState<CoverStatus | null>(null)
  const [imgFailed, setImgFailed] = useState(false)

  // The card only mounts when its row is virtualized into view (+ overscan), so
  // ensureCover runs exactly when the cover is (about to be) needed. On unmount
  // — a scroll past the overscan window — cancelCover aborts any in-flight
  // download so fast scrolling doesn't flood the network. `coverEpoch` bumps on
  // a cache-clear to force a fresh ensure.
  useEffect(() => {
    let cancelled = false
    setImgFailed(false)
    window.kindleAPI
      .ensureCover(book.title, book.author, book.isbn)
      .then((r) => {
        if (!cancelled) {
          setCoverKey(r.key)
          setStatus(r.status)
        }
      })
      .catch((err) => {
        if (!cancelled) console.error('ensureCover failed:', err)
      })
    return () => {
      cancelled = true
      window.kindleAPI.cancelCover(book.title, book.author, book.isbn)
    }
  }, [book.title, book.author, book.isbn, coverEpoch])

  const version = coverKey ? coverVersions.get(coverKey) : undefined
  // A terminal "no cover" push (not-found / retries exhausted) moves the card out
  // of its pulse into the extension placeholder without waiting for a remount.
  const pushedMissing = coverKey !== null && coverMissing.has(coverKey)

  // A push (retry succeeded / cache busted) means the file exists now — clear a
  // prior load error so the new version is retried.
  useEffect(() => {
    if (version !== undefined) setImgFailed(false)
  }, [version])

  const isMissing = status === 'missing' || pushedMissing
  const showImage =
    coverKey !== null && !imgFailed && !pushedMissing && (status === 'ready' || version !== undefined)
  const coverSrc = showImage && coverKey ? buildCoverSrc(coverKey, version ?? 0, coverEpoch) : null
  const accessibleName = book.title.trim() || t('books.untitled')

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={accessibleName}
      className="relative bg-gray-800 border border-gray-700 rounded-lg overflow-hidden hover:border-indigo-500 transition-colors cursor-pointer group flex flex-col focus:outline-none focus:ring-2 focus:ring-indigo-500"
      onClick={() => onSelect(book, bookRelpath, coverSrc)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(book, bookRelpath, coverSrc)
        }
      }}
    >
      {/* Cover area — 2:3 book aspect ratio */}
      <div className="relative w-full aspect-[2/3] bg-gray-900 flex items-center justify-center overflow-hidden shrink-0">
        {coverSrc ? (
          <img
            key={`${coverKey}:${version ?? 0}`}
            src={coverSrc}
            alt=""
            decoding="async"
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : isMissing || imgFailed ? (
          <div className="flex flex-col items-center gap-1">
            <span className="text-indigo-300 text-xl font-bold">{book.extension}</span>
          </div>
        ) : (
          <div className="absolute inset-0 bg-gray-800 animate-pulse" />
        )}

        {/* Format badge */}
        <span className="absolute top-2 left-2 bg-black/60 text-indigo-300 text-[10px] font-bold px-1.5 py-0.5 rounded">
          {book.extension}
        </span>

        {/* Collection tag button — only device books belong to collections. */}
        {collections.length > 0 && book.onDevice && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setPickerOpen((v) => !v)
            }}
            aria-label={t('books.manageCollections')}
            title={t('books.manageCollections')}
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1 rounded bg-black/60 text-gray-300 hover:text-indigo-300"
          >
            <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
          </button>
        )}

        {/* Presence badge — on-device (green), in-library-only (amber), or a
            transient converting/uploading state while a send is in flight. */}
        <span
          className={`absolute bottom-2 left-2 flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${
            book.conversionStatus
              ? 'bg-indigo-600/80 text-white'
              : book.onDevice
                ? 'bg-green-700/85 text-green-50'
                : 'bg-amber-600/85 text-amber-50'
          }`}
        >
          {book.conversionStatus ? (
            <>
              <svg aria-hidden="true" className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {book.conversionStatus === 'uploading' ? t('library.uploading') : t('library.converting')}
            </>
          ) : book.onDevice ? (
            <>
              <svg aria-hidden="true" className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {t('books.onKindle')}
            </>
          ) : (
            <>
              <svg aria-hidden="true" className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              {t('books.inLibraryOnly')}
            </>
          )}
        </span>
      </div>

      {/* Info area */}
      <div className="p-3 flex flex-col gap-0.5">
        <h3 className="text-white text-xs font-medium leading-tight line-clamp-2 group-hover:text-indigo-300 transition-colors">
          {book.title}
        </h3>
        {book.author && <p className="text-gray-400 text-[11px] truncate">{book.author}</p>}
        <p className="text-gray-400 text-[10px] mt-0.5">{formatSize(book.size)}</p>
      </div>

      {pickerOpen && (
        <CollectionPicker
          bookRelpath={bookRelpath}
          collections={collections}
          onAdd={onAddToCollection}
          onRemove={onRemoveFromCollection}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
})

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
  isLoading,
  kindleConnected,
  mountpoint,
  collections,
  documentsBase,
  onAddBookToCollection,
  onRemoveBookFromCollection,
  onBookUpdated,
  onLibraryChanged
}: BooksGridProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null)
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return books
    return books.filter(
      (b) =>
        b.title.toLowerCase().includes(q) || (b.author ?? '').toLowerCase().includes(q)
    )
  }, [books, query])

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-400 text-sm">{t('books.noBooks')}</div>
      </div>
    )
  }

  if (books.length === 0) {
    return <EmptyState kindleConnected={kindleConnected} />
  }

  const virtualRows = rowVirtualizer.getVirtualItems()

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 flex flex-col p-6 overflow-hidden">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <p className="text-gray-400 text-sm shrink-0">
            {filtered.length === books.length
              ? t('books.booksCount', { count: books.length })
              : t('books.booksCountFiltered', { filtered: filtered.length, total: books.length })}
          </p>
          <div className="relative ml-4 w-56">
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

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-gray-300 text-sm">{t('books.noResults', { query })}</p>
            <button onClick={() => setQuery('')} className="mt-2 text-indigo-400 text-xs hover:underline">
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
                        key={book.libraryId ?? book.path}
                        book={book}
                        bookRelpath={toBookRelpath(book.path, documentsBase)}
                        collections={collections}
                        coverVersions={coverVersions}
                        coverMissing={coverMissing}
                        coverEpoch={coverEpoch}
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
