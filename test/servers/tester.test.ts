import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'

const execMocks = vi.hoisted(() => ({ whichImpl: null as null | ((cmd: string) => Promise<string | null>) }))

vi.mock('@core/platform/exec', () => ({
  // Real taskkill (Windows tree kill) so no test process is left behind.
  run: vi.fn(
    (command: string, args: string[]) =>
      new Promise((resolve) => execFile(command, args, { windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, code: err ? 1 : 0, stdout, stderr, timedOut: false })))
  ),
  runPowerShell: vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '', timedOut: false })),
  which: vi.fn(async (cmd: string) => (execMocks.whichImpl ? execMocks.whichImpl(cmd) : null)),
  fixPath: vi.fn(async () => {}),
  cleanEnv: vi.fn(() => ({ ...process.env })),
  spawnDetached: vi.fn()
}))

import { testServer } from '@core/servers/tester'

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mcp-echo-server.mjs')
const node = process.execPath

afterEach(() => {
  execMocks.whichImpl = null
})

describe('testServer — stdio', () => {
  it('connects to a working server and lists its tools', async () => {
    const r = await testServer({ type: 'stdio', command: node, args: [fixture] }, { timeoutMs: 20000 })
    expect(r.ok).toBe(true)
    expect(r.serverName).toBe('echo-fixture')
    expect(r.serverVersion).toBe('1.2.3')
    expect(r.instructions).toContain('Echo server')
    expect(r.protocol).toBeTruthy()
    expect(r.tools.map((t) => t.name).sort()).toEqual(['add', 'echo'])
    expect(r.tools.find((t) => t.name === 'echo')).toMatchObject({ title: 'Echo', description: 'Returns the text it receives.' })
    expect(r.kind).toBeUndefined()
  })

  it('passes the configured environment variables to the server', async () => {
    const r = await testServer({ type: 'stdio', command: node, args: [fixture, '--require-env', 'FIXTURE_TOKEN'], env: { FIXTURE_TOKEN: 'secret' } }, { timeoutMs: 20000 })
    expect(r.ok).toBe(true)
  })

  it('keeps the stderr output of a working server', async () => {
    const r = await testServer({ type: 'stdio', command: node, args: [fixture, '--stderr', 'hello from stderr'] }, { timeoutMs: 20000 })
    expect(r.ok).toBe(true)
    expect(r.stderr).toContain('hello from stderr')
  })

  it('reports a server that exits because a setting is missing, naming the variable', async () => {
    const r = await testServer({ type: 'stdio', command: node, args: [fixture, '--require-env', 'FIXTURE_TOKEN'] }, { timeoutMs: 20000 })
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('process-exited')
    expect(r.stderr).toContain('FIXTURE_TOKEN environment variable is required')
    expect(r.hint).toContain('FIXTURE_TOKEN')
  })

  it('captures the error output of a crashing server', async () => {
    const r = await testServer({ type: 'stdio', command: node, args: [fixture, '--exit', 'boom: invalid configuration', '3'] }, { timeoutMs: 20000 })
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('process-exited')
    expect(r.stderr).toContain('boom: invalid configuration')
    expect(r.hint).toBeTruthy()
  })

  it('reports a missing command before starting anything', async () => {
    const r = await testServer({ type: 'stdio', command: 'definitely-not-a-real-command-xyz', args: [] })
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('command-not-found')
    expect(r.hint).toContain("wasn't found")
  })

  it('suggests installing Node.js when npx is missing', async () => {
    const r = await testServer({ type: 'stdio', command: 'npx', args: ['-y', 'some-server'] })
    expect(r.kind).toBe('command-not-found')
    expect(r.hint).toMatch(/Node\.js/)
  })

  it('detects a missing command from the spawn failure when PATH lookup is unavailable', async () => {
    execMocks.whichImpl = async () => {
      throw new Error('lookup unavailable')
    }
    const r = await testServer({ type: 'stdio', command: 'definitely-not-a-real-command-xyz', args: [] }, { timeoutMs: 20000 })
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('command-not-found')
  })

  it('times out on a server that never answers', async () => {
    const started = Date.now()
    const r = await testServer({ type: 'stdio', command: node, args: [fixture, '--hang'] }, { timeoutMs: 1500 })
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('timeout')
    expect(r.hint).toMatch(/didn't answer within 2 seconds|didn't answer within 1 seconds/)
    expect(Date.now() - started).toBeLessThan(15000)
  })

  it('rejects invalid configs without running anything', async () => {
    expect((await testServer({ type: 'stdio', command: '  ' })).kind).toBe('invalid-config')
    expect((await testServer({ type: 'http', url: 'not a url' })).kind).toBe('invalid-config')
    expect((await testServer({ type: 'http', url: 'ftp://example.com/mcp' })).kind).toBe('invalid-config')
  })
})

// ─── remote servers over a local HTTP endpoint ───────────────────────────────

type Handler = (req: Request) => Promise<Response>

async function startHttp(handler: Handler): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0
      const response = await handler(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }))
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      if (response.body) for await (const chunk of response.body) res.write(chunk)
      res.end()
    } catch (err) {
      res.writeHead(500)
      res.end(String(err))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      })
  }
}

function mcpHandler(): Handler {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'http-fixture', version: '9.9.9' })
    server.registerTool('ping', { description: 'Pong.', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    return server
  })
  return (req) => handler.fetch(req)
}

describe('testServer — remote', () => {
  it('connects over Streamable HTTP', async () => {
    const http = await startHttp(mcpHandler())
    try {
      const r = await testServer({ type: 'http', url: http.url }, { timeoutMs: 15000 })
      expect(r.ok).toBe(true)
      expect(r.serverName).toBe('http-fixture')
      expect(r.tools.map((t) => t.name)).toEqual(['ping'])
    } finally {
      await http.close()
    }
  })

  it('sends the configured headers', async () => {
    const inner = mcpHandler()
    const http = await startHttp(async (req) => (req.headers.get('x-api-key') === 'k-123' ? inner(req) : new Response('missing key', { status: 401 })))
    try {
      const ok = await testServer({ type: 'http', url: http.url, headers: { 'X-Api-Key': 'k-123' } }, { timeoutMs: 15000 })
      expect(ok.ok).toBe(true)
      const denied = await testServer({ type: 'http', url: http.url }, { timeoutMs: 15000 })
      expect(denied.ok).toBe(false)
      expect(denied.kind).toBe('auth-required')
      expect(denied.hint).toMatch(/sign in/)
    } finally {
      await http.close()
    }
  })

  it('explains a wrong address', async () => {
    const http = await startHttp(async () => new Response('not here', { status: 404 }))
    try {
      const r = await testServer({ type: 'http', url: http.url }, { timeoutMs: 15000 })
      expect(r.ok).toBe(false)
      expect(r.kind).not.toBe('auth-required')
      expect(r.hint).toMatch(/address|URL/i)
    } finally {
      await http.close()
    }
  })

  it('reports an unreachable server', async () => {
    const http = await startHttp(async () => new Response('', { status: 200 }))
    const url = http.url
    await http.close()
    const r = await testServer({ type: 'http', url }, { timeoutMs: 8000 })
    expect(r.ok).toBe(false)
    expect(r.hint).toBeTruthy()
  })
})
