/**
 * Tool-name mapping between Anthropic and OpenAI.
 *
 * Anthropic accepts tool names up to 128 characters; OpenAI-compatible APIs only accept
 * `^[a-zA-Z0-9_-]{1,64}$`. Long or unusual names (e.g. `mcp__some-server__a_very_long_tool_name…`)
 * are shortened deterministically (55 chars + `_` + 8 hex of a SHA-1) and mapped back when the
 * model calls them. A new mapper is created per request.
 */
import { createHash } from 'node:crypto'

const MAX_LENGTH = 64
const VALID_NAME = /^[a-zA-Z0-9_-]{1,64}$/

function hash8(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}

/** Bidirectional Anthropic ⇄ upstream tool-name map for one request. */
export class ToolNameMapper {
  private readonly toUpstream = new Map<string, string>()
  private readonly toOriginal = new Map<string, string>()

  /** Upstream-safe name for an Anthropic tool name. Stable for the lifetime of the mapper. */
  shorten(name: string): string {
    const known = this.toUpstream.get(name)
    if (known !== undefined) return known
    let short = VALID_NAME.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool'
    if (short.length > MAX_LENGTH) short = `${short.slice(0, 55)}_${hash8(name)}`
    const owner = this.toOriginal.get(short)
    if (owner !== undefined && owner !== name) {
      // Two different names sanitized to the same string: disambiguate with the hash form.
      short = `${short.slice(0, 55)}_${hash8(name)}`
      for (let n = 2; this.toOriginal.has(short); n++) short = `${short.slice(0, MAX_LENGTH - String(n).length - 1)}_${n}`
    }
    this.toUpstream.set(name, short)
    this.toOriginal.set(short, name)
    return short
  }

  /** Original Anthropic name for a name the upstream model used (unknown names are returned unchanged). */
  restore(upstreamName: string): string {
    return this.toOriginal.get(upstreamName) ?? upstreamName
  }
}
