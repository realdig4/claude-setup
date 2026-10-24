import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogSource } from '@shared/types'
import type { CoreContext } from '@core/context'
import { createCatalogService, type CatalogService } from '@core/registry/service'
import { FEATURED_IDS } from '@core/registry/seed'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { collectEvents, FAST_HTTP, fixture, sourceRoutes, stubFetch, testContext, type Route } from './helpers'

let sb: Sandbox | undefined
let service: CatalogService | undefined

afterEach(async () => {
  await service?.close()
  service = undefined
  vi.unstubAllGlobals()
  await sb?.cleanup()
  sb = undefined
})

async function setup(opts: Parameters<typeof createCatalogService>[1] = {}): Promise<{ ctx: CoreContext; svc: CatalogService }> {
  sb = await createSandbox()
  const ctx = await testContext(sb.dataDir)
  service = createCatalogService(ctx, { http: FAST_HTTP, seed: null, ...opts })
  return { ctx, svc: service }
}

async function onlySources(ctx: CoreContext, enabled: CatalogSource[]): Promise<void> {
  await ctx.state.update((d) => {
    for (const s of Object.keys(d.settings.sources) as CatalogSource[]) d.settings.sources[s] = enabled.includes(s) || s === 'seed'
  })
}

const sourceStatus = (stats: Awaited<ReturnType<CatalogService['stats']>>, s: CatalogSource) => stats.sources.find((x) => x.source === s)!

describe('first run (offline)', () => {
  it('serves the curated seed instantly without touching the network', async () => {
    const { calls } = stubFetch([])
    const { svc } = await setup()
    const page = await svc.api.search({ query: 'filesystem' })
    expect(page.items[0].id).toBe('io.github.modelcontextprotocol/server-filesystem')
    const featured = await svc.api.featured()
    expect(featured.map((s) => s.id)).toEqual([...FEATURED_IDS])
    expect(featured.every((s) => s.install.length > 0)).toBe(true)
    expect((await svc.api.categories()).length).toBeGreaterThan(5)
    const stats = await svc.api.stats()
    expect(stats.total).toBe(42)
    expect(sourceStatus(stats, 'seed')).toMatchObject({ enabled: true, count: 42 })
    expect(sourceStatus(stats, 'official')).toMatchObject({ enabled: true, count: 0 })
    expect(stats.refreshing).toBe(false)
    expect(calls).toHaveLength(0)
    expect(await svc.api.get('nope/nope')).toBeNull()
    expect(await svc.api.get('')).toBeNull()
  })

  it('includes the bundled registry seed (Claude directory, GitHub, Docker)', async () => {
    stubFetch([])
    const { svc } = await setup({ seed: undefined })
    const notion = (await svc.api.search({ query: 'notion' })).items[0]
    expect(notion.id).toBe('com.notion/mcp')
    expect(notion.sources).toEqual(expect.arrayContaining(['anthropic', 'seed']))
    const stats = await svc.api.stats()
    expect(sourceStatus(stats, 'anthropic').count).toBeGreaterThan(250)
    expect(sourceStatus(stats, 'anthropic').lastFetched).toBeUndefined()
    expect(sourceStatus(stats, 'seed').lastFetched).toMatch(/^\d{4}-/)
  })
})

