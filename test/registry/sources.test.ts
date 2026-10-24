import { describe, expect, it } from 'vitest'
import { parseOfficialPage, parseOfficialItem } from '@core/registry/sources/official'
import { parseAnthropicPage } from '@core/registry/sources/anthropic'
import { parseGithubPage } from '@core/registry/sources/github'
import { parseSmitheryPage, parseSmitheryDetail, smitheryHostedUrl } from '@core/registry/sources/smithery'
import { parseDockerYaml } from '@core/registry/sources/docker'
import { parseClineMarketplace } from '@core/registry/sources/cline'
import { parseAwesomeReadme } from '@core/registry/sources/awesome'
import { parseGlamaPage } from '@core/registry/sources/glama'
import { parsePulsePage, parsePulseSecret } from '@core/registry/sources/pulsemcp'
import { fixture, fixtureText } from './helpers'

describe('official registry', () => {
  it('parses a page: entries, cursor, guard names, deprecated flag', () => {
    const p1 = parseOfficialPage(fixture('official-page-1.json'))
    expect(p1.next).toBe('ai.smithery/brave:1.0.0')
    expect(p1.entries.map((e) => e.sourceId)).toContain('io.github.github/github-mcp-server')
    const gh = p1.entries.find((e) => e.sourceId === 'io.github.github/github-mcp-server')!
    expect(gh.guardName).toBe('io.github.github/github-mcp-server')
    expect(gh.keys).toContain('name:io.github.github/github-mcp-server')
    expect(gh.server).toMatchObject({ id: 'io.github.github/github-mcp-server', name: 'GitHub', publisher: 'github', sources: ['official'] })
    expect(gh.server.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const p2 = parseOfficialPage(fixture('official-page-2.json'))
    expect(p2.next).toBeUndefined()
    const dep = p2.entries.find((e) => e.sourceId === 'ai.agentplaybooks/agentplaybooks')!
    expect(dep.deprecated).toBeTruthy()
  })

  it('builds friendly names when no title is published', () => {
    const brave = parseOfficialPage(fixture('official-page-1.json')).entries.find((e) => e.sourceId === 'io.github.brave/brave-search-mcp-server')!
    expect(brave.server.name).toBe('Brave Search')
    expect(brave.nameExplicit).toBeUndefined()
    expect(brave.server.slug).toBe('brave-search')
    expect(brave.server.categories).toContain('search')
  })

  it('reports deleted and non-latest items in deltas', () => {
    const delta = parseOfficialPage(fixture('official-delta.json'))
    expect(delta.deleted).toEqual(['com.notion/mcp'])
    expect(delta.entries.map((e) => e.sourceId)).toEqual(['io.github.brave/brave-search-mcp-server'])
    expect(parseOfficialItem({ server: { name: 'x/y' }, _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false } } })).toEqual({ stale: true })
    expect(parseOfficialItem({ nope: 1 })).toEqual({})
  })
})

describe('Anthropic (Claude connectors directory)', () => {
  const page = parseAnthropicPage(fixture('anthropic-page.json'))
  const byId = (id: string) => page.entries.find((e) => e.sourceId === id)!

  it('uses displayName / oneLiner and marks entries verified + official', () => {
    const notion = byId('com.notion/mcp')
    expect(notion.server.name).toBe('Notion')
    expect(notion.server.verified).toBe(true)
    expect(notion.server.official).toBe(true)
    expect(notion.server.install[0]).toMatchObject({ kind: 'remote', url: 'https://mcp.notion.com/mcp' })
    expect(notion.server.install[0].notes).toMatch(/OAuth/)
    expect(notion.keys).toContain('name:com.notion/mcp')
  })

  it('turns urlOptions into one remote option per region', () => {
    const amp = byId('com.amplitude/mcp-server')
    expect(amp.server.install.map((o) => o.url)).toEqual(['https://mcp.amplitude.com/mcp', 'https://mcp.eu.amplitude.com/mcp'])
    expect(amp.server.install[1].label).toBe('Remote (EU)')
    expect(amp.keys).toContain('remote:mcp.amplitude.com/mcp')
  })

  it('asks for the personal URL when requiredFields contains "url"', () => {
    const port = byId('io.port/Port')
    expect(port.server.install[0]).toMatchObject({ kind: 'remote', url: '{{arg:url}}' })
    expect(port.server.install[0].argsSpec).toEqual([expect.objectContaining({ name: 'url', required: true, format: 'url' })])
    expect(port.server.install[0].notes).toMatch(/must match/)
  })

  it('keeps packages published next to remotes and notes authless servers', () => {
    expect(byId('com.supabase/mcp').server.install.map((o) => o.kind)).toEqual(['remote', 'npm'])
    expect(byId('com.microsoft/microsoft-learn-mcp').server.install[0].notes).toBe('No sign-in needed.')
  })
})

