/**
 * VS Code user settings for the Claude Code extension (JSONC — edited with comment-preserving edits):
 * `claudeCode.environmentVariables` (array of {name, value}) and `claudeCode.disableLoginPrompt`.
 */
import { join } from 'node:path'
import { isPlainObject, pathExists, readJson, type JsoncEdit } from '../fs/json'
import { vscodeUserDir, type EditorVariant } from '../platform/paths'
import type { WrittenFile } from './marker'
import { isAlwaysOwned, valueTag } from './ownedKeys'

export const ENV_SETTING = 'claudeCode.environmentVariables'
export const LOGIN_SETTING = 'claudeCode.disableLoginPrompt'

export interface VsEnvEntry {
  name: string
  value: string
}

export interface VsCodeSettingsFile {
  variant: EditorVariant
  path: string
  exists: boolean
  data?: Record<string, unknown>
  error?: string
}

/** VS Code settings files to configure: stable VS Code always, Insiders when its User folder exists. */
export async function vscodeSettingsTargets(): Promise<Array<{ variant: EditorVariant; path: string }>> {
  const out: Array<{ variant: EditorVariant; path: string }> = [{ variant: 'Code', path: join(vscodeUserDir('Code'), 'settings.json') }]
  if (await pathExists(vscodeUserDir('Code - Insiders'))) {
    out.push({ variant: 'Code - Insiders', path: join(vscodeUserDir('Code - Insiders'), 'settings.json') })
  }
  return out
}

/** Read one VS Code settings file (JSONC) without throwing. */
export async function readVsCodeSettings(variant: EditorVariant, path: string): Promise<VsCodeSettingsFile> {
  const r = await readJson<unknown>(path, { jsonc: true })
  if (!r.exists) return { variant, path, exists: false, data: {} }
  if (r.error) return { variant, path, exists: true, error: r.error }
  if (!isPlainObject(r.data)) return { variant, path, exists: true, error: 'the file must contain a JSON object ({ … })' }
  return { variant, path, exists: true, data: r.data }
}

/** Entries of claudeCode.environmentVariables (array form or the object map the extension also accepts). */
export function parseEnvEntries(value: unknown): VsEnvEntry[] {
  if (Array.isArray(value)) {
    return value
      .filter((e): e is Record<string, unknown> => isPlainObject(e) && typeof e.name === 'string' && e.name.trim() !== '')
      .map((e) => ({ name: (e.name as string).trim(), value: e.value === undefined || e.value === null ? '' : String(e.value) }))
  }
  if (isPlainObject(value)) {
    return Object.entries(value).map(([name, v]) => ({ name, value: v === undefined || v === null ? '' : String(v) }))
  }
  return []
}

/** The model-related entries as a map (owned names only). */
export function ownedEnvMap(entries: VsEnvEntry[], marker: WrittenFile | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of entries) if (ownsVsEntry(e, marker)) out[e.name] = e.value
  return out
}

/** True when an entry belongs to Claude Setup (always-owned name, or a tracked one still holding our value). */
export function ownsVsEntry(entry: VsEnvEntry, marker: WrittenFile | undefined): boolean {
  if (isAlwaysOwned(entry.name)) return true
  const tag = marker?.env[entry.name]
  return tag !== undefined && valueTag(entry.value) === tag
}

export interface VsCodeEditPlan {
  edits: JsoncEdit[]
  /** Marker entry describing what we own in this file afterwards (undefined when we own nothing). */
  marker?: WrittenFile
}

/**
 * Edits for one settings file. `entries` = the model env to write (apply), or null to remove ours (reset).
 * Entries the user added themselves are always kept.
 */
export function planVsCodeEdit(file: VsCodeSettingsFile, entries: VsEnvEntry[] | null, marker: WrittenFile | undefined): VsCodeEditPlan {
  const data = file.data ?? {}
  const current = parseEnvEntries(data[ENV_SETTING])
  const kept = current.filter((e) => !ownsVsEntry(e, marker))
  const edits: JsoncEdit[] = []
  const loginOurs = marker?.settings[LOGIN_SETTING] !== undefined && data[LOGIN_SETTING] === true

  if (entries === null) {
    if (kept.length !== current.length) edits.push({ path: [ENV_SETTING], value: kept.length ? kept : undefined })
    if (loginOurs) edits.push({ path: [LOGIN_SETTING], value: undefined })
    return { edits }
  }

  const next: WrittenFile = { path: file.path, env: {}, settings: {} }
  edits.push({ path: [ENV_SETTING], value: [...kept, ...entries] })
  for (const e of entries) if (!isAlwaysOwned(e.name)) next.env[e.name] = valueTag(e.value)
  if (data[LOGIN_SETTING] !== true) {
    edits.push({ path: [LOGIN_SETTING], value: true })
    next.settings[LOGIN_SETTING] = valueTag(true)
  } else if (loginOurs) {
    next.settings[LOGIN_SETTING] = valueTag(true)
  }
  return { edits, marker: next }
}
