/**
 * The browser mock of window.api is what page authors develop against, so it must implement the whole
 * contract with data that matches src/shared/types.ts and behaves plausibly.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { CORE_METHODS, type CoreEvent, type Namespace, type PreloadApi } from '@shared/api'
import { createMockApi, mockCore } from '../../src/renderer/src/mock/api'
import { CATALOG } from '../../src/renderer/src/mock/catalog'

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
let api: PreloadApi

beforeAll(() => {
  api = createMockApi({ platform: 'win32', latency: [0, 0], timeScale: 0 })
})

describe('renderer/mock: contract coverage', () => {
  it('implements every allow-listed core method', () => {
    for (const ns of Object.keys(CORE_METHODS) as Namespace[]) {
      for (const method of CORE_METHODS[ns]) {
        const target = mockCore[ns] as unknown as Record<string, unknown>
        expect(typeof target[method], `${ns}.${method}`).toBe('function')
      }
    }
  })

  it('rejects unknown methods with an Electron-style IPC error', async () => {
    const untypedCall = api.call as unknown as (ns: string, method: string) => Promise<unknown>
    await expect(untypedCall('app', 'nope')).rejects.toThrow(/^Error invoking remote method 'core:call': Error: Unknown method app\.nope/)
  })

  it('rejects arguments that cannot cross IPC', async () => {
    const bad = { mode: 'simple', onClick: () => {} } as unknown as Parameters<typeof mockCore.app.updateSettings>[0]
    await expect(api.call('app', 'updateSettings', bad)).rejects.toThrow(/could not be cloned/)
  })

  it('returns copies (callers cannot mutate mock state)', async () => {
    const a = await api.call('catalog', 'featured')
    a[0]!.name = 'mutated'
    const b = await api.call('catalog', 'featured')
    expect(b[0]!.name).not.toBe('mutated')
  })

  it('serves GUI helpers', async () => {
    expect(api.platform).toBe('win32')
    await expect(api.ui('pickFolder')).resolves.toMatch(/acme-web$/)
    await expect(api.ui('copyText', 'hello')).resolves.toBeUndefined()
  })
})

describe('renderer/mock: catalog', () => {
  it('has well-formed, unique servers', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(25)
    expect(new Set(CATALOG.map((s) => s.id)).size).toBe(CATALOG.length)
    expect(new Set(CATALOG.map((s) => s.slug)).size).toBe(CATALOG.length)
    for (const server of CATALOG) {
      expect(server.slug, server.id).toMatch(NAME_RE)
      expect(server.install.length, server.id).toBeGreaterThan(0)
      expect(server.categories.length, server.id).toBeGreaterThan(0)
      for (const option of server.install) {
        expect(['npm', 'pypi', 'docker', 'remote', 'binary', 'mcpb', 'nuget', 'manual']).toContain(option.kind)
        if (option.kind === 'remote') expect(option.url, server.id).toMatch(/^https?:\/\//)
        else expect(option.package, server.id).toBeTruthy()
        for (const env of option.env) expect(typeof env.required === 'boolean' && typeof env.secret === 'boolean').toBe(true)
      }
    }
  })

  it('searches, filters, sorts and paginates', async () => {
    const git = await api.call('catalog', 'search', { query: 'git' })
    const names = git.items.map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['Git', 'GitHub']))
    expect(git.total).toBe(git.items.length)

    const db = await api.call('catalog', 'search', { category: 'databases' })
    expect(db.items.every((s) => s.categories.includes('databases'))).toBe(true)

    const remote = await api.call('catalog', 'search', { remoteOnly: true, limit: 100 })
    expect(remote.items.every((s) => s.install.some((o) => o.kind === 'remote'))).toBe(true)

    const free = await api.call('catalog', 'search', { noKeyRequired: true, limit: 100 })
    expect(free.items.map((s) => s.slug)).not.toContain('brave-search')

    const page2 = await api.call('catalog', 'search', { sort: 'name', offset: 5, limit: 5 })
    expect(page2.items).toHaveLength(5)
    expect(page2.offset).toBe(5)
    const sorted = [...page2.items].map((s) => s.name)
    expect(sorted).toEqual([...sorted].sort((a, b) => a.localeCompare(b)))
  })

  it('lists categories with counts and refreshes with events', async () => {
    const categories = await api.call('catalog', 'categories')
    expect(categories.find((c) => c.id === 'databases')?.count).toBeGreaterThan(0)

    const events: CoreEvent[] = []
    const off = api.onEvent((e) => events.push(e))
    const stats = await api.call('catalog', 'refresh', { force: true })
    off()
    expect(stats.refreshing).toBe(false)
    const phases = events.filter((e) => e.name === 'catalog').map((e) => (e.payload as { phase: string }).phase)
    expect(phases[0]).toBe('start')
    expect(phases).toContain('source')
    expect(phases[phases.length - 1]).toBe('done')
  })
})

describe('renderer/mock: targets & servers', () => {
  it('reports five apps with the agreed install states', async () => {
    const targets = await api.call('targets', 'list')
    const byId = Object.fromEntries(targets.map((t) => [t.id, t]))
    expect(targets).toHaveLength(5)
    expect(byId['claude-desktop']).toMatchObject({ installed: true, running: true, supportsRemote: false, primary: true })
    expect(byId['claude-code']).toMatchObject({ installed: true, scopes: ['user', 'project', 'local'] })
    expect(byId.vscode?.installed).toBe(true)
    expect(byId.cursor?.installed).toBe(false)
    expect(byId.windsurf?.installed).toBe(false)
    const servers = await api.call('servers', 'list')
    for (const target of targets) expect(target.serverCount).toBe(servers.filter((s) => s.target.target === target.id).length)
    expect(servers.every((s) => NAME_RE.test(s.name))).toBe(true)
  })

  it('previews missing values and bridges remote servers for Claude Desktop', async () => {
    const brave = await api.call('servers', 'preview', { catalogId: 'brave-search', targets: [{ target: 'claude-code', scope: 'user' }] })
    expect(brave.missingValues).toContain('BRAVE_API_KEY')
    expect(brave.config).toMatchObject({ type: 'stdio', command: 'npx' })

    const notion = await api.call('servers', 'preview', { catalogId: 'notion', targets: [{ target: 'claude-desktop' }, { target: 'vscode', scope: 'user' }] })
    expect(notion.targets[0]?.snippet).toContain('mcp-remote')
    expect(notion.targets[1]?.snippet).toContain('"servers"')
    expect(notion.warnings.join(' ')).toMatch(/restart/i)
  })

  it('installs, toggles, tests and removes a server', async () => {
    const target = { target: 'claude-code' as const, scope: 'user' as const }
    const refused = await api.call('servers', 'install', { catalogId: 'brave-search', targets: [target] })
    expect(refused.ok).toBe(false)
    expect(refused.results[0]?.message).toMatch(/BRAVE_API_KEY/)

    const installed = await api.call('servers', 'install', {
      catalogId: 'brave-search',
      values: { env: { BRAVE_API_KEY: 'BSA-test-key' } },
      targets: [target],
      test: true
    })
    expect(installed.ok).toBe(true)
    expect(installed.results[0]?.backupId).toBeTruthy()
    expect(installed.test?.ok).toBe(true)

    const duplicate = await api.call('servers', 'install', { catalogId: 'brave-search', values: { env: { BRAVE_API_KEY: 'x' } }, targets: [target] })
    expect(duplicate.ok).toBe(false)

    const off = await api.call('servers', 'setEnabled', 'brave-search', target, false)
    expect(off.ok).toBe(true)
    const listed = await api.call('servers', 'list', { target: 'claude-code' })
    expect(listed.find((s) => s.name === 'brave-search')?.enabled).toBe(false)

    const removed = await api.call('servers', 'uninstall', 'brave-search', [target])
    expect(removed[0]?.ok).toBe(true)
    const after = await api.call('servers', 'list', { target: 'claude-code' })
    expect(after.some((s) => s.name === 'brave-search')).toBe(false)
  })

  it('produces friendly test failures', async () => {
    const noKey = await api.call('servers', 'test', { type: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server@2.1.3'] })
    expect(noKey).toMatchObject({ ok: false, kind: 'auth-required' })
    expect(noKey.hint).toMatch(/BRAVE_API_KEY/)

    const uv = await api.call('servers', 'test', { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] })
    expect(uv).toMatchObject({ ok: false, kind: 'command-not-found' })

    const fs = await api.call('servers', 'testInstalled', 'filesystem', { target: 'claude-desktop' })
    expect(fs.ok).toBe(true)
    expect(fs.tools.map((t) => t.name)).toContain('read_text_file')
  })

  it('returns raw config text that parses as JSON and keeps preferences', async () => {
    const raw = await api.call('targets', 'readRaw', { target: 'claude-desktop' })
    expect(raw?.exists).toBe(true)
    const doc = JSON.parse(raw?.text ?? '{}') as { mcpServers: Record<string, unknown>; preferences?: unknown }
    expect(Object.keys(doc.mcpServers)).toContain('filesystem')
    expect(doc.preferences).toBeTruthy()
  })
})

describe('renderer/mock: models, proxy, doctor, extensions, backups', () => {
  it('offers the provider presets with consistent defaults', async () => {
    const providers = await api.call('models', 'providers')
    expect(providers.map((p) => p.id)).toEqual(expect.arrayContaining(['anthropic', 'kimi', 'deepseek', 'zai', 'openrouter', 'groq', 'ollama']))
    for (const p of providers) {
      expect(p.models.some((m) => m.id === p.defaults.main), p.id).toBe(true)
      expect(p.regions.length, p.id).toBeGreaterThan(0)
      expect(p.color, p.id).toMatch(/^#[0-9a-f]{6}$/i)
    }
    expect(providers.find((p) => p.id === 'groq')?.kind).toBe('openai-proxy')
  })

  it('saves and applies a profile (starting the proxy for OpenAI-only providers)', async () => {
    const profile = await api.call('models', 'saveProfile', { name: 'Groq fast', providerId: 'groq', apiKey: 'gsk_live_test_key_123', models: { main: 'openai/gpt-oss-120b' } })
    expect(profile.hasKey).toBe(true)
    expect(profile.models.haiku).toBe('openai/gpt-oss-20b')

    const applied = await api.call('models', 'apply', { profileId: profile.id, targets: ['claude-code', 'vscode'] })
    expect(applied.ok).toBe(true)
    expect(applied.proxyStarted).toBe(true)
    expect(applied.warnings.join(' ')).toMatch(/Anthropic/)

    const status = await api.call('models', 'status')
    expect(status).toMatchObject({ mode: 'custom', providerId: 'groq', vscodeConfigured: true })
    expect((await api.call('proxy', 'status')).running).toBe(true)

    const busy = await api.call('models', 'deleteProfile', profile.id)
    expect(busy.ok).toBe(false)
    await api.call('models', 'reset', ['claude-code', 'vscode'])
    expect((await api.call('models', 'status')).mode).toBe('anthropic')
    expect((await api.call('models', 'deleteProfile', profile.id)).ok).toBe(true)
    expect((await api.call('proxy', 'stop')).running).toBe(false)
  })

  it('classifies connection test results', async () => {
    const bad = await api.call('models', 'testConnection', { providerId: 'kimi', apiKey: 'bad-key' })
    expect(bad).toMatchObject({ ok: false, verdict: 'bad-key' })
    const ok = await api.call('models', 'testConnection', { providerId: 'kimi', apiKey: 'sk-a-perfectly-fine-key' })
    expect(ok).toMatchObject({ ok: true, verdict: 'ok' })
    const local = await api.call('models', 'testConnection', { providerId: 'ollama', baseUrl: 'http://localhost:11434' })
    expect(local.verdict).toBe('network')
  })

  it('validates proxy config', async () => {
    const config = await api.call('proxy', 'getConfig')
    await expect(api.call('proxy', 'saveConfig', { ...config, port: 80 })).rejects.toThrow(/port/)
    const saved = await api.call('proxy', 'saveConfig', { ...config, port: 3999 })
    expect(saved.port).toBe(3999)
  })

  it('runs the doctor and applies fixes', async () => {
    const report = await api.call('doctor', 'run')
    const total = Object.values(report.summary).reduce((a, b) => a + b, 0)
    expect(total).toBe(report.checks.length)
    const uv = report.checks.find((c) => c.id === 'uv')
    expect(uv?.status).toBe('warn')
    expect(uv?.fix?.id).toBe('install-uv')
    expect((await api.call('doctor', 'fix', 'install-uv')).ok).toBe(true)
    const again = await api.call('doctor', 'run')
    expect(again.checks.find((c) => c.id === 'uv')?.status).toBe('ok')
    expect((await api.call('runtimes', 'detect')).find((r) => r.id === 'uv')?.found).toBe(true)
    expect((await api.call('doctor', 'fix', 'unknown-fix')).ok).toBe(false)
  })

  it('manages extensions and marketplaces', async () => {
    const skills = await api.call('extensions', 'search', { kind: 'skill' })
    expect(skills.length).toBeGreaterThan(0)
    expect(skills.every((i) => i.kind === 'skill')).toBe(true)
    const target = skills.find((i) => !i.installed)!
    expect((await api.call('extensions', 'install', target.id)).ok).toBe(true)
    expect((await api.call('extensions', 'installed', 'skill')).some((i) => i.id === target.id)).toBe(true)
    expect((await api.call('extensions', 'addMarketplace', 'not a repo!')).ok).toBe(false)
    expect((await api.call('extensions', 'addMarketplace', 'anthropics/skills')).ok).toBe(true)
    expect((await api.call('extensions', 'marketplaces')).find((m) => m.repo === 'anthropics/skills')?.added).toBe(true)
  })

  it('records backups for changes and restores them', async () => {
    const backups = await api.call('backups', 'list')
    expect(backups.length).toBeGreaterThan(0)
    expect(backups[0]!.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/)
    const restored = await api.call('backups', 'restore', backups[backups.length - 1]!.id)
    expect(restored.ok).toBe(true)
    expect((await api.call('backups', 'delete', 'missing')).ok).toBe(false)
  })

  it('persists settings and emits a state event', async () => {
    const events: CoreEvent[] = []
    const off = api.onEvent((e) => events.push(e))
    const next = await api.call('app', 'updateSettings', { mode: 'advanced', theme: 'dark' })
    off()
    expect(next).toMatchObject({ mode: 'advanced', theme: 'dark' })
    expect((await api.call('app', 'getSettings')).mode).toBe('advanced')
    expect(events.some((e) => e.name === 'state')).toBe(true)
    expect((await api.call('app', 'setSecret', 'test:ref', 'value')).ok).toBe(true)
    expect(await api.call('app', 'hasSecret', 'test:ref')).toBe(true)
  })
})
