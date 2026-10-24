/**
 * Safe JSON / JSONC file helpers.
 * - Strict JSON for Claude files (Claude Desktop + Claude Code reject comments).
 * - JSONC (comment-preserving edits) for VS Code-family settings.
 * - Atomic writes: write <file>.tmp-<rand> then rename.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser'

export interface ReadResult<T> {
  exists: boolean
  data?: T
  /** Raw file text (when it exists). */
  text?: string
  /** Parse error message (data is undefined when set). */
  error?: string
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Read a JSON file. With `jsonc: true`, comments and trailing commas are tolerated. Empty file → {}. */
export async function readJson<T = unknown>(path: string, opts: { jsonc?: boolean } = {}): Promise<ReadResult<T>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false }
    return { exists: true, error: `Cannot read ${path}: ${(err as Error).message}` }
  }
  const body = stripBom(text)
  if (!body.trim()) return { exists: true, text, data: {} as T }
  if (opts.jsonc) {
    const errors: ParseError[] = []
    const data = parse(body, errors, { allowTrailingComma: true, disallowComments: false }) as T
    if (errors.length) {
      const e = errors[0]
      return { exists: true, text, error: `${printParseErrorCode(e.error)} at offset ${e.offset}` }
    }
    return { exists: true, text, data }
  }
  try {
    return { exists: true, text, data: JSON.parse(body) as T }
  } catch (err) {
    return { exists: true, text, error: (err as Error).message }
  }
}

export async function writeTextAtomic(path: string, text: string, opts: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: opts.mode })
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  if (opts.mode !== undefined && process.platform !== 'win32') await chmod(path, opts.mode).catch(() => {})
}

/** Pretty-printed (2 spaces), trailing newline, no BOM. */
export async function writeJsonAtomic(path: string, data: unknown, opts: { mode?: number; indent?: number } = {}): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(data, null, opts.indent ?? 2) + '\n', { mode: opts.mode })
}

export interface JsoncEdit {
  path: Array<string | number>
  /** undefined removes the property. */
  value: unknown
}

/**
 * Apply edits to a JSONC file while preserving comments and formatting.
 * Creates the file ({}) when missing. Throws if the existing file cannot be parsed.
 */
export async function editJsonc(path: string, edits: JsoncEdit[]): Promise<void> {
  const current = await readJson(path, { jsonc: true })
  if (current.error) throw new Error(`Cannot edit ${path}: ${current.error}`)
  let text = current.exists && current.text && stripBom(current.text).trim() ? stripBom(current.text) : '{}\n'
  for (const edit of edits) {
    const changes = modify(text, edit.path, edit.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } })
    text = applyEdits(text, changes)
  }
  await writeTextAtomic(path, text.endsWith('\n') ? text : text + '\n')
}

/** Deep clone of a JSON value. */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
