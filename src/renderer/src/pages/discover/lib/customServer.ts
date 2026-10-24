/**
 * Custom servers (Advanced "Add custom tool" and the JSON editor in My Tools): a form draft, validation,
 * conversion to ServerConfig and parsing of pasted JSON in the shapes people copy from READMEs.
 * Pure TypeScript (unit-tested in Node).
 */
import type { ServerConfig } from '@shared/types'

/** Server names allowed by Claude Desktop and Claude Code. */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Names Claude Code keeps for its built-in tools. */
export const RESERVED_NAMES = ['workspace', 'claude-in-chrome', 'computer-use']

export interface KeyValueRow {
  id: string
  key: string
  value: string
}

export interface CustomDraft {
  name: string
  /** 'command' = a program on this computer (stdio), 'url' = an online server. */
  kind: 'command' | 'url'
  command: string
  args: string[]
  env: KeyValueRow[]
  url: string
  transport: 'http' | 'sse'
  headers: KeyValueRow[]
}

export type DraftErrors = Partial<Record<'name' | 'command' | 'url' | 'env' | 'headers', string>>

let rowCounter = 0

/** A new empty key/value row (unique id for React keys). */
export function newRow(key = '', value = ''): KeyValueRow {
  rowCounter++
  return { id: `row-${rowCounter}`, key, value }
}

/** Rows from a record. */
export function rowsFrom(record: Record<string, string> | undefined): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => newRow(key, value))
}

/** Record from rows (blank names skipped). */
export function recordFrom(rows: readonly KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) out[key] = row.value
  }
  return out
}

export function emptyDraft(): CustomDraft {
  return { name: '', kind: 'command', command: '', args: [], env: [], url: '', transport: 'http', headers: [] }
}

/** Friendly problem with a server name, or null. */
export function nameProblem(name: string): string | null {
  const text = name.trim()
  if (!text) return 'Give the tool a short name.'
  if (text.length > 64) return 'Use at most 64 characters.'
  if (!SERVER_NAME_RE.test(text)) return 'Use only letters, numbers, “-” and “_” (no spaces).'
  if (RESERVED_NAMES.includes(text.toLowerCase())) return 'Claude Code uses this name for a built-in tool. Pick another one.'
  return null
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const HTTP_URL_RE = /^https?:\/\/[^\s/$.?#][^\s]*$/i

function rowsProblem(rows: readonly KeyValueRow[], kind: 'env' | 'headers'): string | undefined {
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) {
      if (row.value.trim()) return 'Every value needs a name.'
      continue
    }
    if (kind === 'env' && !ENV_NAME_RE.test(key)) return `“${key}” can’t be used: names use letters, numbers and _ and can’t start with a number.`
    if (kind === 'headers' && !HEADER_NAME_RE.test(key)) return `“${key}” isn’t a valid header name.`
    const norm = kind === 'headers' ? key.toLowerCase() : key
    if (seen.has(norm)) return `“${key}” is listed twice.`
    seen.add(norm)
    if (/[\r\n]/.test(row.value)) return `The value of “${key}” can’t contain line breaks.`
  }
  return undefined
}

/** Is `command` probably a whole command line typed into the program box ("npx -y foo")? */
function looksLikeCommandLine(command: string): boolean {
  const text = command.trim()
  return /\s/.test(text) && !/[\\/]/.test(text) && !/^".*"$/.test(text)
}

/** Problems in a draft by field (empty = valid). */
export function draftErrors(draft: CustomDraft): DraftErrors {
  const errors: DraftErrors = {}
  const name = nameProblem(draft.name)
  if (name) errors.name = name
  if (draft.kind === 'command') {
    const command = draft.command.trim()
    if (!command) errors.command = 'Enter the program to start, like npx, uvx or docker.'
    else if (looksLikeCommandLine(command)) {
      errors.command = 'Put only the program here (like “npx”) and each argument on its own line below.'
    }
    const env = rowsProblem(draft.env, 'env')
    if (env) errors.env = env
  } else {
    const url = draft.url.trim()
    if (!url) errors.url = 'Enter the server’s address.'
    else if (!HTTP_URL_RE.test(url)) errors.url = 'Enter a full address that starts with https:// (or http:// for local servers).'
    const headers = rowsProblem(draft.headers, 'headers')
    if (headers) errors.headers = headers
  }
  return errors
}

/** Split a typed command line ("npx -y foo") into program + arguments (quotes respected). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current) out.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started || current) out.push(current)
  return out
}

/** The ServerConfig a (valid) draft describes. */
export function draftToConfig(draft: CustomDraft): ServerConfig {
  if (draft.kind === 'url') {
    const headers = recordFrom(draft.headers)
    return { type: draft.transport, url: draft.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) }
  }
  const args = draft.args.map((a) => a.trim()).filter((a) => a.length > 0)
  const env = recordFrom(draft.env)
  return {
    type: 'stdio',
    command: draft.command.trim(),
    ...(args.length ? { args } : {}),
    ...(Object.keys(env).length ? { env } : {})
  }
}

