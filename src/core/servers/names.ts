/** Server-name helpers: turn catalog slugs, package names and URLs into valid config keys. */
import type { ServerConfig } from '@shared/types'
import { isRemoteConfig, SERVER_NAME_RE } from '../targets/validate'

const PREFIXES = [/^mcp[-_]server[-_]/i, /^server[-_]/i, /^mcp[-_]/i]
const SUFFIXES = [/[-_]mcp[-_]server$/i, /[-_]server[-_]mcp$/i, /[-_]mcp$/i, /[-_]server$/i]

/**
 * Make a valid server name ([A-Za-z0-9_-], ≤ 64 chars) from free text such as "@modelcontextprotocol/server-filesystem",
 * "io.github.github/github-mcp-server", "ghcr.io/org/tool:1.2" or "Brave Search". Falls back to "server".
 */
export function sanitizeServerName(input: string): string {
  let s = input.trim()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // URL scheme
  s = s.replace(/[@:](?:\d[\w.-]*|latest|sha256:[0-9a-f]+)$/i, '') // trailing version / tag / digest
  s = s.replace(/\/+$/, '')
  const last = s.split('/').filter(Boolean).pop() ?? s
  let name = last.replace(/^@/, '')
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
const DOCKER_VALUE_FLAGS = new Set([
  '-e',
  '--env',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '--name',
  '--network',
  '--net',
  '-w',
  '--workdir',
  '--mount',
  '--env-file',
  '-u',
  '--user',
  '--entrypoint',
  '--platform',
  '--pull'
])

/** Package / image argument of a launch command (npx, uvx, docker run, dnx…), when recognizable. */
function packageFromCommand(command: string, args: string[]): string | null {
  const cmd = command.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(cmd|exe|bat)$/, '')
  let rest = args
  let tool = cmd
  if (tool === 'cmd' && rest[0]?.toLowerCase() === '/c' && rest[1]) {
    tool = rest[1].toLowerCase().replace(/\.(cmd|exe|bat)$/, '')
    rest = rest.slice(2)
  }
  if (tool === 'docker' || tool === 'podman') {
    const run = rest.indexOf('run')
    if (run < 0) return null
    for (let i = run + 1; i < rest.length; i++) {
      const a = rest[i]
      if (DOCKER_VALUE_FLAGS.has(a)) i++
      else if (!a.startsWith('-')) return a
    }
    return null
  }
  if (['npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'dnx'].includes(tool) || (tool === 'uv' && rest[0] === 'tool')) {
    const from = rest.indexOf('--from')
    if (from >= 0 && rest[from + 1]) return rest[from + 1].replace(/[=<>!~].*$/, '')
    return rest.find((a) => !a.startsWith('-') && a !== 'run' && a !== 'tool') ?? null
  }
  if (tool === 'node' || tool === 'python' || tool === 'python3' || tool === 'deno' || tool === 'bun') {
    const script = rest.find((a) => !a.startsWith('-') && a !== 'run')
    return script ? script.replace(/\\/g, '/').split('/').pop()!.replace(/\.(m?js|ts|py)$/i, '') : null
  }
  return cmd
}

/** A sensible default name for a custom config (package, image, script or host name). */
export function nameFromConfig(config: ServerConfig): string {
  if (isRemoteConfig(config)) {
    try {
      const host = new URL(config.url).hostname.replace(/^(www|mcp|api|server)\./i, '')
      return sanitizeServerName(host.split('.')[0] || host)
    } catch {
      return 'remote'
    }
  }
  const pkg = packageFromCommand(config.command, config.args ?? [])
  return sanitizeServerName(pkg ?? config.command)
}

/** First name not in `taken` (base, base-2, base-3…), respecting the 64-character limit. */
export function uniqueServerName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const candidate = base.slice(0, 64 - suffix.length) + suffix
    if (!used.has(candidate)) return candidate
  }
}
