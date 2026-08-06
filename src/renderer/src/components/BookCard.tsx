import { useState, useEffect, memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Collection, CoverStatus } from '../../../preload/api'
import type { DisplayBook } from '../utils/mergeBooks'
import { CollectionPicker } from './CollectionPicker'
import { CoverPlaceholder } from './CoverPlaceholder'
import { formatSize } from '../utils/format'
import { buildCoverSrc } from '../utils/coverSrc'
import { useLongPress } from '../hooks/useLongPress'

interface BookCardProps {
  book: DisplayBook
  bookRelpath: string
  collections: Collection[]
  coverVersions: Map<string, number>
  coverMissing: Set<string>
  coverEpoch: number
  isSelectionMode: boolean
  isSelected: boolean
  /** Set while THIS book is the one being sent in a bulk run. */
  sendPhase: 'converting' | 'uploading' | null
  onLongPress: (book: DisplayBook) => void
  onToggleSelect: (book: DisplayBook) => void
  onAddToCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onRemoveFromCollection: (collectionId: string, bookRelpath: string) => Promise<void>
  onSelect: (book: DisplayBook, bookRelpath: string, cover: string | null) => void
}

/**
 * One book tile in the virtualized grid.
 *
 * Memoized because the grid re-renders every mounted card whenever a cover push
 * lands; only the cards whose props actually changed then re-run.
 */
export const BookCard = memo(function BookCard({
  book,
  bookRelpath,
  collections,
  coverVersions,
  coverMissing,
  coverEpoch,
  isSelectionMode,
  isSelected,
  sendPhase,
  onLongPress,
  onToggleSelect,
  onAddToCollection,
  onRemoveFromCollection,
  onSelect
}: BookCardProps) {
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
        if (cancelled) return
        console.error('ensureCover failed:', err)
        setStatus('missing') // terminal: show the placeholder rather than pulse forever
      })
    return () => {
      cancelled = true
      window.kindleAPI.cancelCover(book.title, book.author, book.isbn)
    }
  }, [book.title, book.author, book.isbn, coverEpoch])

  const version = coverKey ? coverVersions.get(coverKey) : undefined
  // A terminal "no cover" push (not-found / retries exhausted) moves the card out
  // of its pulse into the placeholder art without waiting for a remount.
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

  const longPress = useLongPress(() => onLongPress(book))

  // One activation path for pointer and keyboard: in selection mode a card
  // toggles, otherwise it opens the detail panel. The click that follows a long
  // press is swallowed, or releasing the gesture would also open the panel.
  const activate = (): void => {
    if (isSelectionMode) onToggleSelect(book)
    else onSelect(book, bookRelpath, coverSrc)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={accessibleName}
      aria-pressed={isSelectionMode ? isSelected : undefined}
      {...longPress.handlers}
      className={`relative bg-gray-800 border rounded-lg overflow-hidden transition-colors cursor-pointer group flex flex-col select-none focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
        isSelected ? 'border-indigo-500 ring-2 ring-indigo-500/60' : 'border-gray-700 hover:border-indigo-500'
      }`}
      onClick={() => {
        if (longPress.consumeClick()) return
        activate()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate()
        }
      }}
    >
      {/* Selection checkbox — visual only; the whole card is the hit target. */}
      {isSelectionMode && (
        <span
          aria-hidden="true"
          className={`absolute top-2 right-2 z-10 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
            isSelected ? 'bg-indigo-500 border-indigo-400' : 'bg-black/50 border-gray-400'
          }`}
        >
          {isSelected && (
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </span>
      )}
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
          <CoverPlaceholder title={book.title} author={book.author} />
        ) : (
          <div className="absolute inset-0 bg-gray-800 animate-pulse" />
        )}

        {/* Format badge */}
        <span className="absolute top-2 left-2 bg-black/60 text-indigo-300 text-[10px] font-bold px-1.5 py-0.5 rounded">
          {book.extension}
        </span>

        {/* Collection tag button — only device books belong to collections. Hidden
            while selecting: the checkbox owns that corner and every click on the
            card is a toggle. */}
        {collections.length > 0 && book.onDevice && !isSelectionMode && (
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
            sendPhase
              ? 'bg-indigo-600/80 text-white'
              : book.onDevice
                ? 'bg-green-700/85 text-green-50'
                : 'bg-amber-600/85 text-amber-50'
          }`}
        >
          {sendPhase ? (
            <>
              <svg aria-hidden="true" className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {sendPhase === 'uploading' ? t('library.uploading') : t('library.converting')}
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
