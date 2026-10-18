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

export interface DeleteFromKindle {
  /** Asks for confirmation, deletes, reports the outcome. Resolves once everything is refreshed. */
  deleteBooks: (books: readonly DisplayBook[]) => Promise<void>
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
      if (!mountpoint || books.length === 0) return
      if (!window.confirm(t('selection.confirmDeleteFromKindle', { count: books.length }))) return
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
      } catch (err) {
        console.error('[bulk-delete] failed:', err)
        onNotify('error', t(errorMessageKey(err, 'library.deleteError')))
      }
      onLibraryChanged()
      await refreshCollections()
    },
    [mountpoint, t, onNotify, onLibraryChanged, refreshCollections]
  )

  return { deleteBooks, refreshCollections }
}
