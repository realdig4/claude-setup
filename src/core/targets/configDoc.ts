/**
 * Formatting-preserving editing of other apps' JSON / JSONC config files.
 *
 * - Only the edited property changes; every other key, comment and the file's indentation / line endings survive.
 * - Strict JSON files (Claude) are validated with JSON.parse first; JSONC files (VS Code family) with jsonc-parser.
 * - Writes are atomic (writeTextAtomic) and serialized per file inside this process.
 * - A symlinked config (dotfiles setups) is edited at its target, so the link survives.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applyEdits, modify, parse, printParseErrorCode, type FormattingOptions, type ParseError } from 'jsonc-parser'
import { isPlainObject, writeTextAtomic } from '../fs/json'

export type DocFormat = 'json' | 'jsonc'

export interface ConfigDoc {
  file: string
  format: DocFormat
  exists: boolean
  /** Parsed fine and the top level is an object (a missing or empty file counts as valid). */
  valid: boolean
  /** Friendly parse / read problem when not valid. */
  error?: string
  /** Parsed content ({} when missing, empty or invalid). */
  data: Record<string, unknown>
  /** File text without BOM ('' when missing). */
  text: string
  /** POSIX permission bits of the existing file. */
  mode?: number
}

/** Thrown by editConfigDoc for expected problems: unreadable/invalid file, wrong structure, lost race. */
export class ConfigDocError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly kind: 'invalid' | 'structure' | 'conflict' = 'invalid'
  ) {
    super(message)
    this.name = 'ConfigDocError'
  }
}

export interface DocEdit {
  path: string[]
  /** undefined deletes the property. */
  value: unknown
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function lineCol(text: string, offset: number): string {
  const before = text.slice(0, Math.max(0, offset))
  const line = before.split('\n').length
  const col = offset - before.lastIndexOf('\n')
  return `line ${line}, column ${col}`
}

/** Read and parse a config file. Never throws. */
export async function readConfigDoc(file: string, format: DocFormat): Promise<ConfigDoc> {
  let raw: string
  let mode: number | undefined
  try {
    raw = await readFile(file, 'utf8')
    if (process.platform !== 'win32') mode = (await stat(file)).mode & 0o777
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { file, format, exists: false, valid: true, data: {}, text: '' }
    const reason =
      code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code === 'EISDIR' ? 'it is a folder, not a file' : (err as Error).message
    return { file, format, exists: true, valid: false, error: `Can't read the file (${reason}).`, data: {}, text: '' }
  }
  const text = stripBom(raw)
  if (!text.trim()) return { file, format, exists: true, valid: true, data: {}, text, mode }
  let data: unknown
  if (format === 'json') {
    try {
      data = JSON.parse(text)
    } catch (err) {
      const msg = (err as Error).message
      const pos = /position (\d+)/.exec(msg)
      const where = pos ? ` (${lineCol(text, Number(pos[1]))})` : ''
      return { file, format, exists: true, valid: false, error: `It isn't valid JSON${where}: ${msg}`, data: {}, text, mode }
    }
  } else {
    const errors: ParseError[] = []
    data = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
    if (errors.length) {
      const e = errors[0]
      const error = `It can't be read: ${printParseErrorCode(e.error)} at ${lineCol(text, e.offset)}.`
      return { file, format, exists: true, valid: false, error, data: {}, text, mode }
    }
  }
  if (!isPlainObject(data)) {
    const error = "It doesn't contain a JSON object ({ … }) at the top level."
    return { file, format, exists: true, valid: false, error, data: {}, text, mode }
  }
  return { file, format, exists: true, valid: true, data, text, mode }
}

/** Value at a property path, or undefined. */
export function getAt(data: unknown, path: string[]): unknown {
  let cur: unknown = data
  for (const key of path) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined
    cur = cur[key]
  }
  return cur
}

/** The server map at `path` (empty when missing or not an object). */
export function getMap(data: unknown, path: string[]): Record<string, unknown> {
  const v = getAt(data, path)
  return isPlainObject(v) ? v : {}
}

