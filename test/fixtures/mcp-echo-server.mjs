#!/usr/bin/env node
/**
 * Tiny MCP stdio server used by the tester tests (SDK v2, serveStdio).
 *
 *   node mcp-echo-server.mjs                      → serves tools "echo" and "add"
 *   node mcp-echo-server.mjs --require-env NAME   → exits 1 with "NAME environment variable is required" unless set
 *   node mcp-echo-server.mjs --exit "msg" [code]  → prints msg to stderr and exits (default code 1)
 *   node mcp-echo-server.mjs --hang               → starts but never answers
 *   node mcp-echo-server.mjs --stderr "text"      → writes text to stderr, then serves normally
 */
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

const argv = process.argv.slice(2)
const opt = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? (argv[i + 1] ?? '') : undefined
}

if (argv.includes('--hang')) {
  setInterval(() => {}, 1000)
} else if (opt('--exit') !== undefined) {
  process.stderr.write(`${opt('--exit')}\n`)
  const code = Number(argv[argv.indexOf('--exit') + 2] ?? 1)
  process.exitCode = Number.isFinite(code) ? code : 1
} else {
  const required = opt('--require-env')
  if (required && !process.env[required]) {
    process.stderr.write(`Error: ${required} environment variable is required\n`)
    process.exit(1)
  }
  const extra = opt('--stderr')
  if (extra) process.stderr.write(`${extra}\n`)

  const handle = serveStdio(() => {
    const server = new McpServer({ name: 'echo-fixture', version: '1.2.3' }, { instructions: 'Echo server for Claude Setup tests.' })
    server.registerTool(
      'echo',
      { title: 'Echo', description: 'Returns the text it receives.', inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: 'text', text }] })
    )
    server.registerTool(
      'add',
      { description: 'Adds two numbers.', inputSchema: z.object({ a: z.number(), b: z.number() }) },
      async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
    )
    return server
  })
  process.on('SIGINT', () => void handle.close())
}