/** A draft pre-filled from an existing config. */
export function configToDraft(name: string, config: ServerConfig): CustomDraft {
  if (config.type === 'stdio') {
    return { ...emptyDraft(), name, kind: 'command', command: config.command, args: [...(config.args ?? [])], env: rowsFrom(config.env) }
  }
  return { ...emptyDraft(), name, kind: 'url', url: config.url, transport: config.type, headers: rowsFrom(config.headers) }
}

const PREFIXES = [/^mcp[-_]server[-_]/i, /^server[-_]/i, /^mcp[-_]/i]
const SUFFIXES = [/[-_]mcp[-_]server$/i, /[-_]server[-_]mcp$/i, /[-_]mcp$/i, /[-_]server$/i]

/** A valid name from free text such as "@scope/server-foo", "ghcr.io/org/tool:1.2" or "Brave Search" (same rules as the core). */
export function suggestName(input: string): string {
  let s = input.trim()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  s = s.replace(/[@:](?:\d[\w.-]*|latest|sha256:[0-9a-f]+)$/i, '')
  s = s.replace(/\/+$/, '')
  let name = (s.split('/').filter(Boolean).pop() ?? s).replace(/^@/, '')
  for (const re of PREFIXES) if (re.test(name) && name.replace(re, '').length >= 2) name = name.replace(re, '')
  for (const re of SUFFIXES) if (re.test(name) && name.replace(re, '').length >= 2) name = name.replace(re, '')
  name = name
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .toLowerCase()
    .slice(0, 64)
    .replace(/[-_]+$/g, '')
  return SERVER_NAME_RE.test(name) ? name : 'server'
}

/** docker run options that take a value (the image is the first argument that is not an option). */
const DOCKER_VALUE_FLAGS = ['-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '--network', '-w', '--workdir']
  .concat(['--mount', '--env-file', '-u', '--user'])

/** A sensible name for a config (package, image or host name). */
export function nameForConfig(config: ServerConfig): string {
  if (config.type !== 'stdio') {
    try {
      const host = new URL(config.url).hostname.replace(/^(www|mcp|api|server)\./i, '')
      return suggestName(host.split('.')[0] || host)
    } catch {
      return 'remote'
    }
  }
  const args = config.args ?? []
  const tool = config.command.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.(cmd|exe|bat)$/, '') ?? ''
  if (tool === 'docker' || tool === 'podman') {
    const valueFlags = new Set(DOCKER_VALUE_FLAGS)
    const run = args.indexOf('run')
    for (let i = run + 1; run >= 0 && i < args.length; i++) {
      const arg = args[i] ?? ''
      if (valueFlags.has(arg)) i++
      else if (!arg.startsWith('-')) return suggestName(arg)
    }
  }
  const pkg = args.find((a) => !a.startsWith('-') && a !== 'run' && a !== 'tool')
  return suggestName(pkg ?? config.command)
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON
// ─────────────────────────────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeEntry(value: unknown): value is JsonRecord {
  return isRecord(value) && (typeof value.command === 'string' || typeof value.url === 'string' || typeof value.serverUrl === 'string')
}

function stringList(value: unknown, what: string): string[] | string {
  if (value === undefined) return []
  if (!Array.isArray(value)) return `${what} must be a list, like ["-y", "some-package"].`
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
    else if (typeof item === 'number' || typeof item === 'boolean') out.push(String(item))
    else return `${what} may only contain text.`
  }
  return out
}

function stringRecord(value: unknown, what: string): Record<string, string> | string {
  if (value === undefined) return {}
  if (!isRecord(value)) return `${what} must map names to values, like { "API_KEY": "…" }.`
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item)
    else return `The value of “${key}” in ${what} must be text.`
  }
  return out
}

/** Lenient conversion of one pasted entry (Claude, VS Code, Cursor or Windsurf style) to a ServerConfig. */
function entryToConfig(entry: JsonRecord): ServerConfig | string {
  const url = typeof entry.url === 'string' ? entry.url : typeof entry.serverUrl === 'string' ? entry.serverUrl : undefined
  if (url !== undefined) {
    if (!HTTP_URL_RE.test(url.trim())) return 'The "url" must start with https:// or http://.'
    const headers = stringRecord(entry.headers, '"headers"')
    if (typeof headers === 'string') return headers
    const type = typeof entry.type === 'string' && entry.type.toLowerCase() === 'sse' ? 'sse' : 'http'
    return { type, url: url.trim(), ...(Object.keys(headers).length ? { headers } : {}) }
  }
  if (typeof entry.command !== 'string' || !entry.command.trim()) return 'Add a "command" (the program to start) or a "url".'
  const args = stringList(entry.args, '"args"')
  if (typeof args === 'string') return args
  const env = stringRecord(entry.env, '"env"')
  if (typeof env === 'string') return env
  const config: ServerConfig = { type: 'stdio', command: entry.command.trim() }
  if (args.length) config.args = args
  if (Object.keys(env).length) config.env = env
  if (typeof entry.cwd === 'string' && entry.cwd.trim()) config.cwd = entry.cwd.trim()
  return config
}

