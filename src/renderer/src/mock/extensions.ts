/**
 * Mock: ExtensionsApi — plugins, skills, subagents, commands, hooks, status lines and output styles from
 * the official marketplace, anthropics/skills, skills.sh and aitmpl.com (names from research_skills.md).
 */
import type { ExtensionsApi } from '@shared/api'
import type { ClaudeMdTemplate, ExtensionItem, Marketplace, OpResult } from '@shared/types'
import { recordBackup } from './misc'
import { env, homePath, log, sleep, clone } from './runtime'

const pluginsDir = (): string => homePath('.claude', 'plugins', 'cache')

let itemsState: ExtensionItem[] | null = null

/** Built lazily so paths follow the configured fake OS. */
function items(): ExtensionItem[] {
  itemsState ??= [
    {
      id: 'commit-commands@claude-plugins-official',
      kind: 'plugin',
      name: 'commit-commands',
      description: 'Git commit workflows: /commit, /commit-push-pr and /clean_gone.',
      author: 'Anthropic',
      source: 'claude-cli',
      marketplace: 'claude-plugins-official',
      repo: 'anthropics/claude-plugins-official',
      category: 'productivity',
      installs: 412_300,
      installed: true,
      installedPath: [pluginsDir(), 'claude-plugins-official', 'commit-commands', '58267944f921'].join(env.sep),
      scope: 'user',
      enabled: true
    },
    {
      id: 'frontend-design@claude-plugins-official',
      kind: 'plugin',
      name: 'frontend-design',
      description: 'Create distinctive, production-grade interfaces that avoid generic AI aesthetics.',
      author: 'Anthropic',
      source: 'claude-cli',
      marketplace: 'claude-plugins-official',
      repo: 'anthropics/claude-plugins-official',
      category: 'design',
      installs: 617_078,
      installed: false
    },
    {
      id: 'feature-dev@claude-plugins-official',
      kind: 'plugin',
      name: 'feature-dev',
      description: 'A guided feature workflow with agents for exploring code, designing the architecture and reviewing.',
      author: 'Anthropic',
      source: 'claude-cli',
      marketplace: 'claude-plugins-official',
      repo: 'anthropics/claude-plugins-official',
      category: 'development',
      installs: 298_410,
      installed: false
    },
    {
      id: 'code-review@claude-plugins-official',
      kind: 'plugin',
      name: 'code-review',
      description: 'Automated pull request reviews with several specialized agents and confidence scoring.',
      author: 'Anthropic',
      source: 'claude-cli',
      marketplace: 'claude-plugins-official',
      repo: 'anthropics/claude-plugins-official',
      category: 'development',
      installs: 251_960,
      installed: false
    },
    {
      id: 'superpowers@claude-plugins-official',
      kind: 'plugin',
      name: 'superpowers',
      description: 'A skills library for test-driven development, systematic debugging and planning.',
      author: 'Jesse Vincent',
      source: 'claude-cli',
      marketplace: 'claude-plugins-official',
      repo: 'obra/superpowers',
      category: 'development',
      installs: 389_120,
      stars: 304_000,
      installed: false
    },
    {
      id: 'explanatory-output-style@claude-plugins-official',
      kind: 'plugin',
      name: 'explanatory-output-style',
      description: 'Claude explains the choices it makes and the codebase patterns it notices as it works.',
      author: 'Anthropic',
      source: 'claude-cli',
      marketplace: 'claude-plugins-official',
      category: 'learning',
      installs: 120_440,
      installed: true,
      installedPath: [pluginsDir(), 'claude-plugins-official', 'explanatory-output-style', '1.0.0'].join(env.sep),
      scope: 'user',
      enabled: false
    },
    {
      id: 'security-guidance@claude-plugins-official',
      kind: 'plugin',
      name: 'security-guidance',
      description: 'Warns about risky patterns (command injection, XSS, unsafe deserialization) while Claude edits files.',
      author: 'Anthropic',
      source: 'claude-cli',
      marketplace: 'claude-plugins-official',
      category: 'security',
      installs: 176_005,
      installed: false
    },
    {
      id: 'document-skills@anthropic-agent-skills',
      kind: 'plugin',
      name: 'document-skills',
      description: 'Work with Excel, Word, PowerPoint and PDF files.',
      author: 'Anthropic',
      source: 'marketplace',
      marketplace: 'anthropic-agent-skills',
      repo: 'anthropics/skills',
      category: 'documents',
      installs: 93_200,
      installed: false
    },
    {
      id: 'skill:anthropic-skills:pdf',
      kind: 'skill',
      name: 'pdf',
      description: 'Extract text and tables, fill in forms, and merge or split PDF files.',
      author: 'anthropics',
      source: 'anthropic-skills',
      repo: 'anthropics/skills',
      path: 'skills/pdf',
      url: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
      category: 'documents',
      installs: 215_790,
      stars: 183_000,
      installed: false
    },
    {
      id: 'skill:anthropic-skills:mcp-builder',
      kind: 'skill',
      name: 'mcp-builder',
      description: 'Guide for creating high-quality MCP servers in Python (FastMCP) or TypeScript.',
      author: 'anthropics',
      source: 'anthropic-skills',
      repo: 'anthropics/skills',
      path: 'skills/mcp-builder',
      category: 'development',
      installs: 61_480,
      installed: false
    },
    {
      id: 'skill:anthropic-skills:skill-creator',
      kind: 'skill',
      name: 'skill-creator',
      description: 'Create, improve and test your own skills.',
      author: 'anthropics',
      source: 'anthropic-skills',
      repo: 'anthropics/skills',
      path: 'skills/skill-creator',
      category: 'meta',
      installs: 88_012,
      installed: true,
      installedPath: homePath('.claude', 'skills', 'skill-creator'),
      scope: 'user',
      enabled: true
    },
    {
      id: 'skill:anthropic-skills:webapp-testing',
      kind: 'skill',
      name: 'webapp-testing',
      description: 'Test local web apps with Playwright: screenshots, logs and UI checks.',
      author: 'anthropics',
      source: 'anthropic-skills',
      repo: 'anthropics/skills',
      path: 'skills/webapp-testing',
      category: 'testing',
      installs: 44_930,
      installed: false
    },
    {
      id: 'skill:skills.sh:obra/superpowers/test-driven-development',
      kind: 'skill',
      name: 'test-driven-development',
      description: 'Write the test first, watch it fail, then write just enough code to pass.',
      author: 'obra',
      source: 'skills.sh',
      repo: 'obra/superpowers',
      path: 'skills/test-driven-development',
      url: 'https://skills.sh/obra/superpowers/test-driven-development',
      category: 'development',
      installs: 48_210,
      installed: false
    },
    {
      id: 'agent:aitmpl:code-reviewer',
      kind: 'agent',
      name: 'code-reviewer',
      description: 'Reviews changes for bugs, security issues and maintainability before you commit.',
      author: 'davila7',
      source: 'aitmpl',
      repo: 'davila7/claude-code-templates',
      path: 'cli-tool/components/agents/development-tools/code-reviewer.md',
      category: 'development-tools',
      installs: 39_400,
      installed: true,
      installedPath: homePath('.claude', 'agents', 'code-reviewer.md'),
      scope: 'user',
      enabled: true
    },
    {
      id: 'agent:aitmpl:accessibility-tester',
      kind: 'agent',
      name: 'accessibility-tester',
      description: 'Audits interfaces against WCAG and suggests concrete fixes.',
      author: 'davila7',
      source: 'aitmpl',
      repo: 'davila7/claude-code-templates',
      path: 'cli-tool/components/agents/accessibility/accessibility-tester.md',
      category: 'accessibility',
      installs: 12_870,
      installed: false
    },
    {
      id: 'agent:aitmpl:debugger',
      kind: 'agent',
      name: 'debugger',
      description: 'Finds the root cause of errors and test failures, then proposes a minimal fix.',
      author: 'davila7',
      source: 'aitmpl',
      repo: 'davila7/claude-code-templates',
      category: 'development-tools',
      installs: 27_350,
      installed: false
    },
    {
      id: 'command:aitmpl:generate-tests',
      kind: 'command',
      name: 'generate-tests',
      description: 'Adds a /generate-tests command that writes unit tests for the selected code.',
      author: 'davila7',
      source: 'aitmpl',
      repo: 'davila7/claude-code-templates',
      category: 'testing',
      installs: 18_600,
      installed: false
    },
    {
      id: 'command:local:deploy',
      kind: 'command',
      name: 'deploy',
      description: 'Project command: build and deploy the preview environment.',
      source: 'local',
      installed: true,
      installedPath: [homePath('Projects', 'acme-web'), '.claude', 'commands', 'deploy.md'].join(env.sep),
      scope: 'project',
      enabled: true
    },
    {
      id: 'hook:aitmpl:notify-when-done',
      kind: 'hook',
      name: 'notify-when-done',
      description: 'Shows a desktop notification when Claude finishes or needs your input.',
      author: 'davila7',
      source: 'aitmpl',
      category: 'automation',
      installs: 9_840,
      installed: false
    },
    {
      id: 'hook:aitmpl:format-on-edit',
      kind: 'hook',
      name: 'format-on-edit',
      description: 'Runs Prettier on every file Claude edits.',
      author: 'davila7',
      source: 'aitmpl',
      category: 'automation',
      installs: 14_120,
      installed: false,
      warnings: ['Runs a shell command after every edit.']
    },
    {
      id: 'statusline:aitmpl:context-usage',
      kind: 'statusline',
      name: 'context-usage',
      description: 'Status line with the model, folder, git branch and how full the context window is.',
      author: 'davila7',
      source: 'aitmpl',
      category: 'statusline',
      installs: 21_300,
      installed: false
    },
    {
      id: 'output-style:aitmpl:concise',
      kind: 'output-style',
      name: 'concise',
      description: 'Short, direct answers with minimal explanation.',
      author: 'davila7',
      source: 'aitmpl',
      category: 'style',
      installs: 6_420,
      installed: false
    }
  ]
  return itemsState
}

