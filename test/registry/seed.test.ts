import { statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATEGORIES } from '@core/registry/categories'
import { FEATURED_IDS, SEED_SERVERS, seedEntries, undeclaredPlaceholders } from '@core/registry/seed'
import { bundledEntries, isSeedPayload, loadBundledSeed } from '@core/registry/seed-data'
import { buildServerConfig } from '@core/registry/launch'
import { mergeAll } from '@core/registry/dedupe'

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id))

describe('curated seed', () => {
  it('has ~40 well-formed servers', () => {
    expect(SEED_SERVERS.length).toBeGreaterThanOrEqual(35)
    const ids = new Set<string>()
    const slugs = new Set<string>()
    for (const s of SEED_SERVERS) {
      expect(ids.has(s.id), `duplicate id ${s.id}`).toBe(false)
      ids.add(s.id)
      const entry = seedEntries().find((e) => e.sourceId === s.id)!
      expect(entry.server.slug).toMatch(/^[a-z0-9-]{1,64}$/)
      expect(slugs.has(entry.server.slug), `duplicate slug ${entry.server.slug}`).toBe(false)
      slugs.add(entry.server.slug)
      expect(s.description.length).toBeGreaterThan(20)
      expect(s.description.length).toBeLessThanOrEqual(140)
      expect(s.categories.length).toBeGreaterThan(0)
      for (const c of s.categories) expect(CATEGORY_IDS.has(c), `${s.id}: unknown category ${c}`).toBe(true)
      expect(s.install.length).toBeGreaterThan(0)
      expect(new Set(s.install.map((o) => o.id)).size).toBe(s.install.length)
    }
  })

  it('has complete, pinned and self-consistent install options', () => {
    for (const s of SEED_SERVERS) {
      for (const o of s.install) {
        expect(undeclaredPlaceholders(o), `${s.id}/${o.id}`).toEqual([])
        if (o.kind === 'npm') {
          expect(o.command).toBe('npx')
          expect(o.args?.[0]).toBe('-y')
          expect(o.version, `${s.id} npm version`).toMatch(/^\d+\.\d+\.\d+/)
          expect(o.args).toContain(`${o.package}@${o.version}`)
        }
        if (o.kind === 'pypi') {
          expect(o.command).toBe('uvx')
          expect(o.args).toContain(`${o.package}@${o.version}`)
        }
        if (o.kind === 'remote') expect(o.url).toMatch(/^https:\/\//)
        if (o.kind === 'docker') expect(o.args?.slice(0, 3)).toEqual(['run', '-i', '--rm'])
        for (const e of [...o.env, ...(o.headers ?? [])]) if (e.helpUrl) expect(e.helpUrl).toMatch(/^https:\/\//)
      }
    }
  })

  it('produces runnable configs once required values are given', () => {
    for (const s of SEED_SERVERS) {
      for (const o of s.install) {
        const values = {
          env: Object.fromEntries(o.env.map((e) => [e.name, 'value'])),
          headers: Object.fromEntries((o.headers ?? []).map((h) => [h.name, 'token'])),
          args: Object.fromEntries((o.argsSpec ?? []).map((a) => [a.name, a.repeatable ? ['/tmp/a', '/tmp/b'] : 'x']))
        }
        const r = buildServerConfig(o, values)
        expect(r.ok, `${s.id}/${o.id}: ${r.missing.join(',')} ${r.warnings.join(' ')}`).toBe(true)
        expect(JSON.stringify(r.config)).not.toMatch(/\{\{/)
      }
    }
  })

  it('features 12–16 beginner picks that all exist in the seed', () => {
    expect(FEATURED_IDS.length).toBeGreaterThanOrEqual(12)
    expect(FEATURED_IDS.length).toBeLessThanOrEqual(16)
    for (const id of FEATURED_IDS) expect(SEED_SERVERS.some((s) => s.id === id), id).toBe(true)
    const names = FEATURED_IDS.map((id) => SEED_SERVERS.find((s) => s.id === id)!.name)
    expect(names).toEqual(expect.arrayContaining(['Filesystem', 'Fetch', 'Memory', 'Sequential Thinking', 'Time', 'Git', 'Playwright', 'Context7', 'DeepWiki', 'GitHub', 'Notion', 'Linear', 'Sentry', 'Brave Search']))
  })

  it('marks curated entries with guard names and keys', () => {
    const fs = seedEntries().find((e) => e.sourceId === 'io.github.modelcontextprotocol/server-filesystem')!
    expect(fs.guardName).toBe('io.github.modelcontextprotocol/server-filesystem')
    expect(fs.keys).toEqual(
      expect.arrayContaining(['name:io.github.modelcontextprotocol/server-filesystem', 'npm:@modelcontextprotocol/server-filesystem', 'oci:docker.io/mcp/filesystem'])
    )
    expect(fs.server.verified).toBe(true)
    expect(fs.server.sources).toEqual(['seed'])
  })
})

describe('bundled catalog seed (resources/catalog-seed.json)', () => {
  it('stays within the size budget', () => {
    const size = statSync(join(__dirname, '..', '..', 'resources', 'catalog-seed.json')).size
    expect(size).toBeLessThanOrEqual(1_500_000)
  })

  it('loads and normalises with the live parsers', async () => {
    const seed = await loadBundledSeed()
    expect(seed).not.toBeNull()
    expect(isSeedPayload(seed)).toBe(true)
    const entries = bundledEntries(seed!)
    expect(entries.anthropic!.length).toBeGreaterThan(250)
    expect(entries.github!.length).toBeGreaterThan(400)
    expect(entries.docker!.length).toBeGreaterThan(200)
    const merged = mergeAll([...entries.anthropic!, ...entries.github!, ...entries.docker!, ...seedEntries()])
    const notion = merged.find((m) => m.server.id === 'com.notion/mcp')!
    expect(notion.server.sources).toEqual(expect.arrayContaining(['anthropic', 'seed']))
    expect(notion.server.install[0]).toMatchObject({ kind: 'remote', url: 'https://mcp.notion.com/mcp' })
    expect(merged.length).toBeGreaterThan(900)
    expect(isSeedPayload({ format: 'nope' })).toBe(false)
  })
})
