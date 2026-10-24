import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sys = vi.hoisted(() => ({
  managedDir: '' as string,
  claude: { found: false, version: undefined as string | undefined, path: undefined as string | undefined }
}))

vi.mock('@core/platform/exec', () => ({
  run: vi.fn(async () => ({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false })),
  runPowerShell: vi.fn(async () => ({ ok: true, code: 0, stdout: '[]', stderr: '', timedOut: false })),
  which: vi.fn(async () => null),
  fixPath: vi.fn(async () => {}),
  cleanEnv: vi.fn(() => ({})),
  spawnDetached: vi.fn()
}))
vi.mock('@core/platform/runtimes', () => ({
  detectRuntime: vi.fn(async (id: string) => ({ id, label: id, purpose: '', ...(id === 'claude' ? sys.claude : { found: true }) })),
  detectRuntimes: vi.fn(async () => []),
  installRuntime: vi.fn(),
  findClaudeCli: vi.fn(async () => null),
  findVsCodeCli: vi.fn(async () => null),
  createRuntimesApi: vi.fn()
}))
vi.mock('@core/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/platform/paths')>()
  return { ...actual, managedClaudeCodeDir: () => sys.managedDir || join(actual.homeDir(), 'no-managed-dir') }
})
vi.mock('@core/targets/configDoc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/targets/configDoc')>()
  return { ...actual, editsApplied: vi.fn(actual.editsApplied) }
})

import { projectKeyVariants } from '@core/platform/paths'
import type { NormalizedRef } from '@core/targets/adapter'
import { claudeCodeFromNative, createClaudeCodeAdapter } from '@core/targets/claudeCode'
import { editsApplied } from '@core/targets/configDoc'
import { withSandbox, type Sandbox } from '../helpers/sandbox'
import { createTestContext } from './testContext'

const USER: NormalizedRef = { target: 'claude-code', scope: 'user' }

afterEach(() => {
  sys.managedDir = ''
  sys.claude = { found: false, version: undefined, path: undefined }
  vi.mocked(editsApplied).mockClear()
})

function claudeJson(sb: Sandbox): string {
  return join(sb.home, '.claude.json')
}

const REAL_LOOKING = (projectKey: string) => ({
  numStartups: 42,
  installMethod: 'native',
  autoUpdates: false,
  oauthAccount: { accountUuid: 'u-1', emailAddress: 'me@example.com' },
  tipsHistory: { 'new-user-warmup': 7 },
  userID: 'abc123',
  mcpServers: { existing: { type: 'stdio', command: 'uvx', args: ['mcp-server-time'], env: {} } },
  projects: {
    [projectKey]: {
      allowedTools: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      lastCost: 0.12
    }
  }
})

