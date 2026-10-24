/** Helpers to read the many slightly different native server entry shapes leniently. */
import type { RemoteServerConfig, StdioServerConfig } from '@shared/types'
import { isPlainObject } from '../fs/json'

/** Strings kept; numbers/booleans stringified; anything else dropped. */
export function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean').map(String)
}

/** String values kept; numbers/booleans stringified; null/objects dropped (VS Code allows numbers and null). */
export function toStringRecord(v: unknown): Record<string, string> | undefined {
  if (!isPlainObject(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k] = String(x)
  }
  return out
}

/** stdio entry {command, args?, env?, cwd?} → StdioServerConfig (null without a command). */
export function parseStdioEntry(entry: Record<string, unknown>): StdioServerConfig | null {
  if (typeof entry.command !== 'string' || !entry.command.trim()) return null
  const cfg: StdioServerConfig = { type: 'stdio', command: entry.command }
  const args = toStringArray(entry.args)
  if (args?.length) cfg.args = args
  const env = toStringRecord(entry.env)
  if (env && Object.keys(env).length) cfg.env = env
  if (typeof entry.cwd === 'string' && entry.cwd.trim()) cfg.cwd = entry.cwd
  return cfg
}

/** Remote entry → RemoteServerConfig. `type` may be http / streamable-http / sse or absent (guessed from the URL). */
export function parseRemoteEntry(entry: Record<string, unknown>, urlKeys: string[] = ['url']): RemoteServerConfig | null {
  const key = urlKeys.find((k) => typeof entry[k] === 'string' && (entry[k] as string).trim())
  if (!key) return null
  const url = (entry[key] as string).trim()
  const declared = typeof entry.type === 'string' ? entry.type : typeof entry.transport === 'string' ? entry.transport : ''
  const rawType = declared.toLowerCase()
  const isHttp = rawType === 'http' || rawType === 'streamable-http' || rawType === 'streamablehttp'
  const type: 'http' | 'sse' = rawType === 'sse' ? 'sse' : isHttp ? 'http' : guessRemoteType(url)
  const cfg: RemoteServerConfig = { type, url }
  const headers = toStringRecord(entry.headers)
  if (headers && Object.keys(headers).length) cfg.headers = headers
  return cfg
}

/** URLs ending in /sse are almost always legacy SSE endpoints; everything else is Streamable HTTP. */
export function guessRemoteType(url: string): 'http' | 'sse' {
  try {
    return /\/sse\/?$/i.test(new URL(url).pathname) ? 'sse' : 'http'
  } catch {
    return 'http'
  }
}

/** A stdio config as a plain native object: {command, args, env?, cwd?}. */
export function stdioNative(
  cfg: StdioServerConfig,
  opts: { withType?: boolean; alwaysEnv?: boolean; withCwd?: boolean } = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (opts.withType) out.type = 'stdio'
  out.command = cfg.command
  out.args = [...(cfg.args ?? [])]
  if (opts.alwaysEnv || (cfg.env && Object.keys(cfg.env).length)) out.env = { ...(cfg.env ?? {}) }
  if (opts.withCwd && cfg.cwd) out.cwd = cfg.cwd
  return out
}
