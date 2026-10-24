import { describe, expect, it } from 'vitest'
import { dedupe, matchScore, rankItems } from '@core/extensions/catalog'
import { parseCliJson, pluginCommandEnv } from '@core/extensions/cli'
import { fmString, parseFrontmatter } from '@core/extensions/frontmatter'
import { catalogItemId, isSafeRelativePath, localItemId, parseId, pluginItemId } from '@core/extensions/ids'
import { cleanDescription, parseAitmplComponents, skillspectorWarnings } from '@core/extensions/sources/aitmpl'
import { anthropicSkillItem, skillPathsFromMarketplace } from '@core/extensions/sources/anthropicSkills'
import { parseAvailablePlugins, readInstallCounts } from '@core/extensions/sources/claudeCli'
import { parseGitHubRepo, parseMarketplaceJson, pluginSourceKey } from '@core/extensions/sources/marketplaces'
import { parseSkillsShResults } from '@core/extensions/sources/skillsSh'
import type { CatalogItem } from '@core/extensions/types'
import { join } from 'node:path'
import { FIXTURES, fixture } from './helpers'

describe('parseCliJson', () => {
  it('parses pretty-printed listings', () => {
    expect(parseCliJson('[\n  {\n    "name": "x"\n  }\n]\n')).toEqual([{ name: 'x' }])
  })
  it('takes the last JSON line after progress output', () => {
    const out = 'Cloning…\nDone\n{"command":"install","outcome":"ok","message":"Installed"}\n'
    expect(parseCliJson(out)).toEqual({ command: 'install', outcome: 'ok', message: 'Installed' })
  })
  it('finds a multi-line block that starts at column 0 after text', () => {
    expect(parseCliJson('warning: something\n{\n  "a": 1\n}')).toEqual({ a: 1 })
  })
  it('returns undefined for plain text', () => {
    expect(parseCliJson('✔ Anthropic Directory is on.')).toBeUndefined()
    expect(parseCliJson('')).toBeUndefined()
  })
})

describe('pluginCommandEnv', () => {
  it('adds core.longpaths on Windows and prefers HTTPS', () => {
    expect(pluginCommandEnv('win32', {})).toEqual({
      CLAUDE_CODE_PLUGIN_PREFER_HTTPS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.longpaths',
      GIT_CONFIG_VALUE_0: 'true'
    })
  })
  it('appends after existing GIT_CONFIG entries', () => {
    const env = pluginCommandEnv('win32', { GIT_CONFIG_COUNT: '2' })
    expect(env.GIT_CONFIG_COUNT).toBe('3')
    expect(env.GIT_CONFIG_KEY_2).toBe('core.longpaths')
    expect(env.GIT_CONFIG_VALUE_2).toBe('true')
  })
  it('does not touch git config elsewhere', () => {
    expect(pluginCommandEnv('linux', {})).toEqual({ CLAUDE_CODE_PLUGIN_PREFER_HTTPS: '1', GIT_TERMINAL_PROMPT: '0' })
  })
})

