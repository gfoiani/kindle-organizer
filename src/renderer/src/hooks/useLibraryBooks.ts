import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LibraryBook } from '../../../preload/api'
import { createLatestGate } from '../utils/latestGate'

/** How long the drag-and-drop add summary toast stays up (ms). */
const DROP_SUMMARY_RESET_MS = 6000

interface LibraryBooksOptions {
  reportError: (err: unknown, fallbackKey: string) => void
  showInfo: (message: string, durationMs?: number) => void
  showError: (message: string, durationMs?: number) => void
}

export interface LibraryBooks {
  libraryBooks: LibraryBook[]
  /** Re-reads the library; of overlapping reloads only the newest applies. Stable. */
  loadLibrary: () => Promise<void>
  /** Imports dropped files into the library and announces a per-status summary. */
  addDroppedFiles: (files: File[]) => Promise<void>
}

/** The staging library: dropped books and the books of the library folders. */
export function useLibraryBooks({ reportError, showInfo, showError }: LibraryBooksOptions): LibraryBooks {
  const { t } = useTranslation()
  const [libraryBooks, setLibraryBooks] = useState<LibraryBook[]>([])

  // A folder push, a window focus and a send can all reload the library at once.
  const [libraryLoads] = useState(createLatestGate)
  const loadLibrary = useCallback(async () => {
    const isLatest = libraryLoads.begin()
    try {
      const result = await window.kindleAPI.getLibrary()
      if (isLatest()) setLibraryBooks(result)
    } catch (err) {
      if (isLatest()) reportError(err, 'errors.loadLibrary')
    }
  }, [libraryLoads, reportError])

  const addDroppedFiles = useCallback(
    async (files: File[]) => {
      const paths = files.map((file) => window.kindleAPI.getPathForFile(file)).filter((p) => p.length > 0)
      if (paths.length === 0) return
      try {
        const results = await window.kindleAPI.addBooks(paths)
        await loadLibrary()

        const counts = {
          added: results.filter((r) => r.status === 'added').length,
          duplicate: results.filter((r) => r.status === 'duplicate').length,
          unsupported: results.filter((r) => r.status === 'unsupported').length,
          error: results.filter((r) => r.status === 'error').length
        }
        const summary = [
          counts.added > 0 ? t('library.added', { count: counts.added }) : null,
          counts.duplicate > 0 ? t('library.duplicate', { count: counts.duplicate }) : null,
          counts.unsupported > 0 ? t('library.unsupported', { count: counts.unsupported }) : null,
          counts.error > 0 ? t('library.addError', { count: counts.error }) : null
        ]
          .filter(Boolean)
          .join(', ')
        if (!summary) return

        // A rejected or unreadable file is a failure, not a confirmation.
        const hasFailures = counts.unsupported + counts.error > 0
        if (hasFailures) showError(summary, DROP_SUMMARY_RESET_MS)
        else showInfo(summary, DROP_SUMMARY_RESET_MS)
      } catch (err) {
        reportError(err, 'errors.addBooks')
      }
    },
    [loadLibrary, reportError, showError, showInfo, t]
  )

  return { libraryBooks, loadLibrary, addDroppedFiles }
}
