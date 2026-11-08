import { useCallback, useEffect, useState } from 'react'
import type { Collection, FirstSyncAnswer, KindleBook, KindleDrive, KindleSyncState } from '../../../preload/api'
import { createLatestGate } from '../utils/latestGate'
import { shouldOfferFirstSync } from '../utils/kindleSyncView'
import type { ReportedRun } from './useReportedRun'

/**
 * Collections and books change in bursts (a connect loads both, a bulk edit
 * touches many): the desired state is rewritten once they stop changing.
 */
const REFRESH_SETTLE_MS = 800

export interface KindleSync {
  /** Null while unknown (no Kindle, or the first refresh not back yet). */
  state: KindleSyncState | null
  isFirstSyncOpen: boolean
  isAnswering: boolean
  openFirstSync: () => void
  /** "Later": closes the question and stops offering it by itself for this Kindle. */
  postponeFirstSync: () => void
  answerFirstSync: (answer: FirstSyncAnswer) => Promise<void>
  isInstallOpen: boolean
  isInstalling: boolean
  openInstall: () => void
  closeInstall: () => void
  /** Stages the sync on the Kindle; the header then asks for the restart. */
  install: () => Promise<void>
}

interface KindleSyncOptions {
  kindle: KindleDrive | null
  /** Watched only to know when to refresh: the main process reads the stores itself. */
  collections: Collection[]
  books: KindleBook[]
  reportError: ReportedRun['reportError']
  run: ReportedRun['run']
  /** An import created app collections: the sidebar must show them. */
  onCollectionsImported: () => Promise<void>
}

/**
 * The connected Kindle's collection sync: its state for the header, refreshed
 * on connect and after every change to the collections or the device's books
 * (each refresh also rewrites desired.json for the next unplug), and the
 * first-sync question.
 */
export function useKindleSync({
  kindle,
  collections,
  books,
  reportError,
  run,
  onCollectionsImported
}: KindleSyncOptions): KindleSync {
  const [state, setState] = useState<KindleSyncState | null>(null)
  const [isAnswering, setIsAnswering] = useState(false)
  const [isFirstSyncRequested, setIsFirstSyncRequested] = useState(false)
  const [isInstallOpen, setIsInstallOpen] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)
  const [postponedDeviceIds, setPostponedDeviceIds] = useState<ReadonlySet<string>>(() => new Set())
  // Refreshes and answers may overlap; only the newest reply may land.
  const [gate] = useState(createLatestGate)
  const mountpoint = kindle?.mountpoint ?? null

  // Another Kindle (or none): the previous state no longer describes it, and
  // a reply still in flight for it must not land.
  useEffect(() => {
    gate.begin()
    setState(null)
  }, [mountpoint, gate])

  useEffect(() => {
    if (mountpoint === null) return
    const timer = setTimeout(() => {
      const isLatest = gate.begin()
      window.kindleAPI
        .refreshKindleSync(mountpoint)
        .then((next) => {
          if (isLatest()) setState(next)
        })
        .catch((err: unknown) => {
          if (isLatest()) reportError(err, 'errors.kindleSyncRefresh')
        })
    }, REFRESH_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [mountpoint, collections, books, gate, reportError])

  const answerFirstSync = useCallback(
    async (answer: FirstSyncAnswer): Promise<void> => {
      if (mountpoint === null) return
      setIsAnswering(true)
      const isLatest = gate.begin()
      const outcome = await run('errors.kindleSyncAnswer', () => window.kindleAPI.answerFirstSync(mountpoint, answer))
      setIsAnswering(false)
      if (!outcome.ok) return
      if (isLatest()) setState(outcome.value)
      setIsFirstSyncRequested(false)
      if (answer === 'import') await onCollectionsImported()
    },
    [mountpoint, gate, run, onCollectionsImported]
  )

  const postponeFirstSync = useCallback(() => {
    setIsFirstSyncRequested(false)
    if (state?.kind !== 'first-sync') return
    const deviceId = state.status.deviceId
    setPostponedDeviceIds((previous) => new Set([...previous, deviceId]))
  }, [state])

  const openFirstSync = useCallback(() => setIsFirstSyncRequested(true), [])

  const install = useCallback(async (): Promise<void> => {
    if (mountpoint === null) return
    setIsInstalling(true)
    const isLatest = gate.begin()
    const outcome = await run('errors.kindleSyncInstall', () => window.kindleAPI.installKindleSync(mountpoint))
    setIsInstalling(false)
    if (!outcome.ok) return
    if (isLatest()) setState(outcome.value)
    setIsInstallOpen(false)
  }, [mountpoint, gate, run])

  const openInstall = useCallback(() => setIsInstallOpen(true), [])
  const closeInstall = useCallback(() => setIsInstallOpen(false), [])

  const isFirstSyncOpen =
    state?.kind === 'first-sync' && (isFirstSyncRequested || shouldOfferFirstSync(state, postponedDeviceIds))

  return {
    state,
    isFirstSyncOpen,
    isAnswering,
    openFirstSync,
    postponeFirstSync,
    answerFirstSync,
    isInstallOpen: isInstallOpen && mountpoint !== null,
    isInstalling,
    openInstall,
    closeInstall,
    install
  }
}
