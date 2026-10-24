import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import type { CoreApi } from '@shared/api'
import { TOOL_NAMES, buildMcpServer } from '../../src/mcp/tools'
import { makeFakeCore, sampleServer, type FakeCore } from './fakeCore'

type CallResult = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }

let client: Client | null = null

async function connect(core: FakeCore | (() => Promise<CoreApi>)): Promise<Client> {
  const getCore = typeof core === 'function' ? core : async () => core as unknown as CoreApi
  const server = buildMcpServer(getCore, '9.9.9')
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  client = new Client({ name: 'test', version: '1' })
  await client.connect(b)
  return client
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await c.callTool({ name, arguments: args })) as unknown as CallResult
}

afterEach(async () => {
  await client?.close().catch(() => {})
  client = null
})

describe('MCP server definition', () => {
  it('exposes every tool with object schemas (no top-level unions) and annotations', async () => {
    const c = await connect(makeFakeCore())
    expect(c.getServerVersion()).toMatchObject({ name: 'claude-setup', version: '9.9.9' })
    expect(c.getInstructions()).toMatch(/confirm with the user/i)
    const { tools } = await c.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object')
      expect(t.inputSchema).not.toHaveProperty('anyOf')
      expect(t.inputSchema).not.toHaveProperty('oneOf')
      expect(t.inputSchema).not.toHaveProperty('allOf')
      expect(t.description?.length).toBeGreaterThan(20)
      expect(t.annotations).toBeDefined()
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.search_mcp_servers.annotations?.readOnlyHint).toBe(true)
    expect(byName.uninstall_mcp_server.annotations?.destructiveHint).toBe(true)
    expect(byName.restore_backup.annotations?.destructiveHint).toBe(true)
    expect(byName.install_mcp_server.annotations?.readOnlyHint).toBe(false)
    expect(byName.test_mcp_server.annotations?.openWorldHint).toBe(true)
  })
})

describe('catalog tools', () => {
  it('search_mcp_servers maps arguments and returns concise text + structured items', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    const r = await call(c, 'search_mcp_servers', { query: 'github', remote_only: true, limit: 5 })
    expect(core.catalog.search).toHaveBeenCalledWith({ query: 'github', category: undefined, remoteOnly: true, noKeyRequired: undefined, limit: 5, offset: 0 })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toContain('io.github.example/github')
    const items = r.structuredContent?.items as Array<Record<string, unknown>>
    expect(items[0]).toMatchObject({ id: sampleServer.id, needsKey: false, remote: true, installOptions: ['npm', 'remote'] })
  })

  it('get_mcp_server reports unknown ids as a tool error', async () => {
    const c = await connect(makeFakeCore())
    const ok = await call(c, 'get_mcp_server', { id: sampleServer.id })
    expect(ok.content[0].text).toContain('option_id "npm"')
    expect(ok.content[0].text).toContain('GITHUB_TOKEN')
    const missing = await call(c, 'get_mcp_server', { id: 'nope' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toMatch(/search_mcp_servers/)
  })

  it('validates input with the schema', async () => {
    const c = await connect(makeFakeCore())
    const r = await call(c, 'search_mcp_servers', { limit: 500 })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/Input validation error/)
  })
})

