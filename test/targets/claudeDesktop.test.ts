import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sys = vi.hoisted(() => ({
  processes: [] as Array<{ ProcessId: number; ExecutablePath: string | null; CommandLine: string | null }>,
  spawned: [] as Array<{ cmd: string; args: string[] }>
}))

vi.mock('@core/platform/exec', () => ({
  run: vi.fn(async () => ({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false })),
  runPowerShell: vi.fn(async (script: string) => ({
    ok: true,
    code: 0,
    stdout: script.includes('Get-CimInstance') ? JSON.stringify(sys.processes) : '',
    stderr: '',
    timedOut: false
  })),
  which: vi.fn(async () => null),
  fixPath: vi.fn(async () => {}),
  cleanEnv: vi.fn(() => ({})),
  spawnDetached: vi.fn((cmd: string, args: string[]) => void sys.spawned.push({ cmd, args }))
}))
vi.mock('@core/platform/runtimes', () => ({
  detectRuntime: vi.fn(async (id: string) => ({ id, label: id, found: true, purpose: '' })),
  detectRuntimes: vi.fn(async () => []),
  installRuntime: vi.fn(),
  findClaudeCli: vi.fn(async () => null),
  findVsCodeCli: vi.fn(async () => null),
  createRuntimesApi: vi.fn()
}))

import type { NormalizedRef } from '@core/targets/adapter'
import { createClaudeDesktopAdapter, desktopFromNative, prepareDesktopConfig, reapplyPendingDesktopChanges } from '@core/targets/claudeDesktop'
import { detectDesktopInstall, parseDesktopLog, resolveDesktopConfig } from '@core/targets/desktopPaths'
import { invalidDesktopEntries } from '@core/targets/validate'
import { withSandbox, type Sandbox } from '../helpers/sandbox'
import { createTestContext } from './testContext'

const REF: NormalizedRef = { target: 'claude-desktop', scope: 'user' }
const win = process.platform === 'win32'

/** Proxy / CA variables of the developer's machine would end up in Desktop entries; keep tests deterministic. */
const MACHINE_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'https_proxy', 'http_proxy', 'no_proxy']
const savedMachineEnv = new Map<string, string | undefined>()
beforeEach(() => {
  for (const k of MACHINE_ENV) {
    savedMachineEnv.set(k, process.env[k])
    delete process.env[k]
  }
})
afterEach(() => {
  for (const [k, v] of savedMachineEnv) if (v !== undefined) process.env[k] = v
})

afterEach(() => {
  sys.processes = []
  sys.spawned = []
})

/** Point Claude Desktop at a sandbox folder (works on every OS). */
async function useDataDir(sb: Sandbox, content?: unknown): Promise<string> {
  const dir = join(sb.root, 'claude-data')
  await mkdir(dir, { recursive: true })
  process.env.CLAUDE_USER_DATA_DIR = dir
  const file = join(dir, 'claude_desktop_config.json')
  if (content !== undefined) await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return file
}

const ORIGINAL = {
  mcpServers: { existing: { command: 'uvx', args: ['mcp-server-time'] } },
  globalShortcut: 'Alt+Space',
  features: { isDxtEnabled: true },
  preferences: { quickEntryShortcut: 'Ctrl+Space', sidebarMode: 'chat', nested: { list: [1, 2, 3] } },
  someFutureKey: { anything: true }
}

