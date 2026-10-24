import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServersApi, TargetsApi } from '@shared/api'
import type { InstallRequest, InstalledServer, StdioServerConfig, TargetRef } from '@shared/types'
import type { CoreContext } from '@core/context'
import { CoreEmitter } from '@core/events'
import { cliCommandPath, createSelfApi } from '@core/self/index'
import { refreshStaleRegistrations } from '@core/self/sync'
import { createSandbox, type Sandbox } from '../helpers/sandbox'

const exe = process.platform === 'win32' ? 'C:\\Apps\\Claude Setup\\claude-setup.exe' : '/opt/Claude Setup/claude-setup'
const mcpJs =
  process.platform === 'win32' ? 'C:\\Apps\\Claude Setup\\resources\\app.asar\\out\\main\\mcp.js' : '/opt/Claude Setup/resources/app.asar/out/main/mcp.js'
const selfConfig: StdioServerConfig = { type: 'stdio', command: exe, args: [mcpJs], env: { ELECTRON_RUN_AS_NODE: '1' } }

function makeCtx(config: StdioServerConfig | undefined, dataDir: string): CoreContext {
  return {
    options: { surface: 'gui', appVersion: '0.1.0', selfMcpConfig: config },
    dataDir,
    cacheDir: join(dataDir, 'cache'),
    events: new CoreEmitter(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    backups: { snapshot: vi.fn(async () => ({ id: 'backup-1', createdAt: '', reason: '', files: [] })) },
    state: {},
    secrets: {}
  } as unknown as CoreContext
}

function makeServers(entries: InstalledServer[] = []): ServersApi {
  return {
    list: vi.fn(async (filter?: { target?: string }) => entries.filter((e) => !filter?.target || e.target.target === filter.target)),
    install: vi.fn(async (req: InstallRequest) => ({
      ok: true,
      name: req.name ?? '',
      results: req.targets.map((t) => ({ target: t, ok: true, message: 'Added.' })),
      warnings: []
    })),
    uninstall: vi.fn(async (_name: string, refs: TargetRef[]) => refs.map((t) => ({ target: t, ok: true, message: 'Removed.' }))),
    update: vi.fn(async (_name: string, target: TargetRef) => ({ target, ok: true, message: 'Updated.' }))
  } as unknown as ServersApi
}

const targets = { list: vi.fn(async () => []) } as unknown as TargetsApi

let sb: Sandbox
let savedPath: string | undefined
beforeEach(async () => {
  sb = await createSandbox()
  savedPath = process.env.PATH
})
afterEach(async () => {
  process.env.PATH = savedPath
  await sb.cleanup()
})

describe('installCli', () => {
  it('writes the shim into ~/.local/bin and explains PATH when missing', async () => {
    process.env.PATH = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin'
    const api = createSelfApi(makeCtx(selfConfig, sb.dataDir), { servers: makeServers(), targets })
    const r = await api.installCli()
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/not on your PATH/)
    expect(r.details).toMatch(/\.local/)
    const file = join(sb.home, '.local', 'bin', process.platform === 'win32' ? 'claude-setup.cmd' : 'claude-setup')
    const text = await readFile(file, 'utf8')
    expect(text).toContain('ELECTRON_RUN_AS_NODE')
    expect(text).toContain('cli.js')
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o755)
  })

  it('reports success when ~/.local/bin is already on PATH', async () => {
    const bin = join(sb.home, '.local', 'bin')
    process.env.PATH = [bin, process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin'].join(process.platform === 'win32' ? ';' : ':')
    const r = await createSelfApi(makeCtx(selfConfig, sb.dataDir), { servers: makeServers(), targets }).installCli()
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/ready/)
  })

  it('backs up a foreign file before replacing it, but not our own shim', async () => {
    const ctx = makeCtx(selfConfig, sb.dataDir)
    const api = createSelfApi(ctx, { servers: makeServers(), targets })
    const bin = join(sb.home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const file = join(bin, process.platform === 'win32' ? 'claude-setup.cmd' : 'claude-setup')
    await writeFile(file, 'echo something else\n')
    const first = await api.installCli()
    expect(first.backupId).toBe('backup-1')
    expect(ctx.backups.snapshot).toHaveBeenCalledTimes(1)
    const second = await api.installCli()
    expect(second.backupId).toBeUndefined()
    expect(ctx.backups.snapshot).toHaveBeenCalledTimes(1)
  })

  it('exposes the absolute command path for apiKeyHelper', () => {
    expect(cliCommandPath('win32')).toBe(join(sb.home, '.local', 'bin', 'claude-setup.cmd'))
    expect(cliCommandPath('linux')).toBe(join(sb.home, '.local', 'bin', 'claude-setup'))
  })

  it('fails with a friendly reason when this copy has no launch config', async () => {
    const r = await createSelfApi(makeCtx(undefined, sb.dataDir), { servers: makeServers(), targets }).installCli()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/can't be installed/)
  })
})

