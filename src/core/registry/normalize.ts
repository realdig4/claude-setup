/** Helpers that turn source fields into normalised CatalogServer pieces (names, publishers, tags, popularity). */
import type { CatalogServer, CatalogSource, InstallOption } from '@shared/types'
import type { Metrics } from './types'
import { classify } from './categories'
import { cleanText, logScale, prettifyName, slugify, truncate } from './util'

/** Regex matching registry namespaces that start with one of the given prefixes. */
function namespaceRe(prefixes: string[]): RegExp {
  return new RegExp(`^(${prefixes.map((p) => p.replace(/\./g, '\\.')).join('|')})\\b`, 'i')
}

/** Namespaces that republish other people's servers (never a "vendor official" signal). */
const AGGREGATOR_NAMESPACES = namespaceRe([
  'io.github',
  'ai.smithery',
  'com.pulsemcp',
  'ai.glama',
  'com.mcp',
  'io.mcp',
  'so.mcp',
  'org.mcp',
  'dev.mcp',
  'com.docker',
  'io.toolhive',
  'com.stacklok',
  'com.apify',
  'app.workalong',
  'ai.cybernative'
])

/** Namespaces of services that republish many third-party servers under their own name. */
const REPUBLISHER_NAMESPACES = namespaceRe([
  'ai.smithery',
  'com.pulsemcp',
  'ai.glama',
  'com.mcparmory',
  'ai.waystation',
  'com.apify',
  'app.workalong',
  'ai.cybernative',
  'io.toolhive',
  'com.stacklok',
  'com.thenextgennexus'
])

/** True for registry names published by a republishing service (e.g. "ai.smithery/brave"). */
export function isRepublisherName(name: string): boolean {
  return REPUBLISHER_NAMESPACES.test(name.split('/')[0] ?? '')
}

/** Owner token of a registry namespace: "io.github.brave/x" → "brave", "com.notion/mcp" → "notion". */
export function namespaceOwner(name: string): string {
  const ns = (name.split('/')[0] ?? '').toLowerCase()
  const gh = /^io\.github\.(.+)$/.exec(ns)
  if (gh) return gh[1]
  const parts = ns.split('.').filter((p) => !/^(mcp|www|api)$/.test(p))
  return parts.length > 1 ? parts[1] : (parts[0] ?? '')
}

/**
 * Soft matching key "vendor:<publisher>/<name-slug>" — the same publisher shipping a server with the
 * same name in two registries is very likely the same server.
 */
export function vendorKey(publisher: string | undefined, name: string): string | undefined {
  if (!publisher) return undefined
  const pub = publisher
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^(www|mcp|api)\./, '')
    .split('.')[0]
    .replace(/[^a-z0-9]/g, '')
  const slug = slugify(name, '')
  if (pub.length < 2 || !slug || slug === 'server') return undefined
  return `vendor:${pub}/${slug}`
}

/** Reference servers moved to modelcontextprotocol/servers-archived (no longer maintained). */
const ARCHIVED_REFERENCE = new Set([
  'aws-kb-retrieval-server',
  'brave-search',
  'everart',
  'gdrive',
  'github',
  'gitlab',
  'google-maps',
  'postgres',
  'puppeteer',
  'redis',
  'sentry',
  'slack',
  'sqlite'
])

/** Message used for archived reference servers. */
export const ARCHIVED_NOTE = 'This reference server was archived by its maintainers and is no longer updated.'

/**
 * True when a repository reference (or a catalog key) designates an archived reference server of
 * github.com/modelcontextprotocol/servers.
 */
export function isArchivedReference(
  repo: { host: string; owner: string; repo: string; subfolder?: string } | undefined,
  key?: string
): boolean {
  if (!repo || repo.host !== 'github.com' || repo.owner !== 'modelcontextprotocol' || !/^servers(-archived)?$/.test(repo.repo)) return false
  if (repo.repo === 'servers-archived') return true
  const sub = repo.subfolder?.match(/^src\/([^/]+)/)?.[1]
  const name = (sub ?? key ?? '').toLowerCase()
  return ARCHIVED_REFERENCE.has(name)
}

/** Tags that say nothing useful about a server. */
const GENERIC_TAGS = new Set([
  'mcp',
  'mcp-server',
  'mcp-servers',
  'mcpserver',
  'model-context-protocol',
  'modelcontextprotocol',
  'model-context-protocol-server',
  'mcp-tools',
  'mcp-tool',
  'ai',
  'llm',
  'llms',
  'claude',
  'claude-ai',
  'claude-code',
  'claude-desktop',
  'anthropic',
  'cursor',
  'windsurf',
  'cline',
  'chatgpt',
  'openai',
  'codex',
  'copilot',
  'gemini',
  'gemini-cli',
  'gemini-cli-extension',
  'ai-agents',
  'ai-agent',
  'agent',
  'agents',
  'ai-tools',
  'llm-tools',
  'remote',
  'server',
  'tools',
  'secrets',
  'devops',
  'agent-skills',
  'claude-code-plugin',
  'cursor-plugin',
  'codex-plugin',
  'claude-plugin',
  'vibe-coding',
  'open-source',
  'typescript',
  'python',
  'javascript'
])