describe('refresh', () => {
  it('fetches every enabled source, merges them, emits progress and respects the TTL', async () => {
    const { calls } = stubFetch(sourceRoutes())
    const { ctx, svc } = await setup()
    const events = collectEvents(ctx)
    const stats = await svc.api.refresh()
    const counts = Object.fromEntries(stats.sources.map((s) => [s.source, s.count]))
    expect(counts).toEqual({ official: 10, anthropic: 6, github: 4, smithery: 4, docker: 14, cline: 3, awesome: 9, glama: 0, pulsemcp: 0, seed: 42 })
    expect(sourceStatus(stats, 'glama').enabled).toBe(false)
    expect(stats.sources.filter((s) => s.source !== 'glama' && s.source !== 'pulsemcp' && s.source !== 'seed').every((s) => s.lastFetched && !s.error)).toBe(true)
    expect(stats.lastRefreshed).toBeDefined()
    expect(stats.refreshing).toBe(false)
    expect(events[0].phase).toBe('start')
    expect(events.at(-1)).toMatchObject({ phase: 'done', count: stats.total })
    expect(events.some((e) => e.phase === 'error')).toBe(false)
    for (const s of ['official', 'anthropic', 'github', 'smithery', 'docker', 'cline', 'awesome']) {
      expect(events.some((e) => e.phase === 'source' && e.source === s && typeof e.count === 'number'), s).toBe(true)
    }
    const brave = (await svc.api.search({ query: 'brave search' })).items[0]
    expect(brave.id).toBe('io.github.brave/brave-search-mcp-server')
    expect(brave.sources).toEqual(['official', 'docker', 'cline', 'awesome', 'seed'])

    const before = calls.length
    events.length = 0
    await svc.api.refresh()
    expect(calls.length).toBe(before)
    expect(events.map((e) => e.phase)).toEqual(['start', 'done'])
    expect(events[1].message).toMatch(/up to date/)
  })

  it('syncs the official registry incrementally on later refreshes', async () => {
    const { calls } = stubFetch(sourceRoutes())
    const { svc } = await setup()
    await svc.api.refresh()
    expect((await svc.api.get('com.notion/mcp'))!.sources).toContain('official')
    await svc.api.refresh({ force: true })
    expect(calls.some((c) => c.url.includes('updated_since='))).toBe(true)
    const brave = (await svc.api.get('io.github.brave/brave-search-mcp-server'))!
    expect(brave.version).toBe('2.2.0')
    expect(brave.install.find((o) => o.kind === 'npm')).toMatchObject({ version: '2.2.0', args: ['-y', '@brave/brave-search-mcp-server@2.2.0'] })
    const notion = (await svc.api.get('com.notion/mcp'))!
    expect(notion.sources).not.toContain('official')
    expect(notion.sources).toEqual(expect.arrayContaining(['anthropic', 'seed']))
    expect((await svc.api.get('io.github.upstash/context7'))!.version).toBe('4.4.4')
  })

  it('shares one promise between concurrent refresh calls', async () => {
    stubFetch(sourceRoutes())
    const { svc } = await setup()
    const p1 = svc.api.refresh()
    const p2 = svc.api.refresh({ force: true })
    expect(p1).toBe(p2)
    await Promise.resolve()
    expect((await svc.api.stats()).refreshing).toBe(true)
    await p1
    expect((await svc.api.stats()).refreshing).toBe(false)
  })

  it('keeps the previous data of a failing source and reports a friendly error', async () => {
    let failAnthropic = false
    const { ctx, svc } = await setup()
    stubFetch(sourceRoutes({ anthropic: (u) => (u.host === 'api.anthropic.com' ? (failAnthropic ? { status: 500, body: 'oops' } : { body: fixture('anthropic-page.json') }) : undefined) }))
    await svc.api.refresh()
    failAnthropic = true
    const events = collectEvents(ctx)
    const stats = await svc.api.refresh({ force: true })
    const anth = sourceStatus(stats, 'anthropic')
    expect(anth.count).toBe(6)
    expect(anth.error).toMatch(/Claude connectors directory could not be updated: .*HTTP 500.* The previous data is kept\./)
    expect(sourceStatus(stats, 'docker').error).toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ phase: 'error', source: 'anthropic' }))
    expect(events.at(-1)!.message).toMatch(/could not be reached/)
    expect((await svc.api.search({ query: 'amplitude' })).items[0].sources).toContain('anthropic')
    // a failing source is not retried on every call (unless forced)
    failAnthropic = false
    const again = await svc.api.refresh()
    expect(sourceStatus(again, 'anthropic').error).toBeDefined()
  })

  it('refreshes stale sources after the TTL and uses the Docker ETag', async () => {
    let now = new Date('2026-10-23T12:00:00Z')
    const dockerHeaders: Array<string | undefined> = []
    const docker: Route = (u, init) => {
      if (u.host !== 'desktop.docker.com') return undefined
      const inm = new Headers(init?.headers).get('if-none-match') ?? undefined
      dockerHeaders.push(inm)
      if (inm === '"v1"') return { status: 304 }
      return { body: fixtureText(), headers: { etag: '"v1"', 'content-type': 'application/yaml' } }
    }
    function fixtureText(): string {
      return require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'docker-catalog.yaml'), 'utf8')
    }
    stubFetch(sourceRoutes({ docker }))
    const { ctx, svc } = await setup({ now: () => now })
    await ctx.state.update((d) => void (d.settings.catalogTtlHours = 1))
    await svc.api.refresh()
    const first = await svc.api.stats()
    now = new Date('2026-10-23T12:30:00Z')
    await svc.api.refresh()
    expect(dockerHeaders).toHaveLength(1)
    now = new Date('2026-10-23T13:30:00Z')
    const events = collectEvents(ctx)
    const after = await svc.api.refresh()
    expect(dockerHeaders).toEqual([undefined, '"v1"'])
    expect(sourceStatus(after, 'docker').count).toBe(14)
    expect(sourceStatus(after, 'docker').lastFetched).not.toBe(sourceStatus(first, 'docker').lastFetched)
    expect(events.some((e) => e.source === 'docker' && /unchanged/.test(e.message ?? ''))).toBe(true)
    // Smithery and the awesome list refresh weekly at most
    expect(sourceStatus(after, 'smithery').lastFetched).toBe(sourceStatus(first, 'smithery').lastFetched)
  })

  it('keeps at most 4 Smithery requests in flight during deep pagination', async () => {
    let active = 0
    let peak = 0
    const pages = new Set<string>()
    const smithery: Route = async (u) => {
      if (u.host !== 'registry.smithery.ai' || u.pathname !== '/servers') return undefined
      pages.add(u.searchParams.get('page')!)
      expect(u.searchParams.get('seed')).toBe('42')
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      const body = fixture<{ pagination: Record<string, number> }>('smithery-page-1.json')
      body.pagination.totalPages = 10
      return { body }
    }
    stubFetch(sourceRoutes({ smithery }))
    const { ctx, svc } = await setup()
    await onlySources(ctx, ['smithery'])
    await svc.api.refresh()
    expect(pages.size).toBe(10)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('stops quietly when closed during a refresh', async () => {
    stubFetch(sourceRoutes({ official: (u) => (u.host === 'registry.modelcontextprotocol.io' ? { body: fixture('official-page-1.json'), delay: 400 } : undefined) }))
    const { ctx, svc } = await setup()
    await onlySources(ctx, ['official'])
    await svc.api.search({})
    const p = svc.api.refresh()
    await new Promise((r) => setTimeout(r, 50))
    await svc.close()
    const stats = await p
    expect(sourceStatus(stats, 'official').error).toBeUndefined()
    service = undefined
  })
})

