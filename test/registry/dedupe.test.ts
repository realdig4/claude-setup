import { describe, expect, it } from 'vitest'
import { groupEntries, mergeAll, mergeGroup, derivedSoftKeys } from '@core/registry/dedupe'
import { dockerOption, manualOption, npmOption, remoteOption } from '@core/registry/install'
import { parseOfficialPage } from '@core/registry/sources/official'
import { parseDockerYaml } from '@core/registry/sources/docker'
import { parseClineMarketplace } from '@core/registry/sources/cline'
import { parseAnthropicPage } from '@core/registry/sources/anthropic'
import { parseSmitheryPage } from '@core/registry/sources/smithery'
import { seedEntries } from '@core/registry/seed'
import type { SourceEntry } from '@core/registry/types'
import { entry, fixture, fixtureText } from './helpers'

function groupsOf(entries: SourceEntry[]): string[][] {
  const g = groupEntries(entries.map((e) => ({ source: e.source, guardName: e.guardName, keys: e.keys, softKeys: [...(e.softKeys ?? []), ...derivedSoftKeys(e)] })))
  const map = new Map<number, string[]>()
  entries.forEach((e, i) => map.set(g[i], [...(map.get(g[i]) ?? []), `${e.source}:${e.sourceId}`]))
  return [...map.values()].map((v) => v.sort()).sort((a, b) => a[0].localeCompare(b[0]))
}

