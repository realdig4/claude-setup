/**
 * The extensions catalog: loads only the sources a query needs (each cached for 12 h in <cacheDir>/extensions,
 * fetched in parallel, failures isolated so one broken source never empties the list), merges duplicates
 * across sources, then filters and ranks by query match and popularity.
 */
import { stat } from 'node:fs/promises'
import type { ExtensionKind, ExtensionQuery, ExtensionSource } from '@shared/types'
import { CACHE_KEYS, CATALOG_TTL_MS } from './cache'
import { locateClaudeCli, PLUGIN_DIRECTORY } from './cli'
import { knownMarketplaces } from './installers/plugin'
import { pluginCatalogCachePath } from './paths'
import { fetchAitmpl } from './sources/aitmpl'
import { fetchAnthropicSkills } from './sources/anthropicSkills'
import { fetchCliCatalog, readInstallCounts } from './sources/claudeCli'
import { CURATED_MARKETPLACES, DIRECTORY_FAMILY, fetchMarketplace, OFFICIAL_MARKETPLACE, type ParsedMarketplace } from './sources/marketplaces'
import { searchSkillsSh } from './sources/skillsSh'
import type { CatalogItem, ExtEnv } from './types'
import { errorMessage, sha256 } from './util'

/** Plugin name from "plugin:<name>@<marketplace>". */
export function pluginNameOf(item: CatalogItem): string {
  const ref = item.id.startsWith('plugin:') ? item.id.slice(7) : item.id
  const at = ref.lastIndexOf('@')
  return at > 0 ? ref.slice(0, at) : ref
}

function pluginPreference(item: CatalogItem): number {
  if (item.marketplace === OFFICIAL_MARKETPLACE) return 0
  if (item.marketplace === PLUGIN_DIRECTORY) return 1
  if (item.marketplace === 'claude-community') return 2
  const i = CURATED_MARKETPLACES.findIndex((m) => m.name === item.marketplace)
  return (i >= 0 ? 3 + i : 100) * 2 + (item.source === 'claude-cli' ? 0 : 1)
}

const SKILL_PREFERENCE: Partial<Record<ExtensionSource, number>> = { 'anthropic-skills': 0, aitmpl: 1, 'skills.sh': 2 }

/** Fold `other` into `target` (keeps target's identity, fills gaps, keeps the larger counts). */
function mergeInto(target: CatalogItem, other: CatalogItem): void {
  if (other.id !== target.id && !(target.aliases ?? []).includes(other.id)) target.aliases = [...(target.aliases ?? []), other.id]
  for (const alias of other.aliases ?? []) {
    if (alias !== target.id && !target.aliases?.includes(alias)) target.aliases = [...(target.aliases ?? []), alias]
  }
  if (!target.description && other.description) target.description = other.description
  if (other.installs !== undefined && (target.installs === undefined || other.installs > target.installs)) target.installs = other.installs
  if (other.stars !== undefined && (target.stars === undefined || other.stars > target.stars)) target.stars = other.stars
  target.category ??= other.category
  target.author ??= other.author
  target.url ??= other.url
  target.repo ??= other.repo
  target.tags ??= other.tags
  target.version ??= other.version
  target.trusted = target.trusted || other.trusted
  if (other.warnings?.length) target.warnings = [...new Set([...(target.warnings ?? []), ...other.warnings])]
}

/**
 * Merge duplicates:
 * - plugins with the same name and the same source location (e.g. listed by a marketplace and by Anthropic's directory),
 *   and same-name plugins within Anthropic's directory family; the official marketplace wins, then the directory;
 * - skills with the same repo + folder (Anthropic's list beats aitmpl beats skills.sh, installs are kept);
 * - everything else by id.
 */
