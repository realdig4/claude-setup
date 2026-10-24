import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type PreloadApi } from '@shared/api'
import { makeFakeCore } from './fakeCore'

const h = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  invoke: vi.fn(async (..._args: unknown[]) => 'result'),
  on: vi.fn(),
  removeListener: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
  windows: new Map<unknown, { id: number }>()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void (h.exposed[key] = api) },
  ipcRenderer: { invoke: h.invoke, on: h.on, removeListener: h.removeListener },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => void h.handlers.set(channel, fn),
    removeHandler: h.removeHandler
  },
  BrowserWindow: { fromWebContents: (wc: unknown) => h.windows.get(wc) ?? null }
}))

describe('preload bridge', () => {
  let api: PreloadApi
  beforeEach(async () => {
    h.invoke.mockClear()
    await import('../../src/preload/index')
    api = h.exposed.api as PreloadApi
  })

  it('exposes call/ui/onEvent/platform', () => {
    expect(typeof api.call).toBe('function')
    expect(typeof api.ui).toBe('function')
    expect(typeof api.onEvent).toBe('function')
    expect(['win32', 'darwin', 'linux']).toContain(api.platform)
  })

  it('forwards allowed core calls on the core channel', async () => {
    await expect(api.call('catalog', 'search', { query: 'x' })).resolves.toBe('result')
    expect(h.invoke).toHaveBeenCalledWith(IPC.core, 'catalog', 'search', { query: 'x' })
  })

  it('blocks anything outside the allow-list without touching IPC', async () => {
    const call = api.call as unknown as (ns: string, m: string) => Promise<unknown>
    await expect(call('servers', 'deleteEverything')).rejects.toThrow(/Blocked/)
    await expect(call('__proto__', 'constructor')).rejects.toThrow(/Blocked/)
    const ui = api.ui as unknown as (m: string) => Promise<unknown>
    await expect(ui('exec')).rejects.toThrow(/Blocked/)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('forwards UI calls and subscribes/unsubscribes to events', async () => {
    await api.ui('openExternal', 'https://example.com')
    expect(h.invoke).toHaveBeenCalledWith(IPC.ui, 'openExternal', 'https://example.com')
    const cb = vi.fn()
    const off = api.onEvent(cb)
    expect(h.on).toHaveBeenCalledWith(IPC.event, expect.any(Function))
    const listener = h.on.mock.calls[0][1] as (e: unknown, payload: unknown) => void
    listener({}, { name: 'progress', payload: { op: 'x', message: 'y' } })
    expect(cb).toHaveBeenCalledWith({ name: 'progress', payload: { op: 'x', message: 'y' } })
    off()
    expect(h.removeListener).toHaveBeenCalledWith(IPC.event, listener)
  })
})

describe('main-process IPC dispatcher', () => {
  const sender = { id: 'renderer' }
  const send = vi.fn()
  const mainWindow = { id: 1, isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }

  async function setup() {
    h.handlers.clear()
    h.windows.clear()
    h.windows.set(sender, { id: 1 })
    const { registerIpc } = await import('../../src/main/ipc')
    const core = makeFakeCore()
    const ui = { openExternal: vi.fn(async () => {}) } as never
    const onCoreCall = vi.fn()
    const dispose = registerIpc({ core, ui, getWindow: () => mainWindow as never, devServerUrl: 'http://localhost:5173', onCoreCall })
    return { core, ui: ui as { openExternal: ReturnType<typeof vi.fn> }, onCoreCall, dispose }
  }

  const event = (url: string, s: unknown = sender) => ({ sender: s, senderFrame: { url } })

  it('calls the core for trusted senders and allowed methods', async () => {
    const { core, onCoreCall } = await setup()
    const handler = h.handlers.get(IPC.core)!
    const page = await handler(event('file:///C:/app/out/renderer/index.html'), 'catalog', 'search', { query: 'git' })
    expect(core.catalog.search).toHaveBeenCalledWith({ query: 'git' })
    expect(page).toMatchObject({ total: 1 })
    expect(onCoreCall).toHaveBeenCalledWith('catalog', 'search')
    await handler(event('http://localhost:5173/'), 'proxy', 'status')
    expect(core.proxy.status).toHaveBeenCalled()
  })

  it('rejects untrusted pages, other windows and unknown methods', async () => {
    await setup()
    const handler = h.handlers.get(IPC.core)!
    await expect(handler(event('https://evil.example/'), 'catalog', 'search')).rejects.toThrow(/untrusted/)
    await expect(handler(event('file:///x.html', { id: 'other' }), 'catalog', 'search')).rejects.toThrow(/Claude Setup window/)
    await expect(handler(event('file:///x.html'), 'ctx', 'secrets')).rejects.toThrow(/not an allowed call/)
    await expect(handler(event('file:///x.html'), 'catalog', 'constructor')).rejects.toThrow(/not an allowed call/)
  })

  it('dispatches UI calls and forwards core events to the window', async () => {
    const { core, ui, dispose } = await setup()
    await h.handlers.get(IPC.ui)!(event('file:///x.html'), 'openExternal', 'https://example.com')
    expect(ui.openExternal).toHaveBeenCalledWith('https://example.com')
    await expect(h.handlers.get(IPC.ui)!(event('file:///x.html'), 'eval', 'x')).rejects.toThrow(/not an allowed/)
    core.ctx.events.emitEvent('progress', { op: 'install', message: 'Working' })
    expect(send).toHaveBeenCalledWith(IPC.event, { name: 'progress', payload: { op: 'install', message: 'Working' } })
    dispose()
    expect(h.removeHandler).toHaveBeenCalledWith(IPC.core)
    expect(h.removeHandler).toHaveBeenCalledWith(IPC.ui)
    send.mockClear()
    core.ctx.events.emitEvent('progress', { op: 'install', message: 'Ignored' })
    expect(send).not.toHaveBeenCalled()
  })
})