describe('grouping rules', () => {
  it('merges by registry name, package, remote and repo keys', () => {
    const groups = groupsOf([
      entry({ source: 'official', id: 'io.github.acme/tool', guard: 'io.github.acme/tool', name: 'Tool', keys: ['name:io.github.acme/tool', 'npm:@acme/tool'] }),
      entry({ source: 'github', id: 'io.github.acme/tool', guard: 'io.github.acme/tool', name: 'Tool', keys: ['name:io.github.acme/tool'] }),
      entry({ source: 'docker', id: 'docker:tool', name: 'Tool', keys: ['npm:@acme/tool'] }),
      entry({ source: 'anthropic', id: 'com.acme/remote', name: 'Acme', keys: ['remote:mcp.acme.com/mcp'] }),
      entry({ source: 'official', id: 'com.acme/remote2', guard: 'com.acme/remote2', name: 'Acme', keys: ['remote:mcp.acme.com/mcp'] })
    ])
    expect(groups).toEqual([
      ['anthropic:com.acme/remote', 'official:com.acme/remote2'],
      ['docker:docker:tool', 'github:io.github.acme/tool', 'official:io.github.acme/tool']
    ])
  })

  it('never merges two different official names, even through a shared key', () => {
    const groups = groupsOf([
      entry({ source: 'official', id: 'io.github.x/a', guard: 'io.github.x/a', name: 'A', keys: ['pypi:clio-kit'] }),
      entry({ source: 'official', id: 'io.github.x/b', guard: 'io.github.x/b', name: 'B', keys: ['pypi:clio-kit'] }),
      entry({ source: 'docker', id: 'docker:clio', name: 'Clio', keys: ['pypi:clio-kit'] })
    ])
    expect(groups).toHaveLength(3)
  })

  it('prefers the canonical publisher over republishers when a repo is shared', () => {
    const groups = groupsOf([
      entry({ source: 'official', id: 'io.github.brave/brave-search', guard: 'io.github.brave/brave-search', name: 'Brave', keys: ['repo:github.com/brave/brave-search'] }),
      entry({ source: 'official', id: 'ai.smithery/brave', guard: 'ai.smithery/brave', name: 'Brave', keys: ['repo:github.com/brave/brave-search'] }),
      entry({ source: 'docker', id: 'docker:brave', name: 'Brave Search', keys: ['repo:github.com/brave/brave-search'] }),
      entry({ source: 'cline', id: 'cline:brave', name: 'Brave Search', keys: ['repo:github.com/brave/brave-search'] })
    ])
    expect(groups).toEqual([['cline:cline:brave', 'docker:docker:brave', 'official:io.github.brave/brave-search'], ['official:ai.smithery/brave']])
  })

  it('does not treat a monorepo key shared within one source as an identity', () => {
    const groups = groupsOf([
      entry({ source: 'docker', id: 'docker:slack', name: 'Slack', keys: ['repo:github.com/modelcontextprotocol/servers'] }),
      entry({ source: 'docker', id: 'docker:github', name: 'GitHub', keys: ['repo:github.com/modelcontextprotocol/servers'] }),
      entry({ source: 'seed', id: 'seed:fs', name: 'Filesystem', keys: ['repo:github.com/modelcontextprotocol/servers#src/filesystem'] })
    ])
    expect(groups).toHaveLength(3)
  })

  it('merges soft keys only into a single unambiguous group', () => {
    const unique = groupsOf([
      entry({ source: 'official', id: 'io.github.o/r', guard: 'io.github.o/r', name: 'R', keys: ['repo:github.com/o/r#pkg'], softKeys: ['repo:github.com/o/r'] }),
      entry({ source: 'awesome', id: 'awesome:o/r', name: 'R', softKeys: ['repo:github.com/o/r'] })
    ])
    expect(unique).toHaveLength(1)
    const ambiguous = groupsOf([
      entry({ source: 'official', id: 'io.github.o/a', guard: 'io.github.o/a', name: 'A', keys: ['repo:github.com/o/r#a'], softKeys: ['repo:github.com/o/r'] }),
      entry({ source: 'official', id: 'io.github.o/b', guard: 'io.github.o/b', name: 'B', keys: ['repo:github.com/o/r#b'], softKeys: ['repo:github.com/o/r'] }),
      entry({ source: 'awesome', id: 'awesome:o/r', name: 'R', softKeys: ['repo:github.com/o/r'] })
    ])
    expect(ambiguous).toHaveLength(3)
  })

  it('matches the same publisher + name across registries (vendor key), but not Smithery-hosted wrappers', () => {
    const groups = groupsOf([
      entry({ source: 'official', id: 'io.github.upstash/context7', guard: 'io.github.upstash/context7', name: 'Context7', publisher: 'upstash' }),
      entry({ source: 'smithery', id: 'upstash/context7-mcp', name: 'Context7', publisher: 'upstash' }),
      entry({ source: 'official', id: 'io.github.brave/x', guard: 'io.github.brave/x', name: 'Brave Search', publisher: 'brave' }),
      entry({ source: 'smithery', id: 'brave', name: 'Brave Search', publisher: 'brave' })
    ])
    expect(groups).toEqual([['official:io.github.brave/x'], ['official:io.github.upstash/context7', 'smithery:upstash/context7-mcp'], ['smithery:brave']])
  })

  it('groups real registry data: Brave from official + Docker + Cline + seed', () => {
    const official = parseOfficialPage(fixture('official-page-1.json')).entries
    const docker = parseDockerYaml(fixtureText('docker-catalog.yaml'))
    const cline = parseClineMarketplace(fixture('cline-marketplace.json'))
    const merged = mergeAll([...official, ...docker, ...cline, ...seedEntries()])
    const brave = merged.find((m) => m.server.id === 'io.github.brave/brave-search-mcp-server')!
    expect(brave.server.sources).toEqual(['official', 'docker', 'cline', 'seed'])
    expect(brave.aliases).toEqual(expect.arrayContaining(['docker:brave', 'cline:github.com/brave/brave-search-mcp-server']))
    const smitheryBrave = merged.find((m) => m.server.id === 'ai.smithery/brave')!
    expect(smitheryBrave.server.sources).toEqual(['official'])
    // reference servers merge with their Docker images, archived ones stay apart
    const fetch = merged.find((m) => m.server.id === 'io.github.modelcontextprotocol/server-fetch')!
    expect(fetch.server.sources).toEqual(['docker', 'seed'])
    expect(merged.find((m) => m.server.id === 'docker:slack')!.server.tags).toContain('deprecated')
  })
})