describe('GitHub MCP registry', () => {
  it('reads stars, topics, avatar, README excerpt and old-style names', () => {
    const page = parseGithubPage(fixture('github-page-1.json'))
    expect(page.total).toBe(4)
    expect(page.next).toBe('mcp.cursor.eyJ2IjoxfQ')
    const md = page.entries.find((e) => e.sourceId === 'microsoft/markitdown')!
    expect(md.guardName).toBeUndefined()
    expect(md.keys.some((k) => k.startsWith('name:'))).toBe(false)
    expect(md.server.stars).toBeGreaterThan(100_000)
    expect(md.metrics?.stars).toBe(md.server.stars)
    expect(md.server.iconUrl).toMatch(/^https:\/\/avatars\.githubusercontent\.com/)
    expect(md.server.publisher).toBe('microsoft')
    expect(md.server.official).toBe(true)
    expect(md.server.verified).toBe(true)
    expect(md.server.install[0]).toMatchObject({ kind: 'pypi', args: ['markitdown-mcp@0.0.1a4'] })
    const c7 = page.entries.find((e) => e.sourceId === 'io.github.upstash/context7')!
    expect(c7.guardName).toBe('io.github.upstash/context7')
    // README that starts with badges only: no excerpt rather than badge noise
    expect(c7.server.longDescription).toMatch(/^License: /)
    expect(md.server.longDescription).toBeDefined()
    expect(md.server.longDescription).not.toMatch(/!\[|shields\.io|\]\(/)
    const pw = page.entries.find((e) => e.sourceId === 'microsoft/playwright-mcp')!
    expect(pw.server.version).toBeUndefined()
    expect(pw.server.install[0].args).toEqual(['-y', '@playwright/mcp@latest'])
  })
})

describe('Smithery', () => {
  it('parses list items, hiding uninstallable ones (remote: null)', () => {
    const p1 = parseSmitheryPage(fixture('smithery-page-1.json'))
    expect(p1.totalPages).toBe(2)
    expect(p1.items).toBe(3)
    expect(p1.entries.map((e) => e.sourceId)).toEqual(['brave', 'upstash/context7-mcp'])
    const brave = p1.entries[0]
    expect(brave.ref).toBe('brave')
    expect(brave.metrics?.useCount).toBeGreaterThan(1000)
    expect(brave.server).toMatchObject({ id: 'smithery:brave', name: 'Brave Search', verified: true })
    expect(brave.server.install[0]).toMatchObject({ kind: 'remote', url: smitheryHostedUrl('brave') })
    expect(p1.entries[1].softKeys).toContain('repo:github.com/upstash/context7-mcp')
    const p2 = parseSmitheryPage(fixture('smithery-page-2.json'))
    expect(p2.entries[0].server.install[0]).toMatchObject({ kind: 'mcpb', package: 'https://api.smithery.ai/servers/gautamgb%2Fmcpindex/download' })
  })

  it('turns details into remote options with config headers, or bundles', () => {
    const http = parseSmitheryDetail(fixture('smithery-detail-brave.json'))
    expect(http.installable).toBe(true)
    expect(http.options[0]).toMatchObject({ kind: 'remote', url: 'https://brave.run.tools' })
    expect(http.options[0].headers).toEqual([expect.objectContaining({ name: 'braveApiKey', required: true, secret: true })])
    const stdio = parseSmitheryDetail(fixture('smithery-detail-stdio.json'))
    expect(stdio.options[0]).toMatchObject({ kind: 'mcpb' })
    expect(stdio.options[0].package).toMatch(/hugeicons%2Fmcp-server\/download$/)
    expect(parseSmitheryDetail(fixture('smithery-detail-empty.json'))).toEqual({ options: [], installable: false })
  })

  it('puts required non-secret settings in the URL query and skips optional ones', () => {
    const d = parseSmitheryDetail({
      qualifiedName: 'acme/weather',
      connections: [
        {
          type: 'http',
          deploymentUrl: 'https://weather--acme.run.tools',
          configSchema: {
            type: 'object',
            required: ['units', 'apiKey'],
            properties: { units: { type: 'string', 'x-from': { query: 'units' } }, apiKey: { type: 'string', 'x-from': { header: 'x-api-key' } }, lang: { type: 'string' } }
          }
        }
      ]
    })
    expect(d.options[0].url).toBe('https://weather--acme.run.tools?units={{arg:units}}')
    expect(d.options[0].headers).toEqual([expect.objectContaining({ name: 'x-api-key', required: true, secret: true })])
    expect(d.options[0].notes).toMatch(/1 optional setting/)
  })
})

describe('Docker MCP catalog', () => {
  const entries = parseDockerYaml(fixtureText('docker-catalog.yaml'))
  const byKey = (k: string) => entries.find((e) => e.sourceId === k)!

  it('skips poci tool containers', () => {
    expect(byKey('curl')).toBeUndefined()
    expect(entries.length).toBe(14)
  })

  it('maps servers to docker run with secrets as env and fixed env as -e NAME=value', () => {
    const brave = byKey('brave')
    const o = brave.server.install[0]
    expect(o.kind).toBe('docker')
    expect(o.args).toEqual(['run', '-i', '--rm', '-e', 'BRAVE_MCP_TRANSPORT=stdio', '-e', 'BRAVE_API_KEY', o.package!])
    expect(o.package).toMatch(/^mcp\/brave-search@sha256:/)
    expect(o.env).toEqual([expect.objectContaining({ name: 'BRAVE_API_KEY', secret: true, required: true, placeholder: 'YOUR_API_KEY_HERE' })])
    expect(brave.metrics?.pulls).toBeGreaterThan(1000)
    expect(brave.keys).toContain('oci:docker.io/mcp/brave-search')
    expect(brave.keys).toContain('repo:github.com/brave/brave-search-mcp-server')
    expect(brave.server.categories).toContain('search')
  })

  it('translates config templates into env specs and $SECRET references into placeholders', () => {
    const atl = byKey('atlassian').server.install[0]
    expect(atl.env.map((e) => e.name)).toEqual([
      'CONFLUENCE_API_TOKEN',
      'CONFLUENCE_PERSONAL_TOKEN',
      'JIRA_API_TOKEN',
      'JIRA_PERSONAL_TOKEN',
      'CONFLUENCE_URL',
      'CONFLUENCE_USERNAME',
      'JIRA_URL',
      'JIRA_USERNAME'
    ])
    expect(atl.env.find((e) => e.name === 'JIRA_URL')).toMatchObject({ secret: false, required: false })
    expect(atl.env.filter((e) => e.secret).every((e) => !e.required)).toBe(true)
    const notion = byKey('notion').server.install[0]
    expect(notion.args).toContain('OPENAPI_MCP_HEADERS={"Authorization": "Bearer {{INTERNAL_INTEGRATION_TOKEN}}", "Notion-Version": "2022-06-28"}')
    const sentry = byKey('sentry').server.install[0]
    expect(sentry.args?.slice(-2)).toEqual(['--auth-token', '{{SENTRY_AUTH_TOKEN}}'])
  })

  it('maps template volumes / user to arguments and keeps named volumes', () => {
    const aks = byKey('aks').server.install[0]
    expect(aks.args).toContain('{{arg:azure_dir}}:/home/mcp/.azure')
    expect(aks.args).toContain('--user')
    expect(aks.argsSpec?.map((a) => a.name)).toEqual(expect.arrayContaining(['azure_dir', 'kubeconfig', 'container_user', 'access_level']))
    const memory = byKey('memory').server.install[0]
    expect(memory.args).toEqual(expect.arrayContaining(['-v', 'claude-memory:/app/dist']))
  })

  it('falls back to a manual option when templates need the Docker gateway', () => {
    const fs = byKey('filesystem')
    expect(fs.server.name).toBe('Filesystem')
    expect(fs.server.tags).toContain('reference')
    expect(fs.server.install[0]).toMatchObject({ kind: 'manual', url: 'https://hub.docker.com/mcp/server/filesystem/overview' })
  })

  it('maps remotes with Bearer ${VAR} headers to header templates', () => {
    const apify = byKey('apify').server.install[0]
    expect(apify).toMatchObject({ kind: 'remote', url: 'https://mcp.apify.com', transport: 'http' })
    expect(apify.headers).toEqual([expect.objectContaining({ name: 'Authorization', secret: true, required: true, template: 'Bearer {{value}}' })])
    const c7 = byKey('context7').server.install[0]
    expect(c7.headers).toEqual([expect.objectContaining({ name: 'CONTEXT7_API_KEY', template: '{{value}}' })])
  })

  it('flags archived reference servers and ignores monorepo stars', () => {
    expect(byKey('SQLite').deprecated).toBeTruthy()
    expect(byKey('slack').deprecated).toBeTruthy()
    expect(byKey('github').deprecated).toBeTruthy()
    expect(byKey('fetch').deprecated).toBeUndefined()
    expect(byKey('fetch').server.stars).toBeUndefined()
    expect(byKey('github-official').server.official).toBe(true)
  })
})

describe('Cline marketplace', () => {
  it('parses items as discovery entries with stars and downloads', () => {
    const entries = parseClineMarketplace(fixture('cline-marketplace.json'))
    expect(entries).toHaveLength(3)
    const postman = entries[0]
    expect(postman.server).toMatchObject({ id: 'cline:github.com/postmanlabs/postman-mcp-server', name: 'Postman API Tools', publisher: 'postmanlabs' })
    expect(postman.metrics).toMatchObject({ downloads: expect.any(Number), stars: expect.any(Number) })
    expect(postman.server.install[0]).toMatchObject({ kind: 'manual', url: 'https://github.com/postmanlabs/postman-mcp-server' })
    expect(postman.keys).toEqual(['repo:github.com/postmanlabs/postman-mcp-server'])
    const pg = entries[1]
    expect(pg.deprecated).toBeTruthy()
    expect(pg.metrics?.stars).toBeUndefined()
    expect(parseClineMarketplace({ not: 'an array' })).toEqual([])
  })
})

describe('awesome-mcp-servers README', () => {
  it('parses categories, badges, emojis and stops at Frameworks', () => {
    const entries = parseAwesomeReadme(fixtureText('awesome-README.md'))
    expect(entries.length).toBe(9)
    const octo = entries.find((e) => e.sourceId === 'github.com/77777r7/octocrawl')!
    expect(octo.server.official).toBe(true)
    expect(octo.server.tags).toEqual(expect.arrayContaining(['cloud', 'local']))
    expect(octo.server.description).not.toMatch(/glama\.ai|badges/)
    expect(octo.server.categories).toContain('browser-web')
    expect(octo.server.install[0]).toMatchObject({ kind: 'manual', url: 'https://github.com/77777R7/Octocrawl' })
    const archived = entries.find((e) => e.sourceId.startsWith('github.com/modelcontextprotocol/servers-archived'))!
    expect(archived.deprecated).toBeTruthy()
    expect(archived.keys).toEqual(['repo:github.com/modelcontextprotocol/servers-archived#src/puppeteer'])
    expect(entries.some((e) => e.sourceId.includes('ignored/framework'))).toBe(false)
  })
})

describe('Glama and PulseMCP (optional sources)', () => {
  it('parses Glama servers with env schema, attribution link and repo keys', () => {
    const page = parseGlamaPage({
      pageInfo: { hasNextPage: true, endCursor: 'abc', hasPreviousPage: false, startCursor: null },
      servers: [
        {
          id: 'abc1234567',
          name: 'Playwright MCP Server',
          namespace: 'microsoft',
          slug: 'playwright-mcp',
          description: 'Browser automation',
          attributes: ['author:official'],
          environmentVariablesJsonSchema: { type: 'object', properties: { API_KEY: { type: 'string', description: 'Key' } }, required: ['API_KEY'] },
          repository: { url: 'https://github.com/microsoft/playwright-mcp' },
          url: 'https://glama.ai/mcp/servers/microsoft/playwright-mcp',
          thumbnailUrl: null,
          tools: [],
          qualityScore: 4,
          isBoosted: false,
          spdxLicense: null
        }
      ]
    })
    expect(page.next).toBe('abc')
    const e = page.entries[0]
    expect(e.server.homepage).toBe('https://glama.ai/mcp/servers/microsoft/playwright-mcp')
    expect(e.server.official).toBe(true)
    expect(e.server.install[0].env).toEqual([expect.objectContaining({ name: 'API_KEY', required: true, secret: true })])
    expect(e.server.install[0].notes).toMatch(/MCP data from Glama/)
    expect(e.keys).toEqual(['repo:github.com/microsoft/playwright-mcp'])
  })

  it('parses PulseMCP pages (server.json + visitor estimates) and secrets', () => {
    const page = parsePulsePage({
      servers: [
        {
          server: { name: 'io.github.brave/brave-search-mcp-server', description: 'Brave', version: '2.1.3' },
          _meta: {
            'com.pulsemcp/server': { visitorsEstimateLastFourWeeks: 12000, isOfficial: true },
            'com.pulsemcp/server-version': { status: 'active', isLatest: true, updatedAt: '2026-10-01T00:00:00Z' }
          }
        },
        { server: { name: 'x/old', description: 'old' }, _meta: { 'com.pulsemcp/server-version': { isLatest: false } } }
      ],
      metadata: { nextCursor: 'n1' }
    })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({ guardName: 'io.github.brave/brave-search-mcp-server', metrics: { visitors: 12000 } })
    expect(page.next).toBe('n1')
    expect(parsePulseSecret('tenant1:key1')).toEqual({ tenantId: 'tenant1', apiKey: 'key1' })
    expect(parsePulseSecret('{"tenantId":"t","apiKey":"k"}')).toEqual({ tenantId: 't', apiKey: 'k' })
    expect(parsePulseSecret('k', 't')).toEqual({ apiKey: 'k', tenantId: 't' })
    expect(parsePulseSecret(null)).toBeNull()
  })
})
