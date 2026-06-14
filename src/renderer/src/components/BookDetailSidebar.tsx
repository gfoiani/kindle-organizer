import { useState, useEffect, useRef, useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { KindleBook, BookMetadata } from '../../../preload/api'
import { formatSize } from '../utils/format'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  book: KindleBook
  cover: string | null
  bookRelpath: string
  onClose: () => void
  onBookUpdated: (updatedBook: KindleBook) => void
}

export function BookDetailSidebar({ book, cover, bookRelpath, onClose, onBookUpdated }: Props) {
  const { t } = useTranslation()
  const [metadata, setMetadata] = useState<BookMetadata | null>(null)
  const [loading, setLoading] = useState(true)

  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editAuthor, setEditAuthor] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  const titleId = useId()

  // Escape closes the panel (but not mid-save, to avoid losing the edit).
  useFocusTrap(asideRef, { onEscape: isSaving ? undefined : onClose })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setMetadata(null)
    window.kindleAPI
      .getBookMetadata(book.title, book.author)
      .then((data) => { if (!cancelled) setMetadata(data) })
      .catch((err) => { if (!cancelled) console.error('Failed to fetch book metadata:', err) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [book.title, book.author])

  function handleStartEdit() {
    setEditTitle(book.title)
    setEditAuthor(book.author ?? '')
    setIsEditing(true)
  }

  function handleCancel() {
    setIsEditing(false)
  }

  async function handleSave() {
    const trimmedTitle = editTitle.trim()
    if (!trimmedTitle) return
    setIsSaving(true)
    try {
      const newAuthor = editAuthor.trim() || undefined
      await window.kindleAPI.updateBookMetadata(bookRelpath, trimmedTitle, newAuthor)
      onBookUpdated({ ...book, title: trimmedTitle, author: newAuthor })
      setIsEditing(false)
    } catch (err) {
      console.error('Failed to update book metadata:', err)
    } finally {
      setIsSaving(false)
    }
  }

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
        ref={asideRef}
        role="dialog"
        aria-labelledby={titleId}
        className="w-80 shrink-0 border-l border-gray-700 flex flex-col overflow-hidden bg-gray-900"
        style={{ animation: 'slideInRight 0.25s ease-out both' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <h3 id={titleId} className="text-sm font-semibold text-white truncate pr-2">
            {isEditing ? t('bookDetail.editing') : book.title}
          </h3>
          <div className="flex items-center gap-1 shrink-0">
            {isEditing ? (
              <>
                <button
                  onClick={handleSave}
                  disabled={isSaving || !editTitle.trim()}
                  title={t('bookDetail.save')}
                  aria-label={t('bookDetail.save')}
                  className="text-green-400 hover:text-green-300 transition-colors p-0.5 disabled:opacity-40"
                >
                  {isSaving ? (
                    <svg aria-hidden="true" className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  ) : (
                    <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={isSaving}
                  title={t('bookDetail.cancelEdit')}
                  aria-label={t('bookDetail.cancelEdit')}
                  className="text-gray-400 hover:text-white transition-colors p-0.5 disabled:opacity-40"
                >
                  <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleStartEdit}
                  title={t('bookDetail.edit')}
                  aria-label={t('bookDetail.edit')}
                  className="text-gray-400 hover:text-indigo-300 transition-colors p-0.5"
                >
                  <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={onClose}
                  className="text-gray-400 hover:text-white transition-colors p-0.5"
                  title={t('bookDetail.close')}
                  aria-label={t('bookDetail.close')}
                >
                  <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </>
            )}
          </div>
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
            {isEditing ? (
              <>
                <div>
                  <label className="text-gray-500 text-[10px] uppercase tracking-wide block mb-1">
                    {t('bookDetail.titleLabel')}
                  </label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
                    className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-gray-500 text-[10px] uppercase tracking-wide block mb-1">
                    {t('bookDetail.author')}
                  </label>
                  <input
                    type="text"
                    value={editAuthor}
                    onChange={(e) => setEditAuthor(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
                    className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
              </>
            ) : (
              <>
                {book.author && (
                  <div>
                    <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">
                      {t('bookDetail.author')}
                    </p>
                    <p className="text-white text-sm">{book.author}</p>
                  </div>
                )}
              </>
            )}

            {/* File size & format — always visible */}
            <div>
              <p className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">
                {t('bookDetail.fileSize')}
              </p>
              <p className="text-white text-sm">
                {formatSize(book.size)}{' '}
                <span className="text-indigo-400 text-[10px] font-bold ml-1">{book.extension}</span>
              </p>
            </div>

            {/* Fetched metadata — only in view mode */}
            {!isEditing && (
              loading ? (
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
              )
            )}
          </div>
        </div>
      </aside>
    </>
  )
}