describe('install_mcp_server', () => {
  it('installs from the catalog with scope/project and values', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    const project = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'
    const r = await call(c, 'install_mcp_server', {
      catalog_id: sampleServer.id,
      option_id: 'npm',
      targets: ['claude-desktop', 'claude-code'],
      scope: 'project',
      project_path: project,
      env: { GITHUB_TOKEN: 'ghp_x' },
      arg_values: { path: ['a', 'b'] }
    })
    expect(core.servers.install).toHaveBeenCalledWith({
      catalogId: sampleServer.id,
      optionId: 'npm',
      values: { env: { GITHUB_TOKEN: 'ghp_x' }, headers: undefined, args: { path: ['a', 'b'] }, extraArgs: undefined },
      name: undefined,
      targets: [{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'project', projectPath: project }],
      overwrite: undefined,
      test: undefined
    })
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toMatch(/restart needed/)
    // The raw written entry (which may contain secrets) is not echoed back.
    expect(JSON.stringify(r)).not.toContain('do-not-leak')
  })

  it('splits a command line given as one string for custom servers', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    await call(c, 'install_mcp_server', { command: 'npx -y @scope/server --flag', name: 'mine', targets: ['claude-code'] })
    expect(core.servers.install.mock.calls[0][0]).toMatchObject({
      config: { type: 'stdio', command: 'npx', args: ['-y', '@scope/server', '--flag'] },
      name: 'mine',
      targets: [{ target: 'claude-code' }]
    })
  })

  it('supports remote servers and dry runs', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    const r = await call(c, 'install_mcp_server', { url: 'https://mcp.example.com/mcp', name: 'remote1', targets: ['claude-code'], headers: { 'X-Key': 'k' }, dry_run: true })
    expect(core.servers.install).not.toHaveBeenCalled()
    expect(core.servers.preview.mock.calls[0][0].config).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Key': 'k' } })
    expect(r.content[0].text).toMatch(/nothing has been written/i)
    expect(r.structuredContent?.dryRun).toBe(true)
  })

  it('rejects ambiguous or invalid requests with friendly errors', async () => {
    const c = await connect(makeFakeCore())
    const both = await call(c, 'install_mcp_server', { catalog_id: 'x', command: 'npx', targets: ['claude-code'] })
    expect(both.isError).toBe(true)
    expect(both.content[0].text).toMatch(/exactly one/)
    const noName = await call(c, 'install_mcp_server', { command: 'npx', targets: ['claude-code'] })
    expect(noName.content[0].text).toMatch(/name/)
    const badName = await call(c, 'install_mcp_server', { command: 'npx', name: 'has space', targets: ['claude-code'] })
    expect(badName.content[0].text).toMatch(/not a valid server name/)
    const noProject = await call(c, 'install_mcp_server', { catalog_id: 'x', targets: ['claude-code'], scope: 'local' })
    expect(noProject.content[0].text).toMatch(/project_path/)
    const vscodeLocal = await call(c, 'install_mcp_server', { catalog_id: 'x', targets: ['vscode'], scope: 'local', project_path: process.cwd() })
    expect(vscodeLocal.content[0].text).toMatch(/VS Code/)
  })
})

describe('installed server tools', () => {
  it('lists installed servers without secret values', async () => {
    const c = await connect(makeFakeCore())
    const r = await call(c, 'list_installed_mcp_servers')
    const text = JSON.stringify(r)
    expect(text).toContain('GITHUB_TOKEN')
    expect(text).not.toContain('ghp_secret_value')
    expect(text).not.toContain('Bearer secret')
    expect((r.structuredContent?.servers as unknown[]).length).toBe(2)
  })

  it('uninstalls from every app where it is installed when no targets are given', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    const r = await call(c, 'uninstall_mcp_server', { name: 'github' })
    expect(core.servers.uninstall).toHaveBeenCalledWith('github', [{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }])
    expect(r.isError).toBeFalsy()
    const missing = await call(c, 'uninstall_mcp_server', { name: 'nope' })
    expect(missing.isError).toBe(true)
  })

  it('tests installed and custom servers', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    const r = await call(c, 'test_mcp_server', { name: 'github', target: 'claude-code' })
    expect(core.servers.testInstalled).toHaveBeenCalledWith('github', { target: 'claude-code', scope: 'user' })
    expect(r.content[0].text).toMatch(/works/)
    expect(r.content[0].text).toContain('create_issue')
    core.servers.test.mockResolvedValueOnce({ ok: false, kind: 'auth-required', ms: 50, tools: [], error: 'HTTP 401', hint: 'Add your token', stderr: 'line1\nline2' })
    const bad = await call(c, 'test_mcp_server', { url: 'https://x.example/mcp', timeout_seconds: 10 })
    expect(core.servers.test).toHaveBeenCalledWith({ type: 'http', url: 'https://x.example/mcp' }, { timeoutMs: 10_000 })
    expect(bad.isError).toBe(true)
    expect(bad.content[0].text).toMatch(/Hint: Add your token/)
  })

  it('enables/disables using the installed scope', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    await call(c, 'enable_disable_mcp_server', { name: 'github', target: 'claude-code', enabled: false })
    expect(core.servers.setEnabled).toHaveBeenCalledWith('github', { target: 'claude-code', scope: 'user' }, false)
  })
})

