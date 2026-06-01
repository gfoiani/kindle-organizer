import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { KindleBook, Collection } from '../../../preload/api'
import { CollectionPicker } from './CollectionPicker'
import { BookDetailSidebar } from './BookDetailSidebar'

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function BookCard({
  book,
  bookRelpath,
  collections,
  onAddToCollection,
  onRemoveFromCollection,
  onSelect
}: {
  book: KindleBook
  bookRelpath: string
  collections: Collection[]
  onAddToCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onRemoveFromCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onSelect: (cover: string | null) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [cover, setCover] = useState<string | null>(null)
  const [coverLoading, setCoverLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.kindleAPI
      .getCover(book.title, book.author, book.isbn)
      .then((dataUrl) => { if (!cancelled) setCover(dataUrl) })
      .catch((err) => { if (!cancelled) console.error('Failed to load cover:', err) })
      .finally(() => { if (!cancelled) setCoverLoading(false) })
    return () => { cancelled = true }
  }, [book.title, book.author, book.isbn])

  // Listen for retry-succeeded push events from the main process
  useEffect(() => {
    return window.kindleAPI.onCoverUpdated((title, author, dataUrl) => {
      if (title === book.title && author === book.author) {
        setCover(dataUrl)
      }
    })
  }, [book.title, book.author])

  return (
    <div
      className="relative bg-gray-800 border border-gray-700 rounded-lg overflow-hidden hover:border-indigo-500 transition-colors cursor-pointer group flex flex-col"
      onClick={() => onSelect(cover)}
    >
      {/* Cover area — 2:3 book aspect ratio */}
      <div className="relative w-full aspect-[2/3] bg-gray-900 flex items-center justify-center overflow-hidden shrink-0">
        {coverLoading ? (
          <div className="absolute inset-0 bg-gray-800 animate-pulse" />
        ) : cover ? (
          <img
            src={cover}
            alt={book.title}
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
            title="Gestisci collezioni"
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded bg-black/60 text-gray-300 hover:text-indigo-300"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
          <p className="text-gray-500 text-[11px] truncate">{book.author}</p>
        )}
        <p className="text-gray-600 text-[10px] mt-0.5">{formatSize(book.size)}</p>
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
}

function EmptyState({ kindleConnected }: { kindleConnected: boolean }) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-gray-600"
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
          <p className="text-gray-400 font-medium">{t('emptyState.noBooks')}</p>
          <p className="text-gray-600 text-sm mt-1">
            {t('emptyState.emptyDocuments')}
          </p>
        </>
      ) : (
        <>
          <p className="text-gray-400 font-medium">{t('emptyState.noKindleDetected')}</p>
          <p className="text-gray-600 text-sm mt-1">
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
  const [selectedBook, setSelectedBook] = useState<{ book: KindleBook; cover: string | null; bookRelpath: string } | null>(null)

  useEffect(() => {
    setSelectedBook(null)
  }, [books])

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
        <div className="text-gray-500 text-sm">{t('books.noBooks')}</div>
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
          <p className="text-gray-500 text-sm shrink-0">
            {filtered.length === books.length
              ? t('books.booksCount', { count: books.length })
              : t('books.booksCountFiltered', { filtered: filtered.length, total: books.length })}
          </p>
          <div className="relative ml-4 w-56">
            <svg
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none"
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
              className="w-full bg-gray-800 border border-gray-700 rounded-md pl-8 pr-8 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-gray-400 text-sm">{t('books.noResults', { query })}</p>
            <button onClick={() => setQuery('')} className="mt-2 text-indigo-400 text-xs hover:underline">
              {t('books.removeFilter')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filtered.map((book) => {
              const bookRelpath = book.path.startsWith(documentsBase)
                ? book.path.slice(documentsBase.length)
                : book.path
              return (
                <BookCard
                  key={book.path}
                  book={book}
                  bookRelpath={bookRelpath}
                  collections={collections}
                  onAddToCollection={onAddBookToCollection}
                  onRemoveFromCollection={onRemoveBookFromCollection}
                  onSelect={(cover) => setSelectedBook({ book, cover, bookRelpath })}
                />
              )
            })}
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
            setSelectedBook((prev) => prev ? { ...prev, book: updatedBook } : null)
            onBookUpdated(updatedBook)
          }}
        />
      )}
    </div>
  )
}
