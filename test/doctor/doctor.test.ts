import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelsApi, RuntimesApi, ServersApi, TargetsApi } from '@shared/api'
import type { InstalledServer, RuntimeInfo, TargetInfo } from '@shared/types'
import { createDoctorApi, summarize } from '@core/doctor'
import type { DoctorDeps } from '@core/doctor'
import { run, which } from '@core/platform/exec'
import { claudeConfigDir, claudeUserSettingsPath, vscodeUserDir } from '@core/platform/paths'
import { desktopLogDirs } from '@core/targets/desktopPaths'
import { saveProfile } from '@core/models/profiles'
import { withSandbox, type Sandbox } from '../helpers/sandbox'
import { cleanModelEnv, fakeProxy, makeContext, readJsonFile, writeText, type FakeProxy } from '../models/helpers'

vi.mock('@core/platform/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/platform/exec')>()
  return { ...actual, run: vi.fn(), which: vi.fn(), runPowerShell: vi.fn() }
})

const runMock = vi.mocked(run)
const whichMock = vi.mocked(which)
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false })
const notFound = () => ({ ok: false, code: 1, stdout: '', stderr: 'not found', timedOut: false })

function runtime(id: RuntimeInfo['id'], found: boolean, extra: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return { id, label: id, found, purpose: 'test', install: { url: `https://example.com/${id}`, canAutoInstall: true }, ...extra }
}

function desktopInfo(extra: Partial<TargetInfo> = {}): TargetInfo {
  return {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    description: '',
    installed: true,
    configExists: false,
    configValid: true,
    supportsRemote: false,
    scopes: [],
    serverCount: 0,
    notes: [],
    primary: true,
    ...extra
  }
}

interface DepsOptions {
  runtimes?: RuntimeInfo[]
  targets?: TargetInfo[] | (() => Promise<TargetInfo[]>)
  servers?: InstalledServer[]
  proxy?: FakeProxy
}

function makeDeps(opts: DepsOptions = {}) {
  const targets = {
    list: vi.fn(typeof opts.targets === 'function' ? opts.targets : async () => opts.targets ?? [desktopInfo({ installed: false })]),
    restartDesktop: vi.fn(async () => ({ ok: true, message: 'Claude Desktop restarted.' })),
    configPath: vi.fn(),
    readRaw: vi.fn()
  }
  const runtimes = {
    detect: vi.fn(async () => opts.runtimes ?? [runtime('node', true, { version: '24.11.1' }), runtime('npx', true), runtime('uv', true), runtime('docker', false), runtime('git', true)]),
    install: vi.fn(async (id: string) => ({ ok: true, message: `Installed ${id}.` }))
  }
  const servers = { list: vi.fn(async () => opts.servers ?? []) }
  const models = {
    apply: vi.fn(async () => ({ ok: true, results: [{ target: 'vscode' as const, ok: true, message: 'VS Code now uses Kimi K3.', backupId: 'b1' }], warnings: [] }))
  }
  const proxy = opts.proxy ?? fakeProxy()
  const deps: DoctorDeps = {
    targets: targets as unknown as TargetsApi,
    servers: servers as unknown as ServersApi,
    models: models as unknown as ModelsApi,
    runtimes: runtimes as unknown as RuntimesApi,
    proxy
  }
  return { deps, targets, runtimes, servers, models, proxy }
}

function server(name: string, command: string, args: string[] = [], target: InstalledServer['target'] = { target: 'claude-desktop' }): InstalledServer {
  return { name, target, config: { type: 'stdio', command, args }, enabled: true, configPath: 'x', managedByUs: true }
}

let restoreEnv: () => void
beforeEach(() => {
  restoreEnv = cleanModelEnv()
  runMock.mockReset()
  whichMock.mockReset()
  runMock.mockResolvedValue(notFound())
  whichMock.mockResolvedValue(null)
})
afterEach(() => restoreEnv())

async function doctor(sb: Sandbox, opts: DepsOptions = {}) {
  const t = await makeContext(sb)
  const d = makeDeps(opts)
  return { ...t, ...d, api: createDoctorApi(t.ctx, d.deps) }
}

