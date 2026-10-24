/**
 * Persistent app state (state.json in the data dir).
 * The GUI, the CLI and the MCP server are separate processes sharing this file, so every update
 * re-reads the file first (read-modify-write under an in-process queue) and the GUI can watch it.
 */
import { randomBytes } from 'node:crypto'
import { rename, stat } from 'node:fs/promises'
import type { AppSettings, AppState, CatalogSource } from '@shared/types'
import { readJson, writeJsonAtomic, isPlainObject } from './fs/json'

export const DEFAULT_SOURCES: Record<CatalogSource, boolean> = {
  official: true,
  anthropic: true,
  github: true,
  smithery: true,
  docker: true,
  cline: true,
  awesome: true,
  glama: false,
  pulsemcp: false,
  seed: true
}

export function defaultSettings(): AppSettings {
  return {
    mode: 'simple',
    theme: 'system',
    defaultTargets: [{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }],
    sources: { ...DEFAULT_SOURCES },
    catalogTtlHours: 24,
    autoRestartDesktop: false,
    keepBackups: 30,
    onboarded: false,
    recentProjects: [],
    startAtLogin: false
  }
}

export function defaultState(): AppState {
  return {
    version: 1,
    settings: defaultSettings(),
    profiles: [],
    installs: [],
    disabled: [],
    proxy: {
      port: 3460,
      authToken: 'cs-' + randomBytes(16).toString('hex'),
      upstreams: [],
      routes: {},
      autoStart: true
    }
  }
}

/** Event keys emitted when another process changed a part of the state. */
const KEY_EVENTS: Record<string, string[]> = {
  settings: ['settings'],
  profiles: ['profiles', 'models'],
  activeProfileId: ['profiles', 'models'],
  modelApply: ['models'],
  installs: ['servers'],
  disabled: ['servers'],
  proxy: ['proxy']
}

function normalize(d: Partial<AppState>): AppState {
  const base = defaultState()
  return {
    ...base,
    ...d,
    version: 1,
    settings: { ...base.settings, ...(d.settings ?? {}), sources: { ...base.settings.sources, ...(d.settings?.sources ?? {}) } },
    proxy: { ...base.proxy, ...(d.proxy ?? {}) },
    profiles: Array.isArray(d.profiles) ? d.profiles : [],
    installs: Array.isArray(d.installs) ? d.installs : [],
    disabled: Array.isArray(d.disabled) ? d.disabled : []
  }
}

export class StateStore {
  private state: AppState = defaultState()
  private queue: Promise<unknown> = Promise.resolve()
  /** mtime of the file version currently in memory (undefined = not on disk yet). */
  private mtimeMs?: number
  /** Last persistence error (writes never throw; see update()). */
  lastError?: string

  constructor(readonly file: string) {}

  private async fileMtime(): Promise<number | undefined> {
    try {
      return (await stat(this.file)).mtimeMs
    } catch {
      return undefined
    }
  }

  /**
   * Initial load. A missing file gives defaults. A corrupt file is moved aside
   * (state.corrupt-<time>.json) so it can be inspected, and defaults are used.
   */
  async load(): Promise<AppState> {
    const r = await readJson<Partial<AppState>>(this.file)
    if (r.data && isPlainObject(r.data)) {
      this.state = normalize(r.data)
    } else {
      if (r.exists && r.error) {
        const aside = this.file.replace(/\.json$/i, '') + `.corrupt-${Date.now()}.json`
        await rename(this.file, aside).catch(() => {})
      }
      this.state = defaultState()
    }
    this.mtimeMs = await this.fileMtime()
    return this.state
  }

  /**
   * Re-read the file if another process changed it. Returns the top-level keys that changed.
   * A file that cannot be parsed right now keeps the in-memory state (never wipes data).
   */
  async reloadIfChanged(): Promise<string[]> {
    const mtime = await this.fileMtime()
    if (mtime === undefined || mtime === this.mtimeMs) return []
    const r = await readJson<Partial<AppState>>(this.file)
    if (!r.data || !isPlainObject(r.data)) return []
    const before = this.state
    const after = normalize(r.data)
    this.state = after
    this.mtimeMs = mtime
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...keys].filter(
      (k) => JSON.stringify((before as unknown as Record<string, unknown>)[k]) !== JSON.stringify((after as unknown as Record<string, unknown>)[k])
    )
  }

  /** Current in-memory state. Treat as read-only; mutate through update(). */
  get(): AppState {
    return this.state
  }

  settings(): AppSettings {
    return this.state.settings
  }

  /**
   * Mutate (or replace) the state and persist it. Updates are queued; each one first picks up
   * changes written by other processes so concurrent surfaces don't overwrite each other.
   * Never throws for disk errors (the in-memory state is still updated; see lastError).
   */
  async update(fn: (draft: AppState) => void | AppState): Promise<AppState> {
    const job = this.queue.then(async () => {
      await this.reloadIfChanged().catch(() => [])
      const draft = structuredClone(this.state)
      const next = fn(draft) ?? draft
      this.state = next
      try {
        await writeJsonAtomic(this.file, next, { mode: 0o600 })
        this.mtimeMs = await this.fileMtime()
        this.lastError = undefined
      } catch (err) {
        this.lastError = (err as Error).message
      }
      return this.state
    })
    this.queue = job.catch(() => {})
    return job
  }

  /**
   * Poll the file for changes made by other processes. `onChange` receives event keys
   * ('settings', 'servers', 'models', 'profiles', 'proxy'). Returns a stop function.
   */
  watch(intervalMs: number, onChange: (key: string) => void): () => void {
    let busy = false
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      this.queue = this.queue
        .then(() => this.reloadIfChanged())
        .then((changed) => {
          const events = new Set(changed.flatMap((k) => KEY_EVENTS[k] ?? []))
          for (const e of events) onChange(e)
        })
        .catch(() => {})
        .finally(() => {
          busy = false
        })
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
