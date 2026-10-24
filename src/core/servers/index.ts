/** ServersApi: install / remove / enable / test MCP servers across targets. CONTRACT (owned by TARGETS). */
import type { CatalogApi, ServersApi } from '@shared/api'
import type {
  CatalogServer,
  InstallOption,
  InstallPreview,
  InstallRequest,
  InstallResult,
  InstalledServer,
  RuntimeInfo,
  RuntimeName,
  Scope,
  ServerConfig,
  TargetChangeResult,
  TargetId,
  TargetRef,
  TestResult
} from '@shared/types'
import type { CoreContext } from '../context'
import type { NormalizedRef, TargetAdapter } from '../targets/adapter'
import { reapplyPendingDesktopChanges } from '../targets/claudeDesktop'
import { jsonEqual } from '../targets/configDoc'
import { isDesktopRunning, restartDesktop } from '../targets/desktopProcess'
import { deleteInstallRecord, deleteStash, findInstallRecord, findStash, loadStash, saveInstallRecord, saveStash } from '../targets/records'
import { normalizeRef, publicRef, refLabel, samePath, TARGET_LABELS, TARGET_ORDER } from '../targets/refs'
import { getAdapters } from '../targets/registry'
import { safeDetectRuntime } from '../targets/sys'
import { normalizeServerConfig, serverConfigProblem, serverNameProblem } from '../targets/validate'
import { buildServerConfig, buildServerConfigStrict, MissingValuesError, UnsupportedOptionError } from './build'
import { dockerRisks, requiredRuntimes } from './checks'
import { expandForTarget } from './expand'
import { nameFromConfig, sanitizeServerName } from './names'
import { testServer } from './tester'

export { buildServerConfig, buildServerConfigStrict, MissingValuesError, UnsupportedOptionError } from './build'
export { testServer, DEFAULT_TEST_TIMEOUT_MS } from './tester'
export { hintFor, missingEnvVars } from './hints'
export { sanitizeServerName, nameFromConfig, uniqueServerName } from './names'
export { dockerRisks, requiredRuntimes } from './checks'

export interface ServersDeps {
  catalog: CatalogApi
}

/** Everything needed to write one server: its config and name, plus where it came from. */
interface Source {
  config: ServerConfig
  name: string
  catalog?: CatalogServer
  option?: InstallOption
  missing: string[]
  warnings: string[]
}

type SourceResult = { ok: true; source: Source } | { ok: false; message: string }

const AUTO_KINDS = new Set(['npm', 'pypi', 'docker', 'remote', 'nuget'])
const MAX_RECENT_PROJECTS = 12

/** The best automatic install option: the first that can be set up without manual steps. */
function defaultOption(options: InstallOption[]): InstallOption | undefined {
  return options.find((o) => AUTO_KINDS.has(o.kind) || ((o.kind === 'binary' || o.kind === 'manual') && !!o.command)) ?? options[0]
}

function stashLost(name: string): string {
  return `The saved settings for "${name}" are missing (they're kept in the secure store). Reinstall it from Discover.`
}

function errMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

