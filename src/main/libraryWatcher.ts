import { watch as fsWatch } from 'fs'
import { listLibraryFolders, type LibraryFolder } from './library'
import {
  addLibraryFolder,
  removeLibraryFolder,
  syncAllLibraryFolders,
  syncLibraryFolder,
  type FolderSyncResult
} from './libraryFolders'

/**
 * Keeps the library in step with its folders while the app runs: every folder
 * gets a recursive filesystem watcher, and once a folder has been quiet for a
 * moment it is synced and the renderer is told the library changed.
 *
 * Watching is best-effort. Network shares and some external disks deliver no
 * events, and a watcher dies with its disk — so the renderer also asks for a
 * full sync when the window regains focus, which re-arms dead watchers too.
 */

/** How long a folder must stay quiet before it is rescanned: lets a copy in progress finish. */
export const FOLDER_SETTLE_MS = 1500

export interface FolderWatch {
  close: () => void
}

/** Starts watching `dir` recursively. `filename` is relative to `dir`, or null when the OS does not say. */
export type WatchFn = (
  dir: string,
  onEvent: (filename: string | null) => void,
  onError: (err: unknown) => void
) => FolderWatch

export interface FolderWatcherOptions {
  watch?: WatchFn
  debounceMs?: number
}

export interface FolderWatchers {
  /** Watches exactly these folders: starts new ones, stops dropped ones, re-arms failed ones. */
  watch: (folders: readonly LibraryFolder[]) => void
  close: () => void
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const watchRecursively: WatchFn = (dir, onEvent, onError) => {
  // persistent: false — a watcher must never be what keeps the process alive.
  const watcher = fsWatch(dir, { recursive: true, persistent: false }, (_event, filename) =>
    onEvent(filename ?? null)
  )
  watcher.on('error', onError)
  return { close: () => watcher.close() }
}

/** Changes the scan ignores anyway: .DS_Store, editor swap files, anything under a dot-folder. */
function isHiddenChange(filename: string | null): boolean {
  return filename !== null && filename.split(/[\\/]/).some((part) => part.startsWith('.'))
}

export function createFolderWatchers(
  onChange: (folderId: string) => void,
  options: FolderWatcherOptions = {}
): FolderWatchers {
  const watchFn = options.watch ?? watchRecursively
  const debounceMs = options.debounceMs ?? FOLDER_SETTLE_MS
  const active = new Map<string, { path: string; handle: FolderWatch }>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function cancel(folderId: string): void {
    clearTimeout(timers.get(folderId))
    timers.delete(folderId)
  }

  function schedule(folderId: string): void {
    cancel(folderId)
    timers.set(
      folderId,
      setTimeout(() => {
        timers.delete(folderId)
        onChange(folderId)
      }, debounceMs)
    )
  }

  function stop(folderId: string): void {
    active.get(folderId)?.handle.close()
    active.delete(folderId)
    cancel(folderId)
  }

  function start(folder: LibraryFolder): void {
    let handle: FolderWatch | undefined
    const onEvent = (filename: string | null): void => {
      if (!isHiddenChange(filename)) schedule(folder.id)
    }
    const onError = (err: unknown): void => {
      if (!handle || active.get(folder.id)?.handle !== handle) return
      console.error(`[library-watcher] Stopped watching "${folder.path}":`, errorText(err))
      handle.close()
      active.delete(folder.id)
      // Whatever broke the watcher (an unplugged disk) is worth a sync.
      schedule(folder.id)
    }
    try {
      handle = watchFn(folder.path, onEvent, onError)
      active.set(folder.id, { path: folder.path, handle })
    } catch (err) {
      console.error(`[library-watcher] Cannot watch "${folder.path}":`, errorText(err))
    }
  }

  return {
    watch(folders) {
      const wanted = new Map(folders.map((folder) => [folder.id, folder]))
      for (const [folderId, running] of [...active]) {
        if (wanted.get(folderId)?.path !== running.path) stop(folderId)
      }
      for (const folderId of [...timers.keys()]) {
        if (!wanted.has(folderId)) cancel(folderId)
      }
      for (const folder of folders) {
        if (!active.has(folder.id)) start(folder)
      }
    },

    close() {
      for (const folderId of [...active.keys()]) stop(folderId)
      for (const folderId of [...timers.keys()]) cancel(folderId)
    }
  }
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export interface LinkedFolder {
  folder: LibraryFolder
  result: FolderSyncResult
}

export interface LibraryFolderWatching {
  /** Watches the folders currently in the library; re-arms watchers that died. */
  refresh: () => void
  /** Adds a folder, starts watching it and reads it. */
  link: (folderPath: string) => Promise<LinkedFolder>
  /** Stops watching a folder and drops it (and its books) from the library. */
  forget: (folderId: string) => Promise<void>
  /** Syncs every folder (and re-arms the watchers). */
  syncAll: () => Promise<FolderSyncResult[]>
  stop: () => void
}

function changedSomething(result: FolderSyncResult): boolean {
  return result.added + result.updated + result.removed > 0
}

/** `notify` is called whenever the library's books changed, so the renderer reloads them. */
export function startLibraryFolderWatching(
  notify: () => void,
  options: FolderWatcherOptions = {}
): LibraryFolderWatching {
  const announce = (results: readonly FolderSyncResult[]): void => {
    if (results.some(changedSomething)) notify()
  }

  const sync = async (folderId: string): Promise<FolderSyncResult> => {
    const result = await syncLibraryFolder(folderId)
    announce([result])
    return result
  }

  const watchers = createFolderWatchers((folderId) => {
    sync(folderId).catch((err: unknown) => {
      console.error('[library-watcher] Sync after a change failed:', errorText(err))
    })
  }, options)

  const refresh = (): void => watchers.watch(listLibraryFolders())

  return {
    refresh,

    async link(folderPath) {
      const folder = await addLibraryFolder(folderPath)
      refresh()
      return { folder, result: await sync(folder.id) }
    },

    async forget(folderId) {
      await removeLibraryFolder(folderId)
      refresh()
      notify()
    },

    async syncAll() {
      refresh()
      const results = await syncAllLibraryFolders()
      announce(results)
      return results
    },

    stop: () => watchers.close()
  }
}
