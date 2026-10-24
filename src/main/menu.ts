/**
 * Application menu. macOS gets the standard menu bar (needed for copy/paste shortcuts and Cmd+Q).
 * Windows/Linux use a frameless window without a menu bar, so zoom and developer shortcuts are
 * handled directly on the window instead.
 */
import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** Inputs for the application menu. */
export interface MenuOptions {
  dev: boolean
  dataDir: string
  showWindow: () => void
  quit: () => void
}

/** Install the application menu (macOS) or remove the default one (Windows/Linux). */
export function installAppMenu(opts: MenuOptions): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Claude Setup',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Claude Setup', accelerator: 'Command+Q', click: () => opts.quit() }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(opts.dev ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { label: 'Show Claude Setup', click: () => opts.showWindow() }, { role: 'front' }]
    },
    {
      role: 'help',
      submenu: [{ label: 'Open Claude Setup Data Folder', click: () => void shell.openPath(opts.dataDir) }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Keyboard shortcuts for frameless Windows/Linux windows (zoom always; reload/devtools in development). */
export function attachWindowShortcuts(win: BrowserWindow, dev: boolean): void {
  if (process.platform === 'darwin') return
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const contents = win.webContents
    if (input.control && !input.alt) {
      if (key === '=' || key === '+') {
        contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 4))
        event.preventDefault()
      } else if (key === '-') {
        contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3))
        event.preventDefault()
      } else if (key === '0') {
        contents.setZoomLevel(0)
        event.preventDefault()
      } else if (dev && input.shift && key === 'i') {
        contents.toggleDevTools()
        event.preventDefault()
      } else if (dev && key === 'r') {
        contents.reload()
        event.preventDefault()
      }
    } else if (dev && key === 'f12') {
      contents.toggleDevTools()
      event.preventDefault()
    }
  })
}
