/** Persistent app state (state.json in the data dir). Single writer per process; writes are serialized. */
import { randomBytes } from 'node:crypto'
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
    recentProjects: []
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

export class StateStore {
  private state: AppState = defaultState()
  private writing: Promise<void> = Promise.resolve()

  constructor(readonly file: string) {}

  async load(): Promise<AppState> {
    const r = await readJson<Partial<AppState>>(this.file)
    const base = defaultState()
    if (r.data && isPlainObject(r.data)) {
      const d = r.data
      this.state = {
        ...base,
        ...d,
        version: 1,
        settings: { ...base.settings, ...(d.settings ?? {}), sources: { ...base.settings.sources, ...(d.settings?.sources ?? {}) } },
        proxy: { ...base.proxy, ...(d.proxy ?? {}) },
        profiles: Array.isArray(d.profiles) ? d.profiles : [],
        installs: Array.isArray(d.installs) ? d.installs : [],
        disabled: Array.isArray(d.disabled) ? d.disabled : []
      }
    } else {
      this.state = base
    }
    return this.state
  }

  /** Current in-memory state. Treat as read-only; mutate through update(). */
  get(): AppState {
    return this.state
  }

  settings(): AppSettings {
    return this.state.settings
  }

  /** Mutate (or replace) the state and persist it. Writes are serialized. */
  async update(fn: (draft: AppState) => void | AppState): Promise<AppState> {
    const draft = structuredClone(this.state)
    const next = fn(draft) ?? draft
    this.state = next
    const snapshot = structuredClone(next)
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, snapshot, { mode: 0o600 })).catch(() => {})
    await this.writing
    return this.state
  }
}
