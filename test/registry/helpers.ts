/** Shared helpers for registry tests: fixtures, a fake fetch router, a core context and entry builders. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { CatalogServer, CatalogSource, InstallOption } from '@shared/types'
import type { CoreEvents } from '@shared/api'
import { createContext, type CoreContext } from '@core/context'
import { createMemorySecretStore, type SecretStore } from '@core/secrets'
import { makeServer } from '@core/registry/normalize'
import type { SourceEntry } from '@core/registry/types'

const FIXTURES = join(__dirname, 'fixtures')

/** Raw fixture text. */
export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/** Parsed JSON fixture (fresh copy each call). */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T
}

export interface FakeResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Delay before answering (ms). */
  delay?: number
}

export type Route = (url: URL, init: RequestInit | undefined) => FakeResponse | undefined | Promise<FakeResponse | undefined>

/**
 * Install a fake global fetch. Routes are tried in order; the first returning a response wins.
 * Unmatched requests fail like a network error. Returns the call log.
 */
export function stubFetch(routes: Route[]): { calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    calls.push({ url: url.toString(), headers })
    for (const route of routes) {
      const res = await route(url, init)
      if (!res) continue
      if (res.delay) await new Promise((r) => setTimeout(r, res.delay))
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const body = typeof res.body === 'string' ? res.body : res.body === undefined ? '' : JSON.stringify(res.body)
      return new Response(res.status === 304 ? null : body, { status: res.status ?? 200, headers: res.headers ?? { 'content-type': 'application/json' } })
    }
    throw new TypeError(`fetch failed (no route for ${url})`)
  })
  return { calls }
}

/** Routes answering every public source with the fixtures (one page set per source). */
export function sourceRoutes(overrides: Partial<Record<string, Route>> = {}): Route[] {
  const routes: Record<string, Route> = {
    official: (u) => {
      if (u.host !== 'registry.modelcontextprotocol.io') return undefined
      if (u.searchParams.get('updated_since')) return { body: fixture('official-delta.json') }
      return { body: fixture(u.searchParams.get('cursor') ? 'official-page-2.json' : 'official-page-1.json') }
    },
    anthropic: (u) => (u.host === 'api.anthropic.com' ? { body: fixture('anthropic-page.json') } : undefined),
    github: (u) => (u.host === 'api.mcp.github.com' ? { body: fixture(u.searchParams.get('cursor') ? 'github-page-2.json' : 'github-page-1.json') } : undefined),
    smitheryDetail: (u) => {
      if (u.host !== 'registry.smithery.ai' || !u.pathname.startsWith('/servers/')) return undefined
      const qn = decodeURIComponent(u.pathname.slice('/servers/'.length))
      if (qn === 'brave') return { body: fixture('smithery-detail-brave.json') }
      if (qn === 'gautamgb/mcpindex') return { body: { ...fixture<Record<string, unknown>>('smithery-detail-stdio.json'), qualifiedName: qn } }
      return { body: { ...fixture<Record<string, unknown>>('smithery-detail-empty.json'), qualifiedName: qn } }
    },
    smithery: (u) =>
      u.host === 'registry.smithery.ai' && u.pathname === '/servers'
        ? { body: fixture(u.searchParams.get('page') === '2' ? 'smithery-page-2.json' : 'smithery-page-1.json') }
        : undefined,
    docker: (u) =>
      u.host === 'desktop.docker.com' ? { body: fixtureText('docker-catalog.yaml'), headers: { 'content-type': 'application/yaml', etag: '"v1"' } } : undefined,
    cline: (u) => (u.host === 'api.cline.bot' ? { body: fixture('cline-marketplace.json') } : undefined),
    awesome: (u) => (u.host === 'raw.githubusercontent.com' ? { body: fixtureText('awesome-README.md'), headers: { 'content-type': 'text/plain' } } : undefined)
  }
  for (const [k, v] of Object.entries(overrides)) if (v) routes[k] = v
  return Object.values(routes)
}

/** Core context inside a sandbox data dir, with an in-memory secret store. */
export async function testContext(dataDir: string, secrets: SecretStore = createMemorySecretStore()): Promise<CoreContext> {
  return createContext({ surface: 'cli', appVersion: '0.0.0-test', dataDir, secretStore: secrets })
}

/** Collect 'catalog' events. */
export function collectEvents(ctx: CoreContext): Array<CoreEvents['catalog']> {
  const events: Array<CoreEvents['catalog']> = []
  ctx.events.on('catalog', (e) => events.push(e))
  return events
}

/** Fast HTTP settings for tests. */
export const FAST_HTTP = { minIntervalMs: 0, retryBaseMs: 1, retries: 2, timeoutMs: 5000 }

export interface EntryInput {
  source: CatalogSource
  id: string
  name: string
  description?: string
  guard?: string
  keys?: string[]
  softKeys?: string[]
  install?: InstallOption[]
  stars?: number
  useCount?: number
  publisher?: string
  categories?: string[]
  tags?: string[]
  updatedAt?: string
  deprecated?: string | true
  official?: boolean
  verified?: boolean
}

/** Build a SourceEntry for dedupe/store tests. */
export function entry(e: EntryInput): SourceEntry {
  const server: CatalogServer = makeServer(e.source, {
    id: e.id,
    name: e.name,
    description: e.description ?? `${e.name} server`,
    publisher: e.publisher,
    categories: e.categories,
    tags: e.tags,
    updatedAt: e.updatedAt,
    official: e.official,
    verified: e.verified,
    stars: e.stars,
    install: e.install ?? []
  })
  const out: SourceEntry = { source: e.source, sourceId: e.id, keys: e.keys ?? [], softKeys: e.softKeys ?? [], server, nameExplicit: true }
  if (e.guard) out.guardName = e.guard
  if (e.stars !== undefined || e.useCount !== undefined) out.metrics = { stars: e.stars, useCount: e.useCount }
  if (e.deprecated) out.deprecated = e.deprecated
  return out
}
