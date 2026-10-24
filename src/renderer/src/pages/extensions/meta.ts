/**
 * Pure helpers for the Extensions page: kind and source wording, scopes per kind, marketplace input validation and
 * client-side filtering. No React or DOM (unit-tested in Node).
 */
import type { ExtensionItem, ExtensionKind, ExtensionSource, Scope } from '@shared/types'

export interface KindMeta {
  label: string
  singular: string
  description: string
  /** Where this kind can be installed. */
  scopes: Scope[]
}

export const KIND_META: Record<ExtensionKind, KindMeta> = {
  plugin: {
    label: 'Plugins',
    singular: 'plugin',
    description: 'Bundles of skills, commands, agents and hooks — added in one step.',
    scopes: ['user', 'project', 'local']
  },
  skill: {
    label: 'Skills',
    singular: 'skill',
    description: 'Know-how Claude loads when a task needs it, like working with PDFs or spreadsheets.',
    scopes: ['user', 'project']
  },
  agent: {
    label: 'Agents',
    singular: 'agent',
    description: 'Specialists Claude can hand work to, like a code reviewer or a debugger.',
    scopes: ['user', 'project']
  },
  command: {
    label: 'Commands',
    singular: 'command',
    description: 'Shortcuts you type as /name in Claude Code.',
    scopes: ['user', 'project']
  },
  hook: {
    label: 'Hooks',
    singular: 'hook',
    description: 'Commands that run automatically at moments like “after every edit”.',
    scopes: ['user', 'project', 'local']
  },
  statusline: {
    label: 'Status lines',
    singular: 'status line',
    description: 'A custom info line at the bottom of Claude Code: model, folder, branch, context use.',
    scopes: ['user', 'project', 'local']
  },
  'output-style': {
    label: 'Output styles',
    singular: 'output style',
    description: 'Change how Claude Code writes its answers.',
    scopes: ['user', 'project']
  }
}

export const SCOPE_META: Record<Scope, { title: string; simple: string; description: string }> = {
  user: { title: 'User', simple: 'Everywhere', description: 'Works in every project on this computer.' },
  project: {
    title: 'Project',
    simple: 'One project (shared)',
    description: 'Saved in the project’s .claude folder, so your team gets it too.'
  },
  local: { title: 'Local', simple: 'One project (just me)', description: 'Only for you, in one project. Not shared with your team.' }
}

/** Short label for where an item comes from. */
export function sourceLabel(item: Pick<ExtensionItem, 'source' | 'marketplace'>): string {
  switch (item.source) {
    case 'claude-cli':
      if (item.marketplace === 'claude-plugins-official') return 'Official marketplace'
      if (item.marketplace === 'anthropic-plugin-directory') return 'Plugin directory'
      return item.marketplace ?? 'Claude Code'
    case 'marketplace':
      return item.marketplace ?? 'Marketplace'
    case 'skills.sh':
      return 'skills.sh'
    case 'aitmpl':
      return 'aitmpl.com'
    case 'anthropic-skills':
      return 'Anthropic skills'
    case 'local':
      return 'On this computer'
  }
}

/** Items from Anthropic's own marketplaces and skill repo get an "official" look. */
export function isOfficialSource(item: Pick<ExtensionItem, 'source' | 'marketplace'>): boolean {
  return (
    item.source === 'anthropic-skills' ||
    (item.source === 'claude-cli' &&
      (item.marketplace === 'claude-plugins-official' || item.marketplace === 'anthropic-plugin-directory')) ||
    (item.source === 'marketplace' && item.marketplace === 'anthropic-agent-skills')
  )
}

export const SOURCE_FILTERS: ReadonlyArray<{ value: ExtensionSource | ''; label: string }> = [
  { value: '', label: 'All sources' },
  { value: 'claude-cli', label: 'Claude Code marketplaces' },
  { value: 'marketplace', label: 'Other marketplaces' },
  { value: 'anthropic-skills', label: 'Anthropic skills' },
  { value: 'skills.sh', label: 'skills.sh' },
  { value: 'aitmpl', label: 'aitmpl.com' },
  { value: 'local', label: 'On this computer' }
]

/** Local text filter for the "Installed" view. */
export function matchesExtension(item: ExtensionItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = [item.name, item.description, item.author ?? '', item.category ?? '', item.marketplace ?? '', sourceLabel(item)]
    .join(' ')
    .toLowerCase()
  return words.every((w) => haystack.includes(w))
}

/** Kinds that run commands on the user's computer (installing them asks first). */
export function runsCommands(kind: ExtensionKind): boolean {
  return kind === 'hook' || kind === 'statusline'
}

/**
 * Validate a marketplace source typed by the user: "owner/repo", a GitHub URL, a git URL or a marketplace.json URL.
 * Returns the cleaned value, or an error message.
 */
export function parseMarketplaceSource(input: string): { value: string } | { error: string } {
  const raw = input.trim()
  if (!raw) return { error: 'Type a GitHub repository like “owner/repo”.' }
  const github = /^https?:\/\/(www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/i.exec(raw)
  if (github) return { value: `${github[2]}/${github[3]}` }
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return { value: raw.replace(/\.git$/i, '') }
  if (/^https?:\/\/\S+$/i.test(raw) || /^git@[\w.-]+:\S+$/.test(raw)) return { value: raw }
  return { error: 'Use a GitHub repository like “owner/repo”, or a full URL to a git repository or marketplace.json file.' }
}

/** GitHub page for an item, when known. */
export function itemUrl(item: Pick<ExtensionItem, 'url' | 'repo'>): string | undefined {
  if (item.url && /^https?:\/\//.test(item.url)) return item.url
  if (item.repo && /^[\w.-]+\/[\w.-]+$/.test(item.repo)) return `https://github.com/${item.repo}`
  return undefined
}