describe('doctor run', () => {
  it('produces a complete report with unique ids, ordered categories and correct counts', async () => {
    await withSandbox(async (sb) => {
      whichMock.mockImplementation(async (cmd: string) => (cmd === 'npx' ? 'C:\\node\\npx.cmd' : null))
      const { api } = await doctor(sb, {
        runtimes: [
          runtime('node', true, { version: '24.11.1' }),
          runtime('npx', true),
          runtime('uv', false),
          runtime('docker', true, { running: false }),
          runtime('git', true, { path: 'C:\\git\\git.exe' })
        ],
        servers: [server('github', 'npx', ['-y', 'gh']), server('py', 'uvx', ['mcp-x'], { target: 'claude-code', scope: 'user' }), server('dock', 'docker', ['run'])]
      })
      const report = await api.run()
      const ids = report.checks.map((c) => c.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(report.summary).toEqual(summarize(report.checks))
      expect(Object.values(report.summary).reduce((a, b) => a + b, 0)).toBe(report.checks.length)
      const order = ['runtimes', 'claude-desktop', 'claude-code', 'vscode', 'models', 'mcp', 'system']
      const cats = report.checks.map((c) => order.indexOf(c.category))
      expect([...cats].sort((a, b) => a - b)).toEqual(cats)

      const byId = new Map(report.checks.map((c) => [c.id, c]))
      expect(byId.get('runtime:node')?.status).toBe('ok')
      expect(byId.get('runtime:uv')).toMatchObject({ status: 'info', fix: { id: 'install-runtime:uv' } })
      expect(byId.get('runtime:docker')?.status).toBe('warn')
      expect(byId.get('runtime:docker')?.detail).toMatch(/dock/)
      expect(byId.get('mcp:command:uvx')).toMatchObject({ status: 'warn', fix: { id: 'install-runtime:uv' } })
      expect(byId.get('mcp:command:uvx')?.detail).toMatch(/py \(Claude Code\)/)
      expect(byId.has('mcp:command:npx')).toBe(false)
      expect(byId.get('desktop:installed')?.status).toBe('info')
      expect(byId.get('models:current')?.status).toBe('ok')
      expect(byId.get('models:auth-conflict')?.status).toBe('ok')
      expect(report.checks.some((c) => c.status === 'error')).toBe(false)
    })
  })

  it('never throws when dependencies fail', async () => {
    await withSandbox(async (sb) => {
      const { api, runtimes, servers } = await doctor(sb, {
        targets: async () => {
          throw new Error('targets broke')
        }
      })
      runtimes.detect.mockRejectedValue(new Error('detect broke'))
      servers.list.mockRejectedValue(new Error('servers broke'))
      const report = await api.run()
      const byId = new Map(report.checks.map((c) => [c.id, c]))
      expect(byId.get('runtimes')).toMatchObject({ status: 'warn' })
      expect(byId.get('runtimes')?.detail).toMatch(/detect broke/)
      expect(byId.get('desktop')?.detail).toMatch(/targets broke/)
      expect(byId.get('mcp')?.detail).toMatch(/servers broke/)
      expect(byId.get('code:installed')?.status).toBe('warn')
    })
  })

  it('finds broken Claude Desktop entries and removes them with a backup', async () => {
    await withSandbox(async (sb) => {
      const configPath = join(sb.root, 'desktop', 'claude_desktop_config.json')
      await writeText(
        configPath,
        JSON.stringify({
          mcpServers: {
            good: { command: 'npx', args: ['-y', 'x'] },
            remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
            badenv: { command: 'node', env: { PORT: 3000 } }
          },
          preferences: { quickEntryShortcut: 'off' }
        })
      )
      const info = desktopInfo({ configPath, configExists: true, configValid: true, serverCount: 3, running: true })
      const { api, backups } = await doctor(sb, { targets: [info] })
      const report = await api.run()
      const entries = report.checks.find((c) => c.id === 'desktop:invalid-entries')!
      expect(entries.status).toBe('error')
      expect(entries.detail).toMatch(/remote: remote servers \(url\) need a bridge/)
      expect(entries.detail).toMatch(/badenv/)
      expect(entries.fix?.id).toBe('remove-invalid-desktop-entries')

      const fix = await api.fix('remove-invalid-desktop-entries')
      expect(fix).toMatchObject({ ok: true, needsRestart: true })
      expect(fix.backupId).toBeTruthy()
      expect(backups.snapshots[0].paths).toEqual([configPath])
      const after = await readJsonFile(configPath)
      expect(after).toEqual({ mcpServers: { good: { command: 'npx', args: ['-y', 'x'] } }, preferences: { quickEntryShortcut: 'off' } })
      expect((await api.fix('remove-invalid-desktop-entries')).message).toMatch(/No broken/)
    })
  })

  it('lists servers whose latest Desktop log event is a failure', async () => {
    await withSandbox(async (sb) => {
      const logDir = desktopLogDirs()[0]
      await writeText(
        join(logDir, 'main.log'),
        [
          '2026-10-23 10:00:00 [info] [LocalMcpServerManager] Connecting to github',
          '2026-10-23 10:00:01 [error] [LocalMcpServerManager] Failed to connect to github: Error: spawn npx ENOENT',
          '2026-10-23 10:00:02 [info] [LocalMcpServerManager] Connected to fs (3 tools)',
          '2026-10-23 11:00:00 [error] [LocalMcpServerManager] Failed to connect to fs: timeout',
          '2026-10-23 11:00:05 [info] [LocalMcpServerManager] Connected to fs (3 tools)'
        ].join('\n')
      )
      const { api } = await doctor(sb, { targets: [desktopInfo({ running: true })] })
      const check = (await api.run()).checks.find((c) => c.id === 'desktop:mcp-errors')!
      expect(check.status).toBe('warn')
      expect(check.detail).toMatch(/: github\./)
      expect(check.detail).not.toMatch(/fs/)
      expect(check.fix?.id).toBe('restart-desktop')
    })
  })

  it('flags Windows policies that turn off local MCP servers', async () => {
    if (process.platform !== 'win32') return
    await withSandbox(async (sb) => {
      runMock.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'reg' && args[1] === 'HKCU\\SOFTWARE\\Policies\\Claude') {
          return ok('\r\nHKEY_CURRENT_USER\\SOFTWARE\\Policies\\Claude\r\n    isLocalDevMcpEnabled    REG_DWORD    0x0\r\n')
        }
        return notFound()
      })
      const { api } = await doctor(sb, { targets: [desktopInfo()] })
      const check = (await api.run()).checks.find((c) => c.id === 'desktop:policies')!
      expect(check.status).toBe('warn')
      expect(check.detail).toMatch(/isLocalDevMcpEnabled/)
    })
  })

  it('checks Claude Code files, PATH and the official marketplace', async () => {
    await withSandbox(async (sb) => {
      const claudePath = join(sb.home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
      runMock.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === 'reg' && args.includes('/v')) return ok('\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Windows;C:\\Tools\r\n')
        if (args.includes('command -v claude')) return notFound()
        return notFound()
      })
      await writeText(claudeUserSettingsPath(), '{ "env": { "A": "1", } }')
      const { api } = await doctor(sb, {
        runtimes: [runtime('node', true), runtime('npx', true), runtime('uv', true), runtime('docker', true, { running: true }), runtime('git', true), runtime('claude', true, { version: '2.1.310', path: claudePath })]
      })
      const byId = new Map((await api.run()).checks.map((c) => [c.id, c]))
      expect(byId.get('code:installed')?.status).toBe('ok')
      expect(byId.get('code:path')?.status).toBe('info')
      expect(byId.get('code:path')?.detail).toMatch(/isn't on your PATH/)
      expect(byId.get('code:settings')?.status).toBe('error')
      expect(byId.get('code:marketplace')?.status).toBe('info')
      expect(byId.get('models:current')?.status).toBe('skip')

      await writeText(claudeUserSettingsPath(), '{}')
      await writeText(join(claudeConfigDir(), 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'claude-plugins-official': { source: {} } }))
      const again = new Map((await api.run()).checks.map((c) => [c.id, c]))
      expect(again.get('code:settings')?.status).toBe('ok')
      expect(again.get('code:marketplace')?.status).toBe('ok')
    })
  })
})

