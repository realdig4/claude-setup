import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@core/platform/exec', () => ({
  run: vi.fn(async () => ({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false })),
  runPowerShell: vi.fn(async () => ({ ok: true, code: 0, stdout: '[]', stderr: '', timedOut: false })),
  which: vi.fn(async () => null),
  fixPath: vi.fn(async () => {}),
  cleanEnv: vi.fn(() => ({})),
  spawnDetached: vi.fn()
}))
vi.mock('@core/platform/runtimes', () => ({
  detectRuntime: vi.fn(async (id: string) => ({ id, label: id, purpose: '', found: false })),
  detectRuntimes: vi.fn(async () => []),
  installRuntime: vi.fn(),
  findClaudeCli: vi.fn(async () => null),
  findVsCodeCli: vi.fn(async () => null),
  createRuntimesApi: vi.fn()
}))

import { roamingDir } from '@core/platform/paths'
import { createTargetsApi } from '@core/targets'
import { withSandbox } from '../helpers/sandbox'
import { createTestContext } from './testContext'

describe('TargetsApi', () => {
  it('lists all five targets in order with primary flags, counts and notes', () =>
    withSandbox(async (sb) => {
      process.env.CLAUDE_USER_DATA_DIR = join(sb.root, 'claude-data')
      await mkdir(process.env.CLAUDE_USER_DATA_DIR, { recursive: true })
      await writeFile(join(process.env.CLAUDE_USER_DATA_DIR, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }))
      await writeFile(join(sb.home, '.claude.json'), JSON.stringify({ mcpServers: { c: { type: 'stdio', command: 'z' } } }))
      const api = createTargetsApi(await createTestContext(sb))
      const list = await api.list()
      expect(list.map((t) => t.id)).toEqual(['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf'])
      expect(list.filter((t) => t.primary).map((t) => t.id)).toEqual(['claude-desktop', 'claude-code'])
      expect(list[0]).toMatchObject({ label: 'Claude Desktop', serverCount: 2, configExists: true, configValid: true, supportsRemote: false, scopes: ['user'], running: false })
      expect(list[1]).toMatchObject({ label: 'Claude Code', serverCount: 1, supportsRemote: true })
      expect(list[1].notes.join(' ')).toMatch(/isn't installed yet/)
      expect(list[2]).toMatchObject({ id: 'vscode', installed: false, configExists: false, configValid: true, serverCount: 0 })
      for (const t of list) expect(Array.isArray(t.notes)).toBe(true)
    }))

  it('returns config paths and raw text, and null for invalid refs', () =>
    withSandbox(async (sb) => {
      const api = createTargetsApi(await createTestContext(sb))
      expect(await api.configPath({ target: 'claude-code', scope: 'user' })).toBe(join(sb.home, '.claude.json'))
      expect(await api.configPath({ target: 'vscode' })).toBe(join(roamingDir(), 'Code', 'User', 'mcp.json'))
      expect(await api.configPath({ target: 'claude-code', scope: 'project' })).toBeNull()
      expect(await api.configPath({ target: 'nope' as never })).toBeNull()
      expect(await api.readRaw({ target: 'cursor' })).toEqual({ path: join(sb.home, '.cursor', 'mcp.json'), exists: false, text: '' })
      await mkdir(join(sb.home, '.cursor'), { recursive: true })
      await writeFile(join(sb.home, '.cursor', 'mcp.json'), '{ "mcpServers": {} }')
      expect(await api.readRaw({ target: 'cursor' })).toMatchObject({ exists: true, text: '{ "mcpServers": {} }' })
      const project = join(sb.root, 'p')
      await mkdir(project)
      expect(await api.configPath({ target: 'claude-code', scope: 'project', projectPath: project })).toBe(join(project, '.mcp.json'))
    }))

  it('restartDesktop explains when Claude Desktop is not installed', () =>
    withSandbox(async (sb) => {
      if (process.platform !== 'win32') return
      const api = createTargetsApi(await createTestContext(sb))
      expect(await api.restartDesktop()).toEqual({ ok: false, message: "Claude Desktop isn't installed on this computer." })
    }))
})
