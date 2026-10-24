/**
 * IPC dispatcher: renderer → core (allow-listed by CORE_METHODS) and renderer → UiApi,
 * plus core events → renderer. Only our own window's renderer may call in.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, type Namespace, type UiApi } from '@shared/api'
import type { Core } from '@core/index'
import { isAllowedCoreCall, isAllowedUiCall, isTrustedRendererUrl } from './guards'

/** Dependencies of the IPC dispatcher. */
export interface IpcOptions {
  /** The core, or a promise of it: calls made while it is still starting simply wait. */
  core: Core | Promise<Core>
  ui: UiApi
  getWindow: () => BrowserWindow | null
  devServerUrl?: string
  /** Notified after every successful core call (e.g. to refresh the tray after proxy changes). */
  onCoreCall?: (ns: Namespace, method: string) => void
}

type AnyMethod = (...args: unknown[]) => Promise<unknown>

function assertTrustedSender(event: IpcMainInvokeEvent, opts: IpcOptions): void {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const main = opts.getWindow()
  if (!owner || !main || owner.id !== main.id) throw new Error('Blocked: request did not come from the Claude Setup window.')
  if (!isTrustedRendererUrl(event.senderFrame?.url, opts.devServerUrl)) throw new Error('Blocked: request came from an untrusted page.')
}

/** Register the IPC handlers. Returns a function that removes them again. */
export function registerIpc(opts: IpcOptions): () => void {
  let disposed = false
  let offEvents: (() => void) | null = null

  ipcMain.handle(IPC.core, async (event, ns: unknown, method: unknown, ...args: unknown[]) => {
    assertTrustedSender(event, opts)
    if (!isAllowedCoreCall(ns, method)) throw new Error(`Blocked: ${String(ns)}.${String(method)} is not an allowed call.`)
    const core = await opts.core
    const target = core[ns] as unknown as Record<string, AnyMethod>
    try {
      const result = await target[method as string].apply(target, args)
      opts.onCoreCall?.(ns, method as string)
      return result
    } catch (err) {
      core.ctx.log.error('ipc', `${ns}.${String(method)} failed: ${(err as Error)?.message ?? String(err)}`)
      throw err
    }
  })

  ipcMain.handle(IPC.ui, async (event, method: unknown, ...args: unknown[]) => {
    assertTrustedSender(event, opts)
    if (!isAllowedUiCall(method)) throw new Error(`Blocked: ${String(method)} is not an allowed window action.`)
    const fn = opts.ui[method] as unknown as AnyMethod
    return fn.apply(opts.ui, args)
  })

  const attach = (core: Core): void => {
    if (disposed) return
    offEvents = core.ctx.events.onAny((event) => {
      const win = opts.getWindow()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send(IPC.event, event)
    })
  }
  if (opts.core instanceof Promise) opts.core.then(attach, () => {})
  else attach(opts.core)

  return () => {
    disposed = true
    offEvents?.()
    offEvents = null
    ipcMain.removeHandler(IPC.core)
    ipcMain.removeHandler(IPC.ui)
  }
}
