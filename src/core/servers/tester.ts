/**
 * Connection test for any MCP server config, using the MCP SDK v2 client.
 * - stdio: spawn via StdioClientTransport (cross-spawn; npx/.cmd shims work on Windows), default legacy
 *   negotiation (the 'auto' mode would start the server twice), stderr tail (16 KB) captured.
 * - remote: Streamable HTTP first, legacy SSE as fallback (reversed for type 'sse'); 401/403 stop at once.
 * - Default timeout 60 s: the first npx / uvx / docker run downloads the server.
 * Failures are classified (TestFailureKind) and get a friendly hint.
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  SseError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type Transport
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { RemoteServerConfig, ServerConfig, StdioServerConfig, TestFailureKind, TestResult } from '@shared/types'
import { safeFixPath, safeRun, tryWhich } from '../targets/sys'
import { isRemoteConfig, serverConfigProblem } from '../targets/validate'
import { hintFor } from './hints'

export const DEFAULT_TEST_TIMEOUT_MS = 60_000
const STDERR_TAIL = 16_384
const CLIENT_INFO = { name: 'claude-setup', version: '0.1.0' }

/** Variables passed through to test processes on top of the SDK's safe default environment. */
const PASS_THROUGH_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'DOCKER_HOST',
  'LANG'
]

const NOT_RECOGNIZED = /is not recognized as an internal or external command|: command not found|command not found:/i

export interface TestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Does the command exist? true / false, or undefined when that can't be determined. */
async function commandExists(command: string, cwd?: string): Promise<boolean | undefined> {
  const exists = async (p: string) => {
    try {
      return (await stat(p)).isFile()
    } catch {
      return false
    }
  }
  if (isAbsolute(command)) return exists(command)
  if (/[\\/]/.test(command)) return exists(resolve(cwd ?? process.cwd(), command))
  const found = await tryWhich(command)
  return found === undefined ? undefined : !!found
}

function stdioEnv(config: StdioServerConfig): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASS_THROUGH_ENV) {
    const v = process.env[key]
    if (v) env[key] = v
  }
  for (const [k, v] of Object.entries(config.env ?? {})) {
    // Claude Desktop convention: a literal ${PATH} inside env.PATH means "the normal PATH".
    env[k] = k.toUpperCase() === 'PATH' ? v.replace(/\$\{PATH\}/g, process.env.PATH ?? '') : v
  }
  return env
}

interface Failure {
  kind: TestFailureKind
  error: string
  status?: number
}

function classify(err: unknown, stderr: string, stdio: boolean): Failure {
  const e = err as { message?: string; code?: unknown; status?: unknown }
  const message = String(e?.message ?? err)
  let status: number | undefined
  if (err instanceof SdkHttpError) status = err.status
  else if (err instanceof SseError && typeof err.code === 'number') status = err.code
  else if (typeof e?.status === 'number') status = e.status
  if (status === 401 || status === 403 || err instanceof UnauthorizedError) return { kind: 'auth-required', error: message, status }
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return { kind: 'timeout', error: message, status }
  if (e?.code === 'ENOENT' || (stdio && NOT_RECOGNIZED.test(stderr))) return { kind: 'command-not-found', error: message, status }
  if (err instanceof SdkError && err.code === SdkErrorCode.ConnectionClosed) {
    return { kind: stdio ? 'process-exited' : 'error', error: message, status }
  }
  if (err instanceof SseError) return { kind: 'sse-failed', error: message, status }
  return { kind: 'error', error: message, status }
}

function finish(started: number, config: ServerConfig, timeoutMs: number, failure: Failure, stderr: string): TestResult {
  const result: TestResult = { ok: false, kind: failure.kind, ms: Date.now() - started, tools: [], error: failure.error }
  const tail = stderr.trim()
  if (tail) result.stderr = tail
  result.hint = hintFor({ kind: failure.kind, error: failure.error, stderr: tail, status: failure.status, config, timeoutMs })
  return result
}

