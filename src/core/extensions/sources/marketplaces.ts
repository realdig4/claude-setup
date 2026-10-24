/**
 * Plugin marketplaces: the curated suggestion list and raw marketplace.json parsing
 * (<repo>/.claude-plugin/marketplace.json, fetched from raw.githubusercontent.com).
 * Marketplace names were verified against each repository's marketplace.json (2026-10-23).
 */
import { isPlainObject } from '../../fs/json'
import { PLUGIN_DIRECTORY } from '../cli'
import { fetchRepoText, githubTreeUrl } from '../github'
import { PLUGIN_NAME_RE, pluginItemId } from '../ids'
import type { CatalogItem } from '../types'
import { clip } from '../util'

export interface CuratedMarketplace {
  /** Marketplace name as declared in its marketplace.json (the part after "@" in plugin ids). */
  name: string
  /** GitHub "owner/repo" (what `claude plugin marketplace add` takes). */
  repo: string
  description: string
  /** Run by Anthropic. */
  official?: boolean
}

export const OFFICIAL_MARKETPLACE = 'claude-plugins-official'

/** Marketplaces suggested in the app, in display order. */
export const CURATED_MARKETPLACES: readonly CuratedMarketplace[] = [
  {
    name: OFFICIAL_MARKETPLACE,
    repo: 'anthropics/claude-plugins-official',
    official: true,
    description: "Anthropic's official marketplace: popular tools, integrations and workflows, reviewed by Anthropic."
  },
  {
    name: 'claude-community',
    repo: 'anthropics/claude-plugins-community',
    description: "Community plugins submitted to Anthropic's plugin directory (a large, read-only mirror)."
  },
  {
    name: 'anthropic-agent-skills',
    repo: 'anthropics/skills',
    official: true,
    description: "Anthropic's Agent Skills: Word, Excel, PowerPoint and PDF tools plus design, writing and developer skills."
  },
  {
    name: 'claude-code-plugins',
    repo: 'anthropics/claude-code',
    official: true,
    description: 'Demo plugins from the Claude Code repository: PR review toolkit, commit workflows and Agent SDK tools.'
  },
  {
    name: 'knowledge-work-plugins',
    repo: 'anthropics/knowledge-work-plugins',
    official: true,
    description: 'Plugins for knowledge work (sales, finance, design, legal and more), made mainly for Claude Cowork.'
  },
  {
    name: 'claude-code-workflows',
    repo: 'wshobson/agents',
    description: 'A big collection of workflow plugins with specialist agents, skills and slash commands.'
  },
  {
    name: 'voltagent-subagents',
    repo: 'VoltAgent/awesome-claude-code-subagents',
    description: '150+ specialist subagents grouped into plugins: languages, infrastructure, QA and security, data and AI, and more.'
  },
  {
    name: 'superpowers-marketplace',
    repo: 'obra/superpowers-marketplace',
    description: 'Superpowers: battle-tested skills for test-driven development, debugging, planning and collaboration.'
  },
  {
    name: 'claude-code-plugins-plus',
    repo: 'jeremylongshore/claude-code-plugins-plus-skills',
    description: 'A large community marketplace with hundreds of plugins and skills across many categories.'
  },
  {
    name: 'cc-marketplace',
    repo: 'ananddtyagi/claude-code-marketplace',
    description: 'Community-driven marketplace of Claude Code commands and plugins.'
  },
  {
    name: 'compound-engineering-plugin',
    repo: 'EveryInc/compound-engineering-plugin',
    description: 'Compound Engineering by Every: brainstorm, plan, review and capture learnings with AI agents.'
  }
]

/** Description of the built-in directory marketplace. */
export const DIRECTORY_DESCRIPTION =
  "Anthropic's plugin directory, built into Claude Code: thousands of reviewed plugins that install without adding a marketplace."

/** Marketplaces that are views of Anthropic's directory: the same plugin name means the same plugin. */
export const DIRECTORY_FAMILY: ReadonlySet<string> = new Set([OFFICIAL_MARKETPLACE, PLUGIN_DIRECTORY, 'claude-community'])

/** Marketplaces whose contents are published or reviewed by Anthropic. */
export const TRUSTED_MARKETPLACES: ReadonlySet<string> = new Set([
  PLUGIN_DIRECTORY,
  ...CURATED_MARKETPLACES.filter((m) => m.official).map((m) => m.name)
])

/** Curated entry by marketplace name. */
export function curatedMarketplace(name: string): CuratedMarketplace | undefined {
  return CURATED_MARKETPLACES.find((m) => m.name === name)
}

/** Parse "owner/repo", https://github.com/owner/repo(.git) or git@github.com:owner/repo.git. */
export function parseGitHubRepo(value: string): { owner: string; repo: string } | null {
  const v = value.trim()
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(v)
  if (short && !v.includes(':') && !/^\.+$/.test(short[1]) && !/^\.+$/.test(short[2])) return { owner: short[1], repo: short[2] }
  const m = /^(?:https?:\/\/(?:www\.)?|git@|ssh:\/\/git@)github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(v)
  return m ? { owner: m[1], repo: m[2] } : null
}

function cleanSubPath(p: unknown): string {
  return typeof p === 'string' ? p.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/^\/+|\/+$/g, '') : ''
}