describe('registerMcp / unregisterMcp / mcpStatus', () => {
  it('installs claude-setup with overwrite, defaulting Claude Code to user scope', async () => {
    const servers = makeServers()
    const api = createSelfApi(makeCtx(selfConfig, sb.dataDir), { servers, targets })
    const r = await api.registerMcp([{ target: 'claude-desktop' }, { target: 'claude-code' }])
    expect(r.ok).toBe(true)
    expect(servers.install).toHaveBeenCalledWith({
      config: selfConfig,
      name: 'claude-setup',
      targets: [{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }],
      overwrite: true
    })
  })

  it('returns a failed result with a reason when there is no launch config', async () => {
    const servers = makeServers()
    const r = await createSelfApi(makeCtx(undefined, sb.dataDir), { servers, targets }).registerMcp([{ target: 'claude-desktop' }])
    expect(r.ok).toBe(false)
    expect(r.results[0].ok).toBe(false)
    expect(r.results[0].message.length).toBeGreaterThan(20)
    expect(servers.install).not.toHaveBeenCalled()
  })

  it('reports registration per target', async () => {
    const entry: InstalledServer = {
      name: 'claude-setup',
      target: { target: 'claude-code', scope: 'user' },
      config: selfConfig,
      enabled: true,
      configPath: '/home/u/.claude.json',
      managedByUs: true
    }
    const status = await createSelfApi(makeCtx(selfConfig, sb.dataDir), { servers: makeServers([entry]), targets }).mcpStatus()
    expect(status).toHaveLength(5)
    expect(status.find((s) => s.target === 'claude-code')).toEqual({ target: 'claude-code', registered: true, configPath: '/home/u/.claude.json' })
    expect(status.find((s) => s.target === 'claude-desktop')?.registered).toBe(false)
  })

  it('unregisters using the exact scopes found', async () => {
    const entry: InstalledServer = {
      name: 'claude-setup',
      target: { target: 'claude-code', scope: 'local', projectPath: '/p' },
      config: selfConfig,
      enabled: true,
      configPath: '/home/u/.claude.json',
      managedByUs: true
    }
    const servers = makeServers([entry])
    const api = createSelfApi(makeCtx(selfConfig, sb.dataDir), { servers, targets })
    const results = await api.unregisterMcp([{ target: 'claude-code' }, { target: 'claude-desktop' }])
    expect(servers.uninstall).toHaveBeenCalledWith('claude-setup', [{ target: 'claude-code', scope: 'local', projectPath: '/p' }])
    expect(results.find((r) => r.target.target === 'claude-desktop')?.message).toMatch(/not registered/)
  })
})

describe('refreshStaleRegistrations', () => {
  it('re-points entries whose executable no longer exists', async () => {
    const stale: InstalledServer = {
      name: 'claude-setup',
      target: { target: 'claude-desktop' },
      config: { type: 'stdio', command: join(sb.root, 'gone', 'claude-setup.exe'), args: [join(sb.root, 'gone', 'mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1' } },
      enabled: true,
      configPath: 'x',
      managedByUs: true
    }
    const servers = makeServers([stale])
    const changes = await refreshStaleRegistrations(makeCtx(selfConfig, sb.dataDir), servers)
    expect(changes).toHaveLength(1)
    expect(servers.update).toHaveBeenCalledWith('claude-setup', { target: 'claude-desktop' }, selfConfig)
  })

  it('leaves working or foreign entries alone', async () => {
    const working: InstalledServer = {
      name: 'claude-setup',
      target: { target: 'claude-code', scope: 'user' },
      config: { type: 'stdio', command: process.execPath, args: ['/somewhere/mcp.js'] },
      enabled: true,
      configPath: 'x',
      managedByUs: true
    }
    const foreign: InstalledServer = { ...working, target: { target: 'cursor' }, config: { type: 'stdio', command: '/missing/npx', args: ['-y', 'claude-setup-mcp'] } }
    const servers = makeServers([working, foreign])
    expect(await refreshStaleRegistrations(makeCtx(selfConfig, sb.dataDir), servers)).toEqual([])
    expect(servers.update).not.toHaveBeenCalled()
  })
})
