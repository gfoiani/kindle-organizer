import { Menu, BrowserWindow, app } from 'electron'

export function setupMenu(mainWindow: BrowserWindow): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              {
                label: `About ${app.name}`,
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
          label: 'Learn More',
          click: async (): Promise<void> => {
            const { shell } = await import('electron')
            await shell.openExternal('https://github.com/gfoiani/kindle-organizer')
          }
        },
        ...(!isMac
          ? ([
              { type: 'separator' },
              {
                label: `About ${app.name}`,
                click: (): void => {
                  mainWindow.webContents.send('show-about')
                }
              }
            ] as Electron.MenuItemConstructorOptions[])
          : [])
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
