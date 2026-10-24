/** Helpers for the models + doctor tests: an in-sandbox CoreContext, recording backups, a fake proxy, clean env. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProxyApi } from '@shared/api'
import type { BackupEntry, LogEvent, OpResult, ProxyConfig, ProxyStatus } from '@shared/types'
import type { CoreContext } from '@core/context'
import { CoreEmitter } from '@core/events'
import { BackupManager } from '@core/fs/backups'
import { createMemorySecretStore } from '@core/secrets'
import { StateStore } from '@core/state'
import type { Sandbox } from '../helpers/sandbox'

export interface RecordedSnapshot {
  id: string
  reason: string
  paths: string[]
  /** File contents at snapshot time (null = file didn't exist). */
  contents: Record<string, string | null>
}

/** BackupManager that records snapshots in memory (and can be told to fail). */
export class RecordingBackups extends BackupManager {
  snapshots: RecordedSnapshot[] = []
  failWith?: string

  constructor() {
    super(join(tmpdir(), 'claude-setup-unused-backups'), () => 30)
  }

  override async snapshot(reason: string, paths: string[]): Promise<BackupEntry> {
    if (this.failWith) throw new Error(this.failWith)
    const id = `test-backup-${this.snapshots.length + 1}`
    const contents: Record<string, string | null> = {}
    for (const p of paths) contents[p] = await readFile(p, 'utf8').catch(() => null)
    this.snapshots.push({ id, reason, paths: [...paths], contents })
    return {
      id,
      createdAt: new Date().toISOString(),
      reason,
      files: paths.map((p) => ({ path: p, existed: contents[p] !== null, size: contents[p]?.length ?? 0 }))
    }
  }

  override async list(): Promise<BackupEntry[]> {
    return []
  }

  override async restore(): Promise<OpResult> {
    return { ok: false, message: 'not supported in tests' }
  }

  override async delete(): Promise<OpResult> {
    return { ok: false, message: 'not supported in tests' }
  }
}

export interface TestContext {
  ctx: CoreContext
  backups: RecordingBackups
  logs: LogEvent[]
}

/** A CoreContext whose data lives in the sandbox (memory secret store, recording backups). */
export async function makeContext(sb: Sandbox): Promise<TestContext> {
  const state = new StateStore(join(sb.dataDir, 'state.json'))
  await state.load()
  const events = new CoreEmitter()
  const logs: LogEvent[] = []
  const push = (level: LogEvent['level']) => (scope: string, message: string) => logs.push({ time: new Date().toISOString(), level, scope, message })
  const backups = new RecordingBackups()
  const ctx: CoreContext = {
    options: { surface: 'cli', appVersion: '0.0.0-test', dataDir: sb.dataDir },
    dataDir: sb.dataDir,
    cacheDir: join(sb.dataDir, 'cache'),
    state,
    secrets: createMemorySecretStore(),
    backups,
    events,
    log: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
  }
  return { ctx, backups, logs }
}

export interface FakeProxy extends ProxyApi {
  saved: ProxyConfig[]
  starts: number
  setRunning(running: boolean): void
}

/** In-memory ProxyApi. `startResult` overrides what start() returns; `failSave` makes saveConfig throw. */
export function fakeProxy(opts: { startResult?: Partial<ProxyStatus>; failSave?: string; port?: number } = {}): FakeProxy {
  let config: ProxyConfig = { port: opts.port ?? 3460, authToken: 'cs-test-proxy-token-0001', upstreams: [], routes: {}, autoStart: false }
  let running = false
  const status = (): ProxyStatus => ({ running, port: config.port, ...(running ? { url: `http://127.0.0.1:${config.port}` } : {}), requests: 0, errors: 0 })
  const proxy: FakeProxy = {
    saved: [],
    starts: 0,
    setRunning(value) {
      running = value
    },
    async status() {
      return status()
    },
    async start() {
      proxy.starts++
      if (opts.startResult) return { ...status(), ...opts.startResult } as ProxyStatus
      running = true
      return status()
    },
    async stop() {
      running = false
      return status()
    },
    async getConfig() {
      return structuredClone(config)
    },
    async saveConfig(next) {
      if (opts.failSave) throw new Error(opts.failSave)
      config = structuredClone(next)
      proxy.saved.push(structuredClone(next))
      return structuredClone(config)
    },
    async logs() {
      return []
    }
  }
  return proxy
}

const ENV_PATTERN = /^(ANTHROPIC_|CLAUDE_CODE_USE_|HTTPS?_PROXY$|NO_PROXY$)/i

/** Remove ANTHROPIC_*, CLAUDE_CODE_USE_* and proxy variables from process.env; returns a restore function. */
export function cleanModelEnv(): () => void {
  const saved = new Map<string, string>()
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_PATTERN.test(k) && v !== undefined) {
      saved.set(k, v)
      delete process.env[k]
    }
  }
  return () => {
    for (const k of Object.keys(process.env)) if (ENV_PATTERN.test(k)) delete process.env[k]
    for (const [k, v] of saved) process.env[k] = v
  }
}

/** Write a file (creating folders). */
export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** Read and parse a JSON file. */
export async function readJsonFile<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}