describe('ids', () => {
  it('round-trips every id family', () => {
    expect(parseId(pluginItemId('frontend-design', 'claude-plugins-official'))).toMatchObject({
      type: 'plugin',
      name: 'frontend-design',
      marketplace: 'claude-plugins-official',
      pluginId: 'frontend-design@claude-plugins-official'
    })
    expect(parseId('commit-commands@claude-plugins-official')).toMatchObject({ type: 'plugin', name: 'commit-commands' })
    const cat = catalogItemId('agent', 'aitmpl', 'davila7', 'claude-code-templates', 'cli-tool/components/agents/a/b.md')
    expect(parseId(cat)).toEqual({
      type: 'catalog',
      kind: 'agent',
      source: 'aitmpl',
      owner: 'davila7',
      repo: 'claude-code-templates',
      path: 'cli-tool/components/agents/a/b.md'
    })
    expect(parseId('skill:skills.sh:anthropics/skills/pdf')).toMatchObject({ type: 'catalog', source: 'skills.sh', path: 'pdf' })
    expect(parseId(localItemId('skill', 'user', 'pdf'))).toEqual({ type: 'local', kind: 'skill', scope: 'user', key: 'pdf' })
    const project = 'C:\\Users\\me\\My Project'
    const local = localItemId('agent', 'project', 'nested/reviewer.md', project)
    expect(parseId(local)).toEqual({ type: 'local', kind: 'agent', scope: 'project', projectPath: project, key: 'nested/reviewer.md' })
    expect(parseId(localItemId('hook', 'local', 'rec-ab12cd34', '/home/me/p'))).toMatchObject({ scope: 'local', key: 'rec-ab12cd34' })
  })
  it('rejects malformed and unsafe ids', () => {
    expect(parseId('')).toBeNull()
    expect(parseId('widget:aitmpl:a/b/c.md')).toBeNull()
    expect(parseId('agent:aitmpl:a/b/../../etc/passwd')).toBeNull()
    expect(parseId('agent:unknown-source:a/b/c.md')).toBeNull()
    expect(parseId('skill:local:user:../x')).toBeNull()
    expect(parseId('plugin:bad name@m')).toBeNull()
    expect(parseId('hook:local:user:rec-XYZ')).toBeNull()
    expect(isSafeRelativePath('a\\b')).toBe(false)
    expect(isSafeRelativePath('C:/x')).toBe(false)
    expect(isSafeRelativePath('skills/pdf/SKILL.md')).toBe(true)
  })
})

describe('frontmatter', () => {
  it('parses a valid header', () => {
    const fm = parseFrontmatter('---\nname: pdf\ndescription: "Work with PDFs: merge, split"\n---\n# Body\n')
    expect(fm.present).toBe(true)
    expect(fm.error).toBeUndefined()
    expect(fmString(fm.data, 'name')).toBe('pdf')
    expect(fmString(fm.data, 'description')).toBe('Work with PDFs: merge, split')
    expect(fm.body).toBe('# Body\n')
  })
  it('falls back to a forgiving reader for invalid YAML and reports the error', () => {
    const fm = parseFrontmatter('\uFEFF---\r\nname: reviewer\r\ndescription: Use when: reviewing code: carefully\r\n---\r\nbody')
    expect(fm.present).toBe(true)
    expect(fm.error).toBeTruthy()
    expect(fm.data.name).toBe('reviewer')
    expect(fm.data.description).toBe('Use when: reviewing code: carefully')
  })
  it('handles missing and empty headers', () => {
    expect(parseFrontmatter('# Just markdown').present).toBe(false)
    const empty = parseFrontmatter('---\n---\nbody')
    expect(empty.present).toBe(true)
    expect(empty.data).toEqual({})
    expect(empty.body).toBe('body')
  })
})

describe('claude plugin list --available parser', () => {
  const repos = { 'claude-plugins-official': 'anthropics/claude-plugins-official' }
  const items = parseAvailablePlugins(fixture('cli-available.json'), repos)

  it('normalizes every entry', () => {
    expect(items).toHaveLength(9)
    const dir = items.find((i) => i.id === 'plugin:frontend-design@anthropic-plugin-directory') as CatalogItem
    expect(dir).toMatchObject({ kind: 'plugin', source: 'claude-cli', marketplace: 'anthropic-plugin-directory', installed: false })
    expect(dir.url).toBe('https://github.com/anthropics/claude-plugins-official/tree/HEAD/plugins/frontend-design')
    const official = items.find((i) => i.id === 'plugin:agent-sdk-dev@claude-plugins-official') as CatalogItem
    expect(official.installs).toBeGreaterThan(0)
    expect(official.repo).toBe('anthropics/claude-plugins-official')
  })

  it('computes the same source key for the official entry and its directory copy', () => {
    const a = items.find((i) => i.id === 'plugin:frontend-design@anthropic-plugin-directory')
    const b = items.find((i) => i.id === 'plugin:frontend-design@claude-plugins-official')
    expect(a?.sourceKey).toBe('github.com/anthropics/claude-plugins-official#plugins/frontend-design')
    expect(b?.sourceKey).toBe(a?.sourceKey)
  })
})

