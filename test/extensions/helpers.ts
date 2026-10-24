/** Test helpers for the extensions module: a CoreContext with fake backups, a fetch stub and a fake GitHub repo. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { BackupEntry } from '@shared/types'
import type { CoreContext } from '@core/context'
import { CoreEmitter } from '@core/events'
import type { BackupManager } from '@core/fs/backups'
import { createMemorySecretStore } from '@core/secrets'
import { StateStore } from '@core/state'
import type { Sandbox } from '../helpers/sandbox'

export const FIXTURES = join(__dirname, 'fixtures')

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T
}

export interface SnapshotCall {
  reason: string
  paths: string[]
  existed: boolean[]
}

export interface TestContext {
  ctx: CoreContext
  snapshots: SnapshotCall[]
  progress: string[]
}

/** CoreContext inside a sandbox; backups are recorded (not copied) so tests can assert on them. */
export async function makeCtx(sb: Sandbox): Promise<TestContext> {
  const state = new StateStore(join(sb.dataDir, 'state.json'))
  await state.load()
  const snapshots: SnapshotCall[] = []
  const backups = {
    dir: join(sb.dataDir, 'backups'),
    keep: () => 30,
    snapshot: vi.fn(async (reason: string, paths: string[]): Promise<BackupEntry> => {
      snapshots.push({ reason, paths: [...paths], existed: paths.map((p) => existsSync(p)) })
      return {
        id: `backup-${snapshots.length}`,
        createdAt: new Date().toISOString(),
        reason,
        files: paths.map((p) => ({ path: p, existed: existsSync(p), size: existsSync(p) ? statSync(p).size : 0 }))
      }
    }),
    list: vi.fn(async () => []),
    restore: vi.fn(async () => ({ ok: true, message: 'restored' })),
    delete: vi.fn(async () => ({ ok: true, message: 'deleted' }))
  }
  const events = new CoreEmitter()
  const progress: string[] = []
  events.on('progress', (p) => progress.push(p.message))
  const ctx: CoreContext = {
    options: { surface: 'cli', appVersion: '0.0.0-test' },
    dataDir: sb.dataDir,
    cacheDir: join(sb.dataDir, 'cache'),
    state,
    secrets: createMemorySecretStore(),
    backups: backups as unknown as BackupManager,
    events,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  }
  return { ctx, snapshots, progress }
}

export type Handler = (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>

/** Replace global fetch; unmatched URLs get a 404. Returns the list of requested URLs. */
export function stubFetch(...handlers: Handler[]): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(href)
      const url = new URL(href)
      for (const h of handlers) {
        const res = await h(url, init)
        if (res) return res
      }
      return new Response('404: Not Found', { status: 404 })
    })
  )
  return { calls }
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function textResponse(body: string | Uint8Array, status = 200): Response {
  return new Response(body as ConstructorParameters<typeof Response>[0], { status })
}

export interface FakeFile {
  content: string | Buffer
  executable?: boolean
}

/**
 * A fake GitHub repository answering the git trees API (full and per-folder), the contents API
 * (folder listings) and raw.githubusercontent.com downloads for any ref.
 */
export function fakeRepo(owner: string, repo: string, files: Record<string, string | Buffer | FakeFile>): Handler {
  const entries = Object.entries(files).map(([path, v]) => {
    const f: FakeFile = typeof v === 'string' || Buffer.isBuffer(v) ? { content: v } : v
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8')
    return { path, buf, executable: !!f.executable }
  })
  const dirs = new Set<string>()
  for (const e of entries) {
    const parts = e.path.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const treeFor = (prefix: string) => {
    const base = prefix ? prefix + '/' : ''
    const blobs = entries
      .filter((e) => e.path.startsWith(base))
      .map((e) => ({ path: e.path.slice(base.length), mode: e.executable ? '100755' : '100644', type: 'blob', size: e.buf.length, sha: 'x' }))
    const trees = [...dirs].filter((d) => d.startsWith(base)).map((d) => ({ path: d.slice(base.length), mode: '040000', type: 'tree', sha: 'tree-' + d }))
    return { sha: 'tree-' + (prefix || 'root'), truncated: false, tree: [...trees, ...blobs] }
  }
  return (url) => {
    if (url.hostname === 'api.github.com') {
      const prefix = `/repos/${owner}/${repo}/`
      if (!url.pathname.startsWith(prefix)) return undefined
      const rest = decodeURIComponent(url.pathname.slice(prefix.length))
      if (rest === 'git/trees/HEAD') return jsonResponse(treeFor(''))
      if (rest.startsWith('git/trees/tree-')) {
        const d = rest.slice('git/trees/tree-'.length)
        return dirs.has(d) ? jsonResponse(treeFor(d)) : jsonResponse({ message: 'Not Found' }, 404)
      }
      if (rest === 'contents' || rest.startsWith('contents/')) {
        const dir = rest === 'contents' ? '' : rest.slice('contents/'.length)
        if (dir && !dirs.has(dir)) return jsonResponse({ message: 'Not Found' }, 404)
        const base = dir ? dir + '/' : ''
        const children = new Map<string, { name: string; path: string; type: string; sha: string; size: number }>()
        for (const d of dirs) if (d.startsWith(base) && !d.slice(base.length).includes('/')) children.set(d, { name: d.slice(base.length), path: d, type: 'dir', sha: 'tree-' + d, size: 0 })
        for (const e of entries) if (e.path.startsWith(base) && !e.path.slice(base.length).includes('/')) children.set(e.path, { name: e.path.slice(base.length), path: e.path, type: 'file', sha: 'x', size: e.buf.length })
        return jsonResponse([...children.values()])
      }
      return undefined
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (parts[0] !== owner || parts[1] !== repo) return undefined
      const path = parts.slice(3).join('/')
      const hit = entries.find((e) => e.path === path)
      return hit ? textResponse(new Uint8Array(hit.buf)) : undefined
    }
    return undefined
  }
}

/** Temporarily pretend to run on another platform. */
export function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return fn().finally(() => Object.defineProperty(process, 'platform', original))
}
