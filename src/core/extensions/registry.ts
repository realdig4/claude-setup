/**
 * Install registry: what Claude Setup itself put on disk (skills, agents, commands, output styles,
 * hook handlers, status lines). Used to
 *   - decide whether an existing file is "ours" (safe to update) or the user's (never overwritten),
 *   - remove exactly the hook handlers / scripts we added,
 *   - restore the previous status line on uninstall,
 *   - park hooks / status lines that the user switched off.
 * Stored as <dataDir>/extensions-installs.json (atomic writes, serialized within the process).
 */
import { join } from 'node:path'
import type { ExtensionKind, ExtensionSource, Scope } from '@shared/types'
import { isPlainObject, readJson, writeJsonAtomic } from '../fs/json'
import type { HookRef } from './settingsMerge'
import { pathKey, shortId } from './util'

export interface RecordedFile {
  /** Absolute path. */
  path: string
  /** SHA-256 of the bytes we wrote. */
  sha256: string
}

export interface RegistryRecord {
  /** Short unique key (also used in local ids: "rec-<key>"). */
  key: string
  /** Catalog id the item came from (or the local id of a parked user hook / status line). */
  id: string
  kind: ExtensionKind
  name: string
  source: ExtensionSource
  scope: Scope
  projectPath?: string
  /** Main location: skill folder, .md file, or the settings file for hooks / status lines. */
  path: string
  /** Every file we wrote (skill files, .md, hook scripts). */
  files: RecordedFile[]
  /** Hook handlers we added to `path` (a settings file). */
  hooks?: HookRef[]
  /** Status line we set, and what was there before. */
  statusLine?: { value: Record<string, unknown>; previous?: unknown; hadPrevious: boolean }
  /** Hooks / status line currently switched off (kept here instead of in settings). */
  disabled?: boolean
  description?: string
  url?: string
  repo?: string
  installedAt: string
}

interface RegistryFile {
  version: 1
  records: RegistryRecord[]
}

export class InstallRegistry {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {}

  /** Registry location inside the app data directory. */
  static at(dataDir: string): InstallRegistry {
    return new InstallRegistry(join(dataDir, 'extensions-installs.json'))
  }

  private async readAll(): Promise<RegistryRecord[]> {
    const r = await readJson<RegistryFile>(this.file)
    if (!r.data || !isPlainObject(r.data) || !Array.isArray(r.data.records)) return []
    return r.data.records.filter((rec) => isPlainObject(rec) && typeof rec.key === 'string' && typeof rec.path === 'string')
  }

  /** Run a read-modify-write step after any pending ones. */
  private mutate<T>(fn: (records: RegistryRecord[]) => { records: RegistryRecord[]; result: T }): Promise<T> {
    const job = this.queue.then(async () => {
      const current = await this.readAll()
      const { records, result } = fn(current)
      await writeJsonAtomic(this.file, { version: 1, records } satisfies RegistryFile)
      return result
    })
    this.queue = job.catch(() => {})
    return job
  }

  async list(): Promise<RegistryRecord[]> {
    await this.queue
    return this.readAll()
  }

  /** Add a record (a record for the same kind + path is replaced). */
  add(record: Omit<RegistryRecord, 'key'> & { key?: string }): Promise<RegistryRecord> {
    const full: RegistryRecord = { ...record, key: record.key ?? shortId() }
    return this.mutate((records) => {
      const rest = records.filter((r) => !(r.kind === full.kind && pathKey(r.path) === pathKey(full.path) && sameTarget(r, full)))
      return { records: [...rest, full], result: full }
    })
  }

  update(key: string, patch: Partial<RegistryRecord>): Promise<RegistryRecord | null> {
    return this.mutate((records) => {
      let updated: RegistryRecord | null = null
      const next = records.map((r) => {
        if (r.key !== key) return r
        updated = { ...r, ...patch, key: r.key }
        return updated
      })
      return { records: next, result: updated }
    })
  }

  remove(key: string): Promise<void> {
    return this.mutate((records) => ({ records: records.filter((r) => r.key !== key), result: undefined }))
  }

  /** Record for a file/folder kind at a path (matches the ".disabled" twin too). */
  async findByPath(kind: ExtensionKind, path: string): Promise<RegistryRecord | undefined> {
    const key = pathKey(path).replace(/\.disabled$/, '')
    return (await this.list()).find((r) => r.kind === kind && pathKey(r.path).replace(/\.disabled$/, '') === key)
  }

  async findByKey(key: string): Promise<RegistryRecord | undefined> {
    return (await this.list()).find((r) => r.key === key)
  }

  /** Records installed from a catalog id, optionally narrowed to one scope / project. */
  async findById(id: string, scope?: Scope, projectPath?: string): Promise<RegistryRecord[]> {
    const all = (await this.list()).filter((r) => r.id === id)
    if (!scope) return all
    return all.filter((r) => r.scope === scope && (scope === 'user' || !projectPath || (r.projectPath && pathKey(r.projectPath) === pathKey(projectPath))))
  }

  /** True when another record (other than `exceptKey`) also owns `filePath`. */
  async fileSharedWith(filePath: string, exceptKey: string): Promise<boolean> {
    const k = pathKey(filePath)
    return (await this.list()).some((r) => r.key !== exceptKey && r.files.some((f) => pathKey(f.path) === k))
  }
}

function sameTarget(a: RegistryRecord, b: RegistryRecord): boolean {
  // Hook and status line records share their settings file with others (including parked ones),
  // so they are unique per id there; file-like kinds are unique per path.
  return (a.kind !== 'hook' && a.kind !== 'statusline') || a.id === b.id
}