export function dedupe(items: CatalogItem[]): CatalogItem[] {
  const out: CatalogItem[] = []
  const byId = new Map<string, CatalogItem>()
  const plugins = items.filter((i) => i.kind === 'plugin').sort((a, b) => pluginPreference(a) - pluginPreference(b))
  const bySource = new Map<string, CatalogItem>()
  const byFamilyName = new Map<string, CatalogItem>()
  for (const item of plugins) {
    const name = pluginNameOf(item).toLowerCase()
    const sourceKey = item.sourceKey ? `${name}|${item.sourceKey}` : undefined
    const family = !!item.marketplace && DIRECTORY_FAMILY.has(item.marketplace)
    const target = byId.get(item.id) ?? (sourceKey ? bySource.get(sourceKey) : undefined) ?? (family ? byFamilyName.get(name) : undefined)
    if (target) {
      mergeInto(target, item)
      byId.set(item.id, target)
      if (sourceKey && !bySource.has(sourceKey)) bySource.set(sourceKey, target)
      continue
    }
    const copy: CatalogItem = { ...item }
    out.push(copy)
    byId.set(item.id, copy)
    if (sourceKey) bySource.set(sourceKey, copy)
    if (family) byFamilyName.set(name, copy)
  }
  const skills = items.filter((i) => i.kind === 'skill').sort((a, b) => (SKILL_PREFERENCE[a.source] ?? 9) - (SKILL_PREFERENCE[b.source] ?? 9))
  const byKey = new Map<string, CatalogItem>()
  for (const item of skills) {
    const target = byId.get(item.id) ?? (item.dedupeKey ? byKey.get(item.dedupeKey) : undefined)
    if (target) {
      mergeInto(target, item)
      byId.set(item.id, target)
      continue
    }
    const copy: CatalogItem = { ...item }
    out.push(copy)
    byId.set(item.id, copy)
    if (item.dedupeKey) byKey.set(item.dedupeKey, copy)
  }
  for (const item of items) {
    if (item.kind === 'plugin' || item.kind === 'skill') continue
    const existing = byId.get(item.id)
    if (existing) mergeInto(existing, item)
    else {
      const copy: CatalogItem = { ...item }
      out.push(copy)
      byId.set(item.id, copy)
    }
  }
  return out
}

function tokenize(query: string | undefined): string[] {
  if (!query) return []
  return [...new Set(query.toLowerCase().split(/[\s,]+/).filter(Boolean))].slice(0, 8)
}

function popularity(item: CatalogItem): number {
  const n = item.installs ?? item.stars ?? 0
  return Math.log10(1 + Math.max(0, n)) * 6 + (item.trusted ? 8 : 0)
}

/** Regex matching a token at the start of a word. */
function wordStart(token: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
}

/** Relevance of an item for the query tokens; null when a token matches nowhere. */
export function matchScore(item: CatalogItem, tokens: string[], phrase: string, wordRes: RegExp[] = tokens.map(wordStart)): number | null {
  if (!tokens.length) return 0
  const name = item.name.toLowerCase()
  const altName = item.kind === 'plugin' ? pluginNameOf(item).toLowerCase() : name
  const desc = (item.description ?? '').toLowerCase()
  const extra = [item.category, item.author, item.marketplace, item.repo, ...(item.tags ?? [])].filter(Boolean).join(' ').toLowerCase()
  let score = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (name === t || altName === t) score += 100
    else if (name.startsWith(t) || altName.startsWith(t)) score += 60
    else if (wordRes[i].test(name) || wordRes[i].test(altName)) score += 45
    else if (name.includes(t) || altName.includes(t)) score += 30
    else if (extra.includes(t)) score += 12
    else if (desc.includes(t)) score += 10
    // skills.sh results come from its own (fuzzy, content-aware) search for this very query: keep them, ranked low.
    else if (item.source === 'skills.sh') score += 1
    else return null
  }
  if (tokens.length > 1 && (name.includes(phrase) || altName.includes(phrase))) score += 40
  if (tokens.length > 1 && (name === phrase || altName === phrase)) score += 60
  return score
}

