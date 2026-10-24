/**
 * claude-setup-mcp: Claude Setup as a stdio MCP server, so Claude can search, install and fix its
 * own setup. Started by Claude Desktop / Claude Code / VS Code as
 *   <Claude Setup executable> <…>/out/main/mcp.js   with ELECTRON_RUN_AS_NODE=1
 * stdout carries JSON-RPC only — everything else goes to stderr.
 */
import { format } from 'node:util'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createCore, type Core } from '@core/index'
import { selfLaunchFromEntry } from '@core/self/launch'
import type { LogEvent } from '@shared/types'
import { version } from '../../package.json'
import { buildMcpServer } from './tools'

const debug = !!process.env.CLAUDE_SETUP_DEBUG

/** Redirect console output that would corrupt the JSON-RPC stream on stdout. */
function protectStdout(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(format(...args) + '\n')
  }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
}

function logToStderr(event: LogEvent): void {
  if (event.level === 'warn' || event.level === 'error' || debug) {
    process.stderr.write(`[claude-setup] ${event.level} ${event.scope}: ${event.message}\n`)
  }
}

protectStdout()

// In the bundle this file is out/main/mcp.js; cli.js and mcp.js sit side by side.
const entryDir = typeof __dirname === 'string' ? __dirname : process.cwd()

let corePromise: Promise<Core> | null = null

/** One shared core per process, created on first use and recreated if creation failed. */
function getCore(): Promise<Core> {
  if (!corePromise) {
    const launch = selfLaunchFromEntry({
      platform: process.platform,
      execPath: process.execPath,
      entryDir,
      electron: !!process.versions.electron,
      env: process.env
    })
    corePromise = createCore({ surface: 'mcp', appVersion: version, packaged: entryDir.includes('app.asar'), selfMcpConfig: launch.config })
      .then((core) => {
        core.ctx.events.on('log', logToStderr)
        return core
      })
      .catch((err: unknown) => {
        corePromise = null
        throw new Error(`Claude Setup could not start: ${err instanceof Error ? err.message : String(err)}`)
      })
  }
  return corePromise
}

const handle = serveStdio(() => buildMcpServer(getCore, version), {
  onerror: (err) => process.stderr.write(`[claude-setup] transport error: ${err.message}\n`)
})

// Warm the core up while the client performs its handshake.
void getCore().catch((err: Error) => process.stderr.write(`[claude-setup] ${err.message}\n`))

let closing = false
async function shutdown(code: number): Promise<void> {
  if (closing) return
  closing = true
  const forceExit = setTimeout(() => process.exit(code), 2500)
  forceExit.unref()
  await handle.close().catch(() => {})
  const core = corePromise ? await corePromise.catch(() => null) : null
  await core?.dispose().catch(() => {})
  process.exit(code)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
// Claude Code on Windows closes stdin to stop a server (then kills it 300 ms later).
process.stdin.on('end', () => void shutdown(0))
process.stdin.on('close', () => void shutdown(0))
process.on('uncaughtException', (err) => process.stderr.write(`[claude-setup] unexpected error: ${err.stack ?? err.message}\n`))
process.on('unhandledRejection', (reason) =>
  process.stderr.write(`[claude-setup] unexpected error: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`)
)
process.stderr.write(`[claude-setup] MCP server ${version} ready on stdio\n`)