let marketplaces: Marketplace[] = [
  {
    name: 'claude-plugins-official',
    source: 'github',
    repo: 'anthropics/claude-plugins-official',
    pluginCount: 315,
    added: true,
    official: true,
    description: 'Anthropic’s official plugin directory.'
  },
  {
    name: 'anthropic-agent-skills',
    source: 'github',
    repo: 'anthropics/skills',
    pluginCount: 5,
    added: false,
    official: true,
    description: 'Example skills from Anthropic: documents, design, testing and more.'
  },
  {
    name: 'claude-community',
    source: 'github',
    repo: 'anthropics/claude-plugins-community',
    pluginCount: 2_283,
    added: false,
    official: true,
    description: 'Community plugins listed in the Claude plugin directory.'
  },
  {
    name: 'claude-code-workflows',
    source: 'github',
    repo: 'wshobson/agents',
    pluginCount: 94,
    added: false,
    description: 'Workflow plugins and subagents for many languages and stacks.'
  },
  {
    name: 'superpowers-marketplace',
    source: 'github',
    repo: 'obra/superpowers-marketplace',
    pluginCount: 10,
    added: false,
    description: 'The Superpowers skills framework and companions.'
  }
]

const TEMPLATES: ClaudeMdTemplate[] = [
  {
    id: 'general',
    name: 'Friendly assistant',
    description: 'Plain-language explanations, small safe changes, ask before big edits.',
    content: [
      '# How to work with me',
      '',
      '- Explain what you are about to do in plain words before doing it.',
      '- Prefer small, safe changes and show me what changed.',
      '- Ask before deleting files or running commands that change my system.',
      ''
    ].join('\n')
  },
  {
    id: 'web-app',
    name: 'Web app project',
    description: 'Conventions for a TypeScript web app: tests, linting and commits.',
    content: [
      '# Project guide',
      '',
      '## Commands',
      '- `npm run dev` — start the dev server',
      '- `npm test` — run the tests',
      '',
      '## Conventions',
      '- TypeScript strict mode; no `any`.',
      '- Write a test for every bug fix.',
      '- Keep commits small with clear messages.',
      ''
    ].join('\n')
  },
  {
    id: 'python',
    name: 'Python project',
    description: 'uv-based workflow, type hints, pytest and ruff.',
    content: [
      '# Project guide',
      '',
      '## Commands',
      '- `uv run pytest` — run tests',
      '- `uv run ruff check .` — lint',
      '',
      '## Conventions',
      '- Type hints everywhere.',
      '- Prefer the standard library; ask before adding dependencies.',
      ''
    ].join('\n')
  }
]

