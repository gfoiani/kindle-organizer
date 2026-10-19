import { Menu, BrowserWindow, app } from 'electron'

/** Translatable labels for the custom menu items, supplied by the renderer. */
export interface MenuLabels {
  about: string
  learnMore: string
}

// English defaults — used until the renderer pushes the active language's labels.
const DEFAULT_LABELS: MenuLabels = {
  about: `About ${app.name}`,
  learnMore: 'Learn More'
}

let currentWindow: BrowserWindow | null = null
let currentLabels: MenuLabels = DEFAULT_LABELS

/**
 * Shows the app's About page, or the system About panel when there is no
 * window to show it in: on macOS the app (and its menu) outlive the window.
 */
function showAbout(): void {
  if (currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.webContents.send('show-about')
  } else {
    app.showAboutPanel()
  }
}

function buildMenu(labels: MenuLabels): Menu {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              {
                label: labels.about,
                click: showAbout
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      role: 'fileMenu'
    },
    {
      role: 'editMenu'
    },
    {
      role: 'viewMenu'
    },
    {
      role: 'windowMenu'
    },
    {
      role: 'help',
      submenu: [
        {
          label: labels.learnMore,
          click: async (): Promise<void> => {
            const { shell } = await import('electron')
            await shell.openExternal('https://github.com/gfoiani/kindle-organizer')
          }
        },
        ...(!isMac
          ? ([
              { type: 'separator' },
              {
                label: labels.about,
                click: showAbout
              }
            ] as Electron.MenuItemConstructorOptions[])
          : [])
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

export function setupMenu(mainWindow: BrowserWindow): void {
  currentWindow = mainWindow
  Menu.setApplicationMenu(buildMenu(currentLabels))
}

/**
 * Pops the application menu open at a point in the window, for the renderer's
 * title-bar menu button.
 *
 * Windows/Linux only in practice: hiding the native title bar makes the window
 * frameless (`has_frame_ = frame && titleBarStyle == normal`), and Electron
 * skips building a menu bar for frameless windows — the accelerators still
 * register, but nothing draws the File/Edit/View/Window/Help strip. Without
 * this the menu would have no pointer affordance at all. macOS is unaffected:
 * its menu lives in the system bar, not the window.
 */
export function popupAppMenu(x: number, y: number): void {
  const menu = Menu.getApplicationMenu()
  if (!menu || !currentWindow || currentWindow.isDestroyed()) return
  menu.popup({ window: currentWindow, x, y })
}

/**
 * Rebuilds the application menu with localized labels. Called over IPC by the
 * renderer whenever the UI language changes, so the native menu's custom items
 * ("About …", "Learn More") track the selected language instead of staying
 * hardcoded English.
 */
export function setMenuLabels(labels: MenuLabels): void {
  currentLabels = labels
  Menu.setApplicationMenu(buildMenu(currentLabels))
}
