import { app, BrowserWindow, shell } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import path from 'path'
import { registerIpcHandlers } from './ipc'
import { setupMenu } from './menu'
import { startCoverRetryLoop, cancelAllCovers } from './covers'
import { registerCoverSchemePrivileges, registerCoverProtocol } from './coverProtocol'
import { startKindleWatcher } from './kindle'
import { closeOverridesDb } from './bookOverrides'
import { closeCollectionsDb } from './localCollections'
import { closeLibraryDb } from './library'

const WINDOW_WIDTH = 1200
const WINDOW_HEIGHT = 780

/**
 * Window-chrome theme. The native title bar is hidden on every platform and the
 * renderer paints its own (`components/TitleBar.tsx`), so the bar is the same
 * colour as the app instead of following the OS light/dark appearance.
 *
 * `THEME_BACKGROUND` must stay in sync with the renderer's `bg-gray-900`, and
 * `TITLE_BAR_HEIGHT` with `TITLE_BAR_HEIGHT_PX` in `TitleBar.tsx` — on
 * Windows/Linux the native control overlay is drawn at exactly this height.
 */
const THEME_BACKGROUND = '#111827'
const THEME_SYMBOL_COLOR = '#e5e7eb'
const TITLE_BAR_HEIGHT = 38
/** macOS traffic-light group: its box size, used to centre it in the bar. */
const TRAFFIC_LIGHT_SIZE = 16
const TRAFFIC_LIGHT_INSET_X = 16

type WindowChrome = Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'
>

/**
 * Hides the native title bar so the renderer can draw a themed one. macOS keeps
 * its traffic lights (centred in our bar); Windows/Linux get a native
 * minimise/maximise/close overlay painted in the theme colours.
 */
function themedWindowChrome(): WindowChrome {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: {
        x: TRAFFIC_LIGHT_INSET_X,
        y: Math.round((TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2)
      }
    }
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: THEME_BACKGROUND,
      symbolColor: THEME_SYMBOL_COLOR,
      height: TITLE_BAR_HEIGHT
    }
  }
}

// Schemes we allow to be opened in the user's external browser.
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:'])

// Dev-only verbose logging. Silent in packaged builds.
const debug = (...args: unknown[]): void => {
  if (!app.isPackaged) console.log(...args)
}

/** True if the URL is safe to hand to `shell.openExternal` (https/http only). */
function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)
  } catch (err) {
    debug(`[main] Rejected malformed external URL "${url}":`, err instanceof Error ? err.message : String(err))
    return false
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 800,
    minHeight: 600,
    title: 'Kindle Organizer',
    backgroundColor: THEME_BACKGROUND,
    ...themedWindowChrome(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Set up the system menu
  setupMenu(win)

  // Open external links in the browser instead of the app — but only for
  // http(s) URLs. Anything else (file:, custom schemes) is rejected and logged.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url).catch((err) => {
        debug(`[main] openExternal failed for "${url}":`, err instanceof Error ? err.message : String(err))
      })
    } else {
      debug(`[main] Blocked window-open for disallowed URL "${url}"`)
    }
    return { action: 'deny' }
  })

  const startUrl =
    !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : undefined

  // Lock navigation to the loaded origin: foreign navigations are blocked and
  // (when http/https) re-routed to the external browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL()
    try {
      const target = new URL(url)
      const current = new URL(currentUrl)
      if (target.origin === current.origin) return
    } catch (err) {
      debug(`[main] will-navigate: failed to parse URL "${url}":`, err instanceof Error ? err.message : String(err))
    }
    event.preventDefault()
    debug(`[main] Blocked in-app navigation to "${url}"`)
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url).catch((err) => {
        debug(`[main] openExternal failed for "${url}":`, err instanceof Error ? err.message : String(err))
      })
    }
  })

  if (startUrl) {
    win.loadURL(startUrl)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

/** Sends an IPC message to a window only when it is still alive. */
function safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

// The cover-cache:// scheme must be registered as privileged BEFORE app `ready`.
registerCoverSchemePrivileges()

app.whenReady().then(() => {
  registerIpcHandlers()
  registerCoverProtocol()
  createWindow()

  const stopRetryLoop = startCoverRetryLoop(() => BrowserWindow.getAllWindows()[0] ?? null)

  const stopWatcher = startKindleWatcher(
    (drive) => safeSend(BrowserWindow.getAllWindows()[0] ?? null, 'kindle:connected', drive),
    (drive) => safeSend(BrowserWindow.getAllWindows()[0] ?? null, 'kindle:disconnected', drive)
  )

  // Single teardown point for every long-lived resource: the retry interval,
  // the hot-plug poll, and the three cached SQLite handles.
  app.on('will-quit', () => {
    stopRetryLoop()
    stopWatcher()
    closeOverridesDb()
    closeCollectionsDb()
    closeLibraryDb()
    cancelAllCovers()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
