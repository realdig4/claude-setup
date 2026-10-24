/** The main application window: secure defaults, custom title bar, external links in the OS browser. */
import { BrowserWindow, dialog, shell } from 'electron'
import { isSafeExternalUrl, isTrustedRendererUrl } from './guards'
import type { WindowBounds } from './prefs'

/** Default and minimum window size. */
export const WINDOW_SIZE = { width: 1240, height: 820, minWidth: 880, minHeight: 600 } as const

/** Inputs for createMainWindow(). */
export interface MainWindowOptions {
  preload: string
  rendererFile: string
  devServerUrl?: string
  backgroundColor: string
  bounds?: WindowBounds
  maximized?: boolean
  /** Window icon (used on Linux; Windows/macOS take it from the executable/bundle). */
  icon?: string
  devTools: boolean
  /** Called when the user chooses to quit after a fatal renderer problem. */
  onQuit: () => void
}

/**
 * Windows/Linux: frameless — the renderer draws its own title bar and calls
 * window.api.ui('window', 'minimize' | 'maximize' | 'close').
 * macOS: hidden inset title bar with the traffic lights at (18, 16).
 */
export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const mac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: opts.bounds?.width ?? WINDOW_SIZE.width,
    height: opts.bounds?.height ?? WINDOW_SIZE.height,
    x: opts.bounds?.x,
    y: opts.bounds?.y,
    minWidth: WINDOW_SIZE.minWidth,
    minHeight: WINDOW_SIZE.minHeight,
    show: false,
    title: 'Claude Setup',
    backgroundColor: opts.backgroundColor,
    ...(mac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 16 } } : { frame: false }),
    ...(process.platform === 'linux' && opts.icon ? { icon: opts.icon } : {}),
    webPreferences: {
      preload: opts.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: opts.devTools
    }
  })

  let revealed = false
  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return
    revealed = true
    if (opts.maximized) win.maximize()
    win.show()
  }
  win.once('ready-to-show', reveal)
  // Never leave the user with an invisible app if the first paint is slow or fails.
  setTimeout(reveal, 6000).unref()

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, opts.devServerUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, opts.devServerUrl)) event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'error',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      title: 'Claude Setup',
      message: 'Claude Setup ran into a problem and needs to reload its window.',
      detail: `Reason: ${details.reason}. Your settings and config files are not affected.`
    })
    if (choice === 0) win.reload()
    else opts.onQuit()
  })

  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 = ERR_ABORTED (e.g. a reload interrupted the previous load) — harmless.
    if (!isMainFrame || code === -3 || win.isDestroyed()) return
    reveal()
    const detail = opts.devServerUrl
      ? `Could not load ${url} (${description}). Is the dev server running? Start it with "npm run dev".`
      : `Could not load ${url} (${description}). Please reinstall Claude Setup.`
    void dialog
      .showMessageBox(win, {
        type: 'error',
        buttons: ['Try again', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        title: 'Claude Setup',
        message: "Claude Setup's window could not be loaded.",
        detail
      })
      .then(({ response }) => {
        if (response === 0) loadRenderer(win, opts)
        else opts.onQuit()
      })
  })

  loadRenderer(win, opts)
  return win
}

function loadRenderer(win: BrowserWindow, opts: MainWindowOptions): void {
  if (win.isDestroyed()) return
  // Failures surface through 'did-fail-load'; swallow the promise rejection here.
  const loading = opts.devServerUrl ? win.loadURL(opts.devServerUrl) : win.loadFile(opts.rendererFile)
  loading.catch(() => {})
}