describe('Claude Desktop adapter — writing', () => {
  it('adds a server while preserving preferences, unknown keys and other servers, after a backup', () =>
    withSandbox(async (sb) => {
      const file = await useDataDir(sb, ORIGINAL)
      const ctx = await createTestContext(sb)
      const adapter = createClaudeDesktopAdapter(ctx)
      const r = await adapter.add(REF, 'filesystem', { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me'], cwd: '/somewhere' })
      expect(r.ok).toBe(true)
      expect(r.configPath).toBe(file)
      expect(r.backupId).toBe('test-backup-1')
      expect(ctx.backupsTaken[0].contents[file]).toBe(JSON.stringify(ORIGINAL, null, 2))
      const after = JSON.parse(await readFile(file, 'utf8'))
      expect(after.preferences).toEqual(ORIGINAL.preferences)
      expect(after.globalShortcut).toBe('Alt+Space')
      expect(after.features).toEqual({ isDxtEnabled: true })
      expect(after.someFutureKey).toEqual({ anything: true })
      expect(after.mcpServers.existing).toEqual(ORIGINAL.mcpServers.existing)
      // Only the keys Desktop's schema keeps: no type, no cwd.
      expect(after.mcpServers.filesystem).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me'] })
      expect(r.written).toEqual(after.mcpServers.filesystem)
    }))

  it('creates the config file when it does not exist yet', () =>
    withSandbox(async (sb) => {
      const file = await useDataDir(sb)
      const adapter = createClaudeDesktopAdapter(await createTestContext(sb))
      const r = await adapter.add(REF, 'time', { type: 'stdio', command: 'uvx', args: ['mcp-server-time'], env: { TZ: 'UTC' } })
      expect(r.ok).toBe(true)
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mcpServers: { time: { command: 'uvx', args: ['mcp-server-time'], env: { TZ: 'UTC' } } } })
    }))

  it('bridges remote servers through mcp-remote with header values in env, and lists them back as remote', () =>
    withSandbox(async (sb) => {
      const file = await useDataDir(sb, { preferences: {} })
      const adapter = createClaudeDesktopAdapter(await createTestContext(sb))
      const remote = { type: 'http' as const, url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_secret' } }
      const r = await adapter.add(REF, 'github', remote)
      expect(r.ok).toBe(true)
      expect(r.message).toMatch(/mcp-remote/)
      const written = JSON.parse(await readFile(file, 'utf8')).mcpServers.github
      expect(written).toEqual({
        command: 'npx',
        args: ['-y', 'mcp-remote@0.15.2', 'https://api.githubcopilot.com/mcp/', '--transport', 'http-only', '--header', 'Authorization:${MCP_HEADER_AUTHORIZATION}'],
        env: { MCP_HEADER_AUTHORIZATION: 'Bearer ghp_secret' }
      })
      expect(adapter.supports(remote)).toMatchObject({ ok: true, bridged: true })
      const listed = await adapter.list(REF)
      expect(listed.find((s) => s.name === 'github')?.config).toEqual(remote)

      await adapter.add(REF, 'legacy', { type: 'sse', url: 'http://10.0.0.5:8080/sse' })
      await adapter.add(REF, 'local', { type: 'http', url: 'http://localhost:3000/mcp' })
      const all = JSON.parse(await readFile(file, 'utf8')).mcpServers
      expect(all.legacy.args).toEqual(['-y', 'mcp-remote@0.15.2', 'http://10.0.0.5:8080/sse', '--transport', 'sse-only', '--allow-http'])
      expect(all.local.args).toEqual(['-y', 'mcp-remote@0.15.2', 'http://localhost:3000/mcp', '--transport', 'http-only'])
      expect((await adapter.list(REF)).find((s) => s.name === 'legacy')?.config).toEqual({ type: 'sse', url: 'http://10.0.0.5:8080/sse' })
    }))

  it('refuses to write when the file is not valid JSON (Desktop would ignore every server)', () =>
    withSandbox(async (sb) => {
      const broken = '{\n  "mcpServers": {\n    "a": { "command": "x", },\n  }\n}\n'
      const file = await useDataDir(sb, broken)
      const ctx = await createTestContext(sb)
      const adapter = createClaudeDesktopAdapter(ctx)
      const r = await adapter.add(REF, 'time', { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] })
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/mistake/)
      expect(r.message).toMatch(/Doctor/)
      expect(await readFile(file, 'utf8')).toBe(broken)
      expect(ctx.backupsTaken).toHaveLength(0)
      expect((await adapter.remove(REF, 'a')).ok).toBe(false)
      const info = await adapter.info()
      expect(info.configValid).toBe(false)
      expect(info.configError).toMatch(/line/)
      expect(info.notes.join(' ')).toMatch(/ignoring all servers/)
    }))

  it('validates names and entries like Desktop does', () =>
    withSandbox(async (sb) => {
      await useDataDir(sb, {})
      const adapter = createClaudeDesktopAdapter(await createTestContext(sb))
      expect((await adapter.add(REF, 'my server', { type: 'stdio', command: 'x' })).message).toMatch(/can't be used/)
      expect((await adapter.add(REF, 'empty', { type: 'stdio', command: '' })).ok).toBe(false)
    }))

  it('refuses to replace a different server with the same name unless asked; same entry is a no-op', () =>
    withSandbox(async (sb) => {
      const file = await useDataDir(sb, ORIGINAL)
      const ctx = await createTestContext(sb)
      const adapter = createClaudeDesktopAdapter(ctx)
      const clash = await adapter.add(REF, 'existing', { type: 'stdio', command: 'npx', args: ['other'] })
      expect(clash.ok).toBe(false)
      expect(clash.message).toMatch(/already has a different server/)
      const same = await adapter.add(REF, 'existing', { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] })
      expect(same).toMatchObject({ ok: true })
      expect(same.message).toMatch(/already set up/)
      expect(ctx.backupsTaken).toHaveLength(0)
      const replaced = await adapter.add(REF, 'existing', { type: 'stdio', command: 'npx', args: ['other'] }, { overwrite: true })
      expect(replaced.ok).toBe(true)
      expect(JSON.parse(await readFile(file, 'utf8')).mcpServers.existing).toEqual({ command: 'npx', args: ['other'] })
    }))

  it('removes servers, leaving a tidy empty map and everything else intact', () =>
    withSandbox(async (sb) => {
      const file = await useDataDir(sb, ORIGINAL)
      const adapter = createClaudeDesktopAdapter(await createTestContext(sb))
      const r = await adapter.remove(REF, 'existing')
      expect(r.ok).toBe(true)
      const text = await readFile(file, 'utf8')
      expect(text).toContain('"mcpServers": {}')
      expect(JSON.parse(text).preferences).toEqual(ORIGINAL.preferences)
      expect((await adapter.remove(REF, 'existing')).message).toMatch(/no server named/)
    }))

  it('does not touch the file when the backup fails', () =>
    withSandbox(async (sb) => {
      const file = await useDataDir(sb, ORIGINAL)
      const ctx = await createTestContext(sb)
      ctx.failNextBackup()
      const r = await createClaudeDesktopAdapter(ctx).add(REF, 'time', { type: 'stdio', command: 'uvx' })
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/backup/)
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(ORIGINAL)
    }))

  it.runIf(win)('flags needsRestart while Desktop runs and re-applies changes Desktop overwrote', () =>
    withSandbox(async (sb) => {
      const file = await useDataDir(sb, ORIGINAL)
      const ctx = await createTestContext(sb)
      const adapter = createClaudeDesktopAdapter(ctx)
      const exe = 'C:\\Program Files\\WindowsApps\\Claude_3.6556.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'
      sys.processes = [
        { ProcessId: 4242, ExecutablePath: exe, CommandLine: `"${exe}"` },
        { ProcessId: 4243, ExecutablePath: exe, CommandLine: `"${exe}" --type=renderer` },
        { ProcessId: 99, ExecutablePath: 'C:\\Users\\me\\.local\\bin\\claude.exe', CommandLine: 'claude' }
      ]
      const r = await adapter.add(REF, 'time', { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] })
      expect(r.ok).toBe(true)
      expect(r.needsRestart).toBe(true)
      expect(r.message).toMatch(/restart/i)
      expect((await adapter.info()).running).toBe(true)
      // Desktop rewrites the file from memory (without our server) when it quits…
      await writeFile(file, JSON.stringify({ preferences: ORIGINAL.preferences }, null, 2))
      await reapplyPendingDesktopChanges(ctx)
      const after = JSON.parse(await readFile(file, 'utf8'))
      expect(after.mcpServers.time).toEqual({ command: 'uvx', args: ['mcp-server-time'] })
      expect(after.preferences).toEqual(ORIGINAL.preferences)
    }))

  it('reports skipped entries and counts valid servers in info()', () =>
    withSandbox(async (sb) => {
      await useDataDir(sb, { mcpServers: { good: { command: 'x' }, bad: { args: ['no command'] }, 'bad name': { command: 'y' }, numbers: { command: 'z', env: { PORT: 8080 } } } })
      const info = await createClaudeDesktopAdapter(await createTestContext(sb)).info()
      expect(info.serverCount).toBe(1)
      expect(info.notes.join(' ')).toMatch(/skips these entries because they aren't valid: bad, bad name, numbers/)
      expect(info.primary).toBe(true)
      expect(info.supportsRemote).toBe(false)
    }))
})

