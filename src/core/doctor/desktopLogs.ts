/**
 * Recent MCP connection failures from Claude Desktop's logs (mcp.log / main.log, last ~200 lines each).
 * Desktop logs `[LocalMcpServerManager] Connected to <name> (<n> tools)` and `… Failed to connect to <name>:`;
 * a server counts as failing when its newest event is a failure.
 */
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface McpFailure {
  name: string
  /** Log timestamp ("YYYY-MM-DD HH:MM:SS") when present. */
  time?: string
}

const TAIL_BYTES = 256 * 1024
const TAIL_LINES = 200
const TIME_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/
const FAILED_RE = /Failed to connect to (.+?):(?:\s|$)/
const CONNECTED_RE = /Connected to (.+?) \(\d+ tools?\)/

/** Last `lines` lines of a text file (reads at most the final 256 KB). */
export async function readTailLines(file: string, lines = TAIL_LINES): Promise<string[]> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    const all = buf.toString('utf8').split(/\r?\n/)
    if (size > length) all.shift()
    return all.filter((l) => l.trim()).slice(-lines)
  } finally {
    await handle.close()
  }
}

interface McpEvent {
  name: string
  failed: boolean
  time?: string
  order: number
}

/** Connection events in log lines, in order. */
export function parseMcpEvents(lines: string[], startOrder = 0): McpEvent[] {
  const events: McpEvent[] = []
  lines.forEach((line, i) => {
    const time = TIME_RE.exec(line)?.[1]
    const failed = FAILED_RE.exec(line)
    const connected = failed ? null : CONNECTED_RE.exec(line)
    const name = (failed?.[1] ?? connected?.[1])?.trim().replace(/^["']|["']$/g, '')
    if (name) events.push({ name, failed: Boolean(failed), time, order: startOrder + i })
  })
  return events
}

/** True when `a` happened after `b` (by timestamp when both have one, else by position). */
function isNewer(a: McpEvent, b: McpEvent): boolean {
  if (a.time && b.time && a.time !== b.time) return a.time > b.time
  return a.order > b.order
}

/** Servers whose most recent event is a failure. */
export function failuresFromEvents(events: McpEvent[]): McpFailure[] {
  const latest = new Map<string, McpEvent>()
  for (const e of events) {
    const prev = latest.get(e.name)
    if (!prev || isNewer(e, prev)) latest.set(e.name, e)
  }
  return [...latest.values()]
    .filter((e) => e.failed)
    .map((e) => (e.time ? { name: e.name, time: e.time } : { name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Recent failures across the given Desktop log folders (missing folders/files are ignored). */
export async function recentMcpFailures(logDirs: string[]): Promise<McpFailure[]> {
  const events: McpEvent[] = []
  let order = 0
  for (const dir of logDirs) {
    for (const name of ['main.log', 'mcp.log']) {
      const file = join(dir, name)
      try {
        if (!(await stat(file)).isFile()) continue
        const lines = await readTailLines(file)
        events.push(...parseMcpEvents(lines, order))
        order += lines.length
      } catch {
        // unreadable or missing log
      }
    }
  }
  return failuresFromEvents(events)
}
