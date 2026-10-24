import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

import { roamingDir } from '@core/platform/paths'
import type { NormalizedRef } from '@core/targets/adapter'
import { createCursorAdapter, cursorFromNative } from '@core/targets/cursor'
import { createVsCodeAdapter, vscodeFromNative } from '@core/targets/vscode'
import { createWindsurfAdapter, devinMcpPath, windsurfClassicPath, windsurfFromNative } from '@core/targets/windsurf'
import { withSandbox } from '../helpers/sandbox'
import { createTestContext } from './testContext'

const VSCODE_JSONC = `{
\t// Servers for Copilot agent mode
\t"servers": {
\t\t"github": {
\t\t\t"type": "http",
\t\t\t"url": "https://api.githubcopilot.com/mcp/" // remote
\t\t}
\t},
\t/* prompts */
\t"inputs": [
\t\t{ "type": "promptString", "id": "api-key", "description": "API key", "password": true }
\t]
}
`

describe('VS Code (native MCP)', () => {
  it('adds and removes servers in the user mcp.json keeping comments, inputs and tabs', () =>
    withSandbox(async (sb) => {
      const userDir = join(roamingDir(), 'Code', 'User')
      await mkdir(userDir, { recursive: true })
      const file = join(userDir, 'mcp.json')
      await writeFile(file, VSCODE_JSONC)
      const ctx = await createTestContext(sb)
      const adapter = createVsCodeAdapter(ctx)
      const ref: NormalizedRef = { target: 'vscode', scope: 'user' }
      const r = await adapter.add(ref, 'memory', { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { KEY: '${input:api-key}' } })
      expect(r.ok).toBe(true)
      expect(r.configPath).toBe(file)
      let text = await readFile(file, 'utf8')
      expect(text).toContain('// Servers for Copilot agent mode')
      expect(text).toContain('// remote')
      expect(text).toContain('/* prompts */')
      expect(text).toContain('{ "type": "promptString", "id": "api-key", "description": "API key", "password": true }')
      expect(text).toContain('\t\t"memory": {')
      const listed = await adapter.list(ref)
      expect(listed.find((s) => s.name === 'memory')?.config).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { KEY: '${input:api-key}' } })
      expect(listed.find((s) => s.name === 'github')?.config).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/' })
      expect(ctx.backupsTaken[0].contents[file]).toBe(VSCODE_JSONC)

      expect((await adapter.remove(ref, 'memory')).ok).toBe(true)
      text = await readFile(file, 'utf8')
      expect(text).not.toContain('"memory"')
      expect(text).toContain('// remote')
      expect(text).toContain('"inputs"')
    }))

  it('writes {type:"stdio"} entries and keeps VS Code Insiders in sync when installed', () =>
    withSandbox(async (sb) => {
      await mkdir(join(roamingDir(), 'Code', 'User'), { recursive: true })
      await mkdir(join(roamingDir(), 'Code - Insiders', 'User'), { recursive: true })
      const adapter = createVsCodeAdapter(await createTestContext(sb))
      const ref: NormalizedRef = { target: 'vscode', scope: 'user' }
      expect(await adapter.configFiles(ref)).toHaveLength(2)
      await adapter.add(ref, 'time', { type: 'stdio', command: 'uvx', args: ['mcp-server-time'], cwd: '/x' })
      for (const variant of ['Code', 'Code - Insiders']) {
        const data = JSON.parse(await readFile(join(roamingDir(), variant, 'User', 'mcp.json'), 'utf8'))
        expect(data.servers.time).toEqual({ type: 'stdio', command: 'uvx', args: ['mcp-server-time'], cwd: '/x' })
      }
      const info = await adapter.info()
      expect(info).toMatchObject({ installed: true, serverCount: 1, scopes: ['user', 'project'], primary: false })
      expect(info.notes.join(' ')).toMatch(/Insiders/)
    }))

  it('uses VS Code Insiders alone when stable VS Code is not installed', () =>
    withSandbox(async (sb) => {
      await mkdir(join(roamingDir(), 'Code - Insiders', 'User'), { recursive: true })
      const adapter = createVsCodeAdapter(await createTestContext(sb))
      expect(await adapter.configFiles({ target: 'vscode', scope: 'user' })).toEqual([join(roamingDir(), 'Code - Insiders', 'User', 'mcp.json')])
    }))

  it('project scope writes .vscode/mcp.json', () =>
    withSandbox(async (sb) => {
      const project = join(sb.root, 'app')
      await mkdir(project, { recursive: true })
      const adapter = createVsCodeAdapter(await createTestContext(sb))
      await adapter.add({ target: 'vscode', scope: 'project', projectPath: project }, 'api', { type: 'sse', url: 'https://x.example/sse', headers: { A: 'b' } })
      expect(JSON.parse(await readFile(join(project, '.vscode', 'mcp.json'), 'utf8'))).toEqual({ servers: { api: { type: 'sse', url: 'https://x.example/sse', headers: { A: 'b' } } } })
    }))

  it('refuses a broken mcp.json', () =>
    withSandbox(async (sb) => {
      const userDir = join(roamingDir(), 'Code', 'User')
      await mkdir(userDir, { recursive: true })
      await writeFile(join(userDir, 'mcp.json'), '{ "servers": { "a": ')
      const r = await createVsCodeAdapter(await createTestContext(sb)).add({ target: 'vscode', scope: 'user' }, 'b', { type: 'stdio', command: 'x' })
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/can't be read/)
    }))

  it('reads VS Code entries leniently (numbers in env, no type)', () => {
    expect(vscodeFromNative({ type: 'stdio', command: 'x', env: { PORT: 8080, NOTHING: null } })).toEqual({ type: 'stdio', command: 'x', env: { PORT: '8080' } })
    expect(vscodeFromNative({ url: 'https://x/mcp' })).toEqual({ type: 'http', url: 'https://x/mcp' })
  })
})

