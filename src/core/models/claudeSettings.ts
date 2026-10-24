/**
 * Reading and cleaning ~/.claude/settings.json (strict JSON) and ~/.claude.json for model setups.
 * Nothing here takes backups — callers snapshot first, then write.
 */
import { realpath } from 'node:fs/promises'
import { claudeJsonPath, claudeUserSettingsPath } from '../platform/paths'
import { isPlainObject, readJson, writeJsonAtomic } from '../fs/json'
import type { WrittenFile } from './marker'
import { isAlwaysOwned, isOurKeyHelper, valueTag } from './ownedKeys'

export interface SettingsFile {
  path: string
  exists: boolean
  /** Parsed object (a fresh {} when the file doesn't exist). Undefined when `error` is set. */
  data?: Record<string, unknown>
  /** Why the file can't be used (invalid JSON, not an object, env not an object…). */
  error?: string
  /** Indentation of the existing file, reused when rewriting. */
  indent: number
}

function detectIndent(text: string | undefined): number {
  const m = text?.match(/^( +)"/m)
  return m ? Math.min(Math.max(m[1].length, 1), 8) : 2
}

/** Read ~/.claude/settings.json (or another Claude settings file) without ever throwing. */
export async function readClaudeSettings(path = claudeUserSettingsPath()): Promise<SettingsFile> {
  const r = await readJson<unknown>(path)
  if (!r.exists) return { path, exists: false, data: {}, indent: 2 }
  const indent = detectIndent(r.text)
  if (r.error) return { path, exists: true, error: r.error, indent }
  if (!isPlainObject(r.data)) return { path, exists: true, error: 'the file must contain a JSON object ({ … })', indent }
  if (r.data.env !== undefined && !isPlainObject(r.data.env)) {
    return { path, exists: true, error: 'the "env" entry must be an object of NAME: "value" pairs', indent }
  }
  return { path, exists: true, data: r.data, indent }
}

/** Friendly text for an unusable settings file. */
export function settingsErrorMessage(file: SettingsFile): string {
  return (
    `Claude Code's settings file (${file.path}) can't be read: ${file.error}. ` +
    'Fix it in a text editor or restore a backup from Backups, then try again. Nothing was changed.'
  )
}

/** The env block as raw values (empty object when absent). */
export function rawEnv(data: Record<string, unknown> | undefined): Record<string, unknown> {
  return data && isPlainObject(data.env) ? data.env : {}
}

/** String-valued env entries plus the names whose values aren't strings (Claude Code ignores those). */
export function stringEnv(data: Record<string, unknown> | undefined): { env: Record<string, string>; nonString: string[] } {
  const env: Record<string, string> = {}
  const nonString: string[] = []
  for (const [k, v] of Object.entries(rawEnv(data))) {
    if (typeof v === 'string') env[k] = v
    else nonString.push(k)
  }
  return { env, nonString }
}

/** True when an env entry we may have written still holds the value we wrote. */
function ownsEnv(name: string, value: unknown, marker: WrittenFile | undefined): boolean {
  if (isAlwaysOwned(name)) return true
  const tag = marker?.env[name]
  return tag !== undefined && valueTag(value) === tag
}

/**
 * Remove everything Claude Setup owns from a Claude settings object (mutates `data`):
 * every always-owned env key, tracked env keys still holding our value, tracked top-level keys still holding our
 * value, and our own apiKeyHelper. An env block left empty is removed.
 */
export function removeOwned(data: Record<string, unknown>, marker: WrittenFile | undefined): { env: string[]; settings: string[] } {
  const removed = { env: [] as string[], settings: [] as string[] }
  if (isPlainObject(data.env)) {
    const env: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data.env)) {
      if (ownsEnv(k, v, marker)) removed.env.push(k)
      else env[k] = v
    }
    if (Object.keys(env).length) data.env = env
    else delete data.env
  }
  for (const [key, tag] of Object.entries(marker?.settings ?? {})) {
    if (key in data && valueTag(data[key]) === tag) {
      delete data[key]
      removed.settings.push(key)
    }
  }
  if (isOurKeyHelper(data.apiKeyHelper)) {
    delete data.apiKeyHelper
    if (!removed.settings.includes('apiKeyHelper')) removed.settings.push('apiKeyHelper')
  }
  return removed
}

/**
 * The real file behind a path (symlinks resolved), so atomic writes update a dotfiles-managed target instead of
 * replacing the user's symlink with a plain file. Returns the path itself when it doesn't exist yet.
 */
export async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** Write a Claude settings object back (strict JSON, original indentation, private file mode). */
export async function writeClaudeSettings(file: SettingsFile, data: Record<string, unknown>): Promise<void> {
  await writeJsonAtomic(await physicalPath(file.path), data, { indent: file.indent, mode: 0o600 })
}

/**
 * Merge `"hasCompletedOnboarding": true` into ~/.claude.json, preserving everything else.
 * Many providers need it so Claude Code doesn't stop at the Anthropic sign-in screen.
 */
export async function ensureOnboardingFlag(): Promise<{ changed: boolean; warning?: string }> {
  const path = claudeJsonPath()
  const r = await readJson<unknown>(path)
  if (r.exists && (r.error || !isPlainObject(r.data))) {
    return { changed: false, warning: `${path} couldn't be read (${r.error ?? 'not a JSON object'}), so the first-run screen may still appear.` }
  }
  const data = (r.data as Record<string, unknown> | undefined) ?? {}
  if (data.hasCompletedOnboarding === true) return { changed: false }
  data.hasCompletedOnboarding = true
  await writeJsonAtomic(await physicalPath(path), data, { indent: detectIndent(r.text), mode: 0o600 })
  return { changed: true }
}
