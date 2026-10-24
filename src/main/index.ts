/**
 * Electron main process: single instance, shared core, main window, IPC bridge, tray.
 * The CLI (out/main/cli.js) and MCP server (out/main/mcp.js) are separate entry points that run
 * this same executable as plain Node (ELECTRON_RUN_AS_NODE=1), so they never reach this file.
 */
import { join } from 'node:path'
import { app, dialog, Notification, screen, session, type BrowserWindow } from 'electron'
import { createCore, type Core } from '@core/index'
import { IPC } from '@shared/api'
import { appDataDir } from '@core/platform/paths'
import { devServerUrl, preloadPath, rendererIndexPath, resourcePath } from './appPaths'
import { isTrustedRendererUrl, rendererCsp } from './guards'
import { registerIpc } from './ipc'
import { applyLoginItem, startedHidden } from './loginItem'
import { attachWindowShortcuts, installAppMenu } from './menu'
import { PrefsStore, restoreBounds } from './prefs'
import { resolveSelfMcp } from './selfConfig'
import { runStartupTasks } from './startup'
import { applyThemeSetting, syncWindowBackground, windowBackground } from './theme'
import { AppTray } from './tray'
import { createUiApi } from './ui'
import { WINDOW_SIZE, createMainWindow } from './window'

const APP_USER_MODEL_ID = 'dev.claudesetup.app'
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

let core: Core | null = null
let prefs: PrefsStore | null = null
let tray: AppTray | null = null
let mainWindow: BrowserWindow | null = null
let disposeIpc: (() => void) | null = null
let quitting = false
let shutDown = false

function getWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function showWindow(): void {
  const win = getWindow()
  if (!win) {
    if (prefs) openWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function quitApp(): void {
  quitting = true
  app.quit()
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body, ...(process.platform === 'linux' ? { icon: resourcePath('icon.png') } : {}) }).show()
}

function showTrayNoticeOnce(): void {
  if (!prefs || prefs.get().trayNoticeShown) return
  prefs.update({ trayNoticeShown: true })
  const where = process.platform === 'darwin' ? 'menu bar' : 'tray'
  notify('Claude Setup is still running', `The model proxy keeps running in the background. Use the ${where} icon to open Claude Setup or to quit.`)
}

/** Window close: keep running in the tray while the proxy serves Claude Code, otherwise quit. */
async function decideOnClose(win: BrowserWindow): Promise<void> {
  if (tray) {
    await tray.refresh()
    if (tray.proxyRunningHere) {
      win.hide()
      showTrayNoticeOnce()
      return
    }
  } else if (core) {
    const st = await core.proxy.status().catch(() => null)
    if (st?.running && !st.external) {
      // No tray icon on this desktop: minimise instead of hiding so the user can get back.
      win.minimize()
      return
    }
  }
  quitApp()
}

function openWindow(): void {
  if (!prefs) return
  const saved = prefs.get().window
  const workAreas = screen.getAllDisplays().map((d) => d.workArea)
  const bounds = restoreBounds(saved, workAreas, { width: WINDOW_SIZE.minWidth, height: WINDOW_SIZE.minHeight })
  const dev = !app.isPackaged
  const win = createMainWindow({
    preload: preloadPath(),
    rendererFile: rendererIndexPath(),
    devServerUrl: devServerUrl(),
    backgroundColor: windowBackground(),
    bounds,
    maximized: saved?.maximized,
    icon: resourcePath('icon.png'),
    devTools: dev,
    onQuit: quitApp
  })
  mainWindow = win
  attachWindowShortcuts(win, dev)

  const saveBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    prefs?.update({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  // The renderer's custom title bar swaps the maximize/restore icon.
  const sendWindowState = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.event, { name: 'window', payload: { maximized: win.isMaximized() } })
  }
  win.on('maximize', () => (saveBounds(), sendWindowState()))
  win.on('unmaximize', () => (saveBounds(), sendWindowState()))
  // Windows shutdown / log-off: never hold the session open by hiding to the tray.
  win.on('query-session-end', () => {
    quitting = true
  })
  win.on('session-end', () => {
    quitting = true
  })
  win.on('close', (event) => {
    saveBounds()
    if (quitting) return
    event.preventDefault()
    void decideOnClose(win)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

function installSessionPolicies(devUrl: string | undefined): void {
  const policy = rendererCsp(devUrl)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' || !isTrustedRendererUrl(details.url, devUrl)) {
      callback({})
      return
    }
    const headers: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      if (key.toLowerCase() !== 'content-security-policy') headers[key] = value
    }
    headers['Content-Security-Policy'] = [policy]
    callback({ responseHeaders: headers })
  })
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))
}

