import { app, BrowserWindow, shell } from 'electron'
import path from 'path'
import { registerIpcHandlers } from './ipc'
import { setupMenu } from './menu'

const WINDOW_WIDTH = 1200
const WINDOW_HEIGHT = 780

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 800,
    minHeight: 600,
    title: 'Kindle Organizer',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Set up the system menu
  setupMenu(win)

  // Open external links in the browser instead of the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

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
