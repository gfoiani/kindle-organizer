import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { vi } from 'vitest'

/**
 * Mocks the `electron` module so main-process modules (which do
 * `import { app } from 'electron'`) can be imported and exercised under Vitest.
 *
 * `app.getPath('userData')` returns the CURRENT per-test temp directory. Tests
 * call `freshUserData()` in `beforeEach` to get an isolated SQLite store, so the
 * `localCollections` / `bookOverrides` DBs never leak state across tests or
 * touch a real user profile.
 */
let currentUserData = mkdtempSync(path.join(tmpdir(), 'kindle-organizer-test-'))
const createdDirs: string[] = [currentUserData]

/** Points `app.getPath('userData')` at a brand-new empty temp dir; returns it. */
export function freshUserData(): string {
  currentUserData = mkdtempSync(path.join(tmpdir(), 'kindle-organizer-test-'))
  createdDirs.push(currentUserData)
  return currentUserData
}

/** What `app.getAppPath()` returns (where the dev build looks for bundled files); the repo by default. */
let currentAppPath = process.cwd()

export function setAppPath(dir: string): void {
  currentAppPath = dir
}

/** Best-effort cleanup of every temp userData dir created during the run. */
export function cleanupUserDataDirs(): void {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Every `ipcMain.handle` registration, by channel — see `invokeIpc`. */
const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

/**
 * Calls the handler `registerIpcHandlers` registered for `channel`, the way
 * the renderer's `ipcRenderer.invoke` would (with a minimal sender).
 */
export async function invokeIpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No IPC handler registered for "${channel}"`)
  const event = { sender: { isDestroyed: () => false, send: vi.fn() } }
  return handler(event, ...args)
}

vi.mock('electron', () => ({
  app: {
    name: 'Kindle Organizer',
    isPackaged: false,
    showAboutPanel: vi.fn(),
    getVersion: () => '0.0.0',
    getAppPath: () => currentAppPath,
    getPath: (name: string) => {
      if (name === 'userData') return currentUserData
      return path.join(currentUserData, name)
    }
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    }
  },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  // `Menu` records what it is given, so menu.ts can be exercised: a built menu
  // is just its template, and the application menu is whatever was set last.
  Menu: (() => {
    let applicationMenu: unknown = null
    return {
      buildFromTemplate: (template: unknown[]) => ({ template, popup: vi.fn() }),
      setApplicationMenu: (menu: unknown) => {
        applicationMenu = menu
      },
      getApplicationMenu: () => applicationMenu
    }
  })(),
  // Minimal `protocol` stub so coverProtocol.ts can be imported under Vitest.
  // The pure request handler (handleCoverRequest) is what tests exercise; the
  // register* helpers just need to not throw when referenced.
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: () => {}
  },
  // `nativeImage` has no Vitest-side implementation (it is Chromium's image
  // decoder), so the stub reports an EMPTY image. That is a real production
  // state — an undecodable buffer — and it drives `kindleThumbnails.toKindleJpeg`
  // down its fallback branch, where the original bytes are written unchanged.
  // Tests therefore assert our policy (naming, location, atomicity) against
  // known bytes; the resize/re-encode itself is Electron's code, not ours.
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: () => {
        throw new Error('nativeImage.resize is not stubbed: an empty image must never be resized')
      },
      toJPEG: () => Buffer.alloc(0)
    })
  }
}))