/** Build the ServersApi. */
export function createServersApi(ctx: CoreContext, deps: ServersDeps): ServersApi {
  const adapters = getAdapters(ctx)
  const adapter = (id: TargetId): TargetAdapter => adapters.get(id)!
  const progress = (op: string, message: string, pct?: number) =>
    ctx.events.emitEvent('progress', pct === undefined ? { op, message } : { op, message, pct })
  const changed = () => ctx.events.emitEvent('state', { key: 'servers' })

  /** Resolve the request into a config + name. `strict` refuses missing required values. */
  async function resolveSource(req: InstallRequest, strict: boolean): Promise<SourceResult> {
    if (req.name !== undefined && req.name !== '') {
      const problem = serverNameProblem(req.name)
      if (problem) return { ok: false, message: problem }
    }
    if (req.config) {
      const problem = serverConfigProblem(req.config)
      if (problem) return { ok: false, message: problem }
      const config = normalizeServerConfig(req.config)
      return { ok: true, source: { config, name: req.name || nameFromConfig(config), missing: [], warnings: [] } }
    }
    if (!req.catalogId) return { ok: false, message: 'Choose a server from the catalog, or enter its settings.' }
    let server: CatalogServer | null
    try {
      server = await deps.catalog.get(req.catalogId)
    } catch (err) {
      return { ok: false, message: `Couldn't load "${req.catalogId}" from the catalog: ${errMessage(err)}` }
    }
    if (!server) return { ok: false, message: `"${req.catalogId}" isn't in the catalog anymore. Refresh the catalog and try again.` }
    const option = req.optionId ? server.install.find((o) => o.id === req.optionId) : defaultOption(server.install)
    if (!option) {
      const message = req.optionId
        ? `"${server.name}" has no install option "${req.optionId}".`
        : `"${server.name}" can't be installed automatically. Follow the instructions on its page.`
      return { ok: false, message }
    }
    try {
      const built = strict ? buildServerConfigStrict(option, req.values) : buildServerConfig(option, req.values)
      const warnings = [...built.warnings]
      if (option.notes) warnings.push(option.notes)
      const name = req.name || sanitizeServerName(server.slug || server.name)
      return { ok: true, source: { config: built.config, name, catalog: server, option, missing: built.missing, warnings } }
    } catch (err) {
      if (err instanceof MissingValuesError || err instanceof UnsupportedOptionError) return { ok: false, message: err.message }
      return { ok: false, message: `Couldn't prepare "${server.name}": ${errMessage(err)}` }
    }
  }

  async function rememberProject(projectPath: string): Promise<void> {
    const recent = ctx.state.settings().recentProjects
    if (recent[0] && samePath(recent[0], projectPath)) return
    await ctx.state.update((d) => {
      const others = d.settings.recentProjects.filter((p) => !samePath(p, projectPath))
      d.settings.recentProjects = [projectPath, ...others].slice(0, MAX_RECENT_PROJECTS)
    })
    ctx.events.emitEvent('state', { key: 'settings' })
  }

  /** Restart Claude Desktop automatically when the user opted in and a change needs it. */
  async function autoRestart(results: TargetChangeResult[]): Promise<void> {
    const pending = results.filter((r) => r.ok && r.needsRestart && r.target.target === 'claude-desktop')
    if (!pending.length || !ctx.state.settings().autoRestartDesktop) return
    progress('restart-desktop', 'Restarting Claude Desktop…')
    const restarted = await restartDesktop({ beforeLaunch: () => reapplyPendingDesktopChanges(ctx) })
    for (const r of pending) {
      if (restarted.ok) {
        r.needsRestart = false
        r.message += ' Claude Desktop was restarted automatically.'
      } else {
        r.message += ` ${restarted.message}`
      }
    }
  }

  /** Write `source` into every ref; records installs and recent projects. */
  async function installInto(
    source: Source,
    refs: TargetRef[],
    opts: { overwrite: boolean; catalogId?: string; optionId?: string; op: string }
  ): Promise<InstallResult> {
    const results: TargetChangeResult[] = []
    const warnings = [...source.warnings]
    for (const [i, ref] of refs.entries()) {
      const check = await normalizeRef(ref)
      if (!check.ok) {
        results.push({ target: ref, ok: false, message: check.message })
        continue
      }
      if (!opts.overwrite && findStash(ctx, source.name, publicRef(check.ref))) {
        const message = `${refLabel(check.ref)} has a turned-off server named "${source.name}". Turn it back on, choose Replace, or use another name.`
        results.push({ target: publicRef(check.ref), ok: false, message })
        continue
      }
      progress(opts.op, `Adding "${source.name}" to ${refLabel(check.ref)}…`, Math.round((i / refs.length) * 100))
      const r = await adapter(check.ref.target).add(check.ref, source.name, source.config, { overwrite: opts.overwrite })
      if (r.ok) {
        const installedAt = new Date().toISOString()
        await saveInstallRecord(ctx, { name: source.name, catalogId: opts.catalogId, optionId: opts.optionId, target: check.ref, installedAt })
        await deleteStash(ctx, source.name, publicRef(check.ref))
        if (check.ref.projectPath) await rememberProject(check.ref.projectPath)
      }
      results.push(r)
    }
    await autoRestart(results)
    const okCount = results.filter((r) => r.ok).length
    const summary = okCount === results.length ? `"${source.name}" is ready.` : `"${source.name}" was added to ${okCount} of ${results.length} apps.`
    progress(opts.op, summary, 100)
    if (okCount) changed()
    return { ok: results.length > 0 && okCount === results.length, name: source.name, results, warnings }
  }

  /** Active entry, or turned-off copy (with its full config), of a server. */
  async function findServer(name: string, ref: NormalizedRef): Promise<{ config: ServerConfig; enabled: boolean } | { error: string }> {
    const found = await adapter(ref.target).get(ref, name)
    if (found) return { config: found.config, enabled: true }
    const stash = findStash(ctx, name, publicRef(ref))
    if (stash) {
      const payload = await loadStash(ctx, stash)
      if (payload) return { config: payload.config, enabled: false }
      return { error: stashLost(name) }
    }
    return { error: `There's no server named "${name}" in ${refLabel(ref)}.` }
  }

  const failTest = (message: string): TestResult => ({ ok: false, kind: 'invalid-config', ms: 0, tools: [], error: message, hint: message })

  return {
    async list(filter = {}): Promise<InstalledServer[]> {
      const ids = filter.target ? [filter.target] : TARGET_ORDER
      // Project/local scopes: the given project only (it is a filter), otherwise every recent project.
      const projects: string[] = []
      for (const p of filter.projectPath ? [filter.projectPath] : ctx.state.settings().recentProjects) {
        if (p && !projects.some((q) => samePath(q, p))) projects.push(p)
      }
      const out: InstalledServer[] = []
      for (const id of ids) {
        const a = adapters.get(id)
        if (!a) continue
        for (const scope of a.scopes as Scope[]) {
          if (filter.scope && filter.scope !== scope) continue
          const refs: TargetRef[] =
            scope === 'user' ? [{ target: id, scope }] : projects.map((projectPath) => ({ target: id, scope, projectPath }))
          for (const ref of refs) {
            const check = await normalizeRef(ref)
            if (!check.ok) continue
            try {
              out.push(...(await a.list(check.ref)))
            } catch (err) {
              ctx.log.warn('servers', `Couldn't list ${refLabel(check.ref)}: ${errMessage(err)}`)
            }
          }
        }
      }
      return out
    },

    async preview(req: InstallRequest): Promise<InstallPreview> {
      const res = await resolveSource(req, false)
      if (!res.ok) {
        const config: ServerConfig = req.config ?? { type: 'stdio', command: '' }
        return { name: req.name ?? '', config, targets: [], missingRuntimes: [], missingValues: [], warnings: [res.message] }
      }
      const { source } = res
      const warnings = [...source.warnings, ...dockerRisks(source.config)]
      const runtimes = new Set<RuntimeName>(requiredRuntimes(source.config))
      const targets: InstallPreview['targets'] = []
      // Started early: the process check takes a moment on Windows.
      const desktopRunning = (req.targets ?? []).some((r) => r?.target === 'claude-desktop') ? isDesktopRunning() : Promise.resolve(false)
      for (const ref of req.targets ?? []) {
        const check = await normalizeRef(ref)
        if (!check.ok) {
          targets.push({ target: ref, snippet: '', supported: false, note: check.message })
          continue
        }
        const a = adapter(check.ref.target)
        const support = a.supports(source.config)
        const entry: InstallPreview['targets'][number] = { target: publicRef(check.ref), snippet: '', supported: support.ok }
        const notes: string[] = []
        if (support.reason) notes.push(support.reason)
        try {
          entry.configPath = await a.configFile(check.ref)
        } catch {
          // shown without a path
        }
        if (support.ok) {
          try {
            entry.snippet = await a.snippet(check.ref, source.name, source.config)
          } catch (err) {
            notes.push(`Couldn't prepare the entry: ${errMessage(err)}`)
          }
          for (const rt of requiredRuntimes(source.config, !!support.bridged)) runtimes.add(rt)
        }
        try {
          const existing = await a.get(check.ref, source.name)
          if (existing && !jsonEqual(existing.config, source.config)) {
            notes.push(
              req.overwrite
                ? `This replaces the existing "${source.name}".`
                : `A different "${source.name}" already exists here. Choose Replace or another name.`
            )
          } else if (!existing && (await a.exists(check.ref, source.name))) {
            notes.push(`An entry called "${source.name}" already exists here.`)
          } else if (!existing && findStash(ctx, source.name, entry.target)) {
            notes.push(`A turned-off server called "${source.name}" exists here. Turn it back on, choose Replace, or use another name.`)
          }
        } catch {
          // preview stays usable
        }
        if (check.ref.target === 'claude-code' && check.ref.scope === 'project') {
          notes.push('Claude Code asks everyone to approve project servers the first time.')
        }
        if (notes.length) entry.note = notes.join(' ')
        targets.push(entry)
      }
      const missingRuntimes: RuntimeInfo[] = []
      const detected = await Promise.all([...runtimes].map(async (id) => ({ id, info: await safeDetectRuntime(id) })))
      for (const { id, info } of detected) {
        if (!info) continue
        if (!info.found) missingRuntimes.push(info)
        else if (id === 'docker' && info.running === false) {
          warnings.push('Docker Desktop is installed but not running. Start it before using this server.')
        } else if (info.outdated) {
          warnings.push(`${[info.label, info.version].filter(Boolean).join(' ')} is outdated. Update it for this server to work reliably.`)
        }
      }
      if (await desktopRunning) warnings.push('Claude Desktop is running. It needs a restart after installing.')
      return { name: source.name, config: source.config, targets, missingRuntimes, missingValues: source.missing, warnings }
    },

    async install(req: InstallRequest): Promise<InstallResult> {
      const fail = (message: string): InstallResult => ({ ok: false, name: req?.name ?? '', results: [], warnings: [message] })
      if (!req || !Array.isArray(req.targets) || !req.targets.length) return fail('Choose at least one app to add the server to.')
      const res = await resolveSource(req, true)
      if (!res.ok) return fail(res.message)
      const { source } = res
      const result = await installInto(source, req.targets, {
        overwrite: !!req.overwrite,
        catalogId: source.catalog?.id ?? req.catalogId,
        optionId: source.option?.id,
        op: 'install'
      })
      if (req.test && result.results.some((r) => r.ok)) {
        progress('install', `Testing "${source.name}"…`)
        result.test = await testServer(source.config)
      }
      const outcome = result.results.map((r) => `${r.target.target}=${r.ok ? 'ok' : 'failed'}`).join(', ')
      ctx.log.info('servers', `Install "${source.name}": ${outcome}`)
      return result
    },

    async uninstall(name: string, refs: TargetRef[]): Promise<TargetChangeResult[]> {
      const results: TargetChangeResult[] = []
      for (const [i, ref] of (refs ?? []).entries()) {
        const check = await normalizeRef(ref)
        if (!check.ok) {
          results.push({ target: ref, ok: false, message: check.message })
          continue
        }
        const pub = publicRef(check.ref)
        const where = refLabel(check.ref)
        progress('uninstall', `Removing "${name}" from ${where}…`, Math.round((i / refs.length) * 100))
        const a = adapter(check.ref.target)
        const stash = findStash(ctx, name, pub)
        let r: TargetChangeResult
        if (await a.exists(check.ref, name)) r = await a.remove(check.ref, name)
        else if (stash) r = { target: pub, ok: true, message: `Removed "${name}" (it was turned off) from ${where}.` }
        else r = { target: pub, ok: false, message: `There's no server named "${name}" in ${where}.` }
        if (r.ok) {
          await deleteStash(ctx, name, pub)
          await deleteInstallRecord(ctx, name, pub)
        }
        results.push(r)
      }
      await autoRestart(results)
      progress('uninstall', 'Done.', 100)
      if (results.some((r) => r.ok)) changed()
      return results
    },

    async setEnabled(name: string, ref: TargetRef, enabled: boolean): Promise<TargetChangeResult> {
      const check = await normalizeRef(ref)
      if (!check.ok) return { target: ref, ok: false, message: check.message }
      const pub = publicRef(check.ref)
      const where = refLabel(check.ref)
      const a = adapter(check.ref.target)
      const done = async (r: TargetChangeResult) => {
        await autoRestart([r])
        if (r.ok) changed()
        return r
      }
      if (!enabled) {
        const found = await a.get(check.ref, name)
        if (!found) {
          if (findStash(ctx, name, pub)) return { target: pub, ok: true, message: `"${name}" is already turned off in ${where}.` }
          return { target: pub, ok: false, message: `There's no server named "${name}" in ${where}.` }
        }
        let native: Record<string, unknown> | undefined
        try {
          const converted = a.toNative(await a.prepare(found.config))
          if (found.native && typeof found.native === 'object' && !jsonEqual(converted, found.native)) {
            native = found.native as Record<string, unknown>
          }
        } catch {
          native = found.native as Record<string, unknown>
        }
        try {
          await saveStash(ctx, name, check.ref, found.config, native)
        } catch (err) {
          const message = `Couldn't safely store the settings of "${name}" before turning it off, so nothing was changed. (${errMessage(err)})`
          return { target: pub, ok: false, message }
        }
        progress('disable', `Turning off "${name}" in ${where}…`)
        const r = await a.remove(check.ref, name)
        if (!r.ok) {
          await deleteStash(ctx, name, pub)
          return r
        }
        r.message = `Turned off "${name}" in ${where}. Its settings are kept, so you can turn it back on any time.`
        if (r.needsRestart) r.message += ' Restart Claude Desktop to apply this.'
        return done(r)
      }
      const stash = findStash(ctx, name, pub)
      if (!stash) {
        if (await a.exists(check.ref, name)) return { target: pub, ok: true, message: `"${name}" is already on in ${where}.` }
        return { target: pub, ok: false, message: `There's no turned-off server named "${name}" in ${where}.` }
      }
      const payload = await loadStash(ctx, stash)
      if (!payload) return { target: pub, ok: false, message: stashLost(name) }
      progress('enable', `Turning on "${name}" in ${where}…`)
      const r = await a.add(check.ref, name, payload.config, { overwrite: false, native: payload.native })
      if (!r.ok) return r
      await deleteStash(ctx, name, pub)
      r.message = `Turned on "${name}" in ${where}.${r.needsRestart ? ' Restart Claude Desktop to start using it.' : ''}`
      return done(r)
    },

    async update(name: string, ref: TargetRef, config: ServerConfig): Promise<TargetChangeResult> {
      const check = await normalizeRef(ref)
      if (!check.ok) return { target: ref, ok: false, message: check.message }
      const pub = publicRef(check.ref)
      const where = refLabel(check.ref)
      const problem = serverConfigProblem(config)
      if (problem) return { target: pub, ok: false, message: problem }
      const normalized = normalizeServerConfig(config)
      const a = adapter(check.ref.target)
      if (await a.exists(check.ref, name)) {
        progress('update', `Updating "${name}" in ${where}…`)
        const r = await a.add(check.ref, name, normalized, { overwrite: true })
        if (r.ok) {
          await autoRestart([r])
          changed()
        }
        return r
      }
      if (findStash(ctx, name, pub)) {
        try {
          await saveStash(ctx, name, check.ref, normalized)
        } catch (err) {
          return { target: pub, ok: false, message: `Couldn't save the new settings of "${name}": ${errMessage(err)}` }
        }
        changed()
        return { target: pub, ok: true, message: `Updated the settings of "${name}" in ${where}. It stays turned off until you turn it on.` }
      }
      return { target: pub, ok: false, message: `There's no server named "${name}" in ${where}.` }
    },

    async copy(name: string, from: TargetRef, to: TargetRef[]): Promise<InstallResult> {
      const fail = (message: string): InstallResult => ({ ok: false, name, results: [], warnings: [message] })
      const check = await normalizeRef(from)
      if (!check.ok) return fail(check.message)
      if (!to?.length) return fail('Choose at least one app to copy the server to.')
      const found = await findServer(name, check.ref)
      if ('error' in found) return fail(found.error)
      const record = findInstallRecord(ctx, name, publicRef(check.ref))
      return installInto({ config: found.config, name, missing: [], warnings: [] }, to, {
        overwrite: false,
        catalogId: record?.catalogId,
        optionId: record?.optionId,
        op: 'copy'
      })
    },

    async test(config: ServerConfig, opts?: { timeoutMs?: number }): Promise<TestResult> {
      const problem = serverConfigProblem(config)
      if (problem) return failTest(problem)
      progress('test', 'Testing the server…')
      const result = await testServer(normalizeServerConfig(config), { timeoutMs: opts?.timeoutMs })
      progress('test', result.ok ? `Connected (${result.tools.length} tools).` : (result.hint ?? 'The test failed.'), 100)
      return result
    },

    async testInstalled(name: string, ref: TargetRef): Promise<TestResult> {
      const check = await normalizeRef(ref)
      if (!check.ok) return failTest(check.message)
      const found = await findServer(name, check.ref)
      if ('error' in found) return failTest(found.error)
      const expanded = await expandForTarget(found.config, check.ref.target, check.ref.projectPath)
      progress('test', `Testing "${name}"…`)
      const result = await testServer(expanded.config)
      if (!result.ok && expanded.unresolved.length) {
        const unresolved = `It uses ${expanded.unresolved.join(', ')}, which only ${TARGET_LABELS[check.ref.target]} can fill in.`
        result.hint = result.hint ? `${result.hint} ${unresolved}` : unresolved
      }
      progress('test', result.ok ? `"${name}" connected (${result.tools.length} tools).` : (result.hint ?? 'The test failed.'), 100)
      return result
    }
  }
}