describe('Claude Code adapter — user scope', () => {
  it('writes entries the way `claude mcp add-json` does and preserves projects and other keys', () =>
    withSandbox(async (sb) => {
      const original = REAL_LOOKING('C:/some/project')
      await writeFile(claudeJson(sb), JSON.stringify(original, null, 2))
      const ctx = await createTestContext(sb)
      const adapter = createClaudeCodeAdapter(ctx)
      expect((await adapter.add(USER, 'fs', { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\temp'] })).ok).toBe(true)
      expect((await adapter.add(USER, 'notion', { type: 'http', url: 'https://mcp.notion.com/mcp' })).ok).toBe(true)
      const r = await adapter.add(USER, 'api', { type: 'sse', url: 'https://mcp.example.com/sse', headers: { 'X-Api-Key': 'abc' } })
      expect(r.message).toMatch(/new Claude Code session/)
      const after = JSON.parse(await readFile(claudeJson(sb), 'utf8'))
      expect(after.mcpServers.fs).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\temp'], env: {} })
      expect(after.mcpServers.notion).toEqual({ type: 'http', url: 'https://mcp.notion.com/mcp' })
      expect(after.mcpServers.api).toEqual({ type: 'sse', url: 'https://mcp.example.com/sse', headers: { 'X-Api-Key': 'abc' } })
      expect(after.mcpServers.existing).toEqual(original.mcpServers.existing)
      for (const key of ['numStartups', 'installMethod', 'autoUpdates', 'oauthAccount', 'tipsHistory', 'userID', 'projects'] as const) expect(after[key]).toEqual(original[key])
      expect(ctx.backupsTaken).toHaveLength(3)

      expect((await adapter.remove(USER, 'fs')).ok).toBe(true)
      expect(JSON.parse(await readFile(claudeJson(sb), 'utf8')).mcpServers.fs).toBeUndefined()
      const listed = await adapter.list(USER)
      expect(listed.map((s) => s.name).sort()).toEqual(['api', 'existing', 'notion'])
      expect(listed.find((s) => s.name === 'notion')).toMatchObject({ enabled: true, managedByUs: false, config: { type: 'http', url: 'https://mcp.notion.com/mcp' } })
    }))

  it('uses CLAUDE_CONFIG_DIR when set', () =>
    withSandbox(async (sb) => {
      const dir = join(sb.root, 'alt-claude')
      process.env.CLAUDE_CONFIG_DIR = dir
      const adapter = createClaudeCodeAdapter(await createTestContext(sb))
      expect(await adapter.configFile(USER)).toBe(join(dir, '.claude.json'))
      await adapter.add(USER, 'x', { type: 'stdio', command: 'x' })
      expect(JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8')).mcpServers.x.command).toBe('x')
    }))

  it('re-applies the change when Claude Code rewrote the file at the same moment', () =>
    withSandbox(async (sb) => {
      const original = REAL_LOOKING('C:/p')
      await writeFile(claudeJson(sb), JSON.stringify(original, null, 2))
      vi.mocked(editsApplied).mockImplementationOnce(async (file) => {
        // Simulate Claude Code saving its in-memory copy (without our server, with a new counter value).
        await writeFile(file, JSON.stringify({ ...original, numStartups: 43 }, null, 2))
        return false
      })
      const r = await createClaudeCodeAdapter(await createTestContext(sb)).add(USER, 'fs', { type: 'stdio', command: 'npx', args: ['x'] })
      expect(r.ok).toBe(true)
      const after = JSON.parse(await readFile(claudeJson(sb), 'utf8'))
      expect(after.mcpServers.fs).toEqual({ type: 'stdio', command: 'npx', args: ['x'], env: {} })
      expect(after.numStartups).toBe(43)
      expect(vi.mocked(editsApplied)).toHaveBeenCalledTimes(2)
    }))

  it('gives up with a clear message when the change keeps getting overwritten', () =>
    withSandbox(async (sb) => {
      await writeFile(claudeJson(sb), '{}')
      vi.mocked(editsApplied).mockResolvedValueOnce(false).mockResolvedValueOnce(false)
      const r = await createClaudeCodeAdapter(await createTestContext(sb)).add(USER, 'fs', { type: 'stdio', command: 'npx' })
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/kept changing/)
      expect(r.backupId).toBeTruthy()
    }))

  it('refuses an unreadable ~/.claude.json and mentions Claude Code backups', () =>
    withSandbox(async (sb) => {
      await writeFile(claudeJson(sb), '{ "projects": { ')
      const r = await createClaudeCodeAdapter(await createTestContext(sb)).add(USER, 'fs', { type: 'stdio', command: 'npx' })
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/\.claude[\\/]backups/)
      expect(await readFile(claudeJson(sb), 'utf8')).toBe('{ "projects": { ')
    }))

  it('refuses reserved names', () =>
    withSandbox(async (sb) => {
      const r = await createClaudeCodeAdapter(await createTestContext(sb)).add(USER, 'workspace', { type: 'stdio', command: 'x' })
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/reserves/)
    }))

  it('refuses every write while an enterprise managed-mcp.json is present', () =>
    withSandbox(async (sb) => {
      sys.managedDir = join(sb.root, 'managed')
      await mkdir(sys.managedDir, { recursive: true })
      await writeFile(join(sys.managedDir, 'managed-mcp.json'), '{"mcpServers":{}}')
      const adapter = createClaudeCodeAdapter(await createTestContext(sb))
      const r = await adapter.add(USER, 'fs', { type: 'stdio', command: 'npx' })
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/organization manages/)
      expect((await adapter.remove(USER, 'fs')).message).toMatch(/organization manages/)
      expect((await adapter.info()).notes.join(' ')).toMatch(/organization manages/)
    }))
})

describe('Claude Code adapter — local and project scopes', () => {
  it('local scope writes and removes under every drive-letter variant of the project key', () =>
    withSandbox(async (sb) => {
      const project = join(sb.root, 'proj')
      await mkdir(project, { recursive: true })
      const keys = projectKeyVariants(project)
      if (process.platform === 'win32') expect(keys).toHaveLength(2)
      await writeFile(claudeJson(sb), JSON.stringify(REAL_LOOKING(keys[0]), null, 2))
      const adapter = createClaudeCodeAdapter(await createTestContext(sb))
      const ref: NormalizedRef = { target: 'claude-code', scope: 'local', projectPath: project }
      expect((await adapter.add(ref, 'fs', { type: 'stdio', command: 'npx', args: ['-y', 'x'] })).ok).toBe(true)
      let data = JSON.parse(await readFile(claudeJson(sb), 'utf8'))
      for (const key of keys) expect(data.projects[key].mcpServers.fs).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: {} })
      expect(data.projects[keys[0]].hasTrustDialogAccepted).toBe(true)
      expect(data.projects[keys[0]].lastCost).toBe(0.12)
      expect(data.mcpServers.fs).toBeUndefined()
      expect((await adapter.list(ref)).map((s) => s.name)).toEqual(['fs'])

      expect((await adapter.remove(ref, 'fs')).ok).toBe(true)
      data = JSON.parse(await readFile(claudeJson(sb), 'utf8'))
      for (const key of keys) expect(data.projects[key].mcpServers).toEqual({})
      expect(data.projects[keys[0]].allowedTools).toEqual([])
    }))

  it('local scope inside a git repository uses the repository root as the key', () =>
    withSandbox(async (sb) => {
      const repo = join(sb.root, 'repo')
      const sub = join(repo, 'packages', 'app')
      await mkdir(join(repo, '.git'), { recursive: true })
      await mkdir(sub, { recursive: true })
      const adapter = createClaudeCodeAdapter(await createTestContext(sb))
      await adapter.add({ target: 'claude-code', scope: 'local', projectPath: sub }, 'fs', { type: 'stdio', command: 'npx' })
      const data = JSON.parse(await readFile(claudeJson(sb), 'utf8'))
      for (const key of projectKeyVariants(repo)) expect(data.projects[key].mcpServers.fs).toBeTruthy()
      for (const key of projectKeyVariants(sub)) expect(data.projects[key]).toBeUndefined()
      expect((await adapter.list({ target: 'claude-code', scope: 'local', projectPath: sub })).map((s) => s.name)).toEqual(['fs'])
    }))

  it('project scope writes <project>/.mcp.json', () =>
    withSandbox(async (sb) => {
      const project = join(sb.root, 'shared')
      await mkdir(project, { recursive: true })
      const adapter = createClaudeCodeAdapter(await createTestContext(sb))
      const ref: NormalizedRef = { target: 'claude-code', scope: 'project', projectPath: project }
      const r = await adapter.add(ref, 'shared', { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } })
      expect(r.ok).toBe(true)
      expect(r.message).toMatch(/approve/)
      expect(r.configPath).toBe(join(project, '.mcp.json'))
      expect(JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8'))).toEqual({
        mcpServers: { shared: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } } }
      })
      expect(await adapter.snippet(ref, 'shared', { type: 'http', url: 'https://example.com/mcp' })).toContain('"mcpServers"')
    }))
})

