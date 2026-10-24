/**
 * Tray / menu-bar icon: open the window, start/stop the translation proxy, restart Claude Desktop, quit.
 * While the proxy runs, closing the window keeps Claude Setup alive here.
 */
import { readFileSync } from 'node:fs'
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import type { ProxyStatus } from '@shared/types'
import type { Core } from '@core/index'
import { resourcePath } from './appPaths'

/** Dependencies of the tray icon. */
export interface TrayOptions {
  core: Core
  showWindow: () => void
  quit: () => void
  notify: (title: string, body: string) => void
}

function readImage(name: string): Buffer | null {
  try {
    return readFileSync(resourcePath(name))
  } catch {
    return null
  }
}

/** Platform-appropriate tray image: monochrome template on macOS, colour icon elsewhere. */
export function trayImage(): NativeImage {
  if (process.platform === 'darwin') {
    const image = nativeImage.createEmpty()
    const x1 = readImage('trayTemplate.png')
    const x2 = readImage('trayTemplate@2x.png')
    if (x1) image.addRepresentation({ scaleFactor: 1, buffer: x1 })
    if (x2) image.addRepresentation({ scaleFactor: 2, buffer: x2 })
    image.setTemplateImage(true)
    return image
  }
  const buffer = readImage('tray.png')
  if (!buffer) return nativeImage.createEmpty()
  const full = nativeImage.createFromBuffer(buffer)
  if (process.platform !== 'win32') return full
  // Windows draws tray icons at 16 px (100 %) or 32 px (200 %): provide both representations.
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1, buffer: full.resize({ width: 16, height: 16, quality: 'best' }).toPNG() })
  image.addRepresentation({ scaleFactor: 2, buffer })
  return image
}

/** Tray icon with a menu that reflects the proxy status. */
export class AppTray {
  private readonly tray: Tray
  private status: ProxyStatus | null = null
  private busy = false
  private readonly timer: NodeJS.Timeout
  private refreshQueued: NodeJS.Timeout | undefined
  private readonly offProxyEvents: () => void

  constructor(private readonly opts: TrayOptions) {
    this.tray = new Tray(trayImage())
    this.tray.setToolTip('Claude Setup')
    if (process.platform === 'win32') this.tray.on('click', () => opts.showWindow())
    this.tray.setContextMenu(this.buildMenu())
    this.timer = setInterval(() => void this.refresh(), 15_000)
    this.timer.unref()
    // Proxy log lines arrive per request; use them as a cheap "status may have changed" signal.
    this.offProxyEvents = opts.core.ctx.events.on('proxy', () => this.queueRefresh())
    void this.refresh()
  }

  /** Whether the proxy runs inside this app (so quitting would stop it). */
  get proxyRunningHere(): boolean {
    return !!this.status?.running && !this.status.external
  }

  /** Re-read the proxy status and rebuild the menu. */
  async refresh(): Promise<void> {
    try {
      this.status = await this.opts.core.proxy.status()
    } catch {
      this.status = null
    }
    if (this.tray.isDestroyed()) return
    this.tray.setContextMenu(this.buildMenu())
    const running = this.status?.running
    this.tray.setToolTip(running ? `Claude Setup — model proxy running${this.status?.port ? ` on port ${this.status.port}` : ''}` : 'Claude Setup')
  }

  queueRefresh(): void {
    if (this.refreshQueued) return
    this.refreshQueued = setTimeout(() => {
      this.refreshQueued = undefined
      void this.refresh()
    }, 500)
  }

  destroy(): void {
    clearInterval(this.timer)
    if (this.refreshQueued) clearTimeout(this.refreshQueued)
    this.offProxyEvents()
    if (!this.tray.isDestroyed()) this.tray.destroy()
  }

  private buildMenu(): Menu {
    const st = this.status
    const proxyLabel = !st
      ? 'Model proxy: unavailable'
      : st.running
        ? `Model proxy: running${st.port ? ` on port ${st.port}` : ''}${st.external ? ' (in another window)' : ''}`
        : 'Model proxy: stopped'
    const items: MenuItemConstructorOptions[] = [
      { label: 'Open Claude Setup', click: () => this.opts.showWindow() },
      { type: 'separator' },
      { label: proxyLabel, enabled: false },
      st?.running
        ? { label: 'Stop proxy', enabled: !this.busy && !st.external, click: () => void this.toggleProxy(false) }
        : { label: 'Start proxy', enabled: !this.busy && !!st, click: () => void this.toggleProxy(true) },
      { type: 'separator' },
      { label: 'Restart Claude Desktop', enabled: !this.busy, click: () => void this.restartDesktop() },
      { type: 'separator' },
      { label: 'Quit Claude Setup', click: () => this.opts.quit() }
    ]
    return Menu.buildFromTemplate(items)
  }

  private async run(task: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.tray.setContextMenu(this.buildMenu())
    try {
      await task()
    } finally {
      this.busy = false
      await this.refresh()
    }
  }

  private async toggleProxy(start: boolean): Promise<void> {
    await this.run(async () => {
      try {
        const st = start ? await this.opts.core.proxy.start() : await this.opts.core.proxy.stop()
        if (start && !st.running) this.opts.notify('The model proxy did not start', st.lastError ?? 'Open Claude Setup to see what went wrong.')
      } catch (err) {
        this.opts.notify(start ? 'The model proxy did not start' : 'The model proxy did not stop', (err as Error).message)
      }
    })
  }

  private async restartDesktop(): Promise<void> {
    await this.run(async () => {
      try {
        const r = await this.opts.core.targets.restartDesktop()
        this.opts.notify(r.ok ? 'Claude Desktop restarted' : 'Could not restart Claude Desktop', r.message)
      } catch (err) {
        this.opts.notify('Could not restart Claude Desktop', (err as Error).message)
      }
    })
  }
}
