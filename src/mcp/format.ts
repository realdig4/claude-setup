/**
 * Text/structured formatting for MCP tool results (also reused by the CLI for labels).
 * Results stay small: Claude Code warns above ~10k tokens and saves results over 50k characters
 * to a file, so text is capped and long lists are trimmed. Secret values are never echoed.
 */
import type {
  CatalogServer,
  InstallOption,
  InstalledServer,
  ServerConfig,
  TargetChangeResult,
  TargetId,
  TargetRef,
  TestResult
} from '@shared/types'

/** Shown wherever Claude Code is pointed at a third-party model. */
export const THIRD_PARTY_CAVEAT = "Note: Anthropic doesn't support routing Claude Code to non-Claude models; some features may not work."

/** Maximum characters of text in one tool result. */
export const MAX_TEXT_CHARS = 20_000
/** Maximum characters of JSON in one structuredContent payload. */
export const MAX_STRUCTURED_CHARS = 40_000

/** Display names of the apps. */
export const TARGET_LABELS: Record<TargetId, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  vscode: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf'
}

/** A text content block of a tool result. */
export interface ToolTextContent {
  type: 'text'
  text: string
}

/** Tool result shape returned by every handler. */
export interface ToolResult {
  [key: string]: unknown
  content: ToolTextContent[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** Error for invalid input or an expected failure; its message is shown to the model as-is. */
export class UserError extends Error {}

/** Display name for a target id. */
export function targetLabel(id: TargetId | string): string {
  return TARGET_LABELS[id as TargetId] ?? id
}

/** "Claude Code (project: C:/work/app)" */
export function describeRef(ref: TargetRef): string {
  const label = targetLabel(ref.target)
  if (!ref.scope) return label
  if (ref.scope === 'user') return `${label} (user)`
  return `${label} (${ref.scope}${ref.projectPath ? `: ${ref.projectPath}` : ''})`
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function truncate(text: string | undefined | null, max: number): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : flat
}

/** Keep the end of a long text (e.g. a server's stderr). */
export function tail(text: string | undefined, maxChars: number, maxLines = 20): string {
  if (!text) return ''
  const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-maxLines).join('\n')
  return lines.length > maxChars ? '…' + lines.slice(-(maxChars - 1)) : lines
}

/** Quote an argument for display when it contains spaces. */
function displayArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

/** One-line description of how a server is started: the command line or the URL. */
export function configLine(config: ServerConfig, max = 160): string {
  if (config.type === 'stdio') return truncate([config.command, ...(config.args ?? [])].map(displayArg).join(' '), max)
  return truncate(`${config.url} (${config.type})`, max)
}

/** Server config without secret values: env/header names only. */
export function redactConfig(config: ServerConfig): Record<string, unknown> {
  if (config.type === 'stdio') {
    return {
      type: 'stdio',
      command: config.command,
      args: config.args ?? [],
      envNames: Object.keys(config.env ?? {}),
      ...(config.cwd ? { cwd: config.cwd } : {})
    }
  }
  return { type: config.type, url: config.url, headerNames: Object.keys(config.headers ?? {}) }
}

/** Installed server entry for tool output (secrets removed). */
export function summarizeInstalled(s: InstalledServer): Record<string, unknown> {
  return {
    name: s.name,
    target: s.target.target,
    ...(s.target.scope ? { scope: s.target.scope } : {}),
    ...(s.target.projectPath ? { projectPath: s.target.projectPath } : {}),
    enabled: s.enabled,
    managedByUs: s.managedByUs,
    ...(s.catalogId ? { catalogId: s.catalogId } : {}),
    configPath: s.configPath,
    config: redactConfig(s.config)
  }
}

/** Names of required values (env vars / headers) an install option needs. */
export function requiredValueNames(option: InstallOption): string[] {
  return [...option.env, ...(option.headers ?? [])].filter((v) => v.required && v.default === undefined).map((v) => v.name)
}

/** Every install option needs a secret (API key or token). */
export function needsKey(server: CatalogServer): boolean {
  return server.install.length > 0 && server.install.every((o) => [...o.env, ...(o.headers ?? [])].some((v) => v.required && v.secret))
}

/** At least one install option runs remotely (nothing to install locally). */
export function hasRemote(server: CatalogServer): boolean {
  return server.install.some((o) => o.kind === 'remote' || o.transport !== 'stdio')
}

/** Compact catalog entry for search results. */
export function summarizeCatalogServer(s: CatalogServer): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: truncate(s.description, 240),
    ...(s.publisher ? { publisher: s.publisher } : {}),
    official: !!s.official,
    verified: !!s.verified,
    remote: hasRemote(s),
    needsKey: needsKey(s),
    categories: s.categories.slice(0, 4),
    installOptions: s.install.map((o) => o.id)
  }
}

/** Detailed catalog entry (get_mcp_server). */
export function detailCatalogServer(s: CatalogServer): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: truncate(s.longDescription || s.description, 1500),
    publisher: s.publisher,
    repository: s.repository,
    homepage: s.homepage,
    categories: s.categories,
    official: !!s.official,
    verified: !!s.verified,
    stars: s.stars,
    version: s.version,
    updatedAt: s.updatedAt,
    install: s.install.map((o) => ({
      id: o.id,
      kind: o.kind,
      label: o.label,
      transport: o.transport,
      runtime: o.runtime,
      ...(o.package ? { package: o.package } : {}),
      ...(o.url ? { url: o.url } : {}),
      env: o.env.map((e) => ({ name: e.name, required: e.required, secret: e.secret, description: truncate(e.description, 200) })),
      headers: (o.headers ?? []).map((h) => ({ name: h.name, required: h.required, secret: h.secret, description: truncate(h.description, 200) })),
      args: (o.argsSpec ?? []).map((a) => ({ name: a.name, required: a.required, repeatable: !!a.repeatable, description: truncate(a.description, 200) })),
      ...(o.notes ? { notes: truncate(o.notes, 400) } : {})
    }))
  }
}

