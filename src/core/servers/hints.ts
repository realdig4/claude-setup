/** Turn a failed connection test into one friendly next step for people with little technical background. */
import type { ServerConfig, TestFailureKind } from '@shared/types'
import { isRemoteConfig } from '../targets/validate'

export interface HintInput {
  kind: TestFailureKind
  error?: string
  stderr?: string
  /** HTTP status for remote servers. */
  status?: number
  config: ServerConfig
  timeoutMs: number
}

export type Tool = 'node' | 'uv' | 'docker' | 'python' | 'dotnet' | 'other'

const NOT_ENV = /^(ERR_|MODULE_NOT_FOUND$|HTTP_\d|ENOENT$|EACCES$|EPERM$|ECONNREFUSED$|ETIMEDOUT$|ENOTFOUND$|UNABLE_TO_)/
const ENV_LINE = new RegExp(
  [
    'missing',
    'not set',
    'is required',
    'are required',
    'required env',
    'must be set',
    'must provide',
    'please set',
    'please provide',
    'not defined',
    'undefined',
    'not configured',
    'not provided',
    'no api key',
    'environment variable',
    'env var',
    'keyerror'
  ].join('|')
)

/** Environment variable names a server complained about in its error output (at most five). */
export function missingEnvVars(text: string | undefined): string[] {
  if (!text) return []
  const found = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (!ENV_LINE.test(line.toLowerCase())) continue
    for (const m of line.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]|[A-Z]{2,}(?:KEY|TOKEN|SECRET))\b/g)) {
      if (!NOT_ENV.test(m[1])) found.add(m[1])
      if (found.size >= 5) return [...found]
    }
  }
  return [...found]
}

/** Which runtime a stdio command needs. */
export function commandTool(config: ServerConfig): { tool: Tool; command: string } {
  if (isRemoteConfig(config)) return { tool: 'other', command: '' }
  let command = config.command
  const args = config.args ?? []
  const base = (c: string) => c.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '')
  if (base(command) === 'cmd' && args[0]?.toLowerCase() === '/c' && args[1]) command = args[1]
  const b = base(command)
  if (['npx', 'npm', 'node', 'pnpm', 'pnpx', 'yarn'].includes(b)) return { tool: 'node', command: b }
  if (b === 'uvx' || b === 'uv') return { tool: 'uv', command: b }
  if (b === 'docker' || b === 'podman') return { tool: 'docker', command: b }
  if (['python', 'python3', 'py', 'pip', 'pipx'].includes(b)) return { tool: 'python', command: b }
  if (b === 'dnx' || b === 'dotnet') return { tool: 'dotnet', command: b }
  return { tool: 'other', command }
}

const INSTALL_HINT: Record<Exclude<Tool, 'other'>, string> = {
  node:
    "Node.js isn't installed (or can't be found). Install the LTS version from nodejs.org — Claude Setup can install it for you — then test again.",
  uv: "uv (which provides uvx) isn't installed. Install it from docs.astral.sh/uv — Claude Setup can install it for you — then test again.",
  docker: "Docker isn't installed. Install Docker Desktop, start it, then test again.",
  python: "Python isn't installed (or can't be found). Install it from python.org, or use the uvx version of this server if there is one.",
  dotnet: "The .NET 10 SDK (which provides dnx) isn't installed. Install it from dot.net, then test again."
}

