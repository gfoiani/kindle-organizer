import type { KindleBook } from '../../../../preload/api'

interface BooksGridProps {
  books: KindleBook[]
  isLoading: boolean
  kindleConnected: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function BookCard({ book }: { book: KindleBook }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 hover:border-indigo-500 hover:bg-gray-750 transition-colors cursor-pointer group">
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-12 bg-indigo-900 rounded flex items-center justify-center shrink-0">
          <span className="text-indigo-300 text-xs font-bold">{book.extension}</span>
        </div>
        <span className="text-gray-500 text-xs">{formatSize(book.size)}</span>
      </div>
      <h3 className="text-white text-sm font-medium leading-tight line-clamp-2 group-hover:text-indigo-300 transition-colors">
        {book.title}
      </h3>
    </div>
  )
}

function EmptyState({ kindleConnected }: { kindleConnected: boolean }) {
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
          <p className="text-gray-400 font-medium">Nessun libro trovato</p>
          <p className="text-gray-600 text-sm mt-1">
            La cartella documents del Kindle sembra vuota
          </p>
        </>
      ) : (
        <>
          <p className="text-gray-400 font-medium">Nessun Kindle rilevato</p>
          <p className="text-gray-600 text-sm mt-1">
            Collega il tuo Kindle via USB per vedere i libri
          </p>
        </>
      )}
    </div>
  )
}

export function BooksGrid({ books, isLoading, kindleConnected }: BooksGridProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500 text-sm">Caricamento libri...</div>
      </div>
    )
  }

  if (books.length === 0) {
    return <EmptyState kindleConnected={kindleConnected} />
  }

  return (
    <div className="p-6 overflow-y-auto h-full">
      <p className="text-gray-500 text-sm mb-4">
        {books.length} {books.length === 1 ? 'libro' : 'libri'}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {books.map((book) => (
          <BookCard key={book.path} book={book} />
        ))}
      </div>
    </div>
  )
}
