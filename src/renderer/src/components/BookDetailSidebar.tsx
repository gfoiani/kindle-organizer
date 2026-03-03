import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { KindleBook, BookMetadata } from '../../../preload/api'

interface Props {
  book: KindleBook
  cover: string | null
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function BookDetailSidebar({ book, cover, onClose }: Props) {
  const { t } = useTranslation()
  const [metadata, setMetadata] = useState<BookMetadata | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setMetadata(null)
    window.kindleAPI
      .getBookMetadata(book.title, book.author)
      .then((data) => { if (!cancelled) setMetadata(data) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [book.title, book.author])

  const hasAnyMetadata = metadata && (metadata.year || metadata.genre || metadata.description)

  return (
    <>
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
      <aside
        className="w-80 shrink-0 border-l border-gray-700 flex flex-col overflow-hidden bg-gray-900"
        style={{ animation: 'slideInRight 0.25s ease-out both' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <h3 className="text-sm font-semibold text-white truncate pr-2">{book.title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors shrink-0 p-0.5"
            title={t('bookDetail.close')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Cover */}
          <div className="w-full aspect-[2/3] bg-gray-950 flex items-center justify-center overflow-hidden shrink-0">
            {cover ? (
              <img src={cover} alt={book.title} className="w-full h-full object-cover" />
            ) : (
              <span className="text-indigo-300 text-3xl font-bold">{book.extension}</span>
            )}
          </div>

          {/* Info */}
          <div className="p-4 space-y-4">
            {/* Author (from book data, always available) */}
            {book.author && (
              <div>
                <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">
                  {t('bookDetail.author')}
                </p>
                <p className="text-white text-sm">{book.author}</p>
              </div>
            )}

            {/* File size & format */}
            <div>
              <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">
                {t('bookDetail.fileSize')}
              </p>
              <p className="text-white text-sm">
                {formatSize(book.size)}{' '}
                <span className="text-indigo-400 text-[10px] font-bold ml-1">{book.extension}</span>
              </p>
            </div>

            {/* Fetched metadata */}
            {loading ? (
              <p className="text-gray-600 text-xs animate-pulse">{t('bookDetail.loading')}</p>
            ) : hasAnyMetadata ? (
              <>
                {metadata.year && (
                  <div>
                    <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">
                      {t('bookDetail.year')}
                    </p>
                    <p className="text-white text-sm">{metadata.year}</p>
                  </div>
                )}

                {metadata.genre && (
                  <div>
                    <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">
                      {t('bookDetail.genre')}
                    </p>
                    <p className="text-white text-sm">{metadata.genre}</p>
                  </div>
                )}

                {metadata.description && (
                  <div>
                    <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">
                      {t('bookDetail.description')}
                    </p>
                    <p className="text-gray-300 text-xs leading-relaxed">{metadata.description}</p>
                  </div>
                )}
              </>
            ) : (
              <p className="text-gray-600 text-xs">{t('bookDetail.noInfo')}</p>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}
