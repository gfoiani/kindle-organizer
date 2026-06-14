import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { KindleBook, Collection } from '../../../preload/api'
import { CollectionPicker } from './CollectionPicker'
import { BookDetailSidebar } from './BookDetailSidebar'
import { formatSize } from '../utils/format'
import { computeCoverCacheKey } from '../utils/coverCacheKey'
import { toBookRelpath } from '../utils/relpath'

interface BooksGridProps {
  books: KindleBook[]
  isLoading: boolean
  kindleConnected: boolean
  collections: Collection[]
  documentsBase: string
  onAddBookToCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onRemoveBookFromCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onBookUpdated: (updatedBook: KindleBook) => void
}

interface SelectedBook {
  book: KindleBook
  cover: string | null
  bookRelpath: string
}

const BookCard = memo(function BookCard({
  book,
  bookRelpath,
  collections,
  coverUpdates,
  onAddToCollection,
  onRemoveFromCollection,
  onSelect
}: {
  book: KindleBook
  bookRelpath: string
  collections: Collection[]
  coverUpdates: Map<string, string>
  onAddToCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onRemoveFromCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onSelect: (book: KindleBook, bookRelpath: string, cover: string | null) => void
}) {
  const { t } = useTranslation()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [cover, setCover] = useState<string | null>(null)
  const [coverLoading, setCoverLoading] = useState(true)
  const [isVisible, setIsVisible] = useState(false)
  const [cacheKey, setCacheKey] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Defer cover work until the card scrolls into view (bounds the fetch storm
  // on large libraries). Once seen, stays "visible" so we don't re-fetch.
  useEffect(() => {
    const node = cardRef.current
    if (!node || isVisible) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [isVisible])

  // Compute this card's stable cover cache key so retry-pushed updates match.
  useEffect(() => {
    let cancelled = false
    computeCoverCacheKey(book.title, book.author)
      .then((key) => { if (!cancelled) setCacheKey(key) })
      .catch((err) => { if (!cancelled) console.error('Failed to compute cover key:', err) })
    return () => { cancelled = true }
  }, [book.title, book.author])

  // Fetch the cover only once visible.
  useEffect(() => {
    if (!isVisible) return
    let cancelled = false
    setCoverLoading(true)
    window.kindleAPI
      .getCover(book.title, book.author, book.isbn)
      .then((dataUrl) => { if (!cancelled) setCover(dataUrl) })
      .catch((err) => { if (!cancelled) console.error('Failed to load cover:', err) })
      .finally(() => { if (!cancelled) setCoverLoading(false) })
    return () => { cancelled = true }
  }, [isVisible, book.title, book.author, book.isbn])

  // Apply a retry-pushed cover update routed by the grid-level listener.
  const pushedCover = cacheKey ? coverUpdates.get(cacheKey) : undefined
  const effectiveCover = pushedCover ?? cover

  const accessibleName = book.title.trim() || t('books.untitled')

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      aria-label={accessibleName}
      className="relative bg-gray-800 border border-gray-700 rounded-lg overflow-hidden hover:border-indigo-500 transition-colors cursor-pointer group flex flex-col focus:outline-none focus:ring-2 focus:ring-indigo-500"
      onClick={() => onSelect(book, bookRelpath, effectiveCover)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(book, bookRelpath, effectiveCover)
        }
      }}
    >
      {/* Cover area — 2:3 book aspect ratio */}
      <div className="relative w-full aspect-[2/3] bg-gray-900 flex items-center justify-center overflow-hidden shrink-0">
        {coverLoading && !effectiveCover ? (
          <div className="absolute inset-0 bg-gray-800 animate-pulse" />
        ) : effectiveCover ? (
          <img
            src={effectiveCover}
            alt=""
            decoding="async"
            onError={() => setCover(null)}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center gap-1">
            <span className="text-indigo-300 text-xl font-bold">{book.extension}</span>
          </div>
        )}

        {/* Format badge */}
        {!coverLoading && (
          <span className="absolute top-2 left-2 bg-black/60 text-indigo-300 text-[10px] font-bold px-1.5 py-0.5 rounded">
            {book.extension}
          </span>
        )}

        {/* Collection tag button */}
        {collections.length > 0 && (
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
      </div>

      {/* Info area */}
      <div className="p-3 flex flex-col gap-0.5">
        <h3 className="text-white text-xs font-medium leading-tight line-clamp-2 group-hover:text-indigo-300 transition-colors">
          {book.title}
        </h3>
        {book.author && (
          <p className="text-gray-400 text-[11px] truncate">{book.author}</p>
        )}
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
          <p className="text-gray-400 text-sm mt-1">
            {t('emptyState.emptyDocuments')}
          </p>
        </>
      ) : (
        <>
          <p className="text-gray-300 font-medium">{t('emptyState.noKindleDetected')}</p>
          <p className="text-gray-400 text-sm mt-1">
            {t('emptyState.connectKindle')}
          </p>
        </>
      )}
    </div>
  )
}

export function BooksGrid({
  books,
  isLoading,
  kindleConnected,
  collections,
  documentsBase,
  onAddBookToCollection,
  onRemoveBookFromCollection,
  onBookUpdated
}: BooksGridProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null)
  // Cover updates pushed by the main-process retry loop, keyed on cache key.
  const [coverUpdates, setCoverUpdates] = useState<Map<string, string>>(new Map())

  // One listener for the whole grid (instead of one per card): route each
  // retry-pushed cover into a map keyed on the stable cache key.
  useEffect(() => {
    return window.kindleAPI.onCoverUpdated((_title, _author, dataUrl, cacheKey) => {
      setCoverUpdates((prev) => {
        const next = new Map(prev)
        next.set(cacheKey, dataUrl)
        return next
      })
    })
  }, [])

  // Clear the detail sidebar only when the selected book is actually gone
  // (e.g. a genuine reload), not on every edit that replaces the books array.
  useEffect(() => {
    setSelectedBook((prev) =>
      prev && books.some((b) => b.path === prev.book.path) ? prev : null
    )
  }, [books])

  const handleSelect = useCallback(
    (book: KindleBook, bookRelpath: string, cover: string | null) => {
      setSelectedBook({ book, cover, bookRelpath })
    },
    []
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return books
    return books.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        (b.author ?? '').toLowerCase().includes(q)
    )
  }, [books, query])

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

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
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
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filtered.map((book) => (
              <BookCard
                key={book.path}
                book={book}
                bookRelpath={toBookRelpath(book.path, documentsBase)}
                collections={collections}
                coverUpdates={coverUpdates}
                onAddToCollection={onAddBookToCollection}
                onRemoveFromCollection={onRemoveBookFromCollection}
                onSelect={handleSelect}
              />
            ))}
          </div>
        )}
      </div>

      {selectedBook && (
        <BookDetailSidebar
          book={selectedBook.book}
          cover={selectedBook.cover}
          bookRelpath={selectedBook.bookRelpath}
          onClose={() => setSelectedBook(null)}
          onBookUpdated={(updatedBook) => {
            setSelectedBook((prev) => (prev ? { ...prev, book: updatedBook } : null))
            onBookUpdated(updatedBook)
          }}
        />
      )}
    </div>
  )
}
