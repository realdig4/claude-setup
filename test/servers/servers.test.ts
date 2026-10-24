import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sys = vi.hoisted(() => ({
  processes: [] as Array<{ ProcessId: number; ExecutablePath: string | null; CommandLine: string | null }>,
  alive: new Set<number>(),
  spawned: [] as Array<{ cmd: string; args: string[] }>,
  runtimes: {} as Record<string, { found: boolean; running?: boolean }>
}))

vi.mock('@core/platform/exec', () => ({
  run: vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '', timedOut: false })),
  runPowerShell: vi.fn(async (script: string) => {
    if (script.includes('RmShutdown')) {
      for (const p of sys.processes) sys.alive.delete(p.ProcessId)
      sys.processes = []
      return { ok: true, code: 0, stdout: '0', stderr: '', timedOut: false }
    }
    return { ok: true, code: 0, stdout: script.includes('Get-CimInstance') ? JSON.stringify(sys.processes) : '', stderr: '', timedOut: false }
  }),
  which: vi.fn(async (cmd: string) => (cmd === 'node' ? process.execPath : null)),
  fixPath: vi.fn(async () => {}),
  cleanEnv: vi.fn(() => ({})),
  spawnDetached: vi.fn((cmd: string, args: string[]) => void sys.spawned.push({ cmd, args }))
}))
vi.mock('@core/platform/runtimes', () => ({
  detectRuntime: vi.fn(async (id: string) => ({ id, label: id === 'npx' ? 'Node.js (npx)' : id, purpose: 'test', ...(sys.runtimes[id] ?? { found: true }) })),
  detectRuntimes: vi.fn(async () => []),
  installRuntime: vi.fn(),
  findClaudeCli: vi.fn(async () => null),
  findVsCodeCli: vi.fn(async () => null),
  createRuntimesApi: vi.fn()
}))

import type { CatalogApi } from '@shared/api'
import type { CatalogServer } from '@shared/types'
import { roamingDir } from '@core/platform/paths'
import { createServersApi } from '@core/servers'
import { withSandbox, type Sandbox } from '../helpers/sandbox'
import { createTestContext } from '../targets/testContext'

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mcp-echo-server.mjs')

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

const FILESYSTEM: CatalogServer = {
  id: 'io.github.modelcontextprotocol/filesystem',
  name: 'Filesystem',
  slug: 'filesystem',
  description: 'Read and write files',
  categories: ['files'],
  tags: [],
  sources: ['seed'],
  install: [
    {
      id: 'npm',
      kind: 'npm',
      label: 'npm',
      package: '@modelcontextprotocol/server-filesystem',
      version: '2.0.0',
      runtime: 'node',
      transport: 'stdio',
      env: [],
      argsSpec: [{ name: 'directories', required: true, repeatable: true, format: 'directory' }]
    }
  ]
}

const BRAVE: CatalogServer = {
  id: 'io.github.brave/brave-search-mcp-server',
  name: 'Brave Search',
  slug: 'brave-search',
  description: 'Web search',
  categories: ['search'],
  tags: [],
  sources: ['official'],
  install: [
    { id: 'mcpb', kind: 'mcpb', label: 'Desktop extension', package: 'https://x/brave.mcpb', runtime: 'none', transport: 'stdio', env: [] },
    {
      id: 'npm',
      kind: 'npm',
      label: 'npm',
      package: '@brave/brave-search-mcp-server',
      version: '2.1.3',
      runtime: 'node',
      transport: 'stdio',
      env: [{ name: 'BRAVE_API_KEY', required: true, secret: true, description: 'API key' }]
    }
  ]
}

const catalog = {
  get: async (id: string) => [FILESYSTEM, BRAVE].find((s) => s.id === id) ?? null
} as unknown as CatalogApi

afterEach(() => {
  sys.processes = []
  sys.alive.clear()
  sys.spawned = []
  sys.runtimes = {}
  vi.restoreAllMocks()
})

