/**
 * YAML frontmatter for SKILL.md / agent / command / output-style files.
 * Claude Code only reads frontmatter when "---" is the very first line. Community files often contain
 * YAML that is not strictly valid (unquoted colons); we fall back to a forgiving `key: value` reader for
 * display purposes and report the strict error so callers can warn the user.
 */
import { parse as parseYaml } from 'yaml'
import { isPlainObject } from '../fs/json'

export interface Frontmatter {
  /** Parsed header ({} when there is none). */
  data: Record<string, unknown>
  /** Markdown after the header. */
  body: string
  /** A header block was present. */
  present: boolean
  /** Strict YAML error (data then comes from the forgiving reader). */
  error?: string
}

const BLOCK_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

/** Split and parse a frontmatter block. Never throws. */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const m = BLOCK_RE.exec(src)
  if (!m) return { data: {}, body: src, present: false }
  const block = m[1] ?? ''
  const body = src.slice(m[0].length)
  if (!block.trim()) return { data: {}, body, present: true }
  try {
    const parsed: unknown = parseYaml(block)
    if (isPlainObject(parsed)) return { data: parsed, body, present: true }
    return { data: lenientParse(block), body, present: true, error: 'The header is not a list of "key: value" settings.' }
  } catch (err) {
    const message = (err as Error).message.split('\n')[0]
    return { data: lenientParse(block), body, present: true, error: message }
  }
}

/** Forgiving reader: top-level `key: value` lines, quoted values unquoted, folded continuation lines joined. */
function lenientParse(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let lastKey: string | null = null
  for (const raw of block.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s?(.*)$/.exec(raw)
    if (m && !raw.startsWith(' ') && !raw.startsWith('\t')) {
      lastKey = m[1]
      out[lastKey] = unquote(m[2].trim())
      continue
    }
    if (lastKey && /^\s+\S/.test(raw) && typeof out[lastKey] === 'string') {
      const prev = out[lastKey] as string
      const line = raw.trim()
      out[lastKey] = prev === '|' || prev === '>' || prev === '|-' || prev === '>-' ? line : `${prev} ${line}`
    }
  }
  return out
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1)
    return v.startsWith('"') ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'")
  }
  return v
}

/** String value of a header field (numbers/booleans stringified), trimmed; undefined when absent/empty. */
export function fmString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key]
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}
