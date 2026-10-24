/**
 * Pure helpers for installed servers ("My Tools"): plain-words kinds, command summaries, filtering,
 * grouping by app and the simple key editor. No React / DOM imports (unit-tested in Node).
 */
import type { InstalledServer, Scope, ServerConfig, StdioServerConfig, TargetId } from '@shared/types'
import { TARGET_ORDER, folderName, normalizePath } from '../../discover/lib/targets'

export type ToolKind = 'online' | 'local' | 'docker'

/** Quote an argument for display when it contains spaces or quotes. */
export function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) || arg === '' ? JSON.stringify(arg) : arg
}

/** "npx -y @scope/server \"C:\\My Files\"". */
export function commandLine(config: StdioServerConfig): string {
  return [config.command, ...(config.args ?? [])].map(quoteArg).join(' ')
}

/** One-line technical summary: the command line or the URL. */
export function transportSummary(config: ServerConfig): string {
  return config.type === 'stdio' ? commandLine(config) : config.url
}

const SECRET_TOKEN = /^(sk-|sk_|rk_|pk_live_|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[abpr]-|AKIA|AIza|hf_|BSA)[A-Za-z0-9_\-.]{6,}$/
const SECRET_FLAG = /^(--?(?:api[-_]?key|token|access[-_]?token|auth|password|secret|key)=)(.+)$/i