function forwardLogsToConsole(c: Core): void {
  const verbose = !app.isPackaged || !!process.env.CLAUDE_SETUP_DEBUG
  c.ctx.events.on('log', (e) => {
    if (e.level === 'error') console.error(`[${e.scope}] ${e.message}`)
    else if (e.level === 'warn') console.warn(`[${e.scope}] ${e.message}`)
    else if (verbose && e.level === 'info') console.info(`[${e.scope}] ${e.message}`)
  })
}

function fatal(err: unknown): void {
  dialog.showErrorBox('Claude Setup could not start', `Something went wrong while starting up:\n\n${err instanceof Error ? err.message : String(err)}`)
  app.exit(1)
}

async function start(): Promise<void> {
  await app.whenReady()
  const devUrl = devServerUrl()
  installSessionPolicies(devUrl)
  const dataDir = appDataDir()

  // The window opens right away; the core (PATH discovery can take seconds on macOS) starts in
  // parallel and IPC calls made meanwhile simply wait for it.
  const self = resolveSelfMcp()
  const corePromise = createCore({
    surface: 'gui',
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    selfMcpConfig: self.config,
    selfMcpUnavailableReason: self.unavailableReason
  })
  corePromise.catch(() => {})

  prefs = new PrefsStore(dataDir)
  await prefs.load()
  installAppMenu({ dev: !app.isPackaged, dataDir, showWindow, quit: quitApp })
  disposeIpc = registerIpc({
    core: corePromise,
    ui: createUiApi(getWindow),
    getWindow,
    devServerUrl: devUrl,
    onCoreCall: (ns) => {
      if (ns === 'proxy' || ns === 'models') tray?.queueRefresh()
    }
  })
  syncWindowBackground(getWindow)
  // Started at login: stay in the tray (the window opens from the tray icon or a second launch).
  const hidden = startedHidden()
  if (!hidden) openWindow()

  let c: Core
  try {
    c = await corePromise
  } catch (err) {
    fatal(err)
    return
  }
  core = c
  forwardLogsToConsole(c)
  if (self.unavailableReason) c.ctx.log.warn('gui', self.unavailableReason)
  applyThemeSetting(c.ctx.state.get().settings.theme)
  c.ctx.events.on('state', () => applyThemeSetting(c.ctx.state.get().settings.theme))

  try {
    tray = new AppTray({ core: c, showWindow, quit: quitApp, notify })
  } catch (err) {
    c.ctx.log.warn('gui', `Tray icon unavailable: ${(err as Error).message}`)
  }
  // Without a tray icon a hidden start would leave the user no way in.
  if (hidden && !tray) openWindow()

  // Keep the OS login item in step with Settings → "Start at login".
  let loginItem = c.ctx.state.get().settings.startAtLogin === true
  void applyLoginItem(loginItem).then((why) => why && loginItem && c.ctx.log.warn('gui', why))
  c.ctx.events.on('state', (e) => {
    if (e.key !== 'settings') return
    const wanted = c.ctx.state.get().settings.startAtLogin === true
    if (wanted === loginItem) return
    loginItem = wanted
    void applyLoginItem(wanted).then((why) => {
      if (why) c.ctx.log.warn('gui', why)
    })
  })

  void runStartupTasks(c, { packaged: app.isPackaged }).then(() => tray?.queueRefresh())
}

async function shutdown(): Promise<void> {
  tray?.destroy()
  tray = null
  disposeIpc?.()
  disposeIpc = null
  await prefs?.flush()
  if (core) await Promise.race([core.dispose().catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 3000))])
}

function main(): void {
  if (!app || typeof app.whenReady !== 'function') {
    // Started with ELECTRON_RUN_AS_NODE=1 (e.g. inherited from a VS Code terminal): no GUI is possible.
    process.stderr.write('Claude Setup cannot open its window because ELECTRON_RUN_AS_NODE is set. Unset it and try again.\n')
    process.exit(1)
  }
  // Keep Chromium's own data (cache, local storage) apart from Claude Setup's files in the same folder.
  app.setPath('sessionData', join(app.getPath('userData'), 'Session'))
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => showWindow())
  app.on('activate', () => showWindow())
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('window-all-closed', () => {
    if (!quitting && tray?.proxyRunningHere) return
    app.quit()
  })
  app.on('will-quit', (event) => {
    if (shutDown) return
    event.preventDefault()
    shutDown = true
    void shutdown().finally(() => app.quit())
  })
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    if (core) core.ctx.log.error('gui', `Unhandled error: ${message}`)
    else console.error('Unhandled error:', message)
  })

  start().catch(fatal)
}

main()