describe('lazy Smithery details', () => {
  it('enriches Smithery servers on get() once, and hides uninstallable ones', async () => {
    const { calls } = stubFetch(sourceRoutes())
    const { svc } = await setup()
    await svc.api.refresh()
    const detailCalls = () => calls.filter((c) => /registry\.smithery\.ai\/servers\/./.test(c.url)).length
    const brave = (await svc.api.get('smithery:brave'))!
    expect(brave.install[0]).toMatchObject({ kind: 'remote', url: 'https://brave.run.tools' })
    expect(brave.install[0].headers).toEqual([expect.objectContaining({ name: 'braveApiKey', secret: true, required: true })])
    expect(detailCalls()).toBe(1)
    await svc.api.get('smithery:brave')
    expect(detailCalls()).toBe(1)
    const bundle = (await svc.api.get('smithery:gautamgb/mcpindex'))!
    expect(bundle.install[0]).toMatchObject({ kind: 'mcpb', package: 'https://api.smithery.ai/servers/gautamgb%2Fmcpindex/download' })
    expect((await svc.api.search({ query: 'gmail' })).total).toBe(1)
    const gmail = (await svc.api.get('smithery:gmail'))!
    expect(gmail.install).toEqual([])
    expect((await svc.api.search({ query: 'gmail' })).total).toBe(0)
  })
})

describe('settings', () => {
  it('re-merges when a source is switched off or on', async () => {
    stubFetch(sourceRoutes())
    const { ctx, svc } = await setup()
    await svc.api.refresh()
    expect((await svc.api.search({ query: 'gmail' })).total).toBe(1)
    await ctx.state.update((d) => void (d.settings.sources.smithery = false))
    await vi.waitFor(async () => expect((await svc.api.search({ query: 'gmail' })).total).toBe(0))
    expect(sourceStatus(await svc.api.stats(), 'smithery').enabled).toBe(false)
    await ctx.state.update((d) => void (d.settings.sources.smithery = true))
    await vi.waitFor(async () => expect((await svc.api.search({ query: 'gmail' })).total).toBe(1))
  })

  it('only uses Glama / PulseMCP when their key is configured', async () => {
    const glama: Route = (u) =>
      u.host === 'glama.ai'
        ? {
            body: {
              pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
              servers: [{ id: 'g1', name: 'Glama Only Tool', namespace: 'gl', slug: 'tool', description: 'Only on Glama', attributes: [], repository: null, url: 'https://glama.ai/mcp/servers/gl/tool' }]
            }
          }
        : undefined
    const { calls } = stubFetch([...sourceRoutes(), glama])
    const { ctx, svc } = await setup()
    await onlySources(ctx, ['glama', 'pulsemcp'])
    let stats = await svc.api.refresh()
    expect(sourceStatus(stats, 'glama').enabled).toBe(false)
    expect(sourceStatus(stats, 'pulsemcp').enabled).toBe(false)
    expect(calls.some((c) => c.url.includes('glama.ai'))).toBe(false)
    await ctx.secrets.set('glama', 'gk-123')
    await ctx.state.update((d) => void (d.settings.glamaKeyRef = 'glama'))
    stats = await svc.api.refresh()
    expect(sourceStatus(stats, 'glama')).toMatchObject({ enabled: true, count: 1 })
    expect(calls.find((c) => c.url.includes('glama.ai'))!.headers.authorization).toBe('Bearer gk-123')
    await vi.waitFor(async () => expect((await svc.api.search({ query: 'glama only' })).items[0]?.id).toBe('glama:gl/tool'))
  })
})

describe('fallback store', () => {
  it('works with the JSON cache and keeps data across restarts', async () => {
    stubFetch(sourceRoutes())
    const { ctx, svc } = await setup({ forceMemoryStore: true })
    await onlySources(ctx, ['docker', 'anthropic'])
    await svc.api.refresh()
    expect((await svc.api.search({ query: 'atlassian' })).items[0].sources).toContain('docker')
    await svc.close()
    vi.unstubAllGlobals()
    stubFetch([])
    service = createCatalogService(ctx, { http: FAST_HTTP, seed: null, forceMemoryStore: true })
    const page = await service.api.search({ query: 'amplitude' })
    expect(page.items[0].sources).toContain('anthropic')
    expect(sourceStatus(await service.api.stats(), 'docker').count).toBe(14)
  })
})
