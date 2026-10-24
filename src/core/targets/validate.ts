/** Validation shared by every target: server names, Claude Desktop's entry schema, ServerConfig sanity. */
import type { RemoteServerConfig, ServerConfig } from '@shared/types'
import { isPlainObject } from '../fs/json'

/** Remote (http / sse) config? A type guard, so both branches narrow correctly. */
export function isRemoteConfig(config: ServerConfig): config is RemoteServerConfig {
  return config.type === 'http' || config.type === 'sse'
}

/** Claude Desktop log file names + Claude Code rules: letters, digits, '-' and '_' only. */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Names Claude Code refuses (built-in servers). */
export const CLAUDE_CODE_RESERVED_NAMES = ['workspace', 'claude-in-chrome', 'computer-use']

/** Friendly problem with a server name, or null when it is fine. */
export function serverNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Give the server a name.'
  if (name.length > 64) return 'Server names can be at most 64 characters long.'
  if (!SERVER_NAME_RE.test(name)) return `"${name}" can't be used as a server name. Use only letters, numbers, "-" and "_" (no spaces).`
  return null
}

/** Claude Code reserves a few names for built-in servers. */
export function isClaudeCodeReserved(name: string): boolean {
  return CLAUDE_CODE_RESERVED_NAMES.includes(name.toLowerCase())
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string')
}

/**
 * Problems Claude Desktop's zod schema would find in one mcpServers entry
 * (command string required, args strings only, env string values only). Empty = valid.
 */
export function desktopEntryProblems(entry: unknown): string[] {
  if (!isPlainObject(entry)) return ['the entry is not an object']
  const problems: string[] = []
  if (typeof entry.command !== 'string' || !entry.command.trim()) problems.push('"command" is missing')
  if (entry.args !== undefined && !isStringArray(entry.args)) problems.push('"args" must be a list of text values')
  if (entry.env !== undefined && !isStringRecord(entry.env)) {
    problems.push('"env" values must all be text (put numbers and true/false in quotes)')
  }
  return problems
}

/** Names of mcpServers entries Claude Desktop would skip. */
export function invalidDesktopEntries(servers: Record<string, unknown>): string[] {
  return Object.entries(servers)
    .filter(([name, entry]) => !SERVER_NAME_RE.test(name) || desktopEntryProblems(entry).length > 0)
    .map(([name]) => name)
}

/** Basic sanity of a normalized ServerConfig coming from callers (IPC / MCP / CLI). Null when fine. */
export function serverConfigProblem(config: unknown): string | null {
  if (!isPlainObject(config)) return 'The server settings are missing.'
  const type = config.type ?? 'stdio'
  if (type === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim()) return 'Enter the command that starts the server (for example "npx").'
    if (config.args !== undefined && !isStringArray(config.args)) return 'Arguments must be a list of text values.'
    if (config.env !== undefined && !isStringRecord(config.env)) return 'Environment variable values must be text.'
    if (config.cwd !== undefined && typeof config.cwd !== 'string') return 'The working folder must be a path.'
    return null
  }
  if (type === 'http' || type === 'sse') {
    if (typeof config.url !== 'string' || !config.url.trim()) return 'Enter the server address (URL).'
    let url: URL
    try {
      url = new URL(config.url)
    } catch {
      return `"${config.url}" is not a valid web address.`
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return 'The server address must start with https:// (or http:// for local servers).'
    }
    if (config.headers !== undefined && !isStringRecord(config.headers)) return 'Header values must be text.'
    return null
  }
  return `Unknown server type "${String(type)}". Use stdio, http or sse.`
}

/** Normalize a caller-supplied config: default type, trimmed command, no empty optional fields. */
export function normalizeServerConfig(config: ServerConfig): ServerConfig {
  if (isRemoteConfig(config)) {
    const headers = config.headers && Object.keys(config.headers).length ? { ...config.headers } : undefined
    return headers ? { type: config.type, url: config.url.trim(), headers } : { type: config.type, url: config.url.trim() }
  }
  const out: ServerConfig = { type: 'stdio', command: config.command.trim() }
  if (config.args?.length) out.args = [...config.args]
  if (config.env && Object.keys(config.env).length) out.env = { ...config.env }
  if (config.cwd?.trim()) out.cwd = config.cwd.trim()
  return out
}
