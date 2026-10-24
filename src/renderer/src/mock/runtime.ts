/**
 * Shared helpers for the browser mock of window.api: fake environment (platform + home paths),
 * an event bus that mimics core events, time helpers and ids.
 * Pure TypeScript (no DOM) so the mock can also run in Node tests.
 */
import type { CoreEvent, CoreEventName, CoreEvents } from '@shared/api'
import type { OS } from '@shared/types'

interface MockEnv {
  platform: OS
  home: string
  sep: '\\' | '/'
}

export const env: MockEnv = { platform: 'win32', home: 'C:\\Users\\you', sep: '\\' }

/** Switch the fake OS (paths, runtimes and window chrome follow). */
export function configureEnv(platform: OS): void {
  env.platform = platform
  if (platform === 'win32') Object.assign(env, { home: 'C:\\Users\\you', sep: '\\' })
  else if (platform === 'darwin') Object.assign(env, { home: '/Users/you', sep: '/' })
  else Object.assign(env, { home: '/home/you', sep: '/' })
}

/** Join path segments under the fake home directory. */
export function homePath(...segments: string[]): string {
  return [env.home, ...segments].join(env.sep)
}

/** Platform-specific absolute path helper: pick per-OS segments. */
export function osPath(paths: { win32: string; darwin: string; linux: string }): string {
  return paths[env.platform]
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

const listeners = new Set<(event: CoreEvent) => void>()

/** Emit a core event to every subscriber (window.api.onEvent). */
export function emit<K extends CoreEventName>(name: K, payload: CoreEvents[K]): void {
  const event = { name, payload } as CoreEvent
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // A failing listener must not break the mock.
    }
  }
}

export function subscribe(listener: (event: CoreEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Emit a log event (shows up in Advanced log views). */
export function log(level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string): void {
  emit('log', { time: new Date().toISOString(), level, scope, message })
}

// ─────────────────────────────────────────────────────────────────────────────
// Time & ids
// ─────────────────────────────────────────────────────────────────────────────

/** Mock-wide latency multiplier (0 = instant, used by tests). */
export const timing = { scale: 1 }

export function sleep(ms: number): Promise<void> {
  const scaled = Math.round(ms * timing.scale)
  return scaled <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, scaled))
}

export function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

export const minutesAgo = (n: number): string => isoAgo(n * 60_000)
export const hoursAgo = (n: number): string => isoAgo(n * 3_600_000)
export const daysAgo = (n: number): string => isoAgo(n * 86_400_000)

let counter = 0

/** Short unique id with a prefix, e.g. uid('prof') → "prof-lq2x9a-3". */
export function uid(prefix: string): string {
  counter++
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

/** Backup id in the core's format: YYYYMMDD-HHmmss-xxxx. */
export function backupIdFor(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `${stamp}-${hex}`
}

/** Deep copy (mimics IPC serialization so callers can't mutate mock state). */
export function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}