/** Normalise free-form tags/topics: lowercase dashed, generic ones removed, max `max`. */
export function normalizeTags(tags: Iterable<string | undefined>, max = 8): string[] {
  const out: string[] = []
  for (const t of tags) {
    if (!t) continue
    const tag = t.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9.+#-]/g, '')
    if (!tag || tag.length > 32 || GENERIC_TAGS.has(tag) || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= max) break
  }
  return out
}

/**
 * Publisher from an official registry name: "io.github.brave/x" → "brave", "com.notion/mcp" → "notion.com",
 * "com.figma.mcp/mcp" → "figma.com".
 */
export function publisherFromName(name: string): string | undefined {
  const ns = name.split('/')[0]
  if (!ns || !ns.includes('.')) return ns || undefined
  const gh = /^io\.github\.(.+)$/i.exec(ns)
  if (gh) return gh[1]
  const domain = ns
    .split('.')
    .reverse()
    .filter((p, i, all) => !(i === 0 && all.length > 2 && /^(mcp|www|api)$/i.test(p)))
    .join('.')
  return domain.toLowerCase()
}

/** True for domain-verified namespaces of the official registry that are not aggregators. */
export function isVendorNamespace(name: string): boolean {
  const ns = name.split('/')[0] ?? ''
  return ns.includes('.') && !AGGREGATOR_NAMESPACES.test(ns)
}

/** Display name from a registry name when no title is published: "io.github.x/brave-search-mcp" → "Brave Search". */
export function displayNameFromRegistryName(name: string): string {
  const last = name.split('/').pop() ?? name
  const pretty = prettifyName(last)
  if (pretty && !/^(mcp|server|main|default)$/i.test(last)) return pretty
  const pub = publisherFromName(name)
  return pub ? prettifyName(pub.split('.')[0]) : prettifyName(name)
}

export interface ServerFields {
  id: string
  name: string
  description?: string
  longDescription?: string
  publisher?: string
  repository?: string
  homepage?: string
  iconUrl?: string
  categories?: string[]
  /** Source categories (Docker/Cline/Anthropic labels) mapped onto the taxonomy. */
  sourceCategories?: string[]
  tags?: Array<string | undefined>
  official?: boolean
  verified?: boolean
  stars?: number
  updatedAt?: string
  version?: string
  install: InstallOption[]
  slug?: string
}

/** Build the single-source CatalogServer for a SourceEntry. */
export function makeServer(source: CatalogSource, f: ServerFields): CatalogServer {
  const name = cleanText(f.name) || prettifyName(f.id)
  const description = truncate(cleanText(f.description) || `${name} MCP server.`, 400)
  const tags = normalizeTags(f.tags ?? [])
  const categories =
    f.categories && f.categories.length
      ? f.categories
      : classify({ name, description: `${description} ${f.longDescription ?? ''}`, tags, sourceCategories: f.sourceCategories })
  const server: CatalogServer = {
    id: f.id,
    name,
    slug: f.slug ?? slugify(name, f.id),
    description,
    categories,
    tags,
    sources: [source],
    install: f.install
  }
  if (f.longDescription && f.longDescription !== description) server.longDescription = f.longDescription
  if (f.publisher) server.publisher = f.publisher
  if (f.repository) server.repository = f.repository
  if (f.homepage) server.homepage = f.homepage
  if (f.iconUrl) server.iconUrl = f.iconUrl
  if (f.official) server.official = true
  if (f.verified) server.verified = true
  if (f.stars !== undefined) server.stars = f.stars
  if (f.updatedAt) server.updatedAt = f.updatedAt
  if (f.version) server.version = f.version
  return server
}

/** Sources whose listing is curated (Anthropic directory, GitHub registry, Docker catalog, bundled seed). */
export const CURATED_SOURCES: ReadonlySet<CatalogSource> = new Set<CatalogSource>(['anthropic', 'github', 'docker', 'seed'])

export interface PopularityInput {
  metrics: Metrics
  sources: CatalogSource[]
  official: boolean
  verified: boolean
  deprecated: boolean
  installable: boolean
  featured: boolean
}

/**
 * 0..100 popularity: the strongest log-scaled signal (stars, Smithery uses, Docker pulls, downloads,
 * visitors) plus boosts for curated / official / featured servers; deprecated and manual-only ones are demoted.
 */
export function computePopularity(p: PopularityInput): number {
  const m = p.metrics
  const signals = [
    logScale(m.stars, 100_000),
    logScale(m.useCount, 200_000),
    logScale(m.pulls, 2_000_000),
    logScale(m.downloads, 100_000),
    logScale(m.visitors, 200_000)
  ].sort((a, b) => b - a)
  let score = signals[0] * 0.85 + signals[1] * 0.15
  const curated = p.sources.some((s) => CURATED_SOURCES.has(s))
  if (curated) score = Math.max(score, 30) + 10
  if (p.sources.includes('anthropic')) score += 12
  if (p.sources.includes('seed')) score += 15
  if (p.official) score += 8
  if (p.verified && !curated) score += 4
  if (p.featured) score += 15
  if (p.sources.length > 1) score += Math.min(6, (p.sources.length - 1) * 2)
  if (!p.installable) score -= 15
  if (p.deprecated) score -= 40
  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10
}

/** Stable synthetic id for sources without registry names. */
export function sourceScopedId(source: CatalogSource, value: string): string {
  return `${source}:${value}`
}
