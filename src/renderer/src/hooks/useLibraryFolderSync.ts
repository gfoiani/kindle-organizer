import { useEffect } from 'react'

/** A focus-triggered rescan runs at most this often: it costs one stat per book. */
const FOCUS_SYNC_INTERVAL_MS = 60_000

/**
 * Keeps the library in step with its folders. The main process watches them
 * and pushes `library:changed` after a sync that changed something; this
 * reloads the library then. When the window regains focus it also asks for a
 * full rescan — the safety net for folders whose watcher gets no events
 * (network shares, some external disks) or died with its disk.
 */
export function useLibraryFolderSync(loadLibrary: () => Promise<void>): void {
  useEffect(() => window.kindleAPI.onLibraryChanged(() => void loadLibrary()), [loadLibrary])

  useEffect(() => {
    // The main process already syncs every folder at startup.
    let lastSync = Date.now()
    const onFocus = (): void => {
      const now = Date.now()
      if (now - lastSync < FOCUS_SYNC_INTERVAL_MS) return
      lastSync = now
      window.kindleAPI
        .syncLibraryFolders()
        .catch((err) => console.error('[library-folders] Sync on focus failed:', err))
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
}