describe('Cursor', () => {
  it('writes ~/.cursor/mcp.json with command / url entries', () =>
    withSandbox(async (sb) => {
      const adapter = createCursorAdapter(await createTestContext(sb))
      const ref: NormalizedRef = { target: 'cursor', scope: 'user' }
      await adapter.add(ref, 'fs', { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } })
      await adapter.add(ref, 'remote', { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer t' } })
      const file = join(sb.home, '.cursor', 'mcp.json')
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        mcpServers: { fs: { command: 'npx', args: ['-y', 'x'], env: { A: '1' } }, remote: { url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer t' } } }
      })
      expect((await adapter.list(ref)).find((s) => s.name === 'remote')?.config).toEqual({ type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer t' } })
      expect((await adapter.info()).installed).toBe(true)
    }))

  it('project scope uses .cursor/mcp.json; SSE endpoints are recognized', () =>
    withSandbox(async (sb) => {
      const project = join(sb.root, 'web')
      await mkdir(project, { recursive: true })
      const ref: NormalizedRef = { target: 'cursor', scope: 'project', projectPath: project }
      expect(await createCursorAdapter(await createTestContext(sb)).configFile(ref)).toBe(join(project, '.cursor', 'mcp.json'))
      expect(cursorFromNative({ url: 'https://x.example/sse' })).toEqual({ type: 'sse', url: 'https://x.example/sse' })
    }))
})

describe('Windsurf / Devin Desktop', () => {
  it('classic Windsurf: ~/.codeium/windsurf/mcp_config.json with serverUrl for remote servers', () =>
    withSandbox(async (sb) => {
      await mkdir(join(sb.home, '.codeium', 'windsurf'), { recursive: true })
      const adapter = createWindsurfAdapter(await createTestContext(sb))
      const ref: NormalizedRef = { target: 'windsurf', scope: 'user' }
      expect(await adapter.configFiles(ref)).toEqual([windsurfClassicPath()])
      const r = await adapter.add(ref, 'github', { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } })
      expect(r.message).toMatch(/Refresh/)
      expect(JSON.parse(await readFile(windsurfClassicPath(), 'utf8'))).toEqual({
        mcpServers: { github: { serverUrl: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } } }
      })
      expect((await adapter.list(ref))[0].config).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } })
      expect((await adapter.info()).installed).toBe(true)
    }))

  it('Devin Desktop installed: its mcp_config.json is primary (url + transport) and the classic file stays in sync', () =>
    withSandbox(async (sb) => {
      await mkdir(join(roamingDir(), 'Devin'), { recursive: true })
      await mkdir(join(sb.home, '.codeium', 'windsurf'), { recursive: true })
      await writeFile(windsurfClassicPath(), '{\n  // old servers\n  "mcpServers": {}\n}\n')
      const adapter = createWindsurfAdapter(await createTestContext(sb))
      const ref: NormalizedRef = { target: 'windsurf', scope: 'user' }
      expect(await adapter.configFiles(ref)).toEqual([devinMcpPath(), windsurfClassicPath()])
      await adapter.add(ref, 'legacy', { type: 'sse', url: 'https://x.example/sse' })
      await adapter.add(ref, 'fs', { type: 'stdio', command: 'npx', args: ['-y', 'x'] })
      expect(JSON.parse(await readFile(devinMcpPath(), 'utf8')).mcpServers).toEqual({
        legacy: { url: 'https://x.example/sse', transport: 'sse' },
        fs: { command: 'npx', args: ['-y', 'x'] }
      })
      const classic = await readFile(windsurfClassicPath(), 'utf8')
      expect(classic).toContain('// old servers')
      expect(classic).toContain('"serverUrl": "https://x.example/sse"')
      expect(windsurfFromNative({ url: 'https://x.example/mcp', transport: 'http' })).toEqual({ type: 'http', url: 'https://x.example/mcp' })
      expect((await adapter.remove(ref, 'legacy')).ok).toBe(true)
      expect(await readFile(windsurfClassicPath(), 'utf8')).not.toContain('legacy')
    }))

  it('only supports user-wide servers', async () => {
    const { normalizeRef } = await import('@core/targets/refs')
    const check = await normalizeRef({ target: 'windsurf', scope: 'project', projectPath: process.cwd() })
    expect(check.ok).toBe(false)
  })
})
