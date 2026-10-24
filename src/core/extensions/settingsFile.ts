/**
 * Read / write Claude Code settings files (strict JSON). Unknown keys are always preserved:
 * we read the whole object, change only what we own, and write it back atomically.
 */
import { isPlainObject, readJson, writeJsonAtomic } from '../fs/json'

/** An expected failure with a message that can be shown to the user as-is. */
export class FriendlyError extends Error {
  constructor(
    message: string,
    readonly details?: string
  ) {
    super(message)
    this.name = 'FriendlyError'
  }
}

export interface SettingsDoc {
  path: string
  exists: boolean
  data: Record<string, unknown>
}

/** Read a settings file. Missing → {}. Invalid JSON → FriendlyError (we never overwrite a file we can't parse). */
export async function readSettings(path: string): Promise<SettingsDoc> {
  const r = await readJson<unknown>(path)
  if (!r.exists) return { path, exists: false, data: {} }
  if (r.error) {
    throw new FriendlyError(
      'Your Claude Code settings file has a formatting problem, so nothing was changed.',
      `${path} could not be read as JSON (${r.error}). Fix the file (the Doctor page can help), then try again.`
    )
  }
  if (!isPlainObject(r.data)) {
    throw new FriendlyError('Your Claude Code settings file is not in the expected format, so nothing was changed.', `${path} must contain a JSON object.`)
  }
  return { path, exists: true, data: r.data }
}

/** Read a settings file without throwing (invalid → {}); for listing only. */
export async function peekSettings(path: string): Promise<Record<string, unknown>> {
  const r = await readJson<unknown>(path)
  return isPlainObject(r.data) ? r.data : {}
}

/** Write a settings object (pretty JSON, atomic). */
export async function writeSettings(path: string, data: Record<string, unknown>): Promise<void> {
  await writeJsonAtomic(path, data)
}