export type ParseResult = { ok: true; name?: string; config: ServerConfig } | { ok: false; message: string }

/**
 * Parse JSON people paste from READMEs: a bare entry ({ "command": … } / { "url": … }), a named entry
 * ({ "github": { … } }) or a whole config file ({ "mcpServers": { … } } / VS Code's { "servers": { … } }).
 */
export function parseServerJson(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, message: 'Paste the JSON first.' }
  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    // People often copy just `"name": { … }` out of a bigger file.
    try {
      data = JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`)
    } catch {
      return { ok: false, message: 'That isn’t valid JSON. Check for missing quotes, commas or brackets.' }
    }
  }
  if (!isRecord(data)) return { ok: false, message: 'Paste an object that starts with { and ends with }.' }
  for (const key of ['mcpServers', 'servers', 'mcp_servers', 'context_servers']) {
    const group = data[key]
    if (!isRecord(group)) continue
    const first = Object.entries(group).find(([, entry]) => looksLikeEntry(entry))
    if (!first) return { ok: false, message: 'No server with a "command" or "url" was found in that JSON.' }
    const config = entryToConfig(first[1] as JsonRecord)
    return typeof config === 'string' ? { ok: false, message: config } : { ok: true, name: first[0], config }
  }
  if (looksLikeEntry(data)) {
    const config = entryToConfig(data)
    const name = typeof data.name === 'string' ? data.name : undefined
    return typeof config === 'string' ? { ok: false, message: config } : { ok: true, name, config }
  }
  const named = Object.entries(data).filter(([, entry]) => looksLikeEntry(entry))
  if (named.length >= 1) {
    const [name, entry] = named[0]!
    const config = entryToConfig(entry as JsonRecord)
    return typeof config === 'string' ? { ok: false, message: config } : { ok: true, name, config }
  }
  return { ok: false, message: 'Paste a server entry with a "command" or a "url".' }
}

export type ConfigCheck = { ok: true; config: ServerConfig } | { ok: false; message: string }

/** Strict check of an edited ServerConfig (the My Tools JSON editor). */
export function validateServerConfig(value: unknown): ConfigCheck {
  if (!isRecord(value)) return { ok: false, message: 'The settings must be an object, like { "command": "npx", "args": ["-y", "…"] }.' }
  const type = value.type ?? (typeof value.url === 'string' ? 'http' : 'stdio')
  if (type !== 'stdio' && type !== 'http' && type !== 'sse') return { ok: false, message: '"type" must be "stdio", "http" or "sse".' }
  if (type === 'stdio') {
    if (typeof value.command !== 'string' || !value.command.trim()) {
      return { ok: false, message: '"command" is missing — it’s the program to start, like "npx".' }
    }
    if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((a) => typeof a === 'string'))) {
      return { ok: false, message: '"args" must be a list of text values, like ["-y", "some-package"].' }
    }
    if (value.env !== undefined && !(isRecord(value.env) && Object.values(value.env).every((v) => typeof v === 'string'))) {
      return { ok: false, message: '"env" must map names to text values. Put numbers and true/false in quotes.' }
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') return { ok: false, message: '"cwd" must be a folder path.' }
    const config: ServerConfig = { type: 'stdio', command: value.command.trim() }
    if (Array.isArray(value.args) && value.args.length) config.args = value.args as string[]
    if (isRecord(value.env) && Object.keys(value.env).length) config.env = value.env as Record<string, string>
    if (typeof value.cwd === 'string' && value.cwd.trim()) config.cwd = value.cwd
    return { ok: true, config }
  }
  if (typeof value.url !== 'string' || !HTTP_URL_RE.test(value.url.trim())) {
    return { ok: false, message: '"url" must be a full address that starts with https:// or http://.' }
  }
  if (value.headers !== undefined && !(isRecord(value.headers) && Object.values(value.headers).every((v) => typeof v === 'string'))) {
    return { ok: false, message: '"headers" must map names to text values.' }
  }
  const config: ServerConfig = { type, url: value.url.trim() }
  if (isRecord(value.headers) && Object.keys(value.headers).length) config.headers = value.headers as Record<string, string>
  return { ok: true, config }
}

/** Parse + strictly validate editor text. */
export function parseConfigText(text: string): ConfigCheck {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    const detail = err instanceof Error ? err.message.replace(/^JSON\.parse: /, '') : ''
    return { ok: false, message: `That isn’t valid JSON${detail ? ` (${detail})` : ''}.` }
  }
  return validateServerConfig(data)
}
