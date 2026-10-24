/**
 * createMockApi(): a complete fake PreloadApi (window.api) backed by in-memory mock data.
 * Every call is validated against the IPC allow-list, round-trips through structuredClone (like real IPC)
 * and has a small artificial latency. Errors are thrown in the same "Error invoking remote method…" shape
 * Electron produces, so errorMessage() handles them identically.
 *
 * No DOM access here (Node-testable). The browser wiring lives in ./index.ts.
 */
import { CORE_METHODS, type CoreApi, type Namespace, type PreloadApi, type UiApi } from '@shared/api'
import type { AppSettings, OS } from '@shared/types'
import { catalogApi } from './catalog'
import { doctorApi, runtimesApi } from './doctor'
import { extensionsApi } from './extensions'
import { appApi, backupsApi, seedSettings, selfApi } from './misc'
import { modelsApi } from './models'
import { sampleProject } from './paths'
import { proxyApi } from './proxy'
import { clone, configureEnv, env, homePath, sleep, subscribe, timing } from './runtime'
import { serversApi, targetsApi } from './servers'

export interface MockOptions {
  /** Fake OS (window chrome, paths, runtimes). Default 'win32'. */
  platform?: OS
  /** Artificial latency range per call in ms (default [120, 380]). */
  latency?: [number, number]
  /** Multiplier for every simulated delay (installs, refresh, tests). 0 = instant. Default 1. */
  timeScale?: number
  /** Initial settings overrides (theme, mode, onboarded…). */
  settings?: Partial<AppSettings>
  /** Replace individual GUI helpers (the browser wiring passes clipboard/window.open versions). */
  ui?: Partial<UiApi>
}

/** The full mock core, one object per namespace (each file implements its API interface). */
export const mockCore: CoreApi = {
  app: appApi,
  catalog: catalogApi,
  targets: targetsApi,
  servers: serversApi,
  models: modelsApi,
  proxy: proxyApi,
  extensions: extensionsApi,
  doctor: doctorApi,
  backups: backupsApi,
  runtimes: runtimesApi,
  self: selfApi
}

function ipcError(message: string): Error {
  return new Error(`Error invoking remote method 'core:call': Error: ${message}`)
}

function defaultUi(): UiApi {
  return {
    async openExternal(url) {
      console.info('[mock ui] openExternal', url)
    },
    async showItemInFolder(path) {
      console.info('[mock ui] showItemInFolder', path)
    },
    async openPath(path) {
      console.info('[mock ui] openPath', path)
      return ''
    },
    async pickFolder(opts) {
      console.info('[mock ui] pickFolder', opts)
      return sampleProject()
    },
    async pickFile(opts) {
      console.info('[mock ui] pickFile', opts)
      return homePath('Downloads', 'server.json')
    },
    async copyText(text) {
      console.info('[mock ui] copyText', `${text.length} chars`)
    },
    async readClipboard() {
      const nav = (globalThis as { navigator?: { clipboard?: { readText(): Promise<string> } } }).navigator
      return nav?.clipboard ? nav.clipboard.readText().catch(() => '') : ''
    },
    async window(action) {
      console.info('[mock ui] window', action)
    },
    async windowState() {
      return { maximized: false }
    }
  }
}

/** Build a PreloadApi implementation backed by the mock data. */
export function createMockApi(options: MockOptions = {}): PreloadApi {
  configureEnv(options.platform ?? 'win32')
  timing.scale = options.timeScale ?? 1
  if (options.settings) seedSettings(options.settings)
  const [minLatency, maxLatency] = options.latency ?? [120, 380]
  const ui: UiApi = { ...defaultUi(), ...options.ui }

  const call = async (ns: Namespace, method: string, ...args: unknown[]): Promise<unknown> => {
    const allowed = CORE_METHODS[ns] as ReadonlyArray<string> | undefined
    if (!allowed?.includes(method)) throw ipcError(`Unknown method ${String(ns)}.${method}`)
    let input: unknown[]
    try {
      input = clone(args)
    } catch {
      throw ipcError(`Arguments for ${ns}.${method} could not be cloned (only plain JSON data can cross IPC).`)
    }
    await sleep(minLatency + Math.random() * Math.max(0, maxLatency - minLatency))
    const target = mockCore[ns] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    const fn = target[method]
    if (typeof fn !== 'function') throw ipcError(`${ns}.${method} is not implemented in the mock`)
    try {
      return clone(await fn.apply(target, input))
    } catch (err) {
      throw ipcError(err instanceof Error ? err.message : String(err))
    }
  }

  const uiCall = (method: keyof UiApi, ...args: unknown[]): unknown => {
    const fn = ui[method] as (...a: unknown[]) => unknown
    return fn(...args)
  }

  return {
    platform: env.platform,
    call: call as PreloadApi['call'],
    ui: uiCall as PreloadApi['ui'],
    onEvent: (cb) => subscribe(cb)
  }
}