describe('models, doctor, extensions, backups', () => {
  it('switches profiles with default targets (VS Code only when installed) and shows the caveat', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    const r = await call(c, 'switch_model_profile', { profile_id: 'kimi-1' })
    expect(core.models.apply).toHaveBeenCalledWith({ profileId: 'kimi-1', targets: ['claude-code'] })
    expect(r.content[0].text).toMatch(/doesn't support routing Claude Code to non-Claude models/)
    const missing = await call(c, 'switch_model_profile', { profile_id: 'nope' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toContain('kimi-1')
  })

  it('resets models for both targets by default', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    await call(c, 'reset_model_to_claude')
    expect(core.models.reset).toHaveBeenCalledWith(['claude-code', 'vscode'])
  })

  it('run_doctor lists problems with fix ids; apply_doctor_fix passes the id', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    const r = await call(c, 'run_doctor')
    expect(r.content[0].text).toMatch(/fix_id: repair-desktop/)
    expect(r.content[0].text).toMatch(/1 passing check/)
    const fix = await call(c, 'apply_doctor_fix', { fix_id: 'repair-desktop' })
    expect(core.doctor.fix).toHaveBeenCalledWith('repair-desktop')
    expect(fix.content[0].text).toMatch(/Backup: b-2/)
  })

  it('extension tools pass scope options through', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    const s = await call(c, 'search_extensions', { query: 'x', kind: 'plugin' })
    expect(s.content[0].text).toContain('plugin:x@official')
    await call(c, 'install_extension', { id: 'plugin:x@official' })
    expect(core.extensions.install).toHaveBeenCalledWith('plugin:x@official', { scope: undefined, projectPath: undefined })
    const bad = await call(c, 'install_extension', { id: 'plugin:x@official', scope: 'project' })
    expect(bad.isError).toBe(true)
  })

  it('backups and catalog refresh', async () => {
    const core = makeFakeCore()
    const c = await connect(core)
    const list = await call(c, 'list_backups')
    expect(list.content[0].text).toContain('20261023-120000-abcd')
    await call(c, 'restore_backup', { id: '20261023-120000-abcd' })
    expect(core.backups.restore).toHaveBeenCalledWith('20261023-120000-abcd')
    const refreshed = await call(c, 'refresh_catalog', { force: true })
    expect(core.catalog.refresh).toHaveBeenCalledWith({ force: true })
    expect(refreshed.content[0].text).toMatch(/rate limited/)
  })
})

describe('core failures', () => {
  it('turns a core start-up failure into a tool error instead of crashing', async () => {
    const c = await connect(async () => {
      throw new Error('Claude Setup could not start: disk full')
    })
    const r = await call(c, 'list_targets')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('disk full')
  })

  it('caps very large outputs', async () => {
    const core = makeFakeCore()
    core.catalog.search.mockResolvedValueOnce({
      items: Array.from({ length: 50 }, (_, i) => ({ ...sampleServer, id: `id-${i}`, description: 'x'.repeat(5000) })),
      total: 50,
      offset: 0,
      limit: 50
    })
    const c = await connect(core)
    const r = await call(c, 'search_mcp_servers', { query: 'x', limit: 50 })
    expect(r.content[0].text.length).toBeLessThanOrEqual(20_000)
    expect(JSON.stringify(r.structuredContent).length).toBeLessThanOrEqual(40_100)
  })
})
