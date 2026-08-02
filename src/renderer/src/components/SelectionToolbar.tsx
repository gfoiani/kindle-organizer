import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Collection } from '../../../preload/api'
import { useFocusTrap } from '../hooks/useFocusTrap'

/** Progress of a running bulk send: which item, and how far into it. */
export interface BulkProgress {
  done: number
  total: number
  phase: 'converting' | 'uploading'
  percent: number
}

interface SelectionToolbarProps {
  selectedCount: number
  /** How many of the selected books each action can actually act on. */
  sendableCount: number
  removableCount: number
  collectableCount: number
  collections: Collection[]
  /** False when no Kindle is attached — sending needs a destination. */
  isDeviceConnected: boolean
  progress: BulkProgress | null
  isRunning: boolean
  onSelectAll: () => void
  onClear: () => void
  onExit: () => void
  onSend: () => void
  onRemove: () => void
  onAddToCollection: (collectionId: string) => void
  onStop: () => void
}

/** A count badge on an action button — 0 reads as "nothing here to act on". */
function ActionCount({ value }: { value: number }) {
  return <span className="px-1 rounded bg-black/25 text-[10px] font-medium">{value}</span>
}

/**
 * Picks ONE collection to add every eligible selected book to.
 *
 * Deliberately not CollectionPicker: that one loads a single book's memberships
 * and toggles them, which has no meaning for a mixed selection where each book
 * belongs to a different set.
 */
function CollectionMenu({
  collections,
  disabled,
  count,
  onPick
}: {
  collections: Collection[]
  disabled: boolean
  count: number
  onPick: (collectionId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useFocusTrap(ref, { onEscape: open ? () => setOpen(false) : undefined })

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded-md text-xs text-gray-300 whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <svg aria-hidden="true" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
        </svg>
        {t('selection.addToCollection')}
        <ActionCount value={count} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute z-50 right-0 top-full mt-1 w-56 max-h-64 overflow-y-auto bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1"
        >
          {collections.length === 0 ? (
            <div className="px-3 py-2 text-gray-500 text-xs">{t('collectionPicker.noCollections')}</div>
          ) : (
            collections.map((collection) => (
              <button
                key={collection.id}
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onPick(collection.id)
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
              >
                <span className="truncate">{collection.name}</span>
                {collection.source === 'calibre' && (
                  <span className="ml-auto text-gray-600 text-xs shrink-0">calibre</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Replaces the grid's normal header while multiple books are selected.
 *
 * Each action reports how many of the selection it can actually touch, because
 * the three eligibility rules differ (see utils/bulkSelection) and a mixed
 * selection is normal — the alternative, refusing to select an ineligible book,
 * would leave the user wondering why a card would not highlight.
 */
export function SelectionToolbar({
  selectedCount,
  sendableCount,
  removableCount,
  collectableCount,
  collections,
  isDeviceConnected,
  progress,
  isRunning,
  onSelectAll,
  onClear,
  onExit,
  onSend,
  onRemove,
  onAddToCollection,
  onStop
}: SelectionToolbarProps) {
  const { t } = useTranslation()
  const canSend = isDeviceConnected && sendableCount > 0 && !isRunning

  return (
    <div className="mb-4 shrink-0 rounded-lg border border-indigo-700/60 bg-indigo-950/40">
      <div className="flex items-center justify-between gap-3 px-3 py-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-indigo-200 text-sm font-medium whitespace-nowrap">
            {t('selection.count', { count: selectedCount })}
          </span>
          <button
            onClick={onSelectAll}
            disabled={isRunning}
            className="text-indigo-400 text-xs hover:underline disabled:opacity-40 disabled:no-underline whitespace-nowrap"
          >
            {t('selection.selectAll')}
          </button>
          <button
            onClick={onClear}
            disabled={isRunning || selectedCount === 0}
            className="text-indigo-400 text-xs hover:underline disabled:opacity-40 disabled:no-underline whitespace-nowrap"
          >
            {t('selection.clear')}
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={onSend}
            disabled={!canSend}
            title={isDeviceConnected ? t('selection.send') : t('library.connectToSend')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 border border-indigo-500 rounded-md text-xs text-white whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg aria-hidden="true" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            {t('selection.send')}
            <ActionCount value={sendableCount} />
          </button>

          <CollectionMenu
            collections={collections}
            disabled={collectableCount === 0 || isRunning}
            count={collectableCount}
            onPick={onAddToCollection}
          />

          <button
            onClick={onRemove}
            disabled={removableCount === 0 || isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-red-900/60 border border-gray-600 hover:border-red-700 rounded-md text-xs text-gray-300 hover:text-red-200 whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg aria-hidden="true" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {t('selection.remove')}
            <ActionCount value={removableCount} />
          </button>

          <button
            onClick={onExit}
            disabled={isRunning}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            {t('selection.exit')}
          </button>
        </div>
      </div>

      {progress && (
        <div className="px-3 pb-2.5 pt-0.5" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 mb-1">
            <span className="text-indigo-200 text-xs truncate">
              {t('selection.progress', { done: progress.done, total: progress.total })} —{' '}
              {progress.phase === 'uploading' ? t('library.uploading') : t('library.converting')}{' '}
              {progress.percent}%
            </span>
            <button
              onClick={onStop}
              className="text-indigo-300 text-xs hover:underline shrink-0 whitespace-nowrap"
            >
              {t('selection.stop')}
            </button>
          </div>
          <div
            className="h-1.5 bg-gray-800 rounded overflow-hidden"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
          >
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