describe('merge rules', () => {
  it('takes friendly text from seed/Anthropic, install data by priority and unions sources', () => {
    const official = entry({
      source: 'official',
      id: 'com.acme/tool',
      guard: 'com.acme/tool',
      name: 'acme-tool',
      description: 'Official description',
      install: [npmOption({ package: '@acme/tool', version: '1.2.0' }), remoteOption({ url: 'https://mcp.acme.com/mcp' })],
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    official.nameExplicit = undefined
    const anthropic = entry({ source: 'anthropic', id: 'com.acme/tool', name: 'Acme Tool', description: 'Friendly one-liner', install: [remoteOption({ url: 'https://mcp.acme.com/mcp', notes: 'OAuth' })] })
    const docker = entry({ source: 'docker', id: 'docker:acme', name: 'Acme', install: [dockerOption({ package: 'mcp/acme@sha256:abc' })], stars: 1500, updatedAt: '2026-05-01T00:00:00.000Z' })
    const smithery = entry({ source: 'smithery', id: 'acme/tool', name: 'Acme', install: [remoteOption({ url: 'https://server.smithery.ai/acme/tool' })], useCount: 5000 })
    const m = mergeGroup([docker, smithery, anthropic, official])
    expect(m.server.id).toBe('com.acme/tool')
    expect(m.server.name).toBe('Acme Tool')
    expect(m.server.description).toBe('Friendly one-liner')
    expect(m.server.sources).toEqual(['official', 'anthropic', 'docker', 'smithery'])
    // remote (from official, priority over Anthropic's copy) first, npm, docker; Smithery dropped (better options exist)
    expect(m.server.install.map((o) => `${o.id}:${o.kind}`)).toEqual(['remote:remote', 'npm:npm', 'docker:docker'])
    expect(m.server.install[0].notes).toBeUndefined()
    expect(m.server.stars).toBe(1500)
    expect(m.server.updatedAt).toBe('2026-05-01T00:00:00.000Z')
    expect(m.remote).toBe(true)
    expect(m.needsKey).toBe(false)
    expect(m.server.popularity).toBeGreaterThan(60)
  })

  it('keeps seed options first and bumps them to the newest version of the same package', () => {
    const seed = entry({ source: 'seed', id: 'io.github.acme/tool', guard: 'io.github.acme/tool', name: 'Acme', install: [npmOption({ package: '@acme/tool', version: '1.0.0' })] })
    const official = entry({
      source: 'official',
      id: 'io.github.acme/tool',
      guard: 'io.github.acme/tool',
      name: 'Acme',
      install: [remoteOption({ url: 'https://mcp.acme.com' }), npmOption({ package: '@acme/tool', version: '1.3.0' })]
    })
    const m = mergeGroup([official, seed])
    expect(m.server.install.map((o) => o.kind)).toEqual(['npm', 'remote'])
    expect(m.server.install[0]).toMatchObject({ version: '1.3.0', args: ['-y', '@acme/tool@1.3.0'] })
    expect(m.server.version).toBeUndefined()
  })

  it('drops manual options when real ones exist and keeps one otherwise', () => {
    const awesome = entry({ source: 'awesome', id: 'awesome:x', name: 'X', install: [manualOption({ notes: 'README', url: 'https://github.com/x/x' })] })
    expect(mergeGroup([awesome]).server.install.map((o) => o.kind)).toEqual(['manual'])
    const docker = entry({ source: 'docker', id: 'docker:x', name: 'X', install: [dockerOption({ package: 'mcp/x:1' })] })
    expect(mergeGroup([awesome, docker]).server.install.map((o) => o.kind)).toEqual(['docker'])
  })

  it('demotes deprecated and archived servers and boosts curated ones', () => {
    const plain = mergeGroup([entry({ source: 'official', id: 'a/b', guard: 'a/b', name: 'Plain', install: [npmOption({ package: 'p', version: '1' })] })])
    const deprecated = mergeGroup([
      entry({ source: 'official', id: 'a/c', guard: 'a/c', name: 'Old', deprecated: 'Use a/d instead', install: [npmOption({ package: 'q', version: '1' })] })
    ])
    expect(deprecated.server.tags[0]).toBe('deprecated')
    expect(deprecated.server.longDescription).toMatch(/Use a\/d instead/)
    expect(deprecated.server.popularity).toBe(0)
    const archived = mergeGroup([entry({ source: 'docker', id: 'docker:s', name: 'SQLite (Archived)', install: [dockerOption({ package: 'mcp/sqlite' })] })])
    expect(archived.server.tags).toContain('deprecated')
    const curated = mergeGroup([entry({ source: 'anthropic', id: 'com.x/y', name: 'Y', install: [remoteOption({ url: 'https://y.example.com/mcp' })] })])
    expect(curated.server.popularity!).toBeGreaterThan(plain.server.popularity!)
  })

  it('computes needsKey only when every option needs a secret', () => {
    const keyed = npmOption({ package: 'k', version: '1', env: [{ name: 'API_KEY', required: true, secret: true }] })
    expect(mergeGroup([entry({ source: 'official', id: 'k/k', guard: 'k/k', name: 'K', install: [keyed] })]).needsKey).toBe(true)
    expect(mergeGroup([entry({ source: 'official', id: 'k/k', guard: 'k/k', name: 'K', install: [keyed, remoteOption({ url: 'https://k.example.com' })] })]).needsKey).toBe(false)
  })

  it('lets Anthropic and the official registry merge by remote URL (Context7)', () => {
    const merged = mergeAll([...parseOfficialPage(fixture('official-page-1.json')).entries, ...parseAnthropicPage(fixture('anthropic-page.json')).entries, ...parseSmitheryPage(fixture('smithery-page-1.json')).entries])
    const c7 = merged.find((m) => m.server.id === 'io.github.upstash/context7')!
    expect(c7.server.sources).toEqual(['official', 'anthropic', 'smithery'])
    expect(c7.refs.smithery).toBe('upstash/context7-mcp')
    expect(c7.aliases).toContain('com.context7/context7')
  })
})
