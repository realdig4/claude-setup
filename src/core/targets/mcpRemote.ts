/**
 * mcp-remote bridge: lets stdio-only clients (Claude Desktop's config file) use remote HTTP/SSE servers.
 *   npx -y mcp-remote@0.15.2 <url> --transport http-only|sse-only [--allow-http] [--header Name:${VAR}]…
 * Header values live in `env` and are referenced as ${VAR} (mcp-remote expands them itself). The header argument
 * has no space after the colon because Claude Desktop on Windows does not quote arguments containing spaces.
 */
import { basename } from 'node:path'
import type { RemoteServerConfig, StdioServerConfig } from '@shared/types'

export const MCP_REMOTE_PACKAGE = 'mcp-remote'
/** Pinned, published 2026-10-20. */
export const MCP_REMOTE_VERSION = '0.15.2'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Environment that only describes the machine (added for GUI apps), not the server — ignored when parsing a bridge. */
export const PASS_THROUGH_ENV_NAMES = new Set(['PATH', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'])

/** Plain-http URLs that are not loopback need --allow-http. */
function needsAllowHttp(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && !LOOPBACK.has(u.hostname)
  } catch {
    return false
  }
}

/** Environment variable name that carries a header value, e.g. Authorization → MCP_HEADER_AUTHORIZATION. */
export function headerEnvName(header: string, taken: Record<string, string>): string {
  const base = `MCP_HEADER_${header.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE'}`
  let name = base
  for (let i = 2; Object.prototype.hasOwnProperty.call(taken, name); i++) name = `${base}_${i}`
  return name
}

/** Wrap a remote server in an mcp-remote stdio command. */
export function bridgeRemote(config: RemoteServerConfig): StdioServerConfig {
  const args = ['-y', `${MCP_REMOTE_PACKAGE}@${MCP_REMOTE_VERSION}`, config.url, '--transport', config.type === 'sse' ? 'sse-only' : 'http-only']
  if (needsAllowHttp(config.url)) args.push('--allow-http')
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    const varName = headerEnvName(name, env)
    env[varName] = value
    args.push('--header', `${name}:\${${varName}}`)
  }
  return Object.keys(env).length ? { type: 'stdio', command: 'npx', args, env } : { type: 'stdio', command: 'npx', args }
}

function commandName(command: string): string {
  return basename(command.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1)$/, '')
}

/**
 * Recognize an mcp-remote bridge and turn it back into the remote config it stands for.
 * Returns null for anything that would lose information in the round trip (unknown flags, extra env vars…).
 */
export function parseBridge(config: StdioServerConfig): RemoteServerConfig | null {
  let args = [...(config.args ?? [])]
  let cmd = commandName(config.command)
  if (cmd === 'cmd' && args[0]?.toLowerCase() === '/c' && args.length > 1) {
    cmd = commandName(args[1])
    args = args.slice(2)
  }
  if (cmd !== 'npx') return null
  const pkgIndex = args.findIndex((a) => /^mcp-remote(@[\w.\-^~]+)?$/.test(a))
  if (pkgIndex < 0) return null
  if (args.slice(0, pkgIndex).some((a) => a !== '-y' && a !== '--yes')) return null
  const url = args[pkgIndex + 1]
  if (!url || !/^https?:\/\//i.test(url)) return null
  const env = config.env ?? {}
  const usedVars = new Set<string>()
  const expand = (value: string) =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
      usedVars.add(name)
      return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : whole
    })
  let type: 'http' | 'sse' = 'http'
  const headers: Record<string, string> = {}
  for (let i = pkgIndex + 2; i < args.length; i++) {
    const a = args[i]
    if (a === '--transport' && args[i + 1]) {
      type = /^sse/i.test(args[++i]) ? 'sse' : 'http'
    } else if (a === '--header' && args[i + 1]) {
      const raw = args[++i]
      const colon = raw.indexOf(':')
      if (colon <= 0) return null
      headers[raw.slice(0, colon).trim()] = expand(raw.slice(colon + 1).replace(/^\s+/, ''))
    } else if (a === '--allow-http') {
      continue
    } else {
      return null
    }
  }
  const extraEnv = Object.keys(env).filter((k) => !usedVars.has(k) && !PASS_THROUGH_ENV_NAMES.has(k.toUpperCase()))
  if (extraEnv.length) return null
  if (config.cwd) return null
  return Object.keys(headers).length ? { type, url, headers } : { type, url }
}