/** First prefix of `path` (including the full path's parent chain) that exists but is not an object. */
export function blockingPrefix(data: unknown, path: string[]): string[] | null {
  let cur: unknown = data
  for (let i = 0; i < path.length; i++) {
    if (!isPlainObject(cur)) return path.slice(0, i)
    if (!Object.prototype.hasOwnProperty.call(cur, path[i])) return null
    cur = cur[path[i]]
    if (i < path.length - 1 && cur !== undefined && !isPlainObject(cur)) return path.slice(0, i + 1)
  }
  return null
}

/** Detect indentation and line endings so inserted text matches the file. */
export function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const m = /^([ \t]+)\S/m.exec(text)
  if (m && m[1].startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol }
  const size = m ? Math.min(Math.max(m[1].length, 1), 8) : 2
  return { insertSpaces: true, tabSize: size, eol }
}

/** Deep structural equality for JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => jsonEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    if (ka.length !== kb.length) return false
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]))
  }
  return false
}

const locks = new Map<string, Promise<unknown>>()

function lockKey(file: string): string {
  const r = resolve(file)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** Run `fn` while holding this process's lock for `file` (writes to one file never interleave). */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(file)
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => (release = r))
  const chained = prev.catch(() => {}).then(() => mine)
  locks.set(key, chained)
  await prev.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === chained) locks.delete(key)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** writeTextAtomic with a few retries for Windows' transient sharing violations (antivirus, indexers). */
async function writeWithRetry(file: string, text: string, mode: number | undefined): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeTextAtomic(file, text, { mode })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 3 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw err
      await sleep(80 * (attempt + 1))
    }
  }
}

/** Apply edits to text already known to parse; returns the new text. Throws ConfigDocError on structural problems. */
export function applyDocEdits(file: string, format: DocFormat, text: string, data: Record<string, unknown>, edits: DocEdit[]): string {
  let out = text.trim() ? text : '{}'
  let current: unknown = data
  let changed = false
  const formattingOptions = detectFormatting(text.trim() ? text : '{\n  "x": 1\n}\n')
  for (const edit of edits) {
    const blocked = blockingPrefix(current, edit.path)
    if (blocked) {
      const where = blocked.join('.') || '(top level)'
      throw new ConfigDocError(`"${where}" in ${file} isn't an object, so it can't hold servers. Fix or remove it first.`, file, 'structure')
    }
    if (edit.value === undefined && getAt(current, edit.path) === undefined) continue
    if (edit.value !== undefined && jsonEqual(getAt(current, edit.path), edit.value)) continue
    out = applyEdits(out, modify(out, edit.path, edit.value, { formattingOptions }))
    current = format === 'json' ? JSON.parse(out) : parse(out, [], { allowTrailingComma: true })
    changed = true
  }
  if (!changed) return text
  const eol = formattingOptions.eol ?? '\n'
  return out.endsWith('\n') ? out : out + eol
}

/**
 * Read the file fresh, apply the edits and write it atomically.
 * Throws ConfigDocError when the existing file is invalid or has the wrong structure (nothing is written then).
 */
export async function editConfigDoc(file: string, format: DocFormat, edits: DocEdit[], opts: { createMode?: number } = {}): Promise<void> {
  const target = await realpath(file).catch(() => file)
  await withFileLock(target, async () => {
    const doc = await readConfigDoc(target, format)
    if (!doc.valid) throw new ConfigDocError(doc.error ?? 'The file is not valid.', file)
    const next = applyDocEdits(file, format, doc.text, doc.data, edits)
    if (next === doc.text) return
    await writeWithRetry(target, next, doc.mode ?? opts.createMode)
  })
}

/** True when every edit is reflected in the file right now. */
export async function editsApplied(file: string, format: DocFormat, edits: DocEdit[]): Promise<boolean> {
  const doc = await readConfigDoc(file, format)
  if (!doc.valid) return false
  return edits.every((e) => (e.value === undefined ? getAt(doc.data, e.path) === undefined : jsonEqual(getAt(doc.data, e.path), e.value)))
}