async function setup(sb: Sandbox) {
  const desktopDir = join(sb.root, 'claude-data')
  await mkdir(desktopDir, { recursive: true })
  process.env.CLAUDE_USER_DATA_DIR = desktopDir
  const desktopFile = join(desktopDir, 'claude_desktop_config.json')
  await writeFile(desktopFile, JSON.stringify({ preferences: { keep: true } }, null, 2))
  const ctx = await createTestContext(sb)
  const api = createServersApi(ctx, { catalog })
  return { ctx, api, desktopFile, claudeJson: join(sb.home, '.claude.json') }
}

describe('ServersApi — install / preview', () => {
  it('installs a catalog server into Claude Desktop and Claude Code and records it', () =>
    withSandbox(async (sb) => {
      const { ctx, api, desktopFile, claudeJson } = await setup(sb)
      const events: string[] = []
      ctx.events.on('progress', (p) => events.push(p.message))
      const r = await api.install({
        catalogId: FILESYSTEM.id,
        values: { args: { directories: ['C:\\Users\\me\\Desktop', 'D:\\Work'] } },
        targets: [{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }]
      })
      expect(r.ok).toBe(true)
      expect(r.name).toBe('filesystem')
      expect(r.results.map((x) => x.ok)).toEqual([true, true])
      const expected = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2.0.0', 'C:\\Users\\me\\Desktop', 'D:\\Work'] }
      const desktop = JSON.parse(await readFile(desktopFile, 'utf8'))
      expect(desktop.mcpServers.filesystem).toEqual(expected)
      expect(desktop.preferences).toEqual({ keep: true })
      expect(JSON.parse(await readFile(claudeJson, 'utf8')).mcpServers.filesystem).toEqual({ type: 'stdio', ...expected, env: {} })
      expect(ctx.state.get().installs).toHaveLength(2)
      expect(ctx.state.get().installs[0]).toMatchObject({ name: 'filesystem', catalogId: FILESYSTEM.id, optionId: 'npm', target: { target: 'claude-desktop' } })
      expect(events.some((m) => m.includes('Adding "filesystem" to Claude Desktop'))).toBe(true)
      const listed = await api.list()
      const desktopEntry = listed.find((s) => s.name === 'filesystem' && s.target.target === 'claude-desktop')
      expect(desktopEntry).toMatchObject({ managedByUs: true, catalogId: FILESYSTEM.id, enabled: true })
      expect(desktopEntry?.installedAt).toBeTruthy()
    }))

  it('refuses to install while required values are missing, and changes nothing', () =>
    withSandbox(async (sb) => {
      const { ctx, api, desktopFile } = await setup(sb)
      const r = await api.install({ catalogId: BRAVE.id, targets: [{ target: 'claude-desktop' }] })
      expect(r.ok).toBe(false)
      expect(r.warnings[0]).toContain('BRAVE_API_KEY')
      expect(JSON.parse(await readFile(desktopFile, 'utf8'))).toEqual({ preferences: { keep: true } })
      expect(ctx.backupsTaken).toHaveLength(0)
    }))

  it('previews per-target snippets, missing values, missing runtimes and conflicts', () =>
    withSandbox(async (sb) => {
      const { api } = await setup(sb)
      sys.runtimes.npx = { found: false }
      const p = await api.preview({
        catalogId: BRAVE.id,
        targets: [{ target: 'claude-desktop' }, { target: 'vscode', scope: 'user' }, { target: 'windsurf', scope: 'project', projectPath: sb.root }]
      })
      expect(p.name).toBe('brave-search')
      expect(p.config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server@2.1.3'] })
      expect(p.missingValues).toEqual(['BRAVE_API_KEY'])
      expect(p.missingRuntimes.map((r) => r.id)).toEqual(['npx'])
      expect(JSON.parse(p.targets[0].snippet)).toEqual({ mcpServers: { 'brave-search': { command: 'npx', args: ['-y', '@brave/brave-search-mcp-server@2.1.3'] } } })
      expect(JSON.parse(p.targets[1].snippet)).toEqual({ servers: { 'brave-search': { type: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server@2.1.3'] } } })
      expect(p.targets[2]).toMatchObject({ supported: false })
      expect(p.targets[2].note).toMatch(/doesn't support/)
    }))

  it('previews remote servers for Claude Desktop as an mcp-remote bridge and warns about risky docker flags', () =>
    withSandbox(async (sb) => {
      const { api } = await setup(sb)
      const remote = await api.preview({ config: { type: 'http', url: 'https://mcp.notion.com/mcp' }, targets: [{ target: 'claude-desktop' }] })
      expect(remote.name).toBe('notion')
      expect(remote.targets[0].note).toMatch(/mcp-remote/)
      expect(remote.targets[0].snippet).toContain('mcp-remote@0.15.2')
      const docker = await api.preview({ config: { type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', '--privileged', 'img'] }, targets: [] })
      expect(docker.warnings.join(' ')).toMatch(/--privileged/)
      const bad = await api.preview({ name: 'bad name', config: { type: 'stdio', command: 'x' }, targets: [] })
      expect(bad.warnings[0]).toMatch(/can't be used as a server name/)
    }))

  it('validates install requests', () =>
    withSandbox(async (sb) => {
      const { api } = await setup(sb)
      expect((await api.install({ config: { type: 'stdio', command: 'x' }, targets: [] })).warnings[0]).toMatch(/at least one app/)
      expect((await api.install({ name: 'a b', config: { type: 'stdio', command: 'x' }, targets: [{ target: 'claude-desktop' }] })).ok).toBe(false)
      expect((await api.install({ catalogId: 'nope', targets: [{ target: 'claude-desktop' }] })).warnings[0]).toMatch(/isn't in the catalog/)
      expect((await api.install({ config: { type: 'http', url: 'nope' }, targets: [{ target: 'claude-desktop' }] })).warnings[0]).toMatch(/not a valid web address/)
      const r = await api.install({ config: { type: 'stdio', command: 'x' }, targets: [{ target: 'claude-code', scope: 'project' }] })
      expect(r.results[0].message).toMatch(/project folder/)
    }))

  it('copies a bridged Desktop server to apps with native remote support', () =>
    withSandbox(async (sb) => {
      const { api } = await setup(sb)
      await api.install({ name: 'github', config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer t' } }, targets: [{ target: 'claude-desktop' }] })
      const r = await api.copy('github', { target: 'claude-desktop' }, [{ target: 'vscode', scope: 'user' }, { target: 'cursor', scope: 'user' }])
      expect(r.ok).toBe(true)
      expect(JSON.parse(await readFile(join(roamingDir(), 'Code', 'User', 'mcp.json'), 'utf8')).servers.github).toEqual({
        type: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer t' }
      })
      expect(JSON.parse(await readFile(join(sb.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.github).toEqual({
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer t' }
      })
      expect((await api.copy('missing', { target: 'claude-desktop' }, [{ target: 'cursor' }])).ok).toBe(false)
    }))

  it('remembers project folders and lists project servers', () =>
    withSandbox(async (sb) => {
      const { ctx, api } = await setup(sb)
      const project = join(sb.root, 'my-app')
      await mkdir(project, { recursive: true })
      const r = await api.install({ config: { type: 'stdio', command: 'uvx', args: ['mcp-server-git'] }, targets: [{ target: 'claude-code', scope: 'project', projectPath: project }] })
      expect(r.ok).toBe(true)
      expect(r.name).toBe('git')
      expect(ctx.state.settings().recentProjects).toEqual([project])
      const listed = await api.list({ target: 'claude-code' })
      expect(listed.find((s) => s.name === 'git')?.target).toEqual({ target: 'claude-code', scope: 'project', projectPath: project })
      expect(await api.list({ target: 'claude-code', scope: 'user' })).toEqual([])

      // A second project: without a filter both recent projects are listed; projectPath narrows to one project.
      const other = join(sb.root, 'other-app')
      await mkdir(other, { recursive: true })
      await api.install({ name: 'fetch', config: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }, targets: [{ target: 'claude-code', scope: 'local', projectPath: other }] })
      expect(ctx.state.settings().recentProjects).toEqual([other, project])
      expect((await api.list({ target: 'claude-code' })).map((s) => s.name).sort()).toEqual(['fetch', 'git'])
      expect((await api.list({ target: 'claude-code', projectPath: project })).map((s) => s.name)).toEqual(['git'])
      expect((await api.list({ target: 'claude-code', scope: 'local', projectPath: other })).map((s) => s.name)).toEqual(['fetch'])
    }))
})

describe('ServersApi — turning servers off and on', () => {
  it('stashes a turned-off server without putting secrets into state.json, and restores it exactly', () =>
    withSandbox(async (sb) => {
      const { ctx, api, desktopFile } = await setup(sb)
      await api.install({ catalogId: BRAVE.id, values: { env: { BRAVE_API_KEY: 'BSA-super-secret-123' } }, targets: [{ target: 'claude-desktop' }] })
      const before = JSON.parse(await readFile(desktopFile, 'utf8')).mcpServers['brave-search']

      const off = await api.setEnabled('brave-search', { target: 'claude-desktop' }, false)
      expect(off.ok).toBe(true)
      expect(off.message).toMatch(/Turned off/)
      expect(JSON.parse(await readFile(desktopFile, 'utf8')).mcpServers['brave-search']).toBeUndefined()
      const stateText = await readFile(join(sb.dataDir, 'state.json'), 'utf8')
      expect(stateText).not.toContain('BSA-super-secret-123')
      const listed = (await api.list({ target: 'claude-desktop' })).find((s) => s.name === 'brave-search')
      expect(listed).toMatchObject({ enabled: false, managedByUs: true, catalogId: BRAVE.id })
      expect(listed?.config).toMatchObject({ env: { BRAVE_API_KEY: '' } })
      expect((await api.setEnabled('brave-search', { target: 'claude-desktop' }, false)).message).toMatch(/already turned off/)

      const on = await api.setEnabled('brave-search', { target: 'claude-desktop' }, true)
      expect(on.ok).toBe(true)
      expect(JSON.parse(await readFile(desktopFile, 'utf8')).mcpServers['brave-search']).toEqual(before)
      expect(ctx.state.get().disabled).toHaveLength(0)
      expect((await api.setEnabled('brave-search', { target: 'claude-desktop' }, true)).message).toMatch(/already on/)
    }))

  it('keeps app-specific fields (e.g. VS Code envFile) when a server is turned back on', () =>
    withSandbox(async (sb) => {
      const { api } = await setup(sb)
      const userDir = join(roamingDir(), 'Code', 'User')
      await mkdir(userDir, { recursive: true })
      const entry = { type: 'stdio', command: 'node', args: ['server.js'], envFile: '${workspaceFolder}/.env', dev: { watch: 'src/**/*.ts' } }
      await writeFile(join(userDir, 'mcp.json'), JSON.stringify({ servers: { local: entry } }, null, '\t'))
      const ref = { target: 'vscode' as const, scope: 'user' as const }
      expect((await api.setEnabled('local', ref, false)).ok).toBe(true)
      expect(JSON.parse(await readFile(join(userDir, 'mcp.json'), 'utf8')).servers).toEqual({})
      expect((await api.setEnabled('local', ref, true)).ok).toBe(true)
      expect(JSON.parse(await readFile(join(userDir, 'mcp.json'), 'utf8')).servers.local).toEqual(entry)
    }))

  it('updates active and turned-off servers', () =>
    withSandbox(async (sb) => {
      const { api, claudeJson } = await setup(sb)
      const ref = { target: 'claude-code' as const, scope: 'user' as const }
      await api.install({ name: 'tool', config: { type: 'stdio', command: 'npx', args: ['tool@1'] }, targets: [ref] })
      expect((await api.update('tool', ref, { type: 'stdio', command: 'npx', args: ['tool@2'] })).ok).toBe(true)
      expect(JSON.parse(await readFile(claudeJson, 'utf8')).mcpServers.tool.args).toEqual(['tool@2'])
      await api.setEnabled('tool', ref, false)
      const r = await api.update('tool', ref, { type: 'stdio', command: 'npx', args: ['tool@3'], env: { TOKEN: 'sekret-value' } })
      expect(r.message).toMatch(/stays turned off/)
      expect(JSON.parse(await readFile(claudeJson, 'utf8')).mcpServers.tool).toBeUndefined()
      await api.setEnabled('tool', ref, true)
      expect(JSON.parse(await readFile(claudeJson, 'utf8')).mcpServers.tool).toEqual({ type: 'stdio', command: 'npx', args: ['tool@3'], env: { TOKEN: 'sekret-value' } })
      expect((await api.update('nope', ref, { type: 'stdio', command: 'x' })).ok).toBe(false)
    }))

  it('uninstalls active and turned-off servers, cleaning records and stashed secrets', () =>
    withSandbox(async (sb) => {
      const { ctx, api, desktopFile } = await setup(sb)
      await api.install({ name: 'a', config: { type: 'stdio', command: 'npx', args: ['a'], env: { KEY: 'k-1' } }, targets: [{ target: 'claude-desktop' }, { target: 'claude-code' }] })
      await api.setEnabled('a', { target: 'claude-code' }, false)
      const secretRef = (ctx.state.get().disabled[0] as { secretRef?: string }).secretRef!
      expect(await ctx.secretStore.has(secretRef)).toBe(true)
      const results = await api.uninstall('a', [{ target: 'claude-desktop' }, { target: 'claude-code' }, { target: 'cursor' }])
      expect(results.map((r) => r.ok)).toEqual([true, true, false])
      expect(results[1].message).toMatch(/it was turned off/)
      expect(results[2].message).toMatch(/no server named/)
      expect(JSON.parse(await readFile(desktopFile, 'utf8')).mcpServers).toEqual({})
      expect(ctx.state.get().installs).toHaveLength(0)
      expect(ctx.state.get().disabled).toHaveLength(0)
      expect(await ctx.secretStore.has(secretRef)).toBe(false)
    }))

  it.runIf(process.platform === 'win32')('restarts Claude Desktop automatically when the user opted in', () =>
    withSandbox(async (sb) => {
      const { ctx, api } = await setup(sb)
      await ctx.state.update((d) => {
        d.settings.autoRestartDesktop = true
      })
      await mkdir(join(sb.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc'), { recursive: true })
      const exe = 'C:\\Program Files\\WindowsApps\\Claude_3.6556.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'
      sys.processes = [{ ProcessId: 777, ExecutablePath: exe, CommandLine: `"${exe}"` }]
      sys.alive.add(777)
      vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
        if (sys.alive.has(pid)) return true
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      }) as typeof process.kill)
      const r = await api.install({ name: 'time', config: { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] }, targets: [{ target: 'claude-desktop' }] })
      expect(r.ok).toBe(true)
      expect(r.results[0].needsRestart).toBe(false)
      expect(r.results[0].message).toMatch(/restarted automatically/)
      expect(sys.spawned[0].args).toEqual(['shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude'])
    }))
})

describe('ServersApi — testing', () => {
  it('tests an installed Claude Code server with ${VAR} expansion', () =>
    withSandbox(async (sb) => {
      const { api } = await setup(sb)
      process.env.CLAUDE_SETUP_TEST_SOURCE = 'value-from-env'
      try {
        await api.install({
          name: 'echo',
          config: { type: 'stdio', command: process.execPath, args: [fixture, '--require-env', 'FIXTURE_TOKEN'], env: { FIXTURE_TOKEN: '${CLAUDE_SETUP_TEST_SOURCE}' } },
          targets: [{ target: 'claude-code' }]
        })
        const r = await api.testInstalled('echo', { target: 'claude-code' })
        expect(r.ok).toBe(true)
        expect(r.tools.map((t) => t.name).sort()).toEqual(['add', 'echo'])
      } finally {
        delete process.env.CLAUDE_SETUP_TEST_SOURCE
      }
    }))

  it('tests raw configs and reports problems in a friendly way', () =>
    withSandbox(async (sb) => {
      const { api } = await setup(sb)
      expect((await api.test({ type: 'stdio', command: process.execPath, args: [fixture] }, { timeoutMs: 20000 })).ok).toBe(true)
      expect((await api.test({ type: 'stdio', command: '' })).kind).toBe('invalid-config')
      expect((await api.testInstalled('nope', { target: 'claude-desktop' })).error).toMatch(/no server named/)
    }))

  it('runs an optional test right after installing', () =>
    withSandbox(async (sb) => {
      const { api } = await setup(sb)
      const r = await api.install({ name: 'echo', config: { type: 'stdio', command: process.execPath, args: [fixture] }, targets: [{ target: 'cursor' }], test: true })
      expect(r.ok).toBe(true)
      expect(r.test?.ok).toBe(true)
    }))
})
