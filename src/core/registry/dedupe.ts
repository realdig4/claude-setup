/**
 * Cross-registry de-duplication (research §12): union-find over matching keys, then a field-by-field
 * merge with per-field source priorities.
 *
 * Rules
 *  - Entries sharing a name key are the same server.
 *  - Hard keys (package / remote / repo+subfolder) merge unless the key is shared by entries with
 *    two or more different guard (official registry) names — monorepos & multi-server CLIs.
 *  - Soft keys (repo without subfolder, /mcp vs /sse host, Smithery owner/repo) merge only into a
 *    single unambiguous candidate group.
 *  - Two different guard names are never merged.
 *  - Install data priority: seed > official > anthropic > docker > github > pulsemcp > smithery > others;
 *    the same package from several sources keeps the newest version.
 */
import type { CatalogServer, CatalogSource, InstallOption } from '@shared/types'
import { assignOptionIds, bumpOptionVersion, optionDedupeKey, optionRank, serverNeedsKey } from './install'
import { computePopularity, isRepublisherName, namespaceOwner, vendorKey } from './normalize'
import { MAX_OPTIONS } from './serverjson'
import type { MergedServer, Metrics, SourceEntry } from './types'
import { isImageUrl, latestDate, truncate, uniq } from './util'

/** Display order of sources in CatalogServer.sources. */
export const SOURCE_ORDER: readonly CatalogSource[] = [
  'official',
  'anthropic',
  'github',
  'docker',
  'smithery',
  'pulsemcp',
  'glama',
  'cline',
  'awesome',
  'seed'
]

/** Priority for names / descriptions (friendliest text first). */
const TEXT_PRIORITY: readonly CatalogSource[] = [
  'seed',
  'anthropic',
  'official',
  'github',
  'docker',
  'pulsemcp',
  'smithery',
  'cline',
  'glama',
  'awesome'
]
/** Priority for install data. */
const INSTALL_PRIORITY: readonly CatalogSource[] = [
  'seed',
  'official',
  'anthropic',
  'docker',
  'github',
  'pulsemcp',
  'smithery',
  'glama',
  'cline',
  'awesome'
]
/** Priority for the merged id when no guard name exists. */
const ID_PRIORITY: readonly CatalogSource[] = [
  'official',
  'seed',
  'anthropic',
  'github',
  'pulsemcp',
  'docker',
  'smithery',
  'glama',
  'cline',
  'awesome'
]

function rankOf(order: readonly CatalogSource[], source: CatalogSource): number {
  const i = order.indexOf(source)
  return i < 0 ? order.length : i
}

/** Minimal shape needed for grouping. */
export interface GroupInput {
  source?: string
  guardName?: string
  keys: string[]
  softKeys?: string[]
}

/**
 * Assign a dense group number to every entry. Entries with the same number are the same server.
 */
export function groupEntries(entries: GroupInput[]): Int32Array {
  const n = entries.length
  const parent = new Int32Array(n)
  const size = new Int32Array(n).fill(1)
  const guard: Array<string | undefined> = new Array(n)
  for (let i = 0; i < n; i++) {
    parent[i] = i
    guard[i] = entries[i].guardName?.toLowerCase()
  }
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number): boolean => {
    let ra = find(a)
    let rb = find(b)
    if (ra === rb) return true
    const ga = guard[ra]
    const gb = guard[rb]
    if (ga && gb && ga !== gb) return false
    if (size[ra] < size[rb]) [ra, rb] = [rb, ra]
    parent[rb] = ra
    size[ra] += size[rb]
    guard[ra] = ga ?? gb
    return true
  }

  // Index hard keys; name keys first so registry names anchor the groups.
  const hard = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    for (const k of entries[i].keys) {
      let list = hard.get(k)
      if (!list) hard.set(k, (list = []))
      if (list[list.length - 1] !== i) list.push(i)
    }
  }
  const ordered = [...hard.entries()].filter(([, list]) => list.length > 1)
  const weight = (k: string) => (k.startsWith('name:') ? 0 : k.startsWith('repo:') ? 2 : 1)
  ordered.sort((a, b) => weight(a[0]) - weight(b[0]))
  for (const [key, list] of ordered) {
    let members = list
    if (!key.startsWith('name:')) {
      // Several unguarded entries of one source share the key → monorepo / shared package, not an identity.
      const seenSources = new Set<string>()
      let shared = false
      for (const i of list) {
        const e = entries[i]
        if (e.guardName || !e.source) continue
        if (seenSources.has(e.source)) {
          shared = true
          break
        }
        seenSources.add(e.source)
      }
      if (shared) continue
      const guards = new Set<string>()
      for (const i of list) if (entries[i].guardName) guards.add(entries[i].guardName!.toLowerCase())
      if (guards.size > 1) {
        // Shared by several registered servers: only usable when one of them is clearly canonical
        // (republishers such as ai.smithery/* do not count; for repos the namespace owner must match).
        let canonical = [...guards].filter((g) => !isRepublisherName(g))
        if (canonical.length > 1 && key.startsWith('repo:')) {
          const owner = key.slice('repo:'.length).split('/')[1]?.split('#')[0]
          canonical = canonical.filter((g) => namespaceOwner(g) === owner)
        }
        if (canonical.length !== 1) continue
        const chosen = canonical[0]
        members = list.filter((i) => !entries[i].guardName || entries[i].guardName!.toLowerCase() === chosen)
      }
    }
    for (let j = 1; j < members.length; j++) union(members[0], members[j])
  }

  // Soft keys: merge only into exactly one candidate group.
  const soft = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    for (const k of entries[i].softKeys ?? []) {
      let list = soft.get(k)
      if (!list) soft.set(k, (list = []))
      list.push(i)
    }
  }
  for (const [, list] of soft) {
    if (list.length < 2) continue
    for (const i of list) {
      const self = find(i)
      const candidates = new Set<number>()
      for (const j of list) {
        const r = find(j)
        if (r === self) continue
        candidates.add(r)
        if (candidates.size > 1) break
      }
      if (candidates.size !== 1) continue
      const [target] = candidates
      // Only merge an unguarded group into another group (two guarded groups never merge anyway).
      if (guard[self] && guard[target]) continue
      union(self, target)
    }
  }

  const dense = new Int32Array(n)
  const ids = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    let id = ids.get(r)
    if (id === undefined) ids.set(r, (id = ids.size))
    dense[i] = id
  }
  return dense
}