describe('doctor model checks and fixes', () => {
  it('detects and fixes a credential conflict', async () => {
    await withSandbox(async (sb) => {
      await writeText(
        claudeUserSettingsPath(),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key', ANTHROPIC_MODEL: 'deepseek-flash' } })
      )
      const { api, backups } = await doctor(sb)
      const check = (await api.run()).checks.find((c) => c.id === 'models:auth-conflict')!
      expect(check).toMatchObject({ status: 'error', fix: { id: 'fix-auth-conflict' } })
      const fix = await api.fix('fix-auth-conflict')
      expect(fix.ok).toBe(true)
      expect(fix.message).toMatch(/ANTHROPIC_AUTH_TOKEN/)
      expect(backups.snapshots).toHaveLength(1)
      const env = (await readJsonFile<{ env: Record<string, string> }>(claudeUserSettingsPath())).env
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok')
      expect(env.ANTHROPIC_API_KEY).toBe('')
      expect((await api.run()).checks.find((c) => c.id === 'models:auth-conflict')?.status).toBe('ok')
    })
  })

  it('cancels a conflicting credential that comes from the shell', async () => {
    await withSandbox(async (sb) => {
      process.env.ANTHROPIC_API_KEY = 'from-shell'
      await writeText(claudeUserSettingsPath(), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'tok' } }))
      const { api } = await doctor(sb)
      const fix = await api.fix('fix-auth-conflict')
      expect(fix.ok).toBe(true)
      expect(fix.details).toMatch(/environment variables/)
      expect((await readJsonFile<{ env: Record<string, string> }>(claudeUserSettingsPath())).env.ANTHROPIC_API_KEY).toBe('')
    })
  })

  it('offers to start the proxy when Claude Code depends on it', async () => {
    await withSandbox(async (sb) => {
      await writeText(
        claudeUserSettingsPath(),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3460', ANTHROPIC_AUTH_TOKEN: 'cs-test-proxy-token-0001', ANTHROPIC_MODEL: 'gpt-6.1-sol' } })
      )
      const { api, proxy } = await doctor(sb)
      const check = (await api.run()).checks.find((c) => c.id === 'models:proxy')!
      expect(check).toMatchObject({ status: 'error', fix: { id: 'start-proxy' } })
      const fix = await api.fix('start-proxy')
      expect(fix.ok).toBe(true)
      expect(proxy.starts).toBe(1)
      expect((await api.run()).checks.find((c) => c.id === 'models:proxy')?.status).toBe('ok')
    })
  })

  it('aligns VS Code with the terminal, via the active profile or by copying the settings', async () => {
    await withSandbox(async (sb) => {
      await mkdir(join(sb.home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.310-win32-x64'), { recursive: true })
      await mkdir(vscodeUserDir('Code'), { recursive: true })
      const kimiEnv = {
        ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk',
        ANTHROPIC_MODEL: 'kimi-k3[1m]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k3[1m]',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3[1m]',
        CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3[1m]',
        MY_OWN: 'x'
      }
      await writeText(claudeUserSettingsPath(), JSON.stringify({ env: kimiEnv }))
      const { api, ctx, models } = await doctor(sb)
      const check = (await api.run()).checks.find((c) => c.id === 'vscode:model')!
      expect(check).toMatchObject({ status: 'warn', fix: { id: 'apply-model-vscode' } })
      expect((await api.run()).checks.find((c) => c.id === 'vscode:extension')?.status).toBe('ok')

      // No profile → copy the terminal's model settings into VS Code.
      const copied = await api.fix('apply-model-vscode')
      expect(copied.ok).toBe(true)
      expect(models.apply).not.toHaveBeenCalled()
      const vs = await readFile(join(vscodeUserDir('Code'), 'settings.json'), 'utf8')
      expect(vs).toContain('"ANTHROPIC_BASE_URL"')
      expect(vs).toContain('claudeCode.disableLoginPrompt')
      expect(vs).not.toContain('MY_OWN')
      expect((await api.run()).checks.find((c) => c.id === 'vscode:model')?.status).toBe('ok')

      // With a matching profile → re-apply that profile to VS Code.
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'sk', models: { main: 'kimi-k3[1m]' } })
      const viaProfile = await api.fix('apply-model-vscode')
      expect(viaProfile.ok).toBe(true)
      expect(models.apply).toHaveBeenCalledWith({ profileId: p.id, targets: ['vscode'] })
    })
  })

  it('runs the remaining fixes safely', async () => {
    await withSandbox(async (sb) => {
      const { api, runtimes, targets, backups } = await doctor(sb)
      expect(await api.fix('install-runtime:node')).toMatchObject({ ok: true })
      expect(runtimes.install).toHaveBeenCalledWith('node')
      expect((await api.fix('install-runtime:rocket')).ok).toBe(false)
      expect(await api.fix('restart-desktop')).toMatchObject({ ok: true })
      expect(targets.restartDesktop).toHaveBeenCalled()
      expect((await api.fix('no-such-fix')).ok).toBe(false)

      whichMock.mockResolvedValue('C:\\Git\\cmd\\git.exe')
      runMock.mockImplementation(async (_cmd: string, args: string[]) => (args.includes('--get') ? notFound() : ok()))
      const git = await api.fix('git-longpaths')
      expect(git.ok).toBe(true)
      if (process.platform === 'win32') {
        expect(runMock).toHaveBeenCalledWith('C:\\Git\\cmd\\git.exe', ['config', '--global', 'core.longpaths', 'true'], expect.anything())
        expect(backups.snapshots.at(-1)?.paths[0]).toBe(join(sb.home, '.gitconfig'))
      }
    })
  })

  it('suggests turning on Git long paths on Windows', async () => {
    if (process.platform !== 'win32') return
    await withSandbox(async (sb) => {
      runMock.mockImplementation(async (_cmd: string, args: string[]) => (args.includes('core.longpaths') ? notFound() : notFound()))
      const { api } = await doctor(sb)
      const check = (await api.run()).checks.find((c) => c.id === 'system:longpaths')!
      expect(check).toMatchObject({ status: 'info', fix: { id: 'git-longpaths' } })
      runMock.mockImplementation(async (_cmd: string, args: string[]) => (args.includes('core.longpaths') ? ok('true\n') : notFound()))
      expect((await api.run()).checks.find((c) => c.id === 'system:longpaths')?.status).toBe('ok')
    })
  })
})