describe('Claude Desktop — preparing configs', () => {
  it('macOS/Linux: absolute command path and env.PATH so GUI-launched Desktop finds node', async () => {
    const deps = { os: 'darwin' as const, which: async (c: string) => (c === 'npx' ? '/Users/me/.nvm/versions/node/v22.20.0/bin/npx' : null), fixPath: async () => {} }
    expect(await prepareDesktopConfig({ type: 'stdio', command: 'npx', args: ['-y', 'x'] }, deps)).toEqual({
      type: 'stdio',
      command: '/Users/me/.nvm/versions/node/v22.20.0/bin/npx',
      args: ['-y', 'x'],
      env: { PATH: '/Users/me/.nvm/versions/node/v22.20.0/bin:${PATH}' }
    })
    const keepPath = await prepareDesktopConfig({ type: 'stdio', command: 'npx', env: { PATH: '/custom' } }, deps)
    expect(keepPath.env).toEqual({ PATH: '/custom' })
    const bridged = await prepareDesktopConfig({ type: 'http', url: 'https://x.example/mcp' }, deps)
    expect(bridged.command).toBe('/Users/me/.nvm/versions/node/v22.20.0/bin/npx')
    expect(await prepareDesktopConfig({ type: 'stdio', command: 'my-tool' }, deps)).toEqual({ type: 'stdio', command: 'my-tool' })
  })

  it('copies proxy and company-CA settings of this machine into the entry (Desktop does not pass them on)', async () => {
    const deps = {
      os: 'linux' as const,
      which: async () => null,
      fixPath: async () => {},
      env: { https_proxy: 'http://proxy:3128', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', HOME: '/home/me' }
    }
    expect((await prepareDesktopConfig({ type: 'stdio', command: 'tool', env: { NO_PROXY: 'mine' } }, deps)).env).toEqual({
      NO_PROXY: 'mine',
      https_proxy: 'http://proxy:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem'
    })
    const bridged = await prepareDesktopConfig({ type: 'http', url: 'https://x.example/mcp', headers: { A: 'b' } }, deps)
    expect(desktopFromNative({ command: bridged.command, args: bridged.args, env: bridged.env })).toEqual({
      type: 'http',
      url: 'https://x.example/mcp',
      headers: { A: 'b' }
    })
    const win32 = await prepareDesktopConfig({ type: 'stdio', command: 'npx' }, { os: 'win32' as const, which: async () => null, fixPath: async () => {}, env: {} })
    expect(win32).toEqual({ type: 'stdio', command: 'npx' })
  })

  it('Windows: bare commands are kept and cwd is dropped', async () => {
    const deps = { os: 'win32' as const, which: async () => 'C:\\Program Files\\nodejs\\npx.cmd', fixPath: async () => {} }
    expect(await prepareDesktopConfig({ type: 'stdio', command: 'npx', args: ['-y', 'x'], cwd: 'C:\\x' }, deps)).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'x'] })
  })

  it('reads native entries leniently and keeps unknown bridges as plain commands', () => {
    expect(desktopFromNative({ command: 'npx', args: ['-y', 'x'], env: { A: 'b' } })).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: 'b' } })
    expect(desktopFromNative({ args: [] })).toBeNull()
    expect(desktopFromNative('nope')).toBeNull()
    const custom = { command: 'npx', args: ['-y', 'mcp-remote', 'https://x.example/mcp', '--debug'] }
    expect(desktopFromNative(custom)).toMatchObject({ type: 'stdio', command: 'npx' })
    expect(desktopFromNative({ command: 'cmd', args: ['/c', 'npx', '-y', 'mcp-remote@latest', 'https://x.example/sse', '--transport', 'sse-first'] })).toEqual({ type: 'sse', url: 'https://x.example/sse' })
    expect(invalidDesktopEntries({ ok: { command: 'x' }, broken: { command: 1 } })).toEqual(['broken'])
  })
})

