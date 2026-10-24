/**
 * Editable key/value rows (environment variables, HTTP headers). Pure helpers shared by the Models wizard and the
 * Proxy page — no React, no DOM, so they are unit-tested in Node.
 */

export interface KeyValueRow {
  /** Stable id for React keys and error lookup. */
  id: string
  key: string
  value: string
}

let sequence = 0

/** A new row with a unique id. */
export function newRow(key = '', value = ''): KeyValueRow {
  sequence += 1
  return { id: `kv-${sequence}`, key, value }
}

/** Rows from a record, in insertion order. */
export function rowsFromRecord(record: Record<string, string> | undefined | null): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => newRow(key, value))
}

/** A record from rows: keys are trimmed, rows without a key are skipped and the last duplicate wins. */
export function recordFromRows(rows: readonly KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) out[key] = row.value
  }
  return out
}

/** True when a row has nothing typed in it. */
export function isBlankRow(row: KeyValueRow): boolean {
  return !row.key.trim() && !row.value.trim()
}

export interface RowErrorOptions {
  /** Treat "Foo" and "foo" as the same name (HTTP headers). */
  caseInsensitive?: boolean
  /** Word used in messages, e.g. "variable" or "header". */
  noun?: string
}

/**
 * Validate rows. `check(key, value)` returns a message for an invalid entry. Blank rows are ignored, a value without
 * a name and repeated names are reported. Returns error messages by row id (empty object = all valid).
 */
export function rowErrors(
  rows: readonly KeyValueRow[],
  check: (key: string, value: string) => string | undefined,
  options: RowErrorOptions = {}
): Record<string, string> {
  const noun = options.noun ?? 'entry'
  const errors: Record<string, string> = {}
  const seen = new Map<string, string>()
  for (const row of rows) {
    if (isBlankRow(row)) continue
    const key = row.key.trim()
    if (!key) {
      errors[row.id] = `Give this ${noun} a name.`
      continue
    }
    const message = check(key, row.value)
    if (message) {
      errors[row.id] = message
      continue
    }
    const normalized = options.caseInsensitive ? key.toLowerCase() : key
    if (seen.has(normalized)) errors[row.id] = `“${key}” is listed twice. Keep one of them.`
    else seen.set(normalized, row.id)
  }
  return errors
}

/** Order-insensitive comparison of two records (for "unsaved changes" detection). */
export function sameRecord(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && right[key] === left[key])
}