/** Location of a plugin's files, normalized: "github.com/<owner>/<repo>#<path>" (lowercase owner/repo). */
export function pluginSourceKey(source: unknown, marketplaceRepo?: string, pluginRoot?: string): string | undefined {
  const gh = (owner: string, repo: string, path: string) => `github.com/${owner.toLowerCase()}/${repo.toLowerCase()}#${path}`
  if (typeof source === 'string') {
    if (!marketplaceRepo) return undefined
    const m = parseGitHubRepo(marketplaceRepo)
    if (!m) return undefined
    const rel = source.startsWith('.') ? cleanSubPath(source) : cleanSubPath([cleanSubPath(pluginRoot), source].filter(Boolean).join('/'))
    return gh(m.owner, m.repo, rel)
  }
  if (!isPlainObject(source)) return undefined
  const path = cleanSubPath(source.path)
  if (source.source === 'github' && typeof source.repo === 'string') {
    const m = parseGitHubRepo(source.repo)
    return m ? gh(m.owner, m.repo, path) : undefined
  }
  if ((source.source === 'url' || source.source === 'git' || source.source === 'git-subdir') && typeof source.url === 'string') {
    const m = parseGitHubRepo(source.url)
    if (m) return gh(m.owner, m.repo, path)
    try {
      const u = new URL(source.url)
      return `${u.host.toLowerCase()}${u.pathname.replace(/\.git$/, '').toLowerCase()}#${path}`
    } catch {
      return undefined
    }
  }
  if (source.source === 'npm' && typeof source.package === 'string') return `npm:${source.package}`
  return undefined
}

/** GitHub "owner/repo" and a browser URL for a plugin source, when it lives on GitHub. */
export function pluginSourceLinks(source: unknown, marketplaceRepo?: string, pluginRoot?: string): { repo?: string; url?: string } {
  const key = pluginSourceKey(source, marketplaceRepo, pluginRoot)
  if (!key?.startsWith('github.com/')) return {}
  // Keep the original casing for display.
  let gh: { owner: string; repo: string } | null = null
  if (typeof source === 'string') gh = marketplaceRepo ? parseGitHubRepo(marketplaceRepo) : null
  else if (isPlainObject(source)) gh = parseGitHubRepo(String(source.repo ?? source.url ?? ''))
  if (!gh) return {}
  const path = key.slice(key.indexOf('#') + 1)
  return { repo: `${gh.owner}/${gh.repo}`, url: githubTreeUrl(gh.owner, gh.repo, path || undefined) }
}

export interface ParsedMarketplace {
  name: string
  description?: string
  owner?: string
  plugins: CatalogItem[]
}

function authorName(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (isPlainObject(value) && typeof value.name === 'string') return value.name.trim() || undefined
  return undefined
}

function httpUrl(value: unknown): string | undefined {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length < 60).slice(0, 12)
  return list.length ? list : undefined
}

/** Parse a marketplace.json document fetched from `repo` ("owner/repo"). Invalid entries are skipped. */
export function parseMarketplaceJson(json: unknown, repo: string): ParsedMarketplace {
  if (!isPlainObject(json) || typeof json.name !== 'string' || !Array.isArray(json.plugins)) {
    throw new Error(`${repo} does not contain a valid marketplace.json`)
  }
  const name = json.name
  const metadata = isPlainObject(json.metadata) ? json.metadata : {}
  const pluginRoot = typeof metadata.pluginRoot === 'string' ? metadata.pluginRoot : undefined
  const owner = authorName(json.owner)
  const trusted = TRUSTED_MARKETPLACES.has(name) && repo.toLowerCase().startsWith('anthropics/')
  const plugins: CatalogItem[] = []
  const seen = new Set<string>()
  for (const entry of json.plugins) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || !PLUGIN_NAME_RE.test(entry.name)) continue
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    const links = pluginSourceLinks(entry.source, repo, pluginRoot)
    const displayName = typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : entry.name
    plugins.push({
      id: pluginItemId(entry.name, name),
      kind: 'plugin',
      name: displayName,
      description: typeof entry.description === 'string' ? clip(entry.description, 600) : '',
      author: authorName(entry.author) ?? owner,
      source: 'marketplace',
      marketplace: name,
      repo: links.repo,
      url: httpUrl(entry.homepage) ?? links.url,
      category: typeof entry.category === 'string' ? entry.category : undefined,
      installed: false,
      sourceKey: pluginSourceKey(entry.source, repo, pluginRoot),
      trusted,
      version: typeof entry.version === 'string' ? entry.version : undefined,
      tags: stringList(entry.tags) ?? stringList(entry.keywords)
    })
  }
  const description =
    typeof json.description === 'string' ? json.description : typeof metadata.description === 'string' ? metadata.description : undefined
  return { name, description, owner, plugins }
}

/** Download and parse a GitHub marketplace ("owner/repo"). */
export async function fetchMarketplace(repo: string): Promise<ParsedMarketplace> {
  const gh = parseGitHubRepo(repo)
  if (!gh) throw new Error(`"${repo}" is not a GitHub repository`)
  const text = await fetchRepoText(gh.owner, gh.repo, '.claude-plugin/marketplace.json', { maxBytes: 16 * 1024 * 1024 })
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${repo} has a marketplace.json that is not valid JSON`)
  }
  return parseMarketplaceJson(json, `${gh.owner}/${gh.repo}`)
}
