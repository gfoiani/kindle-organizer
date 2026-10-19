import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { Collection, KindleBook, KindleDrive } from '../../../preload/api'

export interface KindleDevice {
  kindle: KindleDrive | null
  books: KindleBook[]
  setBooks: Dispatch<SetStateAction<KindleBook[]>>
  collections: Collection[]
  setCollections: Dispatch<SetStateAction<Collection[]>>
  /** Whether the first detect+scan cycle has finished; never goes back to false. */
  hasResolvedDevice: boolean
  isLoadingDrive: boolean
  isLoadingBooks: boolean
  isLoadingCollections: boolean
  /** Detects the Kindle, then reads its books and collections. Stable. */
  loadKindle: () => Promise<void>
  reloadCollections: () => Promise<void>
  /** Re-reads the connected device's books, as part of the load in progress. */
  reloadBooks: () => Promise<void>
}

/**
 * The connected Kindle and what is on it, reloaded on plug/unplug. `onNewDevice`
 * runs whenever a detection lands (the collection view belongs to the old
 * device) and must be stable.
 */
export function useKindleDevice(
  reportError: (err: unknown, fallbackKey: string) => void,
  onNewDevice: () => void
): KindleDevice {
  const [kindle, setKindle] = useState<KindleDrive | null>(null)
  const [books, setBooks] = useState<KindleBook[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [isLoadingDrive, setIsLoadingDrive] = useState(true)
  // Gates the grid's initial render (see utils/loadingPhase): later refreshes
  // revalidate in place instead of blanking the list.
  const [hasResolvedDevice, setHasResolvedDevice] = useState(false)
  const [isLoadingBooks, setIsLoadingBooks] = useState(false)
  const [isLoadingCollections, setIsLoadingCollections] = useState(false)

  // Monotonic request id: rapid plug/unplug/Refresh can fire overlapping
  // loadKindle() calls. Each call captures the id at start and re-checks it
  // before every setState so only the most-recent load wins (stale ones no-op).
  const loadRequestId = useRef(0)

  const loadBooks = useCallback(
    async (mountpoint: string, requestId: number) => {
      setIsLoadingBooks(true)
      try {
        const result = await window.kindleAPI.readDocuments(mountpoint)
        if (loadRequestId.current === requestId) setBooks(result)
      } catch (err) {
        if (loadRequestId.current === requestId) {
          setBooks([])
          reportError(err, 'errors.loadBooks')
        }
      } finally {
        if (loadRequestId.current === requestId) setIsLoadingBooks(false)
      }
    },
    [reportError]
  )

  const loadCollections = useCallback(
    async (mountpoint: string, requestId: number) => {
      setIsLoadingCollections(true)
      try {
        await window.kindleAPI.syncCalibre(mountpoint)
        const result = await window.kindleAPI.getLocalCollections()
        if (loadRequestId.current === requestId) setCollections(result)
      } catch (err) {
        if (loadRequestId.current === requestId) {
          setCollections([])
          reportError(err, 'errors.loadCollections')
        }
      } finally {
        if (loadRequestId.current === requestId) setIsLoadingCollections(false)
      }
    },
    [reportError]
  )

  const reloadCollections = useCallback(async () => {
    try {
      setCollections(await window.kindleAPI.getLocalCollections())
    } catch (err) {
      reportError(err, 'errors.loadCollections')
    }
  }, [reportError])

  const loadKindle = useCallback(async () => {
    const requestId = ++loadRequestId.current
    setIsLoadingDrive(true)
    try {
      const drives = await window.kindleAPI.detectKindleDrives()
      if (loadRequestId.current !== requestId) return
      const found = drives[0] ?? null
      setKindle(found)
      onNewDevice()

      if (found) {
        await Promise.all([loadBooks(found.mountpoint, requestId), loadCollections(found.mountpoint, requestId)])
      } else {
        setBooks([])
        setCollections([])
      }
    } catch (err) {
      reportError(err, 'errors.detectDrives')
    } finally {
      // Resolved either way — a failed detection is still an answer, and the
      // grid must not stay stuck behind the loading gate because of it.
      if (loadRequestId.current === requestId) {
        setIsLoadingDrive(false)
        setHasResolvedDevice(true)
      }
    }
  }, [loadBooks, loadCollections, onNewDevice, reportError])

  const reloadBooks = useCallback(async () => {
    if (!kindle) return
    // Reuse the current request id. Taking a new one would orphan a device
    // load still in flight: its loading flags are cleared only by the newest
    // request, so Refresh and the collections would spin forever.
    await loadBooks(kindle.mountpoint, loadRequestId.current)
  }, [kindle, loadBooks])

  // Auto-detect Kindle connect/disconnect while the app is running.
  useEffect(() => {
    const unsubConnect = window.kindleAPI.onKindleConnected(() => {
      loadKindle()
    })
    const unsubDisconnect = window.kindleAPI.onKindleDisconnected(() => {
      loadKindle()
    })
    return () => {
      unsubConnect()
      unsubDisconnect()
    }
  }, [loadKindle])

  return {
    kindle,
    books,
    setBooks,
    collections,
    setCollections,
    hasResolvedDevice,
    isLoadingDrive,
    isLoadingBooks,
    isLoadingCollections,
    loadKindle,
    reloadCollections,
    reloadBooks
  }
}
