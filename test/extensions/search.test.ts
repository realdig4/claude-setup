import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ run: vi.fn(), cli: { path: '/fake/claude' as string | null } }))
vi.mock('@core/platform/exec', () => ({ run: mocks.run, which: vi.fn(async () => '/usr/bin/tool') }))
vi.mock('@core/platform/runtimes', () => ({ findClaudeCli: vi.fn(async () => mocks.cli.path) }))

import { createExtensionsApi } from '@core/extensions'
import { skillPathsFromMarketplace } from '@core/extensions/sources/anthropicSkills'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { fakeRepo, fixture, fixtureText, jsonResponse, makeCtx, stubFetch, type Handler, type TestContext } from './helpers'

function anthropicSkillsRepo(): Handler {
  const files: Record<string, string> = { '.claude-plugin/marketplace.json': fixtureText('marketplace-skills.json') }
  for (const e of skillPathsFromMarketplace(fixture('marketplace-skills.json'))) {
    const name = e.path.split('/').pop() as string
    files[`${e.path}/SKILL.md`] = `---\nname: ${name}\ndescription: Anthropic ${name} skill for documents and more.\n---\n# ${name}\n`
  }
  return fakeRepo('anthropics', 'skills', files)
}

const sources = (opts: { aitmplStatus?: number } = {}): Handler[] => [
  fakeRepo('anthropics', 'claude-plugins-official', { '.claude-plugin/marketplace.json': fixtureText('marketplace-official.json') }),
  fakeRepo('VoltAgent', 'awesome-claude-code-subagents', { '.claude-plugin/marketplace.json': fixtureText('marketplace-voltagent.json') }),
  anthropicSkillsRepo(),
  (url) => {
    if (url.href === 'https://aitmpl.com/components.json') return opts.aitmplStatus ? new Response('oops', { status: opts.aitmplStatus }) : jsonResponse(fixture('aitmpl-components.json'))
    if (url.hostname === 'skills.sh' && url.pathname === '/api/search') return jsonResponse(fixture('skillssh-pdf.json'))
    return undefined
  }
]

