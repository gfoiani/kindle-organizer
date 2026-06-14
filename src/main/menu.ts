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

function buildMenu(mainWindow: BrowserWindow, labels: MenuLabels): Menu {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              {
                label: labels.about,
                click: (): void => {
                  mainWindow.webContents.send('show-about')
                }
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
                click: (): void => {
                  mainWindow.webContents.send('show-about')
                }
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
  Menu.setApplicationMenu(buildMenu(mainWindow, currentLabels))
}

/**
 * Rebuilds the application menu with localized labels. Called over IPC by the
 * renderer whenever the UI language changes, so the native menu's custom items
 * ("About …", "Learn More") track the selected language instead of staying
 * hardcoded English.
 */
export function setMenuLabels(labels: MenuLabels): void {
  currentLabels = labels
  if (currentWindow && !currentWindow.isDestroyed()) {
    Menu.setApplicationMenu(buildMenu(currentWindow, currentLabels))
  }
}
