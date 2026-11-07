import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FirstSyncAnswer, KindleCollectionSummary } from '../../../preload/api'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { sortKindleCollections } from '../utils/kindleSyncView'

interface FirstSyncDialogProps {
  /** Null when the Kindle's own list could not be read. */
  kindleCollections: KindleCollectionSummary[] | null
  isAnswering: boolean
  onAnswer: (answer: FirstSyncAnswer) => void
  onPostpone: () => void
}

const BUTTON = 'px-3 py-1.5 rounded-md text-sm transition-colors disabled:opacity-50'
const SECONDARY = `${BUTTON} bg-gray-700 hover:bg-gray-600 text-gray-200`
const DANGER = `${BUTTON} bg-red-900/60 hover:bg-red-800 border border-red-700 text-red-100`
const PRIMARY = `${BUTTON} bg-indigo-600 hover:bg-indigo-500 text-white`

function KindleCollectionList({ collections }: { collections: KindleCollectionSummary[] | null }) {
  const { t } = useTranslation()
  if (collections === null) return <p className="text-amber-200 text-sm">{t('kindleSync.dialog.unreadable')}</p>
  if (collections.length === 0) return <p className="text-gray-300 text-sm">{t('kindleSync.dialog.kindleHasNone')}</p>
  return (
    <>
      <p className="text-gray-300 text-sm">{t('kindleSync.dialog.kindleHas')}</p>
      <ul className="max-h-60 overflow-y-auto rounded-md border border-gray-700 divide-y divide-gray-700">
        {collections.map((collection) => (
          <li key={collection.name} className="flex justify-between gap-4 px-3 py-1.5 text-sm">
            <span className="text-gray-100 truncate">{collection.name}</span>
            <span className="text-gray-400 shrink-0">{t('kindleSync.dialog.books', { count: collection.bookCount })}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * The first-sync question: before the first mirror, the Kindle's existing
 * collections are either imported into the app or left to be removed. Removing
 * takes a second click, since the Kindle drops them at the next unplug.
 */
export function FirstSyncDialog({ kindleCollections, isAnswering, onAnswer, onPostpone }: FirstSyncDialogProps) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false)
  useFocusTrap(dialogRef, { onEscape: isAnswering ? undefined : onPostpone, trapTab: true })

  const sorted = useMemo(() => kindleCollections && sortKindleCollections(kindleCollections), [kindleCollections])
  const hasNothingToKeep = sorted !== null && sorted.length === 0

  return (
    <div className="app-no-drag fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg flex flex-col gap-4 p-5"
      >
        <h2 id={titleId} className="flex items-center gap-2 text-white font-semibold">
          {t('kindleSync.dialog.title')}
          <span className="uppercase tracking-wide text-[10px] text-indigo-300 border border-indigo-500/60 rounded px-1.5 py-0.5">
            {t('kindleSync.experimental')}
          </span>
        </h2>
        <p className="text-gray-300 text-sm">{t('kindleSync.dialog.intro')}</p>
        <KindleCollectionList collections={sorted} />

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" onClick={onPostpone} disabled={isAnswering} className={SECONDARY}>
            {t('kindleSync.dialog.later')}
          </button>
          {hasNothingToKeep ? (
            <button type="button" onClick={() => onAnswer('discard')} disabled={isAnswering} className={PRIMARY}>
              {isAnswering ? t('kindleSync.dialog.working') : t('kindleSync.dialog.start')}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => (isConfirmingDiscard ? onAnswer('discard') : setIsConfirmingDiscard(true))}
                disabled={isAnswering}
                title={t('kindleSync.dialog.discardHint')}
                className={DANGER}
              >
                {isConfirmingDiscard ? t('kindleSync.dialog.confirmDiscard') : t('kindleSync.dialog.discard')}
              </button>
              <button
                type="button"
                onClick={() => onAnswer('import')}
                disabled={isAnswering || sorted === null}
                title={t('kindleSync.dialog.importHint')}
                className={PRIMARY}
              >
                {isAnswering ? t('kindleSync.dialog.working') : t('kindleSync.dialog.import')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