describe('extension search', () => {
  let sb: Sandbox
  let t: TestContext
  beforeEach(async () => {
    sb = await createSandbox()
    t = await makeCtx(sb)
    mocks.cli.path = '/fake/claude'
    mocks.run.mockReset()
    mocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      const line = args.join(' ')
      if (line === 'plugin list --json --available') return { ok: true, code: 0, stdout: fixtureText('cli-available.json'), stderr: '', timedOut: false }
      if (line === 'plugin marketplace list --json') return { ok: true, code: 0, stdout: '[]\n', stderr: '', timedOut: false }
      return { ok: false, code: 1, stdout: '', stderr: 'unexpected', timedOut: false }
    })
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await sb.cleanup()
  })

  it('merges every source into one ranked list', async () => {
    stubFetch(...sources())
    const items = await createExtensionsApi(t.ctx).search({})
    // 23 plugins (after merging duplicates) + 21 skills + 3 agents + 2 commands + 2 hooks + 2 status lines
    expect(items).toHaveLength(53)
    const kinds = new Set(items.map((i) => i.kind))
    for (const k of ['plugin', 'skill', 'agent']) expect(kinds.has(k as never)).toBe(true)
    expect(items.every((i) => i.installed === false)).toBe(true)
    expect(items.some((i) => 'sourceKey' in i || 'aliases' in i || 'dedupeKey' in i)).toBe(false)
    expect(items[0].id).toBe('plugin:frontend-design@claude-plugins-official')
  })

  it('finds plugins once even when several marketplaces list them', async () => {
    stubFetch(...sources())
    const items = await createExtensionsApi(t.ctx).search({ kind: 'plugin', query: 'frontend' })
    expect(items[0]).toMatchObject({ id: 'plugin:frontend-design@claude-plugins-official', marketplace: 'claude-plugins-official', source: 'claude-cli' })
    expect(items[0].installs).toBeGreaterThan(1000)
    expect(items.filter((i) => i.name === 'frontend-design')).toHaveLength(1)
    const docs = await createExtensionsApi(t.ctx).search({ kind: 'plugin', query: 'document-skills' })
    expect(docs.filter((i) => i.name === 'document-skills')).toHaveLength(1)
  })

  it('ranks Anthropic skills first and adds skills.sh install counts', async () => {
    stubFetch(...sources())
    const items = await createExtensionsApi(t.ctx).search({ kind: 'skill', query: 'pdf' })
    expect(items[0]).toMatchObject({ id: 'skill:anthropic-skills:anthropics/skills/skills/pdf', source: 'anthropic-skills', installs: 215790 })
    expect(items.some((i) => i.source === 'skills.sh')).toBe(true)
  })

  it('filters by kind, source and limit', async () => {
    stubFetch(...sources())
    const api = createExtensionsApi(t.ctx)
    const hooks = await api.search({ kind: 'hook', source: 'aitmpl' })
    expect(hooks).toHaveLength(2)
    expect(hooks.every((h) => h.warnings?.[0]?.includes('run commands'))).toBe(true)
    expect(await api.search({ kind: 'statusline' })).toHaveLength(2)
    expect(await api.search({ limit: 5 })).toHaveLength(5)
    const fromMarketplaces = await api.search({ kind: 'plugin', source: 'marketplace' })
    expect(fromMarketplaces.every((i) => i.source === 'marketplace')).toBe(true)
    expect(await api.search({ kind: 'output-style' })).toEqual([])
  })

  it('serves repeat searches from the cache', async () => {
    const { calls } = stubFetch(...sources())
    const api = createExtensionsApi(t.ctx)
    await api.search({ query: 'pdf' })
    const fetches = calls.length
    const runs = mocks.run.mock.calls.length
    await api.search({ query: 'pdf' })
    expect(calls.length).toBe(fetches)
    // A new instance (e.g. the CLI) reads the disk cache; only sources that failed before are retried.
    await createExtensionsApi(t.ctx).search({ query: 'pdf' })
    const retried = calls.slice(fetches)
    expect(retried.length).toBeGreaterThan(0)
    const healthy = ['/anthropics/claude-plugins-official/', '/VoltAgent/', '/anthropics/skills/', 'aitmpl.com', 'skills.sh']
    expect(retried.filter((u) => healthy.some((h) => u.includes(h)))).toEqual([])
    expect(mocks.run.mock.calls.length).toBe(runs)
  })

  it('keeps working when a source fails', async () => {
    stubFetch(...sources({ aitmplStatus: 500 }))
    const items = await createExtensionsApi(t.ctx).search({ limit: 500 })
    expect(items.some((i) => i.kind === 'plugin')).toBe(true)
    expect(items.some((i) => i.source === 'aitmpl')).toBe(false)
  })

  it('works without Claude Code installed', async () => {
    mocks.cli.path = null
    stubFetch(...sources())
    const items = await createExtensionsApi(t.ctx).search({ kind: 'plugin', limit: 500 })
    expect(items.length).toBeGreaterThan(10)
    expect(items.every((i) => i.source === 'marketplace')).toBe(true)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('marks installed items and lists local ones', async () => {
    stubFetch(...sources())
    const agents = join(sb.home, '.claude', 'agents')
    await mkdir(agents, { recursive: true })
    await writeFile(join(agents, 'accessibility-tester.md'), '---\nname: accessibility-tester\ndescription: mine\n---\n')
    const api = createExtensionsApi(t.ctx)
    const items = await api.search({ kind: 'agent', query: 'accessibility' })
    const hit = items.find((i) => i.id.endsWith('/accessibility/accessibility-tester.md'))
    expect(hit).toMatchObject({ installed: true, installedPath: join(agents, 'accessibility-tester.md'), scope: 'user', enabled: true })
    const local = await api.search({ source: 'local', query: 'accessibility' })
    expect(local).toEqual([expect.objectContaining({ id: 'agent:local:user:accessibility-tester.md', installed: true })])
  })

  it('reports marketplace plugin counts from the cached listings', async () => {
    stubFetch(...sources())
    const api = createExtensionsApi(t.ctx)
    await api.search({ kind: 'plugin' })
    const list = await api.marketplaces()
    expect(list.find((m) => m.name === 'claude-plugins-official')?.pluginCount).toBe(6)
    expect(list.find((m) => m.name === 'voltagent-subagents')?.pluginCount).toBe(10)
    expect(list.find((m) => m.name === 'anthropic-plugin-directory')).toMatchObject({ added: true, pluginCount: 5 })
  })
})