/** The shell / spawn could not find the program itself (not a missing file used by a running server). */
const CMD_NOT_FOUND_RE = /is not recognized as an internal or external command|: command not found|command not found: |\bspawn \S+ ENOENT/i
/** A running server could not find a file or folder from its settings. */
const PATH_NOT_FOUND_RE = /ENOENT: no such file or directory, \w+ '([^']+)'|no such file or directory: '([^']+)'/i
const NODE_TOO_OLD_RE =
  /requires Node(?:\.js)? (?:version )?(?:>=|at least|v)?\s?\d+|engine "node" is incompatible|Unsupported engine|SyntaxError: Unexpected token/i
const DOCKER_DOWN_RE =
  /Cannot connect to the Docker daemon|docker daemon is not running|Is the docker daemon running|error during connect|dockerDesktopLinuxEngine|docker_engine.*(?:cannot find|not exist)|open \/\/\.\/pipe\/docker/i

/** One friendly next step for a failed test. */
export function hintFor(input: HintInput): string {
  const text = `${input.stderr ?? ''}\n${input.error ?? ''}`
  const remote = isRemoteConfig(input.config)
  const { tool, command } = commandTool(input.config)
  const seconds = Math.round(input.timeoutMs / 1000)

  if (input.kind === 'invalid-config') return `Check the server settings: ${input.error ?? 'something is missing'}.`
  if (input.kind === 'auth-required' || input.status === 401 || input.status === 403) {
    return (
      'This server needs you to sign in. Claude Code and Claude Desktop sign in for you (OAuth) when they connect; ' +
      'if the provider gave you an API key or token instead, add it as a header (for example Authorization: Bearer <token>).'
    )
  }
  if (!remote && tool === 'docker' && DOCKER_DOWN_RE.test(text)) {
    return "Docker Desktop isn't running. Start it, wait until it says the engine is running, then test again."
  }
  if (input.kind === 'command-not-found' || (!remote && CMD_NOT_FOUND_RE.test(text) && input.kind !== 'timeout')) {
    if (tool !== 'other') return INSTALL_HINT[tool]
    return (
      `"${command}" wasn't found. Check that the program is installed and the command is spelled correctly ` +
      '(a full path to the program also works).'
    )
  }
  if (/E404|404 Not Found - GET https?:\/\/registry\.npmjs/i.test(text)) {
    return "The package wasn't found on npm. Check the package name and version."
  }
  if (/ETARGET|No matching version found/i.test(text)) return "That version of the package doesn't exist. Try the latest version instead."
  if (/No solution found when resolving|was not found in the package registry|not found in the package registry/i.test(text)) {
    return "The Python package wasn't found. Check its name and version."
  }
  const missingPath = remote ? null : PATH_NOT_FOUND_RE.exec(text)
  if (missingPath) return `"${missingPath[1] ?? missingPath[2]}" doesn't exist. Check the folders and files in this server's settings.`
  const envVars = missingEnvVars(input.stderr)
  if (envVars.length) {
    return `Set ${envVars.join(', ')} in this server's settings (usually an API key or token from the service's website), then test again.`
  }
  if (NODE_TOO_OLD_RE.test(text)) {
    return 'Your Node.js is too old for this server. Install the current LTS version from nodejs.org, then test again.'
  }
  if (/ModuleNotFoundError|No module named/i.test(text)) {
    return "A Python module is missing. Use the server's uvx launch option if it has one — uvx installs what it needs."
  }
  if (/UNABLE_TO_(?:GET|VERIFY)|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|certificate/i.test(text)) {
    return (
      "A security certificate couldn't be verified. " +
      'If you are behind a company proxy, ask IT for its certificate and set NODE_EXTRA_CA_CERTS.'
    )
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|network is unreachable|fetch failed/i.test(text)) {
    return remote
      ? "Couldn't reach the server. Check the address, your internet connection, VPN or proxy, then test again."
      : 'There was a network problem while downloading or starting the server. Check your internet connection, VPN or proxy, then test again.'
  }
  if (/EACCES|permission denied|access is denied/i.test(text)) {
    return 'Permission was denied while starting the server. Check that you can run this program and open the folders it uses.'
  }
  if (input.kind === 'timeout') {
    if (remote) return `The server didn't answer within ${seconds} seconds. Check the address and your connection, then test again.`
    const fetcher = tool === 'node' ? 'npx' : tool === 'uv' ? 'uvx' : tool === 'docker' ? 'Docker' : null
    return fetcher
      ? `The server didn't answer within ${seconds} seconds. ` +
          `The first start can be slow because ${fetcher} downloads the server — wait a minute and test again.`
      : `The server didn't answer within ${seconds} seconds. ` +
          'It may be waiting for something (like a sign-in window) — check the messages below and test again.'
  }
  if (input.status === 410) return 'This server retired its old connection type. Use its /mcp address instead of /sse.'
  if (input.status === 404 || input.status === 405) {
    return 'Nothing answered at that address. Check the URL — MCP addresses usually end in /mcp (older servers use /sse).'
  }
  if (input.status && input.status >= 500) return `The server had a problem (HTTP ${input.status}). Try again in a little while.`
  if (input.kind === 'sse-failed') {
    return "Couldn't connect with either connection type. Check the address — MCP addresses usually end in /mcp (older servers use /sse)."
  }
  if (input.kind === 'process-exited') {
    return (
      'The server stopped right after starting. ' +
      'The messages below usually say why — often a missing setting, a wrong folder path or an outdated runtime.'
    )
  }
  return 'Something went wrong while talking to the server. The details below may help.'
}
