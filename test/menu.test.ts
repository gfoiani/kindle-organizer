import { describe, expect, test, vi } from 'vitest'
import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { setupMenu } from '../src/main/menu'

/** A window whose webContents behaves like Electron's once the window is closed. */
function fakeWindow(): { window: BrowserWindow; close: () => void; send: ReturnType<typeof vi.fn> } {
  let destroyed = false
  const send = vi.fn(() => {
    if (destroyed) throw new Error('Object has been destroyed')
  })
  const window = { isDestroyed: () => destroyed, webContents: { send } } as unknown as BrowserWindow
  return { window, close: () => (destroyed = true), send }
}

/** The menu item labelled `label`, wherever it sits in the application menu. */
function findItem(label: string): MenuItemConstructorOptions {
  const menu = Menu.getApplicationMenu() as unknown as { template: MenuItemConstructorOptions[] }
  const walk = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions | undefined =>
    items.reduce<MenuItemConstructorOptions | undefined>(
      (found, item) => found ?? (item.label === label ? item : walk((item.submenu ?? []) as MenuItemConstructorOptions[])),
      undefined
    )
  const item = walk(menu.template)
  if (!item) throw new Error(`No menu item "${label}"`)
  return item
}

function click(item: MenuItemConstructorOptions): void {
  item.click?.({} as never, undefined, {} as never)
}

describe('application menu — About', () => {
  test('asks the window to show the About page', () => {
    // Arrange
    const { window, send } = fakeWindow()
    setupMenu(window)

    // Act
    click(findItem('About Kindle Organizer'))

    // Assert
    expect(send).toHaveBeenCalledWith('show-about')
  })

  test('with the window closed (macOS keeps the app running) it shows the system About panel instead of throwing', () => {
    // Arrange
    const { window, close } = fakeWindow()
    setupMenu(window)
    close()

    // Act + Assert
    expect(() => click(findItem('About Kindle Organizer'))).not.toThrow()
    expect(app.showAboutPanel).toHaveBeenCalled()
  })
})