describe('marketplace.json parser', () => {
  it('parses the official marketplace', () => {
    const m = parseMarketplaceJson(fixture('marketplace-official.json'), 'anthropics/claude-plugins-official')
    expect(m.name).toBe('claude-plugins-official')
    expect(m.plugins.map((p) => p.name).sort()).toEqual(
      ['42crunch-api-security-testing', 'agent-sdk-dev', 'agentforce-adlc', 'clangd-lsp', 'commit-commands', 'frontend-design'].sort()
    )
    const crunch = m.plugins.find((p) => p.name === '42crunch-api-security-testing') as CatalogItem
    expect(crunch).toMatchObject({ id: 'plugin:42crunch-api-security-testing@claude-plugins-official', source: 'marketplace', category: 'security', trusted: true })
    expect(crunch.sourceKey).toBe('github.com/42crunch-ai/claude-plugins#plugins/api-security-testing')
    expect(crunch.url).toBe('https://42crunch.com')
  })
  it('parses a community marketplace', () => {
    const m = parseMarketplaceJson(fixture('marketplace-voltagent.json'), 'VoltAgent/awesome-claude-code-subagents')
    expect(m.name).toBe('voltagent-subagents')
    expect(m.plugins).toHaveLength(10)
    expect(m.plugins[0].trusted).toBe(false)
    expect(m.plugins[0].sourceKey).toBe('github.com/voltagent/awesome-claude-code-subagents#categories/01-core-development')
  })
  it('rejects documents that are not marketplaces', () => {
    expect(() => parseMarketplaceJson({ hello: 'world' }, 'a/b')).toThrow()
  })
  it('normalizes plugin sources', () => {
    expect(pluginSourceKey({ source: 'url', url: 'https://github.com/obra/superpowers.git' })).toBe('github.com/obra/superpowers#')
    expect(pluginSourceKey('./', 'anthropics/skills')).toBe('github.com/anthropics/skills#')
    expect(pluginSourceKey({ source: 'npm', package: '@o/x' })).toBe('npm:@o/x')
    expect(parseGitHubRepo('git@github.com:Owner/Repo.git')).toEqual({ owner: 'Owner', repo: 'Repo' })
    expect(parseGitHubRepo('./local')).toBeNull()
  })
})

describe('anthropics/skills', () => {
  it('lists the skill folders from its marketplace.json', () => {
    const entries = skillPathsFromMarketplace(fixture('marketplace-skills.json'))
    expect(entries).toHaveLength(19)
    expect(entries[0]).toMatchObject({ path: 'skills/xlsx', group: 'document-skills' })
    const item = anthropicSkillItem(entries[0], { name: 'xlsx', description: 'Spreadsheets' })
    expect(item).toMatchObject({ id: 'skill:anthropic-skills:anthropics/skills/skills/xlsx', name: 'xlsx', author: 'Anthropic', source: 'anthropic-skills' })
  })
})

describe('skills.sh parser', () => {
  it('turns search hits into skill items', () => {
    const items = parseSkillsShResults(fixture('skillssh-pdf.json'))
    expect(items).toHaveLength(5)
    expect(items[0]).toMatchObject({
      id: 'skill:skills.sh:anthropics/skills/pdf',
      name: 'pdf',
      installs: 215790,
      repo: 'anthropics/skills',
      url: 'https://skills.sh/anthropics/skills/pdf',
      dedupeKey: 'anthropics/skills:pdf'
    })
  })
})