describe('Claude Desktop — finding the config file', () => {
  it('uses CLAUDE_USER_DATA_DIR when set', () =>
    withSandbox(async (sb) => {
      const file = await useDataDir(sb)
      expect(await resolveDesktopConfig()).toMatchObject({ configPath: file, source: 'override' })
    }))

  it.runIf(!win)('uses the standard per-OS folder on macOS / Linux', () =>
    withSandbox(async (sb) => {
      const loc = await resolveDesktopConfig()
      const expected =
        process.platform === 'darwin'
          ? join(sb.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : join(sb.home, '.config', 'Claude', 'claude_desktop_config.json')
      expect(loc.configPath).toBe(expected)
    }))

  it('parses main.log lines (newest wins, 3P lines ignored, version from "Starting app")', () => {
    const log = [
      '2026-10-20 10:00:00 [info] Reading claude_desktop_config.json from C:\\old\\claude_desktop_config.json',
      '2026-10-22 16:03:51 [info] Starting app {',
      "  appVersion: '3.6556.1',",
      '  isPackaged: true',
      '}',
      '2026-10-22 16:03:51 [info] Reading claude_desktop_config.json from C:\\new\\claude_desktop_config.json\r',
      '2026-10-22 16:05:00 [info] Reading claude_desktop_config.json from C:\\Users\\me\\AppData\\Local\\Claude-3p\\claude_desktop_config.json'
    ].join('\n')
    expect(parseDesktopLog(log)).toMatchObject({ configPath: 'C:\\new\\claude_desktop_config.json', version: '3.6556.1' })
  })

  it.runIf(win)('Windows: follows the newest main.log line to the MSIX LocalCache folder', () =>
    withSandbox(async (sb) => {
      const msix = join(sb.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude')
      await mkdir(msix, { recursive: true })
      await mkdir(join(sb.localAppData, 'Claude', 'logs'), { recursive: true })
      await writeFile(
        join(sb.localAppData, 'Claude', 'logs', 'main.log'),
        [
          '2026-10-20 09:00:00 [info] Reading claude_desktop_config.json from C:\\gone\\claude_desktop_config.json',
          '2026-10-22 16:03:51 [info] Starting app {',
          "  appVersion: '3.6556.1',",
          '}',
          `2026-10-22 16:03:51 [info] Reading claude_desktop_config.json from ${join(msix, 'claude_desktop_config.json')}`
        ].join('\r\n')
      )
      // A stale roaming copy also exists.
      await mkdir(join(sb.appData, 'Claude'), { recursive: true })
      await writeFile(join(sb.appData, 'Claude', 'claude_desktop_config.json'), '{}')
      const loc = await resolveDesktopConfig()
      expect(loc).toMatchObject({ configPath: join(msix, 'claude_desktop_config.json'), source: 'log' })
      expect(loc.otherCopies).toEqual([join(sb.appData, 'Claude', 'claude_desktop_config.json')])
      const install = await detectDesktopInstall()
      expect(install).toMatchObject({ installed: true, kind: 'msix', packageFamily: 'Claude_pzs8sxrjxfjjc', version: '3.6556.1' })
      const info = await createClaudeDesktopAdapter(await createTestContext(sb)).info()
      expect(info.notes.join(' ')).toMatch(/Microsoft Store \(MSIX\)/)
      expect(info.notes.join(' ')).toMatch(/Another copy/)
    }))

  it.runIf(win)('Windows: falls back to MSIX folder, then Claude-Data, then %APPDATA%\\Claude', () =>
    withSandbox(async (sb) => {
      expect(await resolveDesktopConfig()).toMatchObject({ configPath: join(sb.appData, 'Claude', 'claude_desktop_config.json'), source: 'roaming' })
      const data = join(sb.localAppData, 'Claude-Data', 'Claude_pzs8sxrjxfjjc')
      await mkdir(data, { recursive: true })
      await writeFile(join(data, 'claude_desktop_config.json'), '{}')
      expect(await resolveDesktopConfig()).toMatchObject({ configPath: join(data, 'claude_desktop_config.json'), source: 'data-dir' })
      const store = join(sb.localAppData, 'Packages', 'AnthropicPBC.Claude_fnn82j28hfe8t', 'LocalCache', 'Roaming', 'Claude')
      await mkdir(store, { recursive: true })
      expect(await resolveDesktopConfig()).toMatchObject({ configPath: join(store, 'claude_desktop_config.json'), source: 'msix' })
    }))

  it.runIf(win)('Windows: a Claude-3p folder alone is ignored; an active 3P profile (deploymentMode "3p") gets the servers too', () =>
    withSandbox(async (sb) => {
      const threeP = join(sb.localAppData, 'Claude-3p')
      await mkdir(threeP, { recursive: true })
      const ctx = await createTestContext(sb)
      const adapter = createClaudeDesktopAdapter(ctx)
      expect((await resolveDesktopConfig()).threePConfigPath).toBeUndefined()
      await mkdir(join(threeP, 'configLibrary'), { recursive: true })
      expect((await resolveDesktopConfig()).threePConfigPath).toBeUndefined()
      await writeFile(join(threeP, 'claude_desktop_config.json'), JSON.stringify({ deploymentMode: '1p' }))
      expect((await resolveDesktopConfig()).threePConfigPath).toBeUndefined()
      await writeFile(join(threeP, 'claude_desktop_config.json'), JSON.stringify({ deploymentMode: '3p' }))
      expect((await resolveDesktopConfig()).threePConfigPath).toBe(join(threeP, 'claude_desktop_config.json'))
      const r = await adapter.add(REF, 'time', { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] })
      expect(r.ok).toBe(true)
      expect(ctx.backupsTaken[0].files.map((f) => f.path)).toEqual([join(sb.appData, 'Claude', 'claude_desktop_config.json'), join(threeP, 'claude_desktop_config.json')])
      for (const f of [join(sb.appData, 'Claude', 'claude_desktop_config.json'), join(threeP, 'claude_desktop_config.json')]) {
        expect(JSON.parse(await readFile(f, 'utf8')).mcpServers.time).toEqual({ command: 'uvx', args: ['mcp-server-time'] })
      }
      expect((await adapter.info()).notes.join(' ')).toMatch(/Third-party inference \(3P\)/)
      expect((await adapter.remove(REF, 'time')).ok).toBe(true)
      expect(JSON.parse(await readFile(join(threeP, 'claude_desktop_config.json'), 'utf8')).mcpServers).toEqual({})
    }))

  it.runIf(win)('Windows: detects a Squirrel install and its version from the app folder', () =>
    withSandbox(async (sb) => {
      const root = join(sb.localAppData, 'AnthropicClaude')
      await mkdir(join(root, 'app-0.9.3'), { recursive: true })
      await mkdir(join(root, 'app-0.10.1'), { recursive: true })
      await writeFile(join(root, 'Update.exe'), '')
      expect(await detectDesktopInstall()).toMatchObject({ installed: true, kind: 'squirrel', version: '0.10.1', updateExe: join(root, 'Update.exe') })
    }))

  it.runIf(win)('Windows: not installed when nothing is found', () =>
    withSandbox(async () => {
      expect(await detectDesktopInstall()).toEqual({ installed: false })
    }))
})