function itemLabel(item: ExtensionItem): string {
  return item.kind === 'plugin' ? `the ${item.name} plugin` : `“${item.name}”`
}

export const extensionsApi: ExtensionsApi = {
  async search(query) {
    await sleep(250)
    const words = (query.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const result = items()
      .filter((i) => !query.kind || i.kind === query.kind)
      .filter((i) => !query.source || i.source === query.source)
      .filter((i) => {
        const haystack = [i.name, i.description, i.author ?? '', i.category ?? '', i.marketplace ?? ''].join(' ').toLowerCase()
        return words.every((w) => haystack.includes(w))
      })
      .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0))
    return clone(result.slice(0, Math.max(1, query.limit ?? 50)))
  },

  async installed(kind) {
    return clone(items().filter((i) => i.installed && (!kind || i.kind === kind)))
  },

  async install(id, opts): Promise<OpResult> {
    const item = items().find((i) => i.id === id)
    if (!item) return { ok: false, message: 'That extension is no longer available.' }
    if (item.installed) return { ok: true, message: `${capitalize(itemLabel(item))} is already installed.` }
    await sleep(item.kind === 'plugin' ? 1400 : 700)
    const scope = opts?.scope ?? 'user'
    const base = scope === 'user' ? homePath('.claude') : [opts?.projectPath ?? homePath('Projects', 'acme-web'), '.claude'].join(env.sep)
    const folder: Record<ExtensionItem['kind'], string> = {
      plugin: 'plugins',
      skill: 'skills',
      agent: 'agents',
      command: 'commands',
      hook: 'settings.json',
      statusline: 'settings.json',
      'output-style': 'output-styles'
    }
    const installedPath = item.kind === 'hook' || item.kind === 'statusline' ? [base, 'settings.json'].join(env.sep) : [base, folder[item.kind], item.name].join(env.sep)
    const backupId = item.kind === 'hook' || item.kind === 'statusline' ? recordBackup(`Add ${itemLabel(item)}`, [installedPath]) : undefined
    itemsState = items().map((i) => (i.id === id ? { ...i, installed: true, enabled: true, scope, installedPath } : i))
    log('info', 'extensions', `Installed ${item.id}`)
    return { ok: true, message: `Installed ${itemLabel(item)}. Start a new Claude Code session to use it.`, backupId }
  },

  async uninstall(id): Promise<OpResult> {
    const item = items().find((i) => i.id === id)
    if (!item?.installed) return { ok: false, message: 'That extension isn’t installed.' }
    await sleep(600)
    itemsState = items().map((i) => (i.id === id ? { ...i, installed: false, enabled: undefined, installedPath: undefined, scope: undefined } : i))
    return { ok: true, message: `Removed ${itemLabel(item)}.` }
  },

  async setEnabled(id, enabled): Promise<OpResult> {
    const item = items().find((i) => i.id === id)
    if (!item?.installed) return { ok: false, message: 'That extension isn’t installed.' }
    await sleep(250)
    itemsState = items().map((i) => (i.id === id ? { ...i, enabled } : i))
    return { ok: true, message: `${capitalize(itemLabel(item))} is ${enabled ? 'on' : 'off'}.` }
  },

  async marketplaces() {
    return clone(marketplaces)
  },

  async addMarketplace(source): Promise<OpResult> {
    const trimmed = source.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(trimmed) && !/^https?:\/\//.test(trimmed)) {
      return { ok: false, message: 'Enter a GitHub repository like “owner/repo” or a URL to a marketplace.json file.' }
    }
    await sleep(1500)
    const existing = marketplaces.find((m) => m.repo === trimmed || m.name === trimmed)
    if (existing?.added) return { ok: true, message: `${existing.name} is already added.` }
    if (existing) {
      marketplaces = marketplaces.map((m) => (m === existing ? { ...m, added: true } : m))
      return { ok: true, message: `Added ${existing.name}.` }
    }
    const name = trimmed.split('/').pop() ?? trimmed
    marketplaces = [...marketplaces, { name, source: 'github', repo: trimmed, pluginCount: 12, added: true, description: `Plugins from ${trimmed}.` }]
    return { ok: true, message: `Added ${name}.` }
  },

  async removeMarketplace(name): Promise<OpResult> {
    const existing = marketplaces.find((m) => m.name === name)
    if (!existing?.added) return { ok: false, message: 'That marketplace isn’t added.' }
    await sleep(500)
    marketplaces = marketplaces.map((m) => (m.name === name ? { ...m, added: false } : m))
    return { ok: true, message: `Removed ${name}. Plugins from it were uninstalled.` }
  },

  async refresh(): Promise<OpResult> {
    await sleep(900)
    log('info', 'extensions', 'Extension catalogs refreshed')
    return { ok: true, message: 'Extension lists are up to date.' }
  },

  async claudeMdTemplates() {
    return clone(TEMPLATES)
  },

  async writeClaudeMd(templateId, where, replace): Promise<OpResult> {
    const template = TEMPLATES.find((t) => t.id === templateId)
    if (!template) return { ok: false, message: 'Unknown template.' }
    await sleep(400)
    const path = where.scope === 'user' ? homePath('.claude', 'CLAUDE.md') : [where.projectPath, 'CLAUDE.md'].join(env.sep)
    const backupId = recordBackup(`${replace ? 'Replace' : 'Update'} CLAUDE.md`, [path])
    return { ok: true, message: `${replace ? 'Wrote' : 'Added to'} ${path}.`, backupId }
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