describe('aitmpl parser', () => {
  const items = parseAitmplComponents(fixture('aitmpl-components.json'))
  it('keeps agents, commands, hooks, status lines and skills', () => {
    const count = (k: string) => items.filter((i) => i.kind === k).length
    expect(count('agent')).toBe(3)
    expect(count('command')).toBe(2)
    expect(count('hook')).toBe(2)
    expect(count('statusline')).toBe(2)
    expect(count('skill')).toBe(2)
    expect(items.some((i) => i.name === 'bedrock-configuration')).toBe(false)
  })
  it('builds raw-file ids and clean descriptions', () => {
    const agent = items.find((i) => i.id === 'agent:aitmpl:davila7/claude-code-templates/cli-tool/components/agents/accessibility/accessibility-tester.md')
    expect(agent).toBeDefined()
    expect(agent?.description).not.toContain('<example>')
    expect(agent?.description.length).toBeLessThanOrEqual(420)
    const status = items.find((i) => i.kind === 'statusline' && i.name === 'context-monitor')
    expect(status?.path).toBe('cli-tool/components/settings/statusline/context-monitor.json')
  })
  it('turns security scan results into warnings', () => {
    const risky = items.find((i) => i.name === 'agents-autogpt')
    expect(risky?.warnings?.[0]).toMatch(/advises NOT installing/)
    const hook = items.find((i) => i.kind === 'hook')
    expect(hook?.warnings?.[0]).toMatch(/run commands on your computer/)
    expect(skillspectorWarnings({ recommendation: 'SAFE', severity: 'LOW', findings: [] })).toEqual([])
    expect(skillspectorWarnings({ recommendation: 'CAUTION', severity: 'LOW', findings: [] })[0]).toMatch(/partly/)
    expect(cleanDescription('Short intro text that is long enough to keep.\n\n<example>x</example>')).toBe('Short intro text that is long enough to keep.')
  })
})

describe('dedupe and ranking', () => {
  const cli = parseAvailablePlugins(fixture('cli-available.json'), { 'claude-plugins-official': 'anthropics/claude-plugins-official' })
  const official = parseMarketplaceJson(fixture('marketplace-official.json'), 'anthropics/claude-plugins-official').plugins
  const skillsMkt = parseMarketplaceJson(fixture('marketplace-skills.json'), 'anthropics/skills').plugins
  const merged = dedupe([...cli, ...official, ...skillsMkt])

  it('collapses the same plugin across the official marketplace, the directory and other marketplaces', () => {
    const fd = merged.filter((i) => i.name === 'frontend-design')
    expect(fd).toHaveLength(1)
    expect(fd[0].id).toBe('plugin:frontend-design@claude-plugins-official')
    expect(fd[0].aliases).toContain('plugin:frontend-design@anthropic-plugin-directory')
    const docs = merged.filter((i) => i.name === 'document-skills')
    expect(docs).toHaveLength(1)
    expect(docs[0].id).toBe('plugin:document-skills@anthropic-plugin-directory')
    expect(docs[0].aliases).toContain('plugin:document-skills@anthropic-agent-skills')
    // example-skills shares the "./" source with document-skills but is a different plugin
    expect(merged.some((i) => i.id === 'plugin:example-skills@anthropic-agent-skills')).toBe(true)
  })

  it('merges skills from different sources and keeps install counts', () => {
    const anthropic = anthropicSkillItem({ path: 'skills/pdf', group: 'document-skills' }, { name: 'pdf', description: 'PDF toolkit' })
    const sh = parseSkillsShResults(fixture('skillssh-pdf.json'))
    const skills = dedupe([...sh, anthropic])
    const pdf = skills.filter((i) => i.name === 'pdf')
    expect(pdf).toHaveLength(1)
    expect(pdf[0]).toMatchObject({ id: 'skill:anthropic-skills:anthropics/skills/skills/pdf', installs: 215790, description: 'PDF toolkit' })
    const ranked = rankItems(skills, { query: 'pdf' })
    expect(ranked[0].id).toBe('skill:anthropic-skills:anthropics/skills/skills/pdf')
  })

  it('requires every query word to match and filters by kind', () => {
    const item = merged.find((i) => i.name === 'frontend-design') as CatalogItem
    expect(matchScore(item, ['frontend'], 'frontend')).toBeGreaterThan(0)
    expect(matchScore(item, ['frontend', 'zzzz'], 'frontend zzzz')).toBeNull()
    expect(rankItems(merged, { kind: 'skill' })).toHaveLength(0)
    expect(rankItems(merged, { query: 'frontend design' })[0].name).toBe('frontend-design')
  })
})

describe('install counts from Claude Code’s catalog cache', () => {
  it('reads unique_installs keyed by plugin id', async () => {
    const counts = await readInstallCounts(join(FIXTURES, 'plugin-catalog-cache.json'))
    expect(counts.get('frontend-design@claude-plugins-official')).toBeGreaterThan(1000)
    expect((await readInstallCounts(join(FIXTURES, 'missing.json'))).size).toBe(0)
  })
})