/** Human summary of per-target change results. */
export function formatChangeResults(results: TargetChangeResult[]): string {
  return results
    .map((r) => {
      const extras = [r.configPath ? `file: ${r.configPath}` : '', r.backupId ? `backup: ${r.backupId}` : '', r.needsRestart ? 'restart needed' : '']
        .filter(Boolean)
        .join(', ')
      return `${r.ok ? '✔' : '✘'} ${describeRef(r.target)}: ${r.message}${extras ? ` (${extras})` : ''}`
    })
    .join('\n')
}

/** Change results for structuredContent (drops the raw `written` entry, which may contain secrets). */
export function changeResultsData(results: TargetChangeResult[]): Array<Record<string, unknown>> {
  return results.map((r) => ({
    target: r.target.target,
    ...(r.target.scope ? { scope: r.target.scope } : {}),
    ...(r.target.projectPath ? { projectPath: r.target.projectPath } : {}),
    ok: r.ok,
    message: r.message,
    ...(r.configPath ? { configPath: r.configPath } : {}),
    ...(r.backupId ? { backupId: r.backupId } : {}),
    ...(r.needsRestart ? { needsRestart: true } : {})
  }))
}

/** Human summary of a connection test. */
export function formatTestResult(t: TestResult, label: string): string {
  const seconds = (t.ms / 1000).toFixed(1)
  if (t.ok) {
    const who = [t.serverName, t.serverVersion].filter(Boolean).join(' ')
    const names = t.tools.map((x) => x.name)
    const shown = names.slice(0, 40).join(', ')
    return [
      `✔ ${label} works (connected in ${seconds} s${who ? ` to ${who}` : ''}${t.protocol ? `, protocol ${t.protocol}` : ''}).`,
      names.length ? `${names.length} tool${names.length === 1 ? '' : 's'}: ${shown}${names.length > 40 ? ', …' : ''}` : 'The server offers no tools.'
    ].join('\n')
  }
  const lines = [`✘ ${label} failed${t.kind ? ` (${t.kind})` : ''} after ${seconds} s: ${truncate(t.error ?? 'unknown error', 600)}`]
  if (t.hint) lines.push(`Hint: ${t.hint}`)
  const err = tail(t.stderr, 1500, 15)
  if (err) lines.push('Server output (last lines):', err)
  return lines.join('\n')
}

/** Connection test result for structuredContent (stderr trimmed). */
export function testResultData(t: TestResult): Record<string, unknown> {
  return {
    ok: t.ok,
    ...(t.kind ? { kind: t.kind } : {}),
    ms: t.ms,
    ...(t.serverName ? { serverName: t.serverName } : {}),
    ...(t.serverVersion ? { serverVersion: t.serverVersion } : {}),
    ...(t.protocol ? { protocol: t.protocol } : {}),
    tools: t.tools.slice(0, 100).map((x) => ({ name: x.name, ...(x.description ? { description: truncate(x.description, 160) } : {}) })),
    ...(t.error ? { error: truncate(t.error, 600) } : {}),
    ...(t.hint ? { hint: t.hint } : {}),
    ...(t.stderr ? { stderrTail: tail(t.stderr, 1500, 15) } : {})
  }
}

/** Cap text to MAX_TEXT_CHARS, keeping the beginning. */
export function capText(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max - 80).trimEnd() + '\n… (output shortened — narrow your request to see more)'
}

/**
 * Shrink a structured payload under `max` JSON characters by trimming its longest array
 * (repeatedly), recording `truncated: true`.
 */
export function capStructured<T extends Record<string, unknown>>(data: T, max = MAX_STRUCTURED_CHARS): T & { truncated?: boolean } {
  let out: Record<string, unknown> = data
  for (let i = 0; i < 40 && JSON.stringify(out).length > max; i++) {
    const arrays = Object.entries(out).filter(([, v]) => Array.isArray(v) && v.length > 1) as Array<[string, unknown[]]>
    if (!arrays.length) break
    const [key, arr] = arrays.sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0]
    out = { ...out, [key]: arr.slice(0, Math.max(1, Math.floor(arr.length * 0.6))), truncated: true }
  }
  return out as T & { truncated?: boolean }
}

/** Build a tool result: capped text plus optional structured data. */
export function toolResult(text: string, structured?: Record<string, unknown>, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text: capText(text) }] }
  if (structured) result.structuredContent = capStructured(structured)
  if (isError) result.isError = true
  return result
}

/** Plain-language message for any thrown value. */
export function errorText(err: unknown): string {
  if (err instanceof UserError) return err.message
  const message = err instanceof Error ? err.message : String(err)
  return message || 'Something went wrong.'
}

/** Tool error result with a friendly message. */
export function errorResult(err: unknown): ToolResult {
  return toolResult(errorText(err), undefined, true)
}
