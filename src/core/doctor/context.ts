/** Shared, memoized lookups for one Doctor run, plus helpers to build checks that never throw. */
import type { ModelsApi, ProxyApi, RuntimesApi, ServersApi, TargetsApi } from '@shared/api'
import type { DoctorCheck, InstalledServer, OS, ProxyStatus, RuntimeInfo, RuntimeName, TargetId, TargetInfo } from '@shared/types'
import type { CoreContext } from '../context'
import { inspectModels, type ModelInspection } from '../models/status'
import { withTimeout } from '../models/timeout'
import { currentOS } from '../platform/paths'

export interface DoctorDeps {
  targets: TargetsApi
  servers: ServersApi
  models: ModelsApi
  runtimes: RuntimesApi
  proxy: ProxyApi
}

export type Category = DoctorCheck['category']

export interface RunContext {
  ctx: CoreContext
  deps: DoctorDeps
  os: OS
  runtimes(): Promise<RuntimeInfo[]>
  runtime(id: RuntimeName): Promise<RuntimeInfo | undefined>
  targets(): Promise<TargetInfo[]>
  target(id: TargetId): Promise<TargetInfo | undefined>
  servers(): Promise<InstalledServer[]>
  models(): Promise<ModelInspection>
  proxyStatus(): Promise<ProxyStatus | undefined>
}

/** A group of related checks; if it throws or times out, one 'warn' check with `id` reports that. */
export interface CheckGroup {
  id: string
  category: Category
  title: string
  timeoutMs: number
  run(rc: RunContext): Promise<DoctorCheck[]>
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Calls `fn` once and shares the promise (sync throws become rejections). */
function once<T>(fn: () => Promise<T> | T): () => Promise<T> {
  let p: Promise<T> | undefined
  return () => (p ??= Promise.resolve().then(fn))
}

/** Build the memoized lookups for one run. */
export function createRunContext(ctx: CoreContext, deps: DoctorDeps): RunContext {
  const runtimes = once(() => withTimeout(Promise.resolve().then(() => deps.runtimes.detect()), 40_000, 'Detecting runtimes'))
  const targets = once(() => withTimeout(Promise.resolve().then(() => deps.targets.list()), 25_000, 'Checking apps'))
  const servers = once(() => withTimeout(Promise.resolve().then(() => deps.servers.list()), 25_000, 'Listing MCP servers'))
  const models = once(() => withTimeout(inspectModels(ctx, deps.proxy), 15_000, 'Checking model settings'))
  const proxyStatus = once(() =>
    withTimeout(Promise.resolve().then(() => deps.proxy.status()), 5_000, 'Checking the proxy').catch(() => undefined)
  )
  return {
    ctx,
    deps,
    os: currentOS(),
    runtimes,
    runtime: async (id) => (await runtimes()).find((r) => r.id === id),
    targets,
    target: async (id) => (await targets()).find((t) => t.id === id),
    servers,
    models,
    proxyStatus
  }
}

function unfinished(id: string, category: Category, title: string, err: unknown): DoctorCheck {
  return { id, category, title, status: 'warn', detail: `This check couldn't finish: ${errorText(err)}` }
}

type CheckFn = () => Promise<DoctorCheck | DoctorCheck[] | null>

/** Run one check function; a crash becomes a 'warn' check instead of failing the whole report. */
export async function guard(id: string, category: Category, title: string, fn: CheckFn): Promise<DoctorCheck[]> {
  try {
    const out = await fn()
    if (!out) return []
    return Array.isArray(out) ? out : [out]
  } catch (err) {
    return [unfinished(id, category, title, err)]
  }
}

/** Run a whole group with its timeout. */
export async function runGroup(rc: RunContext, group: CheckGroup): Promise<DoctorCheck[]> {
  try {
    return await withTimeout(group.run(rc), group.timeoutMs, group.title)
  } catch (err) {
    return [unfinished(group.id, group.category, group.title, err)]
  }
}

/** Fix descriptor for installing a runtime, when Claude Setup can do it automatically. */
export function installFix(info: RuntimeInfo | undefined, id: RuntimeName, label: string): DoctorCheck['fix'] | undefined {
  if (!info?.install?.canAutoInstall) return undefined
  return { id: `install-runtime:${id}`, label: `Install ${label}`, auto: true }
}