describe('Claude Code adapter — reading and detection', () => {
  it('maps native entries', () => {
    expect(claudeCodeFromNative({ command: 'npx', args: ['x'] })).toEqual({ type: 'stdio', command: 'npx', args: ['x'] })
    expect(claudeCodeFromNative({ type: 'streamable-http', url: 'https://x/mcp' })).toEqual({ type: 'http', url: 'https://x/mcp' })
    expect(claudeCodeFromNative({ type: 'sse', url: 'https://x/sse', headers: { A: 'b' } })).toEqual({ type: 'sse', url: 'https://x/sse', headers: { A: 'b' } })
    expect(claudeCodeFromNative({ type: 'ws', url: 'wss://x' })).toBeNull()
    expect(claudeCodeFromNative({ url: 'https://x/mcp' })).toBeNull()
  })

  it('counts as installed through the VS Code extension and mentions it', () =>
    withSandbox(async (sb) => {
      await mkdir(join(sb.home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.301-win32-x64'), { recursive: true })
      await mkdir(join(sb.home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.309-win32-x64'), { recursive: true })
      const info = await createClaudeCodeAdapter(await createTestContext(sb)).info()
      expect(info.installed).toBe(true)
      expect(info.version).toBe('2.1.309')
      expect(info.notes.join(' ')).toMatch(/extension for VS Code \(2\.1\.309\)/)
      expect(info.notes.join(' ')).toMatch(/includes its own copy of Claude Code/)
      expect(info.scopes).toEqual(['user', 'project', 'local'])
    }))

  it('uses the CLI version when the CLI is installed', () =>
    withSandbox(async (sb) => {
      sys.claude = { found: true, version: '2.1.310', path: 'C:\\Users\\me\\.local\\bin\\claude.exe' }
      await writeFile(claudeJson(sb), JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { type: 'http', url: 'https://x' } } }))
      const info = await createClaudeCodeAdapter(await createTestContext(sb)).info()
      expect(info).toMatchObject({ installed: true, version: '2.1.310', serverCount: 2, configExists: true, configValid: true, primary: true })
      expect(info.notes.join(' ')).toMatch(/VS Code and JetBrains/)
    }))
})