/** Filter by kind/source/query and sort by relevance + popularity. */
export function rankItems(items: CatalogItem[], q: ExtensionQuery): CatalogItem[] {
  const tokens = tokenize(q.query)
  const phrase = tokens.join(' ')
  const wordRes = tokens.map(wordStart)
  const scored: Array<{ item: CatalogItem; score: number }> = []
  for (const item of items) {
    if (q.kind && item.kind !== q.kind) continue
    if (q.source && item.source !== q.source) continue
    const m = matchScore(item, tokens, phrase, wordRes)
    if (m === null) continue
    scored.push({ item, score: m + popularity(item) })
  }
  scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
  return scored.map((s) => s.item)
}

export class Catalog {
  private readonly byId = new Map<string, CatalogItem>()
  private counts?: { mtimeMs: number; map: Map<string, number> }

  private readonly warned = new Map<string, { message: string; at: number }>()

  constructor(private readonly env: ExtEnv) {}

  /** Log a source problem once (not on every keystroke of a search). */
  private warn(key: string, message: string): void {
    const last = this.warned.get(key)
    if (last && last.message === message && Date.now() - last.at < 10 * 60 * 1000) return
    this.warned.set(key, { message, at: Date.now() })
    this.env.ctx.log.warn('extensions', message)
  }

  /** Items from the sources relevant to a query (merged, not yet ranked). */
  async load(q: ExtensionQuery): Promise<CatalogItem[]> {
    const wantKind = (k: ExtensionKind) => !q.kind || q.kind === k
    const wantSource = (s: ExtensionSource) => !q.source || q.source === s
    const jobs: Array<Promise<CatalogItem[]>> = []
    if (wantKind('plugin')) {
      if (wantSource('claude-cli')) jobs.push(this.loadCli())
      if (wantSource('marketplace')) {
        for (const m of CURATED_MARKETPLACES) jobs.push(this.loadMarketplace(m.name, m.repo).then((p) => p?.plugins ?? []))
      }
    }
    if (wantKind('skill') && wantSource('anthropic-skills')) {
      jobs.push(this.loadCached(CACHE_KEYS.anthropicSkills, "Anthropic's skills", fetchAnthropicSkills))
    }
    if (q.kind !== 'plugin' && wantSource('aitmpl')) {
      const aitmpl = this.loadCached(CACHE_KEYS.aitmpl, 'aitmpl.com', fetchAitmpl)
      jobs.push(aitmpl.then((items) => (q.kind ? items.filter((i) => i.kind === q.kind) : items)))
    }
    const query = q.query?.trim() ?? ''
    if (wantKind('skill') && wantSource('skills.sh') && query.length >= 2) jobs.push(this.loadSkillsSh(query))
    const items = dedupe((await Promise.all(jobs)).flat())
    await this.applyInstallCounts(items)
    for (const item of items) {
      this.byId.set(item.id, item)
      for (const alias of item.aliases ?? []) this.byId.set(alias, item)
    }
    return items
  }

  /** Metadata for an id from memory or the on-disk caches (never fetches). */
  async lookup(id: string): Promise<CatalogItem | undefined> {
    const hit = this.byId.get(id)
    if (hit) return hit
    const keys = [CACHE_KEYS.cli, CACHE_KEYS.aitmpl, CACHE_KEYS.anthropicSkills]
    for (const key of keys) {
      const cached = await this.env.cache.get<CatalogItem[]>(key)
      const found = Array.isArray(cached?.data) ? cached.data.find((i) => i.id === id) : undefined
      if (found) return found
    }
    for (const m of CURATED_MARKETPLACES) {
      const cached = await this.env.cache.get<ParsedMarketplace>(CACHE_KEYS.marketplace(m.name))
      const found = cached?.data?.plugins?.find((i) => i.id === id)
      if (found) return found
    }
    return undefined
  }

