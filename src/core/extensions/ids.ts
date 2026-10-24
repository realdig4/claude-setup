/**
 * Extension ids. Three families, all plain strings so they survive IPC/CLI/MCP:
 *
 *   plugin:<name>@<marketplace>                       a Claude Code plugin (bare "<name>@<marketplace>" also accepted)
 *   <kind>:<source>:<owner>/<repo>/<path>             a catalog item hosted on GitHub (skill dir, agent .md, hook .json…)
 *                                                     for skills.sh the <path> is the skill id (its folder is found at install time)
 *   <kind>:local:user:<key>                           something already on disk, user scope
 *   <kind>:local:<project|local>:<encPath>:<key>      …in a project (encPath = encodeURIComponent(projectPath))
 *
 * <key> is the skill folder name, the file path relative to agents/ commands/ output-styles/ (forward slashes,
 * without ".disabled"), "statusLine", "rec-<registryKey>" for hooks we installed, or "<Event>/<hash>" for other hooks.
 */
import type { ExtensionKind, ExtensionSource, Scope } from '@shared/types'

export const EXTENSION_KINDS: readonly ExtensionKind[] = ['plugin', 'skill', 'agent', 'command', 'hook', 'statusline', 'output-style']
export const CATALOG_SOURCES: readonly ExtensionSource[] = ['claude-cli', 'marketplace', 'skills.sh', 'aitmpl', 'anthropic-skills']

/** Plugin and marketplace names: [A-Za-z0-9._-], starting alphanumeric. */
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const GH_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/

export interface PluginId {
  type: 'plugin'
  kind: 'plugin'
  name: string
  marketplace: string
  /** "<name>@<marketplace>" as the claude CLI expects it. */
  pluginId: string
}

export interface CatalogId {
  type: 'catalog'
  kind: ExtensionKind
  source: ExtensionSource
  owner: string
  repo: string
  /** Path inside the repo (or the skills.sh skill id). Forward slashes, no "..". */
  path: string
}

export interface LocalId {
  type: 'local'
  kind: ExtensionKind
  scope: Scope
  projectPath?: string
  key: string
}

export type ParsedId = PluginId | CatalogId | LocalId

/** "plugin:<name>@<marketplace>" */
export function pluginItemId(name: string, marketplace: string): string {
  return `plugin:${name}@${marketplace}`
}

/** "<kind>:<source>:<owner>/<repo>/<path>" */
export function catalogItemId(kind: ExtensionKind, source: ExtensionSource, owner: string, repo: string, path: string): string {
  return `${kind}:${source}:${owner}/${repo}/${path.replace(/^\/+/, '')}`
}

/** Id of something found on disk. */
export function localItemId(kind: ExtensionKind, scope: Scope, key: string, projectPath?: string): string {
  if (scope === 'user' || !projectPath) return `${kind}:local:user:${key}`
  return `${kind}:local:${scope}:${encodeURIComponent(projectPath)}:${key}`
}

/** True when a repo-relative path is safe (no traversal, no absolute paths, no backslashes, no empty segments). */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[a-zA-Z]:/.test(p)) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

function parsePluginRef(ref: string): PluginId | null {
  const at = ref.lastIndexOf('@')
  if (at <= 0) return null
  const name = ref.slice(0, at)
  const marketplace = ref.slice(at + 1)
  if (!PLUGIN_NAME_RE.test(name) || !PLUGIN_NAME_RE.test(marketplace)) return null
  return { type: 'plugin', kind: 'plugin', name, marketplace, pluginId: `${name}@${marketplace}` }
}

/** Parse any extension id. Returns null for malformed ids. */
export function parseId(id: string): ParsedId | null {
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  if (!trimmed || trimmed.length > 2048) return null
  if (!trimmed.includes(':')) return parsePluginRef(trimmed)
  const parts = trimmed.split(':')
  const kind = parts[0] as ExtensionKind
  if (!EXTENSION_KINDS.includes(kind)) return null
  if (kind === 'plugin' && parts.length === 2) return parsePluginRef(parts[1])
  if (parts.length < 3) return null
  const source = parts[1]
  if (source === 'local') {
    const scope = parts[2] as Scope
    if (scope === 'user') {
      const key = parts.slice(3).join(':')
      return key && isSafeKey(key) ? { type: 'local', kind, scope, key } : null
    }
    if (scope !== 'project' && scope !== 'local') return null
    if (parts.length < 5) return null
    let projectPath: string
    try {
      projectPath = decodeURIComponent(parts[3])
    } catch {
      return null
    }
    const key = parts.slice(4).join(':')
    if (!projectPath || !key || !isSafeKey(key)) return null
    return { type: 'local', kind, scope, projectPath, key }
  }
  if (!CATALOG_SOURCES.includes(source as ExtensionSource)) return null
  const rest = parts.slice(2).join(':')
  const segs = rest.split('/')
  if (segs.length < 3) return null
  const [owner, repo] = segs
  const path = segs.slice(2).join('/')
  if (!GH_NAME_RE.test(owner) || !GH_NAME_RE.test(repo) || !isSafeRelativePath(path)) return null
  return { type: 'catalog', kind, source: source as ExtensionSource, owner, repo, path }
}

/** Keys may contain "/" (nested agents/commands) and ":" but never traversal segments. */
function isSafeKey(key: string): boolean {
  if (key.startsWith('rec-')) return /^rec-[a-f0-9]{4,32}$/.test(key)
  return isSafeRelativePath(key)
}