async function connectRemote(
  config: RemoteServerConfig,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ client: Client; transport: Transport }> {
  const url = new URL(config.url)
  const requestInit: RequestInit = { headers: { ...(config.headers ?? {}) } }
  const makers: Array<() => Transport> = [
    () => new StreamableHTTPClientTransport(url, { requestInit }),
    () => new SSEClientTransport(url, { requestInit })
  ]
  if (config.type === 'sse') makers.reverse()
  let firstError: unknown
  for (const make of makers) {
    const client = new Client(CLIENT_INFO)
    const transport = make()
    try {
      await client.connect(transport, { timeout: timeoutMs, signal })
      return { client, transport }
    } catch (err) {
      await client.close().catch(() => {})
      const kind = classify(err, '', false).kind
      // Signing in won't change with the other transport, and a server that never answered won't answer it either.
      if (kind === 'auth-required' || (firstError === undefined && kind === 'timeout')) throw err
      if (firstError === undefined) firstError = err
      else {
        // Prefer the error that carries an HTTP status (more useful hint), otherwise the first one.
        const firstHasStatus = classify(firstError, '', false).status !== undefined
        throw firstHasStatus || classify(err, '', false).kind === 'timeout' ? firstError : err
      }
    }
  }
  throw firstError
}

/** Test that a server starts and answers. Never throws. */
export async function testServer(config: ServerConfig, opts: TestOptions = {}): Promise<TestResult> {
  const started = Date.now()
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS)
  const problem = serverConfigProblem(config)
  if (problem) return finish(started, config, timeoutMs, { kind: 'invalid-config', error: problem }, '')

  let stderr = ''
  let client: Client | undefined
  let transport: Transport | undefined
  let stdioPid: number | null = null
  try {
    await safeFixPath()
    if (isRemoteConfig(config)) {
      const conn = await connectRemote(config, timeoutMs, opts.signal)
      client = conn.client
      transport = conn.transport
    } else {
      const exists = await commandExists(config.command, config.cwd)
      if (exists === false) {
        return finish(started, config, timeoutMs, { kind: 'command-not-found', error: `Command not found: ${config.command}` }, '')
      }
      const stdio = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        env: stdioEnv(config),
        stderr: 'pipe'
      })
      stdio.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL)
      })
      transport = stdio
      client = new Client(CLIENT_INFO)
      const connecting = client.connect(stdio, { timeout: timeoutMs, signal: opts.signal })
      stdioPid = stdio.pid
      await connecting
      stdioPid = stdio.pid ?? stdioPid
    }
    const caps = client.getServerCapabilities() ?? {}
    const tools = caps.tools ? (await client.listTools(undefined, { timeout: timeoutMs, signal: opts.signal })).tools : []
    const info = client.getServerVersion()
    const result: TestResult = {
      ok: true,
      ms: Date.now() - started,
      tools: tools.map((t) => {
        const tool: TestResult['tools'][number] = { name: t.name }
        if (t.title) tool.title = t.title
        if (t.description) tool.description = t.description
        return tool
      })
    }
    if (info?.name) result.serverName = info.name
    if (info?.version) result.serverVersion = info.version
    const protocol = client.getNegotiatedProtocolVersion() ?? client.getProtocolEra()
    if (protocol) result.protocol = protocol
    const instructions = client.getInstructions()
    if (instructions) result.instructions = instructions
    if (stderr.trim()) result.stderr = stderr.trim()
    return result
  } catch (err) {
    // Let the last stderr chunks of a crashed process arrive before reading them.
    await sleep(60)
    return finish(started, config, timeoutMs, classify(err, stderr, !isRemoteConfig(config)), stderr)
  } finally {
    const pid = stdioPid ?? (transport instanceof StdioClientTransport ? transport.pid : null)
    // On Windows, npx & co. run under cmd.exe: kill the whole tree so no orphaned node/python processes remain.
    if (process.platform === 'win32' && pid) await safeRun('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 })
    if (transport instanceof StreamableHTTPClientTransport) {
      await Promise.race([transport.terminateSession().catch(() => {}), sleep(2000)])
    }
    await client?.close().catch(() => {})
  }
}