  /** Plugins per marketplace (cached listings only) and whether the built-in directory is active. */
  async marketplaceStats(): Promise<{ counts: Map<string, number>; directoryOn?: boolean }> {
    const counts = new Map<string, number>()
    const cli = await this.env.cache.get<CatalogItem[]>(CACHE_KEYS.cli)
    if (Array.isArray(cli?.data)) for (const i of cli.data) if (i.marketplace) counts.set(i.marketplace, (counts.get(i.marketplace) ?? 0) + 1)
    for (const m of CURATED_MARKETPLACES) {
      const cached = await this.env.cache.get<ParsedMarketplace>(CACHE_KEYS.marketplace(m.name))
      if (Array.isArray(cached?.data?.plugins)) counts.set(m.name, cached.data.plugins.length)
    }
    return { counts, directoryOn: Array.isArray(cli?.data) ? counts.has(PLUGIN_DIRECTORY) : undefined }
  }

  private async loadCached<T extends CatalogItem[]>(key: string, label: string, fetcher: () => Promise<T>): Promise<CatalogItem[]> {
    try {
      const r = await this.env.cache.load(key, CATALOG_TTL_MS, fetcher)
      if (r.stale) this.warn(key, `Using the saved ${label} list; refreshing failed: ${r.error}`)
      return Array.isArray(r.data) ? r.data : []
    } catch (err) {
      this.warn(key, `Couldn't load the ${label} list: ${errorMessage(err)}`)
      return []
    }
  }

  private async loadCli(): Promise<CatalogItem[]> {
    const cli = await locateClaudeCli()
    if (!cli) {
      const cached = await this.env.cache.get<CatalogItem[]>(CACHE_KEYS.cli)
      return Array.isArray(cached?.data) ? cached.data : []
    }
    return this.loadCached(CACHE_KEYS.cli, 'Claude Code plugin', async () => fetchCliCatalog(await this.marketplaceRepos()))
  }

  private async marketplaceRepos(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const m of CURATED_MARKETPLACES) out[m.name] = m.repo
    for (const m of (await knownMarketplaces(null)).values()) if (m.repo) out[m.name] = m.repo
    return out
  }

  private async loadMarketplace(name: string, repo: string): Promise<ParsedMarketplace | null> {
    try {
      const r = await this.env.cache.load(CACHE_KEYS.marketplace(name), CATALOG_TTL_MS, () => fetchMarketplace(repo))
      if (r.stale) this.warn(CACHE_KEYS.marketplace(name), `Using the saved ${name} marketplace; refreshing failed: ${r.error}`)
      return r.data
    } catch (err) {
      this.warn(CACHE_KEYS.marketplace(name), `Couldn't load the ${name} marketplace: ${errorMessage(err)}`)
      return null
    }
  }

  private async loadSkillsSh(query: string): Promise<CatalogItem[]> {
    const key = CACHE_KEYS.skillsSh(sha256(query.toLowerCase()).slice(0, 16))
    void this.env.cache.prune(CACHE_KEYS.skillsShPrefix, 3 * CATALOG_TTL_MS).catch(() => {})
    return this.loadCached(key, 'skills.sh', () => searchSkillsSh(query, 50))
  }

  /** Fill plugin install counts from Claude Code's own catalog cache (official marketplace numbers). */
  private async applyInstallCounts(items: CatalogItem[]): Promise<void> {
    if (!items.some((i) => i.kind === 'plugin' && i.installs === undefined)) return
    const file = pluginCatalogCachePath()
    const s = await stat(file).catch(() => null)
    if (!s) return
    if (!this.counts || this.counts.mtimeMs !== s.mtimeMs) this.counts = { mtimeMs: s.mtimeMs, map: await readInstallCounts(file) }
    const map = this.counts.map
    if (!map.size) return
    for (const item of items) {
      if (item.kind !== 'plugin' || item.installs !== undefined) continue
      const name = pluginNameOf(item)
      const candidates = [`${name}@${item.marketplace}`, ...(item.aliases ?? []).map((a) => a.replace(/^plugin:/, ''))]
      if (item.marketplace && DIRECTORY_FAMILY.has(item.marketplace)) candidates.push(`${name}@${OFFICIAL_MARKETPLACE}`)
      for (const c of candidates) {
        const n = map.get(c)
        if (n !== undefined) {
          item.installs = n
          break
        }
      }
    }
  }
}
