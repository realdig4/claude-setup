import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CatalogSource } from '@shared/types'
import { openSqliteStore } from '@core/registry/sqlite-store'
import { openMemoryStore } from '@core/registry/memory-store'
import { normalizeQuery } from '@core/registry/search'
import { dockerOption, manualOption, npmOption, remoteOption } from '@core/registry/install'
import type { CatalogStore } from '@core/registry/store'
import type { SourceEntry } from '@core/registry/types'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { entry } from './helpers'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const ALL: ReadonlySet<CatalogSource> = new Set<CatalogSource>(['official', 'anthropic', 'github', 'smithery', 'docker', 'cline', 'awesome', 'glama', 'pulsemcp', 'seed'])

function dataset(): SourceEntry[] {
  const keyed = (name: string) => [{ name, required: true, secret: true }]
  return [
    entry({
      source: 'official',
      id: 'io.github.github/github-mcp-server',
      guard: 'io.github.github/github-mcp-server',
      name: 'GitHub',
      description: 'Manage repositories, issues and pull requests',
      categories: ['developer-tools'],
      stars: 30000,
      install: [remoteOption({ url: 'https://api.githubcopilot.com/mcp/' })],
      updatedAt: '2026-08-01T00:00:00.000Z'
    }),
    entry({
      source: 'official',
      id: 'com.mcparmory/github',
      guard: 'com.mcparmory/github',
      name: 'GitHub',
      description: 'Another GitHub wrapper',
      categories: ['developer-tools'],
      install: [npmOption({ package: 'armory-github', version: '1.0.0', env: keyed('GITHUB_TOKEN') })]
    }),
    entry({
      source: 'docker',
      id: 'docker:github-chat',
      name: 'GitHub Chat',
      description: 'Chat about GitHub repositories',
      categories: ['developer-tools'],
      stars: 900,
      install: [dockerOption({ package: 'mcp/github-chat:1', env: keyed('OPENAI_API_KEY') })]
    }),
    entry({
      source: 'official',
      id: 'io.github.acme/postgres',
      guard: 'io.github.acme/postgres',
      name: 'Postgres',
      description: 'Query a PostgreSQL database',
      categories: ['databases'],
      install: [npmOption({ package: 'acme-postgres', version: '2.0.0' })],
      updatedAt: '2026-09-01T00:00:00.000Z'
    }),
    entry({
      source: 'anthropic',
      id: 'com.neon/mcp',
      name: 'Neon',
      description: 'Serverless Postgres databases',
      categories: ['databases'],
      install: [remoteOption({ url: 'https://mcp.neon.tech/mcp' })],
      updatedAt: '2026-10-01T00:00:00.000Z'
    }),
    entry({
      source: 'smithery',
      id: 'acme/weather',
      name: 'Weather Forecast',
      description: 'Forecasts for any city',
      categories: ['data-analytics'],
      useCount: 400,
      install: [remoteOption({ url: 'https://weather.run.tools', headers: [{ name: 'apiKey', required: true, secret: true }] })]
    }),
    entry({
      source: 'awesome',
      id: 'awesome:github.com/x/notes',
      name: 'Notes Helper',
      description: 'Take notes',
      categories: ['productivity'],
      install: [manualOption({ notes: 'README', url: 'https://github.com/x/notes' })]
    }),
    entry({
      source: 'official',
      id: 'io.github.old/postgres',
      guard: 'io.github.old/postgres',
      name: 'Postgres Legacy',
      description: 'Old PostgreSQL connector',
      categories: ['databases'],
      deprecated: true,
      install: [npmOption({ package: 'old-postgres', version: '0.1.0' })]
    })
  ]
}

async function fill(store: CatalogStore, entries: SourceEntry[]): Promise<void> {
  const bySource = new Map<CatalogSource, SourceEntry[]>()
  for (const e of entries) bySource.set(e.source, [...(bySource.get(e.source) ?? []), e])
  for (const [source, list] of bySource) {
    const w = store.openSource(source, 'replace')
    await w.put(list)
    await w.commit()
  }
  await store.rebuild({ enabled: ALL, featured: new Set() })
}

