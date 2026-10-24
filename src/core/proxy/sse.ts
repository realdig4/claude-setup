/**
 * Server-sent events helpers.
 *  - `SseParser`: incremental parser for an upstream (OpenAI-style) SSE byte stream. Handles chunks split
 *    anywhere (even inside a UTF-8 character or a CRLF pair), `\n` / `\r\n` / `\r` line endings, `:` comment
 *    lines, `event:` names, `[DONE]`, multi-line `data:` payloads and servers that omit the blank line
 *    between events (each `data:` line that parses as JSON is dispatched immediately).
 *  - `formatSse`: serializes one Anthropic SSE event.
 */
import type { SseEvent } from './wire'

/** One parsed upstream SSE payload: JSON data, the `[DONE]` sentinel, or data that is not JSON. */
export type UpstreamSseItem =
  | { kind: 'json'; event?: string; value: unknown }
  | { kind: 'done' }
  | { kind: 'invalid'; event?: string; data: string }

type Parsed = { ok: true; value: unknown } | { ok: false }

/** A single SSE line/event larger than this is treated as a broken stream (protects memory). */
export const MAX_SSE_EVENT_CHARS = 16 * 1024 * 1024

function tryParse(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

/** Incremental, chunk-boundary-safe parser for an upstream SSE byte stream. */
export class SseParser {
  private readonly decoder = new TextDecoder('utf-8')
  private buffer = ''
  private event: string | undefined
  private pending: string[] = []

  /** Feed raw bytes (or text); returns the items completed by this chunk. Throws on an oversized event. */
  push(chunk: Uint8Array | string): UpstreamSseItem[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    const out: UpstreamSseItem[] = []
    let start = 0
    for (let i = 0; i < this.buffer.length; i++) {
      const code = this.buffer.charCodeAt(i)
      if (code !== 10 && code !== 13) continue
      // A trailing CR may be the first half of a CRLF split across chunks: wait for more data.
      if (code === 13 && i === this.buffer.length - 1) break
      this.processLine(this.buffer.slice(start, i), out)
      if (code === 13 && this.buffer.charCodeAt(i + 1) === 10) i++
      start = i + 1
    }
    this.buffer = this.buffer.slice(start)
    const pendingChars = this.pending.reduce((n, line) => n + line.length, 0)
    if (this.buffer.length + pendingChars > MAX_SSE_EVENT_CHARS) {
      throw new Error('The provider sent an event larger than 16 MB; the stream was stopped.')
    }
    return out
  }

  /** Flush at end of stream (a final line without a terminator is still processed). */
  end(): UpstreamSseItem[] {
    const out: UpstreamSseItem[] = []
    this.buffer += this.decoder.decode()
    const rest = this.buffer.replace(/\r$/, '')
    this.buffer = ''
    if (rest) this.processLine(rest, out)
    this.flushPending(out)
    return out
  }

  private processLine(line: string, out: UpstreamSseItem[]): void {
    if (line === '') {
      this.flushPending(out)
      this.event = undefined
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') {
      this.event = value.trim() || undefined
      return
    }
    if (field !== 'data') return
    const trimmed = value.trim()
    if (!this.pending.length) {
      if (!trimmed) return
      if (trimmed === '[DONE]') {
        out.push({ kind: 'done' })
        return
      }
      const parsed = tryParse(trimmed)
      if (parsed.ok) {
        out.push({ kind: 'json', event: this.event, value: parsed.value })
        this.event = undefined
        return
      }
    }
    // Multi-line data payload: accumulate until it parses (or the event ends).
    this.pending.push(value)
    const parsed = tryParse(this.pending.join('\n'))
    if (parsed.ok) {
      out.push({ kind: 'json', event: this.event, value: parsed.value })
      this.pending = []
      this.event = undefined
    }
  }

  private flushPending(out: UpstreamSseItem[]): void {
    if (!this.pending.length) return
    out.push({ kind: 'invalid', event: this.event, data: this.pending.join('\n') })
    this.pending = []
  }
}

/** One Anthropic SSE event in wire format. */
export function formatSse(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}