function maskValue(value: string): string {
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-2)}`
}

/** Hide keys and tokens inside a single argument (headers, --token=…, bare keys, passwords in URLs). */
export function maskArg(arg: string): string {
  const header = /^([A-Za-z0-9-]*(?:authorization|api-key|token|key)[A-Za-z0-9-]*\s*:\s*)(.+)$/i.exec(arg)
  if (header) {
    const value = header[2] ?? ''
    const bearer = /^(bearer|basic|token)\s+(.+)$/i.exec(value)
    return `${header[1]}${bearer ? `${bearer[1]} ${maskValue(bearer[2] ?? '')}` : maskValue(value)}`
  }
  const flag = SECRET_FLAG.exec(arg)
  if (flag) return `${flag[1]}${maskValue(flag[2] ?? '')}`
  if (/^bearer\s+\S+$/i.test(arg)) return `Bearer ${maskValue(arg.slice(7).trim())}`
  if (SECRET_TOKEN.test(arg)) return maskValue(arg)
  return maskUrl(arg)
}

/** Hide a password in a URL ("postgresql://user:pw@host") and secret-looking query values (?api_key=…). */
export function maskUrl(text: string): string {
  return text
    .replace(/(\/\/[^/\s:@]+:)([^@/\s]+)(@)/, (_, a: string, pw: string, b: string) => `${a}${maskValue(pw)}${b}`)
    .replace(/([?&](?:api[-_]?key|key|token|access[-_]?token|secret|password)=)([^&#\s]+)/gi, (_, a: string, v: string) => `${a}${maskValue(v)}`)
}

/** Like transportSummary, with keys and tokens hidden (for lists and other at-a-glance views). */
export function safeSummary(config: ServerConfig): string {
  if (config.type !== 'stdio') return maskUrl(config.url)
  const args = config.args ?? []
  const masked = args.map((arg, i) => {
    const prev = (args[i - 1] ?? '').toLowerCase()
    if (prev === '--header' || prev === '-h') return maskArg(arg)
    if (/^--?(api[-_]?key|token|access[-_]?token|password|secret)$/.test(prev)) return maskValue(arg)
    return maskArg(arg)
  })
  return [config.command, ...masked].map(quoteArg).join(' ')
}

/** How the tool runs, in broad strokes (bridged remote servers count as online). */
export function toolKind(config: ServerConfig): ToolKind {
  if (config.type !== 'stdio') return 'online'
  const args = config.args ?? []
  if (args.some((a) => /^mcp-remote(@.*)?$/.test(a))) return 'online'
  const tool = config.command.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.(cmd|exe|bat)$/, '') ?? ''
  return tool === 'docker' || tool === 'podman' ? 'docker' : 'local'
}

export const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  online: 'Online tool',
  local: 'Runs on your computer',
  docker: 'Runs in Docker'
}

export interface InstalledFilter {
  query?: string
  target?: TargetId | 'all'
  scope?: Scope | 'all'
  projectPath?: string | 'all'
}

/** Servers matching the filter. `labelOf` supplies the display name used by the text search. */
export function filterInstalled(
  servers: readonly InstalledServer[],
  filter: InstalledFilter,
  labelOf: (server: InstalledServer) => string = (s) => s.name
): InstalledServer[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return servers.filter((server) => {
    if (filter.target && filter.target !== 'all' && server.target.target !== filter.target) return false
    const scope = server.target.scope ?? 'user'
    if (filter.scope && filter.scope !== 'all' && scope !== filter.scope) return false
    if (filter.projectPath && filter.projectPath !== 'all') {
      if (!server.target.projectPath || normalizePath(server.target.projectPath) !== normalizePath(filter.projectPath)) return false
    }
    if (words.length === 0) return true
    const haystack = [server.name, labelOf(server), transportSummary(server.config), server.target.projectPath ?? ''].join(' ').toLowerCase()
    return words.every((w) => haystack.includes(w))
  })
}

export interface TargetGroup {
  target: TargetId
  servers: InstalledServer[]
}

/** Group by app in display order; inside a group: everywhere-scope first, then by project, then by name. */
export function groupByTarget(servers: readonly InstalledServer[], labelOf: (server: InstalledServer) => string = (s) => s.name): TargetGroup[] {
  const groups: TargetGroup[] = []
  for (const target of TARGET_ORDER) {
    const list = servers.filter((s) => s.target.target === target)
    if (!list.length) continue
    list.sort((a, b) => {
      const pa = a.target.projectPath ? normalizePath(a.target.projectPath) : ''
      const pb = b.target.projectPath ? normalizePath(b.target.projectPath) : ''
      if (pa !== pb) return pa.localeCompare(pb)
      return labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' })
    })
    groups.push({ target, servers: list })
  }
  return groups
}

/** Unique project folders used by project/local scoped servers, sorted by folder name. */
export function projectPaths(servers: readonly InstalledServer[]): string[] {
  const seen = new Map<string, string>()
  for (const server of servers) {
    const path = server.target.projectPath
    if (path && !seen.has(normalizePath(path))) seen.set(normalizePath(path), path)
  }
  return [...seen.values()].sort((a, b) => folderName(a).localeCompare(folderName(b)))
}

/** Count of tools per app (all apps present, zero when none). */
export function countByTarget(servers: readonly InstalledServer[]): Record<TargetId, number> {
  const counts = Object.fromEntries(TARGET_ORDER.map((t) => [t, 0])) as Record<TargetId, number>
  for (const server of servers) counts[server.target.target]++
  return counts
}

/** Does a setting name look like it holds a secret (key, token, password…)? */
export function looksSecret(name: string): boolean {
  return /(key|token|secret|passw(or)?d|pass$|auth|bearer|credential|cookie|session|private|pat$)/i.test(name)
}

export interface EditableValue {
  kind: 'env' | 'header'
  name: string
  value: string
  secret: boolean
}

/** Connection strings with a password inside ("postgresql://user:pw@host/db"). */
const CREDENTIALS_IN_URL = /:\/\/[^/\s:@]+:[^@/\s]+@/

/** The values a person can change without touching the command (env vars or headers). */
export function editableValues(config: ServerConfig): EditableValue[] {
  const secret = (name: string, value: string): boolean => looksSecret(name) || CREDENTIALS_IN_URL.test(value)
  if (config.type === 'stdio') {
    return Object.entries(config.env ?? {}).map(([name, value]) => ({ kind: 'env', name, value, secret: secret(name, value) }))
  }
  return Object.entries(config.headers ?? {}).map(([name, value]) => ({ kind: 'header', name, value, secret: secret(name, value) }))
}

/** A copy of `config` with new env / header values (by name). */
export function withValues(config: ServerConfig, values: Record<string, string>): ServerConfig {
  if (config.type === 'stdio') {
    const env = { ...(config.env ?? {}) }
    for (const [name, value] of Object.entries(values)) if (name in env) env[name] = value
    return { ...config, env }
  }
  const headers = { ...(config.headers ?? {}) }
  for (const [name, value] of Object.entries(values)) if (name in headers) headers[name] = value
  return { ...config, headers }
}