const ids = (page: { items: Array<{ id: string }> }) => page.items.map((s) => s.id)

describe.each([['sqlite' as const], ['memory' as const]])('%s store', (kind) => {
  let sb: Sandbox
  let store: CatalogStore
  const open = async () => (kind === 'sqlite' ? openSqliteStore(join(sb.dataDir, 'cache')) : openMemoryStore(join(sb.dataDir, 'cache'), silent))

  afterEach(async () => {
    store?.close()
    await sb?.cleanup()
  })

  async function setup(): Promise<void> {
    sb = await createSandbox()
    store = await open()
    expect(store.kind).toBe(kind)
    await fill(store, dataset())
  }

  it('browses popular-first when the query is empty or only stop words', async () => {
    await setup()
    const page = store.search(normalizeQuery({}))
    expect(page.total).toBe(8)
    expect(page.items[0].id).toBe('io.github.github/github-mcp-server')
    expect(page.items.at(-1)!.id).toBe('io.github.old/postgres')
    const pops = page.items.map((s) => s.popularity ?? 0)
    expect([...pops].sort((a, b) => b - a)).toEqual(pops)
    expect(store.search(normalizeQuery({ query: 'MCP server' })).total).toBe(8)
  })

  it('ranks exact, popular matches first and supports prefixes and plurals', async () => {
    await setup()
    const gh = store.search(normalizeQuery({ query: 'github' }))
    expect(ids(gh)[0]).toBe('io.github.github/github-mcp-server')
    expect(ids(gh)).toEqual(expect.arrayContaining(['com.mcparmory/github', 'docker:github-chat']))
    expect(ids(store.search(normalizeQuery({ query: 'postg' })))).toEqual(expect.arrayContaining(['io.github.acme/postgres', 'com.neon/mcp']))
    expect(ids(store.search(normalizeQuery({ query: 'database' })))).toContain('com.neon/mcp')
    expect(store.search(normalizeQuery({ query: 'zzzz-nothing' })).total).toBe(0)
  })

  it('falls back to OR when no server matches every word', async () => {
    await setup()
    const page = store.search(normalizeQuery({ query: 'github weather' }))
    expect(ids(page)).toEqual(expect.arrayContaining(['io.github.github/github-mcp-server', 'acme/weather']))
  })

  it('filters by category (id or label), source, remote-only and no-key', async () => {
    await setup()
    expect(ids(store.search(normalizeQuery({ category: 'databases' }))).sort()).toEqual(['com.neon/mcp', 'io.github.acme/postgres', 'io.github.old/postgres'])
    expect(store.search(normalizeQuery({ category: 'Databases' })).total).toBe(3)
    expect(store.search(normalizeQuery({ category: 'no-such-category' })).total).toBe(0)
    expect(ids(store.search(normalizeQuery({ source: 'anthropic' })))).toEqual(['com.neon/mcp'])
    expect(ids(store.search(normalizeQuery({ remoteOnly: true }))).sort()).toEqual(['acme/weather', 'com.neon/mcp', 'io.github.github/github-mcp-server'])
    const noKey = ids(store.search(normalizeQuery({ noKeyRequired: true })))
    expect(noKey).not.toContain('com.mcparmory/github')
    expect(noKey).not.toContain('docker:github-chat')
    expect(noKey).not.toContain('acme/weather')
    expect(ids(store.search(normalizeQuery({ query: 'postgres', remoteOnly: true })))).toEqual(['com.neon/mcp'])
  })

  it('sorts by name and by last update, and paginates', async () => {
    await setup()
    const byName = store.search(normalizeQuery({ sort: 'name' })).items.map((s) => s.name.toLowerCase())
    expect([...byName].sort()).toEqual(byName)
    const updated = ids(store.search(normalizeQuery({ sort: 'updated' })))
    expect(updated.slice(0, 3)).toEqual(['com.neon/mcp', 'io.github.acme/postgres', 'io.github.github/github-mcp-server'])
    const all = ids(store.search(normalizeQuery({ limit: 100 })))
    const page = store.search(normalizeQuery({ offset: 2, limit: 2 }))
    expect(ids(page)).toEqual(all.slice(2, 4))
    expect(page).toMatchObject({ total: 8, offset: 2, limit: 2 })
    expect(normalizeQuery({ limit: 1000, offset: -5 })).toMatchObject({ limit: 100, offset: 0 })
  })

  it('counts categories and resolves ids, aliases and case-insensitive ids', async () => {
    await setup()
    const cats = store.categories()
    expect(cats.find((c) => c.id === 'databases')).toEqual({ id: 'databases', label: 'Databases', count: 3 })
    expect(cats.find((c) => c.id === 'developer-tools')!.count).toBe(3)
    expect(cats.map((c) => c.id)).not.toContain('security')
    expect(store.get('com.neon/mcp')!.server.name).toBe('Neon')
    expect(store.get('anthropic:com.neon/mcp')!.server.id).toBe('com.neon/mcp')
    expect(store.get('IO.GITHUB.GITHUB/GITHUB-MCP-SERVER')!.server.id).toBe('io.github.github/github-mcp-server')
    expect(store.get('nope')).toBeNull()
    expect(store.total()).toBe(8)
  })

  it('hides servers updated as hidden', async () => {
    await setup()
    const w = store.get('acme/weather')!
    store.updateServer('acme/weather', { server: { ...w.server, install: [] }, remote: false, needsKey: false, hidden: true })
    expect(store.search(normalizeQuery({ query: 'weather' })).total).toBe(0)
    expect(store.total()).toBe(7)
    expect(store.get('acme/weather')!.hidden).toBe(true)
  })

  it('keeps live data when a replace-mode refresh is aborted, and applies deltas', async () => {
    await setup()
    const aborted = store.openSource('official', 'replace')
    await aborted.put([entry({ source: 'official', id: 'x/y', guard: 'x/y', name: 'XY' })])
    await aborted.abort()
    expect(store.counts().official).toBe(4)
    const delta = store.openSource('official', 'delta')
    await delta.remove(['io.github.old/postgres'])
    await delta.put([entry({ source: 'official', id: 'io.github.new/tool', guard: 'io.github.new/tool', name: 'New Tool' })])
    await delta.commit()
    expect(store.counts().official).toBe(4)
    await store.rebuild({ enabled: ALL, featured: new Set() })
    expect(store.get('io.github.old/postgres')).toBeNull()
    expect(store.get('io.github.new/tool')!.server.name).toBe('New Tool')
    const replace = store.openSource('awesome', 'replace')
    await replace.put([])
    await replace.commit()
    expect(store.counts().awesome).toBeUndefined()
  })

  it('excludes disabled sources at rebuild time', async () => {
    await setup()
    await store.rebuild({ enabled: new Set<CatalogSource>(['official']), featured: new Set() })
    expect(store.total()).toBe(4)
    expect(store.get('com.neon/mcp')).toBeNull()
  })

  it('persists the index across restarts', async () => {
    await setup()
    store.setMeta('hello', { a: 1 })
    store.setDetail('smithery:x', { options: [] })
    store.close()
    store = await open()
    expect(store.hasIndex()).toBe(true)
    expect(ids(store.search(normalizeQuery({ query: 'neon' })))).toEqual(['com.neon/mcp'])
    expect(store.getMeta('hello')).toEqual({ a: 1 })
    expect(store.getDetail('smithery:x')?.data).toEqual({ options: [] })
    expect(store.counts().official).toBe(4)
  })
})
