/** Small shared helpers for the extensions module (hashing, paths, text, concurrency). */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** Hex SHA-256 of a string or buffer. */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Short random id (8 hex chars). */
export function shortId(): string {
  return randomBytes(4).toString('hex')
}

/** Absolute path normalized for comparisons (case-insensitive on Windows). */
export function pathKey(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** True when two paths point to the same location (ignoring case on Windows). */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

/** True when `child` is strictly inside `parent`. */
export function isInside(parent: string, child: string): boolean {
  const p = pathKey(parent)
  const c = pathKey(child)
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** Message of an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : JSON.stringify(err)
}

/** JSON.stringify with sorted object keys, so equal values always produce equal strings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeys(v)
    }
    return out
  }
  return value
}

/** Structural equality of JSON values (key order does not matter). */
export function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

/** Lowercase alphanumerics only — used for forgiving name matching ("React:Components" ≈ "react-components"). */
export function looseSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Collapse whitespace and cut to `max` characters on a word boundary (adds "…"). */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '') + '…'
}

/** "1 file" / "3 files". */
export function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`
}

/**
 * Map over items with at most `limit` promises in flight; keeps the input order.
 * After the first failure no new items start, and the error is thrown only once every running call has
 * settled (so nothing keeps writing in the background after the caller cleans up).
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  let firstError: unknown
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        if (!failed) firstError = err
        failed = true
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw firstError
  return results
}

/** Every regular file below `dir` (absolute paths). Symlinks are not followed. Missing dir → []. */
export async function listFilesRecursive(dir: string, maxFiles = 5000): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  await walk(dir)
  return out
}

/** lstat that returns null instead of throwing. */
export async function lstatSafe(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p)
  } catch {
    return null
  }
}

/** Forward-slash version of a path (for display inside shell commands and ids). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Sleep helper used for short retry back-offs. */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
