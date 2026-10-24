import { describe, expect, it } from 'vitest'
import { CATEGORIES, categoryLabel, classify, resolveCategory } from '@core/registry/categories'
import { prettifyName, slugify, compareVersions, readmeExcerpt, truncate } from '@core/registry/util'
import { normalizeOciRef, packageKey, parseRepoUrl, remoteKey, softRemoteKey } from '@core/registry/keys'
import { publisherFromName, vendorKey, namespaceOwner, isRepublisherName } from '@core/registry/normalize'

describe('category taxonomy', () => {
  it('has the expected ids and labels', () => {
    expect(CATEGORIES.map((c) => c.label)).toEqual([
      'Developer Tools',
      'Browser & Web',
      'Search',
      'Files & Storage',
      'Databases',
      'Cloud & DevOps',
      'Productivity',
      'Communication',
      'AI & Memory',
      'Data & Analytics',
      'Design & Media',
      'Finance & Commerce',
      'Security',
      'Knowledge & Docs',
      'Other'
    ])
    expect(categoryLabel('databases')).toBe('Databases')
    expect(categoryLabel('???')).toBe('Other')
  })

  it('resolves ids, labels and source-specific labels', () => {
    expect(resolveCategory('browser-web')).toBe('browser-web')
    expect(resolveCategory('Browser & Web')).toBe('browser-web')
    expect(resolveCategory('browser-automation')).toBe('browser-web')
    expect(resolveCategory('Finance & Fintech')).toBe('finance-commerce')
    expect(resolveCategory('devops')).toBe('cloud-devops')
    expect(resolveCategory('financial-services')).toBe('finance-commerce')
    expect(resolveCategory('nonsense')).toBeUndefined()
  })

  it('classifies from source categories and keywords', () => {
    expect(classify({ name: 'Playwright', description: 'Automate a real browser' })).toEqual(['browser-web'])
    expect(classify({ name: 'Brave Search', description: 'Web search with the Brave API' })[0]).toBe('search')
    expect(classify({ name: 'Acme', description: 'Query your PostgreSQL database' })[0]).toBe('databases')
    expect(classify({ name: 'Acme', description: 'Anything', sourceCategories: ['devops'] })).toEqual(['cloud-devops'])
    expect(classify({ name: 'Zorblax', description: 'Does things' })).toEqual(['other'])
    expect(classify({ name: 'Slack', description: 'Send messages to channels' })[0]).toBe('communication')
    expect(classify({ name: 'Sentry', description: 'Error monitoring and debugging for your apps' })).toContain('cloud-devops')
  })
})

describe('names, slugs and keys', () => {
  it('builds friendly names and safe slugs', () => {
    expect(prettifyName('brave-search-mcp-server')).toBe('Brave Search')
    expect(prettifyName('@upstash/context7-mcp')).toBe('Context7')
    expect(prettifyName('github-mcp-server')).toBe('GitHub')
    expect(prettifyName('mcp-server')).toBe('Mcp Server'.replace('Mcp', 'MCP'))
    expect(slugify('Brave Search MCP Server')).toBe('brave-search')
    expect(slugify('The MCP Server for Sentry')).toBe('sentry')
    expect(slugify('Café Déjà Vu!')).toBe('cafe-deja-vu')
    expect(slugify('???', 'io.github.x/y')).toBe('io-github-x-y')
    expect(slugify('a'.repeat(100))).toHaveLength(64)
    expect(slugify('Notion')).toMatch(/^[a-z0-9_-]{1,64}$/)
  })

  it('normalises package, remote and repository keys', () => {
    expect(packageKey('npm', '@Brave/Brave-Search-MCP-Server')).toBe('npm:@brave/brave-search-mcp-server')
    expect(packageKey('pypi', 'Mcp_Server.Fetch')).toBe('pypi:mcp-server-fetch')
    expect(packageKey('oci', 'mcp/fetch@sha256:abc')).toBe('oci:docker.io/mcp/fetch')
    expect(normalizeOciRef('postgres:16')).toBe('docker.io/library/postgres')
    expect(normalizeOciRef('ghcr.io/github/github-mcp-server:2.0.3')).toBe('ghcr.io/github/github-mcp-server')
    expect(packageKey('mcpb', 'https://x/y.mcpb')).toBe('mcpb:https://x/y.mcpb')
    expect(packageKey('weird', 'x')).toBeUndefined()
    expect(remoteKey('https://Mcp.Notion.com/mcp/?x=1#y')).toBe('remote:mcp.notion.com/mcp')
    expect(remoteKey('https://{host}/mcp')).toBeUndefined()
    expect(softRemoteKey('https://mcp.asana.com/sse')).toBe('rhost:mcp.asana.com')
    expect(parseRepoUrl('git+https://github.com/Owner/Repo.git')).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', subfolder: undefined })
    expect(parseRepoUrl('https://github.com/o/r/tree/main/src/fetch')).toMatchObject({ subfolder: 'src/fetch' })
    expect(parseRepoUrl('https://github.com/o/r/tree/abc123')).toMatchObject({ subfolder: undefined })
    expect(parseRepoUrl('https://gitlab.com/g/p/-/tree/main/pkg')).toMatchObject({ host: 'gitlab.com', subfolder: 'pkg' })
    expect(parseRepoUrl('github.com/o/r')).toMatchObject({ owner: 'o', repo: 'r' })
    expect(parseRepoUrl('https://example.com/o/r')).toBeUndefined()
  })

  it('derives publishers and vendor keys from registry names', () => {
    expect(publisherFromName('io.github.brave/brave-search-mcp-server')).toBe('brave')
    expect(publisherFromName('com.notion/mcp')).toBe('notion.com')
    expect(publisherFromName('com.figma.mcp/mcp')).toBe('figma.com')
    expect(namespaceOwner('com.notion/mcp')).toBe('notion')
    expect(namespaceOwner('io.github.Brave/x')).toBe('brave')
    expect(isRepublisherName('ai.smithery/brave')).toBe(true)
    expect(isRepublisherName('io.github.brave/x')).toBe(false)
    expect(vendorKey('notion.com', 'Notion')).toBe('vendor:notion/notion')
    expect(vendorKey('Notion', 'Notion')).toBe('vendor:notion/notion')
    expect(vendorKey(undefined, 'X')).toBeUndefined()
  })

  it('compares versions and cleans text', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('2026.10.19', '2026.7.4')).toBeGreaterThan(0)
    expect(truncate('hello wonderful world', 12)).toBe('hello…')
    expect(truncate('a fine and wonderful world', 20)).toBe('a fine and…')
    expect(readmeExcerpt('# Title\n\n[![badge](x)](y)\n\nThis server lets Claude talk to your calendar and schedule meetings.')).toBe(
      'This server lets Claude talk to your calendar and schedule meetings.'
    )
  })
})
