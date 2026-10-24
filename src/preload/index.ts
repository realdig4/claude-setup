/**
 * Preload (sandboxed, CommonJS bundle that only require()s 'electron'): exposes window.api.
 * Every call is checked against the same allow-lists the main process enforces.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type CoreEvent, type PreloadApi } from '@shared/api'
import { isAllowedCoreCall, isAllowedUiCall } from '../main/guards'

function currentPlatform(): PreloadApi['platform'] {
  return process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
}

const call = (ns: string, method: string, ...args: unknown[]): Promise<unknown> => {
  if (!isAllowedCoreCall(ns, method)) return Promise.reject(new Error(`Blocked call: ${String(ns)}.${String(method)}`))
  return ipcRenderer.invoke(IPC.core, ns, method, ...args)
}

const ui = (method: string, ...args: unknown[]): Promise<unknown> => {
  if (!isAllowedUiCall(method)) return Promise.reject(new Error(`Blocked window action: ${String(method)}`))
  return ipcRenderer.invoke(IPC.ui, method, ...args)
}

const api: PreloadApi = {
  call: call as PreloadApi['call'],
  ui: ui as PreloadApi['ui'],
  onEvent(cb) {
    if (typeof cb !== 'function') throw new TypeError('onEvent needs a callback function')
    const listener = (_event: IpcRendererEvent, payload: CoreEvent): void => cb(payload)
    ipcRenderer.on(IPC.event, listener)
    return () => {
      ipcRenderer.removeListener(IPC.event, listener)
    }
  },
  platform: currentPlatform()
}

contextBridge.exposeInMainWorld('api', api)
