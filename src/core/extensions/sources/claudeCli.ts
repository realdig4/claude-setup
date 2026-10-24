/**
 * Plugin catalog straight from Claude Code: `claude plugin list --json --available`.
 * Lists every marketplace the user added plus the built-in "anthropic-plugin-directory" (thousands of plugins),
 * with `installCount` for the official marketplace. Verified output shape (2.1.309):
 *   { installed: [...], available: [{ pluginId, name, description?, marketplaceName, source, version?, installCount? }] }
 */
import { isPlainObject, readJson } from '../../fs/json'
import { locateClaudeCli, runClaude } from '../cli'
import { PLUGIN_NAME_RE, pluginItemId } from '../ids'
import { pluginCatalogCachePath } from '../paths'
import type { CatalogItem } from '../types'
import { clip } from '../util'
import { curatedMarketplace, pluginSourceKey, pluginSourceLinks, TRUSTED_MARKETPLACES } from './marketplaces'

/**
 * Parse the `--available` listing. `repos` maps marketplace names to GitHub "owner/repo"
 * (needed to resolve relative plugin sources such as "./plugins/x").
 */
export function parseAvailablePlugins(json: unknown, repos: Record<string, string> = {}): CatalogItem[] {
  const list: unknown[] = isPlainObject(json) && Array.isArray(json.available) ? json.available : Array.isArray(json) ? json : []
  const out: CatalogItem[] = []
  const seen = new Set<string>()
  for (const p of list) {
    if (!isPlainObject(p)) continue
    const pluginId = typeof p.pluginId === 'string' ? p.pluginId : undefined
    const name = typeof p.name === 'string' ? p.name : pluginId?.slice(0, pluginId.lastIndexOf('@'))
    const marketplace = typeof p.marketplaceName === 'string' ? p.marketplaceName : pluginId?.slice(pluginId.lastIndexOf('@') + 1)
    if (!name || !marketplace || !PLUGIN_NAME_RE.test(name) || !PLUGIN_NAME_RE.test(marketplace)) continue
    const id = pluginItemId(name, marketplace)
    if (seen.has(id)) continue
    seen.add(id)
    const marketplaceRepo = repos[marketplace] ?? curatedMarketplace(marketplace)?.repo
    const links = pluginSourceLinks(p.source, marketplaceRepo)
    out.push({
      id,
      kind: 'plugin',
      name,
      description: typeof p.description === 'string' ? clip(p.description, 600) : '',
      source: 'claude-cli',
      marketplace,
      repo: links.repo,
      url: links.url,
      installs: typeof p.installCount === 'number' && p.installCount >= 0 ? p.installCount : undefined,
      installed: false,
      sourceKey: pluginSourceKey(p.source, marketplaceRepo),
      trusted: TRUSTED_MARKETPLACES.has(marketplace),
      version: typeof p.version === 'string' ? p.version : undefined
    })
  }
  return out
}

/** Run the CLI listing. Throws when the CLI is missing or the command fails (the caller keeps the cached copy). */
export async function fetchCliCatalog(repos: Record<string, string>): Promise<CatalogItem[]> {
  const cli = await locateClaudeCli()
  if (!cli) throw new Error('Claude Code is not installed')
  const r = await runClaude(cli, ['plugin', 'list', '--json', '--available'], { timeoutMs: 180_000 })
  if (!r.ok || !r.json) throw new Error(r.message || 'claude plugin list --available failed')
  return parseAvailablePlugins(r.json, repos)
}

/**
 * Install counts ("name@marketplace" → unique installs) from Claude Code's own catalog cache
 * (~/.claude/plugins/plugin-catalog-cache.json). Internal and unversioned, so read defensively; empty on any problem.
 */
export async function readInstallCounts(file = pluginCatalogCachePath()): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const r = await readJson<unknown>(file)
  const catalog = isPlainObject(r.data) && isPlainObject(r.data.catalog) ? r.data.catalog : undefined
  const plugins = catalog && isPlainObject(catalog.plugins) ? catalog.plugins : undefined
  if (!plugins) return out
  for (const [id, value] of Object.entries(plugins)) {
    if (isPlainObject(value) && typeof value.unique_installs === 'number' && value.unique_installs >= 0) out.set(id, value.unique_installs)
  }
  return out
}
