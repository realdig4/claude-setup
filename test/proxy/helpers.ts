/** Test helpers for the proxy: a minimal CoreContext, a scriptable mock OpenAI upstream, SSE parsing. */
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import type { CoreContext, Logger } from '@core/context'
import { CoreEmitter } from '@core/events'
import { BackupManager } from '@core/fs/backups'
import { createMemorySecretStore, type SecretStore } from '@core/secrets'
import { StateStore } from '@core/state'

/** CoreContext backed by a real StateStore in `dataDir` and an in-memory secret store. */
export async function makeContext(dataDir: string, secrets: SecretStore = createMemorySecretStore()): Promise<CoreContext> {
  const state = new StateStore(join(dataDir, 'state.json'))
  await state.load()
  const noop = (): void => {}
  const log: Logger = { debug: noop, info: noop, warn: noop, error: noop }
  return {
    options: { surface: 'cli', appVersion: '9.9.9-test' },
    dataDir,
    cacheDir: join(dataDir, 'cache'),
    state,
    secrets,
    backups: new BackupManager(join(dataDir, 'backups'), () => 5),
    events: new CoreEmitter(),
    log
  }
}

/** A port that was free a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface UpstreamCall {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
  /** Resolves when the connection for this call closes (used to verify aborts). */
  closed: Promise<void>
}

export type UpstreamHandler = (call: UpstreamCall, res: http.ServerResponse) => void | Promise<void>

/** Scriptable OpenAI-compatible upstream on 127.0.0.1 (records every call). */
export class MockUpstream {
  readonly calls: UpstreamCall[] = []
  handler: UpstreamHandler = (_call, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'no handler configured' } }))
  }
  port = 0
  /** Number of TCP connections accepted (keep-alive reuse keeps this low). */
  connections = 0
  private readonly server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        // keep raw text
      }
      const call: UpstreamCall = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        closed: new Promise<void>((resolve) => res.on('close', () => resolve()))
      }
      this.calls.push(call)
      void Promise.resolve(this.handler(call, res)).catch(() => res.destroy())
    })
  })

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`
  }

  async start(): Promise<void> {
    this.server.on('connection', () => this.connections++)
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()))
    this.port = (this.server.address() as net.AddressInfo).port
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

/** OpenAI-style SSE body for a list of chunks. */
export function openAiSse(chunks: unknown[], opts: { done?: boolean; crlf?: boolean; comment?: boolean } = {}): string {
  const nl = opts.crlf ? '\r\n' : '\n'
  let text = opts.comment ? `: keep-alive${nl}${nl}` : ''
  for (const chunk of chunks) text += `data: ${JSON.stringify(chunk)}${nl}${nl}`
  if (opts.done !== false) text += `data: [DONE]${nl}${nl}`
  return text
}

/** Write `text` in small pieces with an optional delay between them. */
export async function writeInPieces(res: http.ServerResponse, text: string, size = 9, delayMs = 0): Promise<void> {
  for (let i = 0; i < text.length; i += size) {
    res.write(text.slice(i, i + size))
    if (delayMs) await sleep(delayMs)
  }
}

/** Response body as JSON (fetch types it as unknown). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function body(res: Response | Promise<Response>): Promise<any> {
  return (await res).json()
}

export interface ParsedEvent {
  event: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

/** Parse an Anthropic SSE response body. */
export function parseSse(text: string): ParsedEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n')
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? ''
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6)
      return { event, data: data ? JSON.parse(data) : undefined }
    })
}
