import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Collection } from '../../../preload/api'
import type { DisplayBook } from '../utils/mergeBooks'
import type { NoticeKind } from './useNotice'
import { errorMessageKey } from '../utils/appError'

interface DeleteFromKindleOptions {
  mountpoint: string | null
  onNotify: (kind: NoticeKind, message: string) => void
  /** Rescans device + library so the deleted cards go away. */
  onLibraryChanged: () => void
  /** Collection counts change when books leave the device. */
  onCollectionsChanged: (collections: Collection[]) => void
}

/** How a delete went: whether it ran at all, and the book paths left on the device. */
export interface DeleteOutcome {
  attempted: boolean
  failedPaths: string[]
}

export interface DeleteFromKindle {
  /**
   * Asks for confirmation, deletes, reports the outcome. Resolves once
   * everything is refreshed: not attempted when there was no device, no book,
   * or the user cancelled, so the caller can keep its selection.
   */
  deleteBooks: (books: readonly DisplayBook[]) => Promise<DeleteOutcome>
  /** Re-reads the collection list after books left the device. */
  refreshCollections: () => Promise<void>
}

/** The grid's "Delete from Kindle" flow for one or many selected books. */
export function useDeleteFromKindle({
  mountpoint,
  onNotify,
  onLibraryChanged,
  onCollectionsChanged
}: DeleteFromKindleOptions): DeleteFromKindle {
  const { t } = useTranslation()

  const refreshCollections = useCallback(async () => {
    try {
      onCollectionsChanged(await window.kindleAPI.getLocalCollections())
    } catch (err) {
      console.error('[delete] Could not reload the collections:', err)
    }
  }, [onCollectionsChanged])

  const deleteBooks = useCallback(
    async (books: readonly DisplayBook[]) => {
      const notAttempted: DeleteOutcome = { attempted: false, failedPaths: [] }
      if (!mountpoint || books.length === 0) return notAttempted
      if (!window.confirm(t('selection.confirmDeleteFromKindle', { count: books.length }))) return notAttempted
      // A call that failed as a whole leaves every book where it was.
      let failedPaths = books.map((book) => book.path)
      try {
        const { deleted, failed } = await window.kindleAPI.deleteDeviceBooks(
          mountpoint,
          books.map((book) => book.path)
        )
        const summary = [
          deleted.length > 0 ? t('selection.deletedCount', { count: deleted.length }) : null,
          failed.length > 0 ? t('selection.failedCount', { count: failed.length }) : null
        ]
          .filter(Boolean)
          .join(' · ')
        if (summary) onNotify(failed.length > 0 ? 'error' : 'info', summary)
        failedPaths = failed
      } catch (err) {
        console.error('[bulk-delete] failed:', err)
        onNotify('error', t(errorMessageKey(err, 'library.deleteError')))
      }
      onLibraryChanged()
      await refreshCollections()
      return { attempted: true, failedPaths }
    },
    [mountpoint, t, onNotify, onLibraryChanged, refreshCollections]
  )

  return { deleteBooks, refreshCollections }
}