function maxMetric(entries: SourceEntry[], key: keyof Metrics): number | undefined {
  let best: number | undefined
  for (const e of entries) {
    const v = e.metrics?.[key]
    if (v !== undefined && (best === undefined || v > best)) best = v
  }
  return best
}

function firstDefined<T>(entries: SourceEntry[], pick: (s: CatalogServer, e: SourceEntry) => T | undefined): T | undefined {
  for (const e of entries) {
    const v = pick(e.server, e)
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/**
 * Soft keys derived from an entry's normalised fields (stored alongside its own soft keys):
 * "vendor:<publisher>/<name>". Smithery-hosted wrappers (namespace-only names) are excluded.
 */
export function derivedSoftKeys(e: SourceEntry): string[] {
  if (e.source === 'smithery' && !e.sourceId.includes('/')) return []
  const k = vendorKey(e.server.publisher, e.server.name)
  return k ? [k] : []
}

/** Discovery-oriented sources whose install data is only used when nothing better exists. */
const FALLBACK_INSTALL_SOURCES: ReadonlySet<CatalogSource> = new Set<CatalogSource>(['smithery', 'glama', 'cline', 'awesome'])

/** Merge install options from entries already sorted by install priority. */
function mergeInstall(byInstall: SourceEntry[]): InstallOption[] {
  const kept: Array<{ option: InstallOption; seed: boolean; order: number }> = []
  const index = new Map<string, number>()
  let order = 0
  for (const e of byInstall) {
    if (FALLBACK_INSTALL_SOURCES.has(e.source) && kept.some((k) => k.option.kind !== 'manual')) continue
    for (const option of e.server.install) {
      const key = optionDedupeKey(option)
      const at = index.get(key)
      if (at !== undefined) {
        kept[at].option = bumpOptionVersion(kept[at].option, option.version)
        continue
      }
      index.set(key, kept.length)
      kept.push({ option, seed: e.source === 'seed', order: order++ })
    }
  }
  const installable = kept.filter((k) => k.option.kind !== 'manual')
  const chosen = installable.length ? installable : kept.slice(0, 1)
  chosen.sort((a, b) => {
    if (a.seed !== b.seed) return a.seed ? -1 : 1
    if (a.seed && b.seed) return a.order - b.order
    return optionRank(a.option) - optionRank(b.option) || a.order - b.order
  })
  return assignOptionIds(chosen.slice(0, MAX_OPTIONS).map((k) => k.option))
}

function mergeCategories(entries: SourceEntry[]): string[] {
  const seed = entries.find((e) => e.source === 'seed')
  if (seed?.server.categories.length) return seed.server.categories
  const score = new Map<string, number>()
  entries.forEach((e, i) => {
    e.server.categories.forEach((c, j) => score.set(c, (score.get(c) ?? 0) + 10 - j * 2 - Math.min(i, 4)))
  })
  let ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  if (ranked.length > 1) ranked = ranked.filter((c) => c !== 'other')
  return ranked.slice(0, 3)
}

export interface MergeOptions {
  /** Ids of featured servers (popularity boost). */
  featured?: ReadonlySet<string>
}

/** Merge all entries of one group into a single CatalogServer (+ index columns). */
export function mergeGroup(group: SourceEntry[], opts: MergeOptions = {}): MergedServer {
  const byText = [...group].sort((a, b) => rankOf(TEXT_PRIORITY, a.source) - rankOf(TEXT_PRIORITY, b.source))
  const byInstall = [...group].sort((a, b) => rankOf(INSTALL_PRIORITY, a.source) - rankOf(INSTALL_PRIORITY, b.source))
  const byId = [...group].sort((a, b) => rankOf(ID_PRIORITY, a.source) - rankOf(ID_PRIORITY, b.source))

  const guarded = byId.find((e) => e.guardName && e.source === 'official') ?? byId.find((e) => e.guardName)
  const id = guarded?.guardName ?? byId[0].server.id
  const explicitName = byText.find((e) => e.nameExplicit)
  const name = (explicitName ?? byText[0]).server.name
  const description = firstDefined(byText, (s) => s.description) ?? `${name} MCP server.`
  const longDescription = firstDefined(byText, (s) =>
    s.longDescription && s.longDescription !== description ? s.longDescription : undefined
  )
  const slug = (byText.find((e) => e.source === 'seed') ?? explicitName ?? byText[0]).server.slug
  const install = mergeInstall(byInstall)
  const sources = uniq(group.map((e) => e.source)).sort((a, b) => rankOf(SOURCE_ORDER, a) - rankOf(SOURCE_ORDER, b))
  const tags = uniq(byText.flatMap((e) => e.server.tags)).slice(0, 10)
  // Deprecated when the official registry says so, or when every source with an opinion agrees.
  const deprecatedEntry =
    group.find((e) => e.deprecated && e.source === 'official') ??
    (group.every((e) => e.deprecated || e.source === 'awesome' || e.source === 'glama') ? group.find((e) => e.deprecated) : undefined)
  const archived = /\((archived|deprecated)\)/i.test(name) || /^(archived|deprecated)\b/i.test(description)
  if ((deprecatedEntry || archived) && !tags.includes('deprecated')) tags.unshift('deprecated')
  const official = group.some((e) => e.server.official)
  const verified = group.some((e) => e.server.verified)
  const metrics: Metrics = {
    stars: maxMetric(group, 'stars'),
    useCount: maxMetric(group, 'useCount'),
    pulls: maxMetric(group, 'pulls'),
    downloads: maxMetric(group, 'downloads'),
    visitors: maxMetric(group, 'visitors')
  }
  const featured = opts.featured?.has(id) ?? false
  const popularity = computePopularity({
    metrics,
    sources,
    official,
    verified,
    deprecated: !!deprecatedEntry || archived,
    installable: install.some((o) => o.kind !== 'manual'),
    featured
  })

  const server: CatalogServer = {
    id,
    name,
    slug,
    description,
    categories: mergeCategories(byText),
    tags,
    sources,
    popularity,
    install
  }
  let long = longDescription
  if (deprecatedEntry) {
    const msg = typeof deprecatedEntry.deprecated === 'string' ? deprecatedEntry.deprecated : ''
    long = `Deprecated by its publisher${msg ? `: ${msg}` : '.'}${long ? `\n\n${long}` : ''}`
  }
  if (long) server.longDescription = truncate(long, 1200)
  const publisher = firstDefined(byText, (s) => s.publisher)
  if (publisher) server.publisher = publisher
  const repository = firstDefined(byInstall, (s) => s.repository)
  if (repository) server.repository = repository
  const homepage = firstDefined(byInstall, (s) => s.homepage)
  if (homepage) server.homepage = homepage
  const iconUrl = firstDefined(byText, (s) => (isImageUrl(s.iconUrl) ? s.iconUrl : undefined))
  if (iconUrl) server.iconUrl = iconUrl
  if (official) server.official = true
  if (verified) server.verified = true
  if (metrics.stars !== undefined) server.stars = metrics.stars
  const updatedAt = latestDate(...group.map((e) => e.server.updatedAt))
  if (updatedAt) server.updatedAt = updatedAt
  const version = firstDefined(byInstall, (s) => s.version)
  if (version) server.version = version

  const refs: MergedServer['refs'] = {}
  for (const e of group) if (e.ref && !refs[e.source]) refs[e.source] = e.ref
  const aliases = uniq(group.flatMap((e) => [e.server.id, `${e.source}:${e.sourceId}`]).filter((a) => a !== id))
  return {
    server,
    remote: install.some((o) => o.kind === 'remote'),
    needsKey: serverNeedsKey(install),
    aliases,
    refs
  }
}

/** Group + merge a full set of entries (used by the in-memory store and tests). */
export function mergeAll(entries: SourceEntry[], opts: MergeOptions = {}): MergedServer[] {
  const groups = groupEntries(entries)
  const buckets = new Map<number, SourceEntry[]>()
  entries.forEach((e, i) => {
    const g = groups[i]
    let list = buckets.get(g)
    if (!list) buckets.set(g, (list = []))
    list.push(e)
  })
  return [...buckets.values()].map((g) => mergeGroup(g, opts))
}
